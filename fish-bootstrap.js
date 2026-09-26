import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const nativeFetch=globalThis.fetch.bind(globalThis);
const fishKey=process.env.FISH_AUDIO_API_KEY||process.env.FISH_API_KEY||'';
const transcriptCache=new Map();
const persistentVoiceIds=new Map();
const provisioning=new Map();
const voiceMapFile=process.env.FISH_VOICE_MAP_FILE||'/app/data/fish-voice-map.json';
let voiceMapLoaded=false;

function bytes(parts){return Buffer.concat(parts);}
function uint8(n){return Buffer.from([n]);}
function uint16(prefix,n){const b=Buffer.alloc(3);b[0]=prefix;b.writeUInt16BE(n,1);return b;}
function uint32(prefix,n){const b=Buffer.alloc(5);b[0]=prefix;b.writeUInt32BE(n,1);return b;}
function pack(value){
  if(Buffer.isBuffer(value)||value instanceof Uint8Array){const b=Buffer.from(value);return bytes([b.length<=255?Buffer.from([0xc4,b.length]):b.length<=65535?uint16(0xc5,b.length):uint32(0xc6,b.length),b]);}
  if(typeof value==='string'){const b=Buffer.from(value,'utf8');const h=b.length<=31?uint8(0xa0|b.length):b.length<=255?Buffer.from([0xd9,b.length]):b.length<=65535?uint16(0xda,b.length):uint32(0xdb,b.length);return bytes([h,b]);}
  if(Array.isArray(value)){const h=value.length<=15?uint8(0x90|value.length):value.length<=65535?uint16(0xdc,value.length):uint32(0xdd,value.length);return bytes([h,...value.map(pack)]);}
  if(value&&typeof value==='object'){const entries=Object.entries(value),h=entries.length<=15?uint8(0x80|entries.length):entries.length<=65535?uint16(0xde,entries.length):uint32(0xdf,entries.length);return bytes([h,...entries.flatMap(([k,v])=>[pack(k),pack(v)])]);}
  if(value===null)return uint8(0xc0);
  if(value===true)return uint8(0xc3);
  if(value===false)return uint8(0xc2);
  throw new TypeError('Unsupported MessagePack value');
}
function unpack(input){
  const b=Buffer.from(input);let o=0;
  const read=()=>{const c=b[o++];
    if(c<=0x7f)return c;
    if((c&0xf0)===0x80){const n=c&15,obj={};for(let i=0;i<n;i++)obj[read()]=read();return obj;}
    if((c&0xf0)===0x90){const n=c&15,a=[];for(let i=0;i<n;i++)a.push(read());return a;}
    if((c&0xe0)===0xa0){const n=c&31,s=b.toString('utf8',o,o+n);o+=n;return s;}
    if(c===0xc0)return null;if(c===0xc2)return false;if(c===0xc3)return true;
    if(c===0xc4){const n=b[o++],v=b.subarray(o,o+n);o+=n;return v;}
    if(c===0xc5){const n=b.readUInt16BE(o);o+=2;const v=b.subarray(o,o+n);o+=n;return v;}
    if(c===0xc6){const n=b.readUInt32BE(o);o+=4;const v=b.subarray(o,o+n);o+=n;return v;}
    if(c===0xcb){const v=b.readDoubleBE(o);o+=8;return v;}
    if(c===0xcc)return b[o++];if(c===0xcd){const v=b.readUInt16BE(o);o+=2;return v;}if(c===0xce){const v=b.readUInt32BE(o);o+=4;return v;}
    if(c===0xd9){const n=b[o++],s=b.toString('utf8',o,o+n);o+=n;return s;}
    if(c===0xda){const n=b.readUInt16BE(o);o+=2;const s=b.toString('utf8',o,o+n);o+=n;return s;}
    if(c===0xdb){const n=b.readUInt32BE(o);o+=4;const s=b.toString('utf8',o,o+n);o+=n;return s;}
    if(c===0xdc){const n=b.readUInt16BE(o);o+=2;const a=[];for(let i=0;i<n;i++)a.push(read());return a;}
    if(c===0xdd){const n=b.readUInt32BE(o);o+=4;const a=[];for(let i=0;i<n;i++)a.push(read());return a;}
    if(c===0xde){const n=b.readUInt16BE(o);o+=2,obj={};for(let i=0;i<n;i++)obj[read()]=read();return obj;}
    if(c===0xdf){const n=b.readUInt32BE(o);o+=4,obj={};for(let i=0;i<n;i++)obj[read()]=read();return obj;}
    throw new Error('Unsupported MessagePack byte 0x'+c.toString(16));
  };
  return read();
}

