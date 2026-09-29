import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as client } from 'socket.io-client';
import { createChat } from '../server.js';

const rpc=(socket,event,payload)=>new Promise((resolve,reject)=>socket.timeout(2000).emit(event,payload,(error,result)=>error?reject(error):resolve(result)));

test('old Fish TTS handles realistic speech and preview; singing never falls back to TTS',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'live-voice-'));
  const originalFetch=globalThis.fetch,originalFish=process.env.FISH_AUDIO_API_KEY,originalGemini=process.env.GEMINI_API_KEY;
  const external=[];let singing=0,socket,chat;
  process.env.FISH_AUDIO_API_KEY='test-key';delete process.env.GEMINI_API_KEY;
  globalThis.fetch=async(input,options)=>{
    const url=String(input);
    if(url==='https://api.fish.audio/v1/asr'){external.push('asr');return Response.json({text:'Hello world'});}
    if(url==='https://api.fish.audio/v1/tts'){
      external.push('tts');assert.equal(options.headers['Content-Type'],'application/msgpack');assert.ok(options.body.length);
      return new Response(Buffer.from('ID3\x03\0\0sample','binary'),{status:200,headers:{'Content-Type':'audio/mpeg'}});
    }
    return originalFetch(input,options);
  };
  try{
    chat=createChat({dbPath:join(folder,'chat.db'),voiceClone:async({source,mode})=>{assert.equal(mode,'sur-taal');singing++;return{buffer:source,mime:'audio/webm',watermarked:true};}});
    await new Promise(resolve=>chat.server.listen(0,resolve));const port=chat.server.address().port,base='http://localhost:'+port;
    socket=client(base,{transports:['websocket'],forceNew:true});await once(socket,'connect');
    const auth=await rpc(socket,'auth',{username:'singer',password:'strong-password',register:true,accountType:'singer'});
    const room=(await rpc(socket,'enter',{roomName:'Voice room'})).room;
    const headers={Authorization:'Bearer '+auth.token,'Content-Type':'audio/webm'};
    const enrollment=await originalFetch(base+'/api/voices/enroll',{method:'POST',headers:{...headers,'X-Voice-Name':'Singer Voice','X-Voice-Consent':'singer-owned-v1'},body:Buffer.alloc(2048,7)});
    assert.equal(enrollment.status,201);const voice=(await enrollment.json()).voice;
    const url=base+'/api/voices/'+voice.id+'/clone/'+room.id;
    const speech=await originalFetch(url,{method:'POST',headers:{...headers,'X-Voice-Mode':'realistic'},body:Buffer.from([26,69,223,163])});
    assert.equal(speech.status,201);assert.equal((await speech.json()).message.attachment.voiceClone.mode,'realistic');
    assert.deepEqual(external,['asr','asr','tts']);assert.equal(singing,0);
    const preview=await originalFetch(base+'/api/voices/'+voice.id+'/preview',{method:'POST',headers:{Authorization:'Bearer '+auth.token,'Content-Type':'application/json'},body:JSON.stringify({text:'Hello world'})});
    assert.equal(preview.status,200);assert.equal((await preview.arrayBuffer()).byteLength>0,true);assert.deepEqual(external,['asr','asr','tts','tts']);
    const melody=await originalFetch(url,{method:'POST',headers:{...headers,'X-Voice-Mode':'sur-taal'},body:Buffer.from([26,69,223,163])});
    assert.equal(melody.status,201);assert.equal(singing,1);assert.deepEqual(external,['asr','asr','tts','tts']);
  }finally{
    socket?.disconnect();if(chat)await new Promise(resolve=>chat.io.close(resolve));
    globalThis.fetch=originalFetch;
    if(originalFish===undefined)delete process.env.FISH_AUDIO_API_KEY;else process.env.FISH_AUDIO_API_KEY=originalFish;
    if(originalGemini===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=originalGemini;
    rmSync(folder,{recursive:true,force:true});
  }
});

test('realistic send retries supported Gemini audio model before depleted Fish ASR',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'live-gemini-'));
  const originalFetch=globalThis.fetch,previous={fish:process.env.FISH_AUDIO_API_KEY,gemini:process.env.GEMINI_API_KEY,model:process.env.GEMINI_TRANSCRIBE_MODEL};
  const models=[];let fishAsr=0,socket,chat;
  process.env.FISH_AUDIO_API_KEY='test-fish';process.env.GEMINI_API_KEY='test-gemini';process.env.GEMINI_TRANSCRIBE_MODEL='gemini-2.5-flash';
  globalThis.fetch=async(input,options)=>{
    const url=String(input);
    if(url.includes('generativelanguage.googleapis.com/v1beta/models/')){
      const model=url.match(/models\/([^:]+):/)?.[1];models.push(model);
      const audio=JSON.parse(options.body).contents[0].parts[1].inlineData;
      assert.equal(audio.mimeType,'audio/webm');assert.ok(audio.data);
      return model==='gemini-2.5-flash'?Response.json({error:{status:'NOT_FOUND',message:'Model unavailable'}},{status:404}):Response.json({candidates:[{content:{parts:[{text:'Hello world'}]}}]});
    }
    if(url==='https://api.fish.audio/v1/asr'){fishAsr++;return Response.json({reason:'No balance'},{status:402});}
    if(url==='https://api.fish.audio/v1/tts')return new Response(Buffer.from('ID3\x03\0\0sample','binary'),{status:200});
    return originalFetch(input,options);
  };
  try{
    chat=createChat({dbPath:join(folder,'chat.db'),voiceClone:async()=>{throw Error('Wrong mode');}});
    await new Promise(resolve=>chat.server.listen(0,resolve));const base='http://localhost:'+chat.server.address().port;
    socket=client(base,{transports:['websocket'],forceNew:true});await once(socket,'connect');
    const auth=await rpc(socket,'auth',{username:'singer',password:'strong-password',register:true,accountType:'singer'});
    const room=(await rpc(socket,'enter',{roomName:'Voice room'})).room;
    const headers={Authorization:'Bearer '+auth.token,'Content-Type':'audio/webm'};
    const enrolled=await originalFetch(base+'/api/voices/enroll',{method:'POST',headers:{...headers,'X-Voice-Name':'My Voice','X-Voice-Consent':'singer-owned-v1'},body:Buffer.alloc(2048,7)});
    assert.equal(enrolled.status,201);const voice=(await enrolled.json()).voice;
    const result=await originalFetch(base+'/api/voices/'+voice.id+'/clone/'+room.id,{method:'POST',headers:{...headers,'X-Voice-Mode':'realistic'},body:Buffer.from([26,69,223,163])});
    assert.equal(result.status,201);assert.equal((await result.json()).message.attachment.voiceClone.mode,'realistic');
    assert.deepEqual(models,['gemini-2.5-flash','gemini-3.8-flash','gemini-2.5-flash','gemini-3.8-flash']);assert.equal(fishAsr,0);
  }finally{
    socket?.disconnect();if(chat)await new Promise(resolve=>chat.io.close(resolve));globalThis.fetch=originalFetch;
    for(const [key,value] of [['FISH_AUDIO_API_KEY',previous.fish],['GEMINI_API_KEY',previous.gemini],['GEMINI_TRANSCRIBE_MODEL',previous.model]])if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(folder,{recursive:true,force:true});
  }
});
