import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const nativeFetch=globalThis.fetch.bind(globalThis);
const elevenKey=process.env.ELEVENLABS_API_KEY||'';
const performanceVoiceIds=new Map();
const provisioning=new Map();
const voiceMapFile=process.env.PERFORMANCE_VOICE_MAP_FILE||'/app/data/performance-voice-map.json';
let voiceMapLoaded=false;

function audioType(audio){
  const b=Buffer.from(audio);
  if(b.length>=4&&b.subarray(0,4).toString('ascii')==='RIFF')return['audio/wav','.wav'];
  if(b.length>=4&&b.subarray(0,4).toString('ascii')==='OggS')return['audio/ogg','.ogg'];
  if(b.length>=3&&b.subarray(0,3).toString('ascii')==='ID3')return['audio/mpeg','.mp3'];
  if(b.length>=2&&b[0]===0xff&&(b[1]&0xe0)===0xe0)return['audio/mpeg','.mp3'];
  if(b.length>=4&&b[0]===0x1a&&b[1]===0x45&&b[2]===0xdf&&b[3]===0xa3)return['audio/webm','.webm'];
  if(b.length>=12&&b.subarray(4,8).toString('ascii')==='ftyp')return['audio/mp4','.m4a'];
  return['audio/webm','.webm'];
}
function syncSafe(size){return Buffer.from([(size>>21)&127,(size>>14)&127,(size>>7)&127,size&127]);}
function watermarkMp3(audio,model){
  const value=Buffer.from(`Live Chat AI voice clone | model=${model.id} | owner=${model.owner} | generated=${new Date().toISOString()}`,'utf8');
  const payload=Buffer.concat([Buffer.from([3]),Buffer.from('AI_GENERATED\0','utf8'),value]);
  const frameHeader=Buffer.alloc(10);frameHeader.write('TXXX',0,'ascii');frameHeader.writeUInt32BE(payload.length,4);
  const frame=Buffer.concat([frameHeader,payload]);
  return Buffer.concat([Buffer.from('ID3\x03\x00\x00','binary'),syncSafe(frame.length),frame,Buffer.from(audio)]);
}
async function loadVoiceMap(){
  if(voiceMapLoaded)return;voiceMapLoaded=true;
  try{const data=JSON.parse(await readFile(voiceMapFile,'utf8'));for(const [key,id] of Object.entries(data))if(typeof id==='string'&&id)performanceVoiceIds.set(key,id);}catch{}
}
async function saveVoiceMap(){
  try{await mkdir(dirname(voiceMapFile),{recursive:true});await writeFile(voiceMapFile,JSON.stringify(Object.fromEntries(performanceVoiceIds)),'utf8');}
  catch(error){console.warn('Could not persist performance voice map:',error.message);}
}
function providerMessage(data,status){
  const detail=typeof data?.detail==='string'?data.detail:data?.detail?.message||data?.message||data?.error||'';
  if(status===401||status===402||/instant voice cloning|subscription|upgrade your plan|starter plan/i.test(detail)){
    return 'Custom voice recording now uses audio-to-audio conversion only. The connected ElevenLabs plan does not allow creating this cloned target voice; enable Instant Voice Cloning (Starter or above) or configure PERFORMANCE_VOICE_ENDPOINT. No text-to-speech fallback was used.';
  }
  return String(detail||'Audio-to-audio voice provider failed.').slice(0,300);
}
async function ensurePerformanceVoice(model,sample,sampleMime){
  if(!elevenKey)throw Object.assign(new Error('Audio-to-audio custom voice conversion is not configured. Add ELEVENLABS_API_KEY or PERFORMANCE_VOICE_ENDPOINT.'),{statusCode:503});
  await loadVoiceMap();
  const raw=Buffer.from(sample),key=model.id+':'+createHash('sha256').update(raw).digest('hex');
  if(performanceVoiceIds.has(key))return performanceVoiceIds.get(key);
  if(provisioning.has(key))return provisioning.get(key);
  const task=(async()=>{
    const [,ext]=audioType(raw),form=new FormData();
    form.append('name',(model.name||'Live Rooms Voice').slice(0,40));
    form.append('description','Consented Live Rooms custom voice owned by @'+model.owner+'. Used for audio-to-audio voice conversion.');
    form.append('remove_background_noise','false');
    form.append('files',new Blob([raw],{type:sampleMime||audioType(raw)[0]}),'sample'+ext);
    const response=await nativeFetch('https://api.elevenlabs.io/v1/voices/add',{
      method:'POST',signal:AbortSignal.timeout(120000),headers:{'xi-api-key':elevenKey},body:form
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.voice_id)throw Object.assign(new Error(providerMessage(data,response.status)),{statusCode:response.status===429?429:503});
    performanceVoiceIds.set(key,data.voice_id);await saveVoiceMap();
    console.log('Audio-to-audio target voice ready:',String(data.voice_id).slice(0,8));
    return data.voice_id;
  })().finally(()=>provisioning.delete(key));
  provisioning.set(key,task);return task;
}
async function externalPerformanceClone({source,mime,model,sample,sampleMime}){
  const form=new FormData();
  form.append('source',new Blob([source],{type:mime}),'source'+audioType(source)[1]);
  form.append('consented_sample',new Blob([sample],{type:sampleMime||audioType(sample)[0]}),'sample'+audioType(sample)[1]);
  form.append('model_id',model.id);form.append('owner',model.owner);
  const response=await nativeFetch(process.env.PERFORMANCE_VOICE_ENDPOINT,{
    method:'POST',signal:AbortSignal.timeout(180000),
    headers:{...(process.env.PERFORMANCE_VOICE_API_KEY?{Authorization:'Bearer '+process.env.PERFORMANCE_VOICE_API_KEY}:{})},body:form
  });
  if(!response.ok)throw Object.assign(new Error('Audio-to-audio custom voice conversion failed.'),{statusCode:response.status===429?429:502});
  const outputMime=response.headers.get('content-type')?.split(';')[0]?.toLowerCase()||'audio/mpeg';
  const output=Buffer.from(await response.arrayBuffer());if(!output.length)throw Object.assign(new Error('Audio-to-audio converter returned empty audio.'),{statusCode:502});
  if(outputMime==='audio/mpeg')return{buffer:watermarkMp3(output,model),mime:'audio/mpeg',watermarked:true};
  if(response.headers.get('x-ai-watermarked')!=='true')throw Object.assign(new Error('Audio-to-audio converter did not confirm the required AI watermark.'),{statusCode:502});
  return{buffer:output,mime:outputMime,watermarked:true};
}
async function elevenPerformanceClone({source,mime,model,sample,sampleMime}){
  const voiceId=await ensurePerformanceVoice(model,sample,sampleMime),form=new FormData();
  form.append('audio',new Blob([source],{type:mime}),'source'+audioType(source)[1]);
  form.append('model_id','eleven_multilingual_sts_v2');
  form.append('remove_background_noise','false');
  const response=await nativeFetch('https://api.elevenlabs.io/v1/speech-to-speech/'+encodeURIComponent(voiceId)+'?output_format=mp3_44100_128',{
    method:'POST',signal:AbortSignal.timeout(180000),headers:{'xi-api-key':elevenKey},body:form
  });
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error(providerMessage(data,response.status)),{statusCode:response.status===429?429:502});}
  const audio=Buffer.from(await response.arrayBuffer());if(!audio.length)throw Object.assign(new Error('Audio-to-audio converter returned empty audio.'),{statusCode:502});
  return{buffer:watermarkMp3(audio,model),mime:'audio/mpeg',watermarked:true};
}
async function audioToAudioVoiceClone(args){
  console.log('Custom voice mode: strict audio-to-audio (pitch/timing performance preserved; no transcription/TTS path)');
  if(process.env.PERFORMANCE_VOICE_ENDPOINT)return externalPerformanceClone(args);
  return elevenPerformanceClone(args);
}

const {createChat}=await import('./server.js');
const {server}=createChat({voiceClone:audioToAudioVoiceClone});
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log(`Live Chat: http://localhost:${process.env.PORT||3000}`));