async function fishText(response,label){
  const raw=await response.text();let message=raw;
  try{const parsed=JSON.parse(raw);message=parsed.message||parsed.detail||raw;}catch{}
  if(!response.ok)throw new Error(`${label} failed (${response.status}): ${String(message).slice(0,180)}`);
  return raw;
}
function normalizeGeminiBody(body){
  if(!body||typeof body!=='object')return body;
  if(Array.isArray(body)){for(const item of body)normalizeGeminiBody(item);return body;}
  if(body.inline_data&&!body.inlineData){body.inlineData=body.inline_data;delete body.inline_data;}
  if(body.mime_type&&!body.mimeType){body.mimeType=body.mime_type;delete body.mime_type;}
  for(const value of Object.values(body))normalizeGeminiBody(value);
  return body;
}
async function loadVoiceMap(){
  if(voiceMapLoaded)return;voiceMapLoaded=true;
  try{const data=JSON.parse(await readFile(voiceMapFile,'utf8'));for(const [key,id] of Object.entries(data))if(typeof id==='string')persistentVoiceIds.set(key,id);}catch{}
}
async function saveVoiceMap(){try{await mkdir(dirname(voiceMapFile),{recursive:true});await writeFile(voiceMapFile,JSON.stringify(Object.fromEntries(persistentVoiceIds)),'utf8');}catch(error){console.warn('Could not persist Fish voice map:',error.message);}}
function audioType(audio){
  const b=Buffer.from(audio);if(b.length>=4&&b.subarray(0,4).toString('ascii')==='RIFF')return['audio/wav','.wav'];if(b.length>=4&&b.subarray(0,4).toString('ascii')==='OggS')return['audio/ogg','.ogg'];if(b.length>=3&&b.subarray(0,3).toString('ascii')==='ID3')return['audio/mpeg','.mp3'];if(b.length>=2&&b[0]===0xff&&(b[1]&0xe0)===0xe0)return['audio/mpeg','.mp3'];if(b.length>=4&&b[0]===0x1a&&b[1]===0x45&&b[2]===0xdf&&b[3]===0xa3)return['audio/webm','.webm'];if(b.length>=12&&b.subarray(4,8).toString('ascii')==='ftyp')return['audio/mp4','.m4a'];return['audio/webm','.webm'];
}
async function waitForFishModel(id){
  for(let attempt=0;attempt<12;attempt++){
    const response=await nativeFetch('https://api.fish.audio/model/'+encodeURIComponent(id),{headers:{Authorization:`Bearer ${fishKey}`},signal:AbortSignal.timeout(30000)});
    if(response.ok){const data=await response.json().catch(()=>({})),state=String(data.state||data.status||'').toLowerCase();if(!state||state==='trained'||state==='ready'||state==='created')return id;if(state==='failed')throw new Error('Fish Audio could not train the approved singer voice.');}
    await new Promise(resolve=>setTimeout(resolve,1250));
  }
  return id;
}
async function ensurePersistentVoice(audio,text){
  await loadVoiceMap();const raw=Buffer.from(audio),key=createHash('sha256').update(raw).digest('hex');if(persistentVoiceIds.has(key))return persistentVoiceIds.get(key);if(provisioning.has(key))return provisioning.get(key);
  const task=(async()=>{const [mime,ext]=audioType(raw),form=new FormData();form.append('type','tts');form.append('title','LiveRooms-'+key.slice(0,12));form.append('train_mode','fast');form.append('visibility','private');form.append('description','Private consented singer voice used by Live Rooms.');form.append('enhance_audio_quality','true');if(text?.trim())form.append('texts',text.trim());form.append('voices',new Blob([raw],{type:mime}),'voice'+ext);const response=await nativeFetch('https://api.fish.audio/model',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${fishKey}`},body:form});const rawResponse=await fishText(response,'Fish Audio persistent voice creation');let data={};try{data=JSON.parse(rawResponse);}catch{}const id=String(data._id||data.id||'');if(!id)throw new Error('Fish Audio did not return a voice model id.');await waitForFishModel(id);persistentVoiceIds.set(key,id);await saveVoiceMap();console.log('Persistent singer voice ready:',id.slice(0,8));return id;})().finally(()=>provisioning.delete(key));provisioning.set(key,task);return task;
}
async function persistentTts(text,referenceId){
  const response=await nativeFetch('https://api.fish.audio/v1/tts',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${fishKey}`,'Content-Type':'application/json',model:process.env.FISH_AUDIO_MODEL||'s2.1-pro-free'},body:JSON.stringify({text,reference_id:referenceId,format:'mp3',mp3_bitrate:128,normalize:true,temperature:.35,top_p:.5,repetition_penalty:1.1,condition_on_previous_chunks:true,latency:'normal'})});
  if(!response.ok)await fishText(response,'Fish Audio persistent voice synthesis');return response;
}
async function routedFetch(input,init={}){
  const url=String(input);
  if(url==='fish://voice-clone')return fishClone(init.body);
  if(url.startsWith('https://generativelanguage.googleapis.com/')&&typeof init.body==='string'){
    try{const parsed=normalizeGeminiBody(JSON.parse(init.body));return nativeFetch(input,{...init,body:JSON.stringify(parsed)});}catch{}
  }
  if(url==='https://api.fish.audio/v1/tts'&&init.body){
    const headers=new Headers(init.headers||{}),contentType=headers.get('content-type')||'';
    if(contentType.includes('application/msgpack'))try{const payload=unpack(init.body),reference=Array.isArray(payload?.references)?payload.references[0]:null;if(reference?.audio&&reference?.text&&payload?.text){const referenceId=await ensurePersistentVoice(reference.audio,reference.text);return persistentTts(payload.text,referenceId);}}catch(error){console.warn('Persistent singer voice fallback:',error.message);}
  }
  return nativeFetch(input,init);
}
async function geminiTranscribe(file,name){
  if(!process.env.GEMINI_API_KEY)return '';
  const audio=Buffer.from(await file.arrayBuffer()),mime=file.type||'audio/webm',model=process.env.GEMINI_TRANSCRIBE_MODEL||'gemini-3.8-flash';
  const response=await nativeFetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{
    method:'POST',signal:AbortSignal.timeout(120000),headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},
    body:JSON.stringify({contents:[{role:'user',parts:[{text:'Transcribe this audio exactly. Return only the spoken words, with no explanation.'},{inlineData:{mimeType:mime,data:audio.toString('base64')}}]}],generationConfig:{temperature:0}})
  });
  const data=await response.json().catch(()=>({})),text=data.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('').trim();
  if(!response.ok||!text)throw new Error(data.error?.message||`Gemini transcription failed (${response.status}).`);
  return text;
}
async function transcribe(file,name){
  if(process.env.GEMINI_API_KEY){try{return await geminiTranscribe(file,name);}catch(error){console.warn('Gemini transcription fallback failed:',error.message);}}
  const form=new FormData();form.append('audio',file,name);
  const response=await nativeFetch('https://api.fish.audio/v1/asr',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${fishKey}`},body:form});
  const raw=await fishText(response,'Fish Audio transcription');let data={};try{data=JSON.parse(raw);}catch{}
  const text=String(data.text||'').trim();if(!text)throw new Error('Fish Audio returned an empty transcript.');return text;
}
function syncSafe(size){return Buffer.from([(size>>21)&127,(size>>14)&127,(size>>7)&127,size&127]);}
function watermarkMp3(audio,modelId,owner){
  const value=Buffer.from(`Live Chat AI voice clone | model=${modelId} | owner=${owner} | generated=${new Date().toISOString()}`,'utf8');
  const payload=bytes([Buffer.from([3]),Buffer.from('AI_GENERATED\0','utf8'),value]),frameHeader=Buffer.alloc(10);frameHeader.write('TXXX',0,'ascii');frameHeader.writeUInt32BE(payload.length,4);
  const frame=bytes([frameHeader,payload]);return bytes([Buffer.from('ID3\x03\x00\x00','binary'),syncSafe(frame.length),frame,audio]);
}
async function fishClone(form){
  if(!(form instanceof FormData))throw new Error('Fish voice adapter expected multipart audio.');
  const source=form.get('source'),sample=form.get('consented_sample'),modelId=String(form.get('model_id')||''),owner=String(form.get('owner')||'');
  if(!(source instanceof Blob)||!(sample instanceof Blob)||!modelId)throw new Error('Fish voice adapter received an incomplete request.');
  const cached=transcriptCache.get(modelId);
  const [sourceText,sampleText]=await Promise.all([transcribe(source,'source.webm'),cached?Promise.resolve(cached):transcribe(sample,'sample.webm')]);
  if(!cached)transcriptCache.set(modelId,sampleText);
  const referenceId=await ensurePersistentVoice(Buffer.from(await sample.arrayBuffer()),sampleText),response=await persistentTts(sourceText,referenceId);
  const audio=Buffer.from(await response.arrayBuffer());if(!audio.length)throw new Error('Fish Audio returned empty audio.');
  return new Response(watermarkMp3(audio,modelId,owner),{status:200,headers:{'content-type':'audio/mpeg','x-ai-watermarked':'true','cache-control':'no-store'}});
}

if(fishKey){
  process.env.ELEVENLABS_API_KEY='';
  process.env.GEMINI_TRANSCRIBE_MODEL=process.env.GEMINI_TRANSCRIBE_MODEL||'gemini-3.8-flash';
  process.env.VOICE_CLONE_ENDPOINT='fish://voice-clone';
  globalThis.fetch=routedFetch;
  console.log('Singer voice provider: Fish Audio persistent clone (Gemini transcription preferred)');
}
const {createChat}=await import('./server.js');
const {server}=createChat();
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log(`Live Chat: http://localhost:${process.env.PORT||3000}`));