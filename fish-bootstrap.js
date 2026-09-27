import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const nativeFetch=globalThis.fetch.bind(globalThis);
const hfSpace=(process.env.HF_SEED_VC_URL||'https://plachta-seed-vc.hf.space').replace(/\/$/,'');
const hfToken=process.env.HF_TOKEN||'';
let predictArity=0;

function audioType(audio){
  const b=Buffer.from(audio);
  if(b.length>=4&&b.subarray(0,4).toString('ascii')==='RIFF')return['audio/wav','.wav'];
  if(b.length>=4&&b.subarray(0,4).toString('ascii')==='OggS')return['audio/ogg','.ogg'];
  if(b.length>=3&&b.subarray(0,3).toString('ascii')==='ID3')return['audio/mpeg','.mp3'];
  if(b.length>=2&&b[0]===0xff&&(b[1]&0xe0)===0xe0)return['audio/mpeg','.mp3'];
  if(b.length>=4&&b[0]===0x1a&&b[1]===0x45&&b[2]===0xdf&&b[3]===0xa3)return['audio/webm','.webm'];
  if(b.length>=12&&b.subarray(4,8).toString('ascii')==='ftyp')return['audio/mp4','.m4a'];
  return['application/octet-stream','.bin'];
}
function syncSafe(size){return Buffer.from([(size>>21)&127,(size>>14)&127,(size>>7)&127,size&127]);}
function watermarkText(model){return `Live Chat AI voice clone | model=${model.id} | owner=${model.owner} | generated=${new Date().toISOString()}`;}
function watermarkMp3(audio,model){
  const value=Buffer.from(watermarkText(model),'utf8');
  const payload=Buffer.concat([Buffer.from([3]),Buffer.from('AI_GENERATED\0','utf8'),value]);
  const frameHeader=Buffer.alloc(10);frameHeader.write('TXXX',0,'ascii');frameHeader.writeUInt32BE(payload.length,4);
  const frame=Buffer.concat([frameHeader,payload]);
  return Buffer.concat([Buffer.from('ID3\x03\x00\x00','binary'),syncSafe(frame.length),frame,Buffer.from(audio)]);
}
function watermarkWav(audio,model){
  const input=Buffer.from(audio);
  if(input.length<12||input.subarray(0,4).toString('ascii')!=='RIFF'||input.subarray(8,12).toString('ascii')!=='WAVE')return null;
  const text=Buffer.from(watermarkText(model)+'\0','utf8');
  const padded=text.length%2?Buffer.concat([text,Buffer.from([0])]):text;
  const icmt=Buffer.alloc(8);icmt.write('ICMT',0,'ascii');icmt.writeUInt32LE(text.length,4);
  const infoPayload=Buffer.concat([Buffer.from('INFO','ascii'),icmt,padded]);
  const list=Buffer.alloc(8);list.write('LIST',0,'ascii');list.writeUInt32LE(infoPayload.length,4);
  const output=Buffer.concat([input,list,infoPayload]);output.writeUInt32LE(output.length-8,4);return output;
}
function hfHeaders(extra={}){return{...extra,...(hfToken?{Authorization:'Bearer '+hfToken}:{})};}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function fetchRetry(url,options={},attempts=3){
  let lastError;
  for(let attempt=0;attempt<attempts;attempt++){
    try{
      const response=await nativeFetch(url,options);
      if(response.ok||![502,503,504].includes(response.status))return response;
      lastError=new Error('Seed-VC service is waking up.');
    }catch(error){lastError=error;}
    if(attempt<attempts-1)await delay(2500*(attempt+1));
  }
  throw lastError||new Error('Seed-VC service is unavailable.');
}
async function normalizeWav(buffer){
  const raw=Buffer.from(buffer),[mime,ext]=audioType(raw);if(mime==='audio/wav')return raw;
  const dir=await mkdtemp(join(tmpdir(),'live-rooms-vc-')),input=join(dir,'input'+ext),output=join(dir,'output.wav');
  try{
    await writeFile(input,raw);
    await new Promise((resolve,reject)=>{
      const process=spawn('ffmpeg',['-y','-hide_banner','-loglevel','error','-i',input,'-vn','-ac','1','-ar','44100',output]);let stderr='';
      process.stderr.on('data',chunk=>stderr+=chunk.toString());process.on('error',reject);process.on('close',code=>code===0?resolve():reject(new Error(('Audio conversion failed. '+stderr).trim().slice(0,240))));
    });
    return await readFile(output);
  }finally{await rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
async function uploadGradio(buffer,name){
  const form=new FormData();form.append('files',new Blob([buffer],{type:'audio/wav'}),name);
  const response=await fetchRetry(hfSpace+'/gradio_api/upload',{method:'POST',signal:AbortSignal.timeout(90000),headers:hfHeaders(),body:form});
  const data=await response.json().catch(()=>null);const path=Array.isArray(data)?data[0]:data?.files?.[0];
  if(!response.ok||!path)throw new Error('Free Seed-VC could not accept the audio sample.');
  return{path,orig_name:name,mime_type:'audio/wav',is_stream:false,meta:{_type:'gradio.FileData'}};
}
async function getPredictArity(){
  if(predictArity)return predictArity;
  try{
    const response=await fetchRetry(hfSpace+'/gradio_api/info',{signal:AbortSignal.timeout(45000),headers:hfHeaders()},2),info=await response.json();
    const endpoint=info?.named_endpoints?.['/predict']||info?.named_endpoints?.predict;
    predictArity=endpoint?.parameters?.length||0;
  }catch{}
  return predictArity;
}
function parseSse(text){
  let complete=null,errorText='';
  for(const block of text.split(/\r?\n\r?\n/)){
    const lines=block.split(/\r?\n/),event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim(),dataText=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
    if(event==='complete'&&dataText){try{complete=JSON.parse(dataText);}catch{complete=dataText;}}
    if(event==='error'&&dataText)errorText=dataText;
  }
  if(errorText)throw new Error(('Free Seed-VC error: '+errorText).slice(0,300));
  if(complete===null)throw new Error('Free Seed-VC returned no completed audio.');
  return complete;
}
function collectAudioUrls(value,urls=[]){
  if(!value)return urls;
  if(typeof value==='string'){if(/^https?:\/\//i.test(value))urls.push(value);return urls;}
  if(Array.isArray(value)){for(const item of value)collectAudioUrls(item,urls);return urls;}
  if(typeof value==='object'){
    if(typeof value.url==='string'&&/^https?:\/\//i.test(value.url))urls.push(value.url);
    else if(typeof value.path==='string'&&value.path.startsWith('/'))urls.push(hfSpace+'/gradio_api/file='+encodeURI(value.path));
    for(const [key,item] of Object.entries(value))if(key!=='url'&&key!=='path')collectAudioUrls(item,urls);
  }
  return urls;
}
async function callSeedVc(sourceFile,targetFile,args){
  const response=await fetchRetry(hfSpace+'/gradio_api/call/predict',{method:'POST',signal:AbortSignal.timeout(60000),headers:hfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data:[sourceFile,targetFile,...args]})},2);
  const submitted=await response.json().catch(()=>({}));
  if(!response.ok||!submitted.event_id)throw new Error(String(submitted?.detail||submitted?.error||'Free Seed-VC request could not start.').slice(0,300));
  const resultResponse=await nativeFetch(hfSpace+'/gradio_api/call/predict/'+encodeURIComponent(submitted.event_id),{signal:AbortSignal.timeout(300000),headers:hfHeaders({'Accept':'text/event-stream'})});
  const resultText=await resultResponse.text();if(!resultResponse.ok)throw new Error('Free Seed-VC request failed.');return parseSse(resultText);
}
async function freeSeedVoiceClone({source,model,sample}){
  console.log('Custom voice provider: Seed-VC ZeroGPU (free audio-to-audio singing conversion)');
  const [sourceWav,targetWav]=await Promise.all([normalizeWav(source),normalizeWav(sample)]);
  const [sourceFile,targetFile]=await Promise.all([uploadGradio(sourceWav,'source.wav'),uploadGradio(targetWav,'reference.wav')]);
  const arity=await getPredictArity(),args8=[25,1.0,0.7,true,false,0],args9=[25,1.0,0.7,3,true,false,0];
  let result;
  try{result=await callSeedVc(sourceFile,targetFile,arity===9?args9:args8);}
  catch(error){if(arity===8||arity===9)throw error;result=await callSeedVc(sourceFile,targetFile,args9);}
  const urls=collectAudioUrls(result),url=urls.at(-1);if(!url)throw new Error('Free Seed-VC returned no downloadable audio.');
  const outputResponse=await nativeFetch(url,{signal:AbortSignal.timeout(90000),headers:hfHeaders()});if(!outputResponse.ok)throw new Error('Converted Seed-VC audio could not be downloaded.');
  const output=Buffer.from(await outputResponse.arrayBuffer());if(!output.length)throw new Error('Free Seed-VC returned empty audio.');
  const [outputMime]=audioType(output);
  if(outputMime==='audio/mpeg')return{buffer:watermarkMp3(output,model),mime:'audio/mpeg',watermarked:true};
  if(outputMime==='audio/wav'){const marked=watermarkWav(output,model);if(marked)return{buffer:marked,mime:'audio/wav',watermarked:true};}
  const wav=await normalizeWav(output),marked=watermarkWav(wav,model);if(!marked)throw new Error('Converted Seed-VC audio could not be watermarked.');
  return{buffer:marked,mime:'audio/wav',watermarked:true};
}
async function externalPerformanceClone({source,mime,model,sample,sampleMime}){
  const form=new FormData();
  form.append('source',new Blob([source],{type:mime}),'source'+audioType(source)[1]);
  form.append('consented_sample',new Blob([sample],{type:sampleMime||audioType(sample)[0]}),'sample'+audioType(sample)[1]);
  form.append('model_id',model.id);form.append('owner',model.owner);
  const response=await nativeFetch(process.env.PERFORMANCE_VOICE_ENDPOINT,{method:'POST',signal:AbortSignal.timeout(180000),headers:{...(process.env.PERFORMANCE_VOICE_API_KEY?{Authorization:'Bearer '+process.env.PERFORMANCE_VOICE_API_KEY}:{})},body:form});
  if(!response.ok)throw new Error('Audio-to-audio custom voice conversion failed.');
  const output=Buffer.from(await response.arrayBuffer()),[outputMime]=audioType(output);if(!output.length)throw new Error('Audio-to-audio converter returned empty audio.');
  if(outputMime==='audio/mpeg')return{buffer:watermarkMp3(output,model),mime:'audio/mpeg',watermarked:true};
  const wav=outputMime==='audio/wav'?output:await normalizeWav(output),marked=watermarkWav(wav,model);if(!marked)throw new Error('Audio-to-audio converter could not be watermarked.');
  return{buffer:marked,mime:'audio/wav',watermarked:true};
}
async function audioToAudioVoiceClone(args){
  console.log('Custom voice mode: strict audio-to-audio; no transcription/TTS and no paid API fallback');
  if(process.env.PERFORMANCE_VOICE_ENDPOINT)return externalPerformanceClone(args);
  return freeSeedVoiceClone(args);
}

const {createChat}=await import('./server.js');
const {server}=createChat({voiceClone:audioToAudioVoiceClone});
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log(`Live Chat: http://localhost:${process.env.PORT||3000}`));
