const nativeFetch=globalThis.fetch.bind(globalThis);
const fishKey=process.env.FISH_AUDIO_API_KEY||process.env.FISH_API_KEY||'';
const transcriptCache=new Map();

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
async function routedFetch(input,init={}){
  const url=String(input);
  if(url==='fish://voice-clone')return fishClone(init.body);
  if(url.startsWith('https://generativelanguage.googleapis.com/')&&typeof init.body==='string'){
    try{const parsed=normalizeGeminiBody(JSON.parse(init.body));return nativeFetch(input,{...init,body:JSON.stringify(parsed)});}catch{}
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
  const referenceAudio=Buffer.from(await sample.arrayBuffer());
  const payload=pack({text:sourceText,references:[{audio:referenceAudio,text:sampleText}],format:'mp3',latency:'normal'});
  const response=await nativeFetch('https://api.fish.audio/v1/tts',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${fishKey}`,'Content-Type':'application/msgpack',model:process.env.FISH_AUDIO_MODEL||'s2.1-pro-free'},body:payload});
  if(!response.ok){await fishText(response,'Fish Audio voice cloning');}
  const audio=Buffer.from(await response.arrayBuffer());if(!audio.length)throw new Error('Fish Audio returned empty audio.');
  return new Response(watermarkMp3(audio,modelId,owner),{status:200,headers:{'content-type':'audio/mpeg','x-ai-watermarked':'true','cache-control':'no-store'}});
}

if(fishKey){
  process.env.ELEVENLABS_API_KEY='';
  process.env.GEMINI_TRANSCRIBE_MODEL=process.env.GEMINI_TRANSCRIBE_MODEL||'gemini-3.8-flash';
  process.env.VOICE_CLONE_ENDPOINT='fish://voice-clone';
  globalThis.fetch=routedFetch;
  console.log('Singer voice provider: Fish Audio (Gemini transcription preferred)');
}
const {createChat}=await import('./server.js');
const {server}=createChat();
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log(`Live Chat: http://localhost:${process.env.PORT||3000}`));