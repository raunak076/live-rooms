import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as client } from 'socket.io-client';
import { createChat,askGemini } from '../server.js';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const rpc=(s,event,payload)=>new Promise((resolve,reject)=>s.timeout(2000).emit(event,payload,(e,r)=>e?reject(e):resolve(r)));
async function connect(port){const s=client('http://localhost:'+port,{transports:['websocket'],forceNew:true});await once(s,'connect');return s;}

test('real-time delivery, DM isolation, ownership, deduplication, AI routing and persistence',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'live-rooms-'));const dbPath=join(folder,'test.db');let aiCalls=0;const pushes=[];
  let chat=createChat({dbPath,pushNotification:async(subscription,payload)=>{pushes.push({subscription,payload});},generate:async history=>{aiCalls++;assert.match(history.at(-1).text,/@gemini/);return 'Mocked AI answer';}});
  await new Promise(r=>chat.server.listen(0,r));const port=chat.server.address().port;
  const sockets=[];
  try{
    const alice=await connect(port),bob=await connect(port),eve=await connect(port);sockets.push(alice,bob,eve);
    assert.match((await rpc(eve,'enter',{roomName:'Denied'})).error,/sign in/);
    const a=await rpc(alice,'auth',{username:'alice',password:'strong-password',register:true});assert.equal(a.user,'alice');
    const b=await rpc(bob,'auth',{username:'bob',password:'strong-password',register:true});const e=await rpc(eve,'auth',{username:'eve',password:'strong-password',register:true});
    const {room}=await rpc(alice,'enter',{roomName:'Engineering'});await rpc(bob,'enter',{roomId:room.id});
    const keyResponse=await fetch('http://localhost:'+port+'/api/push/public-key');assert.equal(keyResponse.status,200);assert.ok((await keyResponse.json()).publicKey);
    const subscribed=await fetch('http://localhost:'+port+'/api/push/subscribe',{method:'POST',headers:{Authorization:'Bearer '+b.token,'Content-Type':'application/json'},body:JSON.stringify({endpoint:'https://push.example/bob',keys:{p256dh:'test-key',auth:'test-auth'}})});assert.equal(subscribed.status,200);
    const ringing=once(bob,'call:ring');const aliceCall=await rpc(alice,'call:join',{roomId:room.id});assert.equal((await ringing)[0].callId,aliceCall.callId);
    await new Promise(resolve=>setImmediate(resolve));assert.ok(pushes.some(item=>item.payload.type==='call'&&item.payload.callId===aliceCall.callId));
    const bobCall=await rpc(bob,'call:join',{roomId:room.id});assert.equal(bobCall.participants[0].username,'alice');
    const relayed=once(alice,'call:signal');await rpc(bob,'call:signal',{roomId:room.id,callId:bobCall.callId,target:bobCall.participants[0].socketId,signal:{description:{type:'offer',sdp:'test'}}});assert.equal((await relayed)[0].user,'bob');
    assert.match((await rpc(eve,'call:join',{roomId:room.id})).error,/Join/);await rpc(alice,'call:leave',{roomId:room.id});const callEnded=once(alice,'call:ended');await rpc(bob,'call:leave',{roomId:room.id});assert.equal((await callEnded)[0].callId,aliceCall.callId);
    const arrival=once(bob,'message');const sent=await rpc(alice,'send',{roomId:room.id,text:'hello',clientId:'hello-1'});assert.equal((await arrival)[0].text,'hello');
    await new Promise(resolve=>setImmediate(resolve));assert.ok(pushes.some(item=>item.payload.type==='message'&&item.payload.body==='hello'));
    assert.equal(aiCalls,0);
    const dup=await rpc(alice,'send',{roomId:room.id,text:'hello',clientId:'hello-1'});assert.equal(dup.message.id,sent.message.id);
    assert.match((await rpc(bob,'delete',{id:sent.message.id})).error,/own messages/);
    const deleted=once(bob,'deleted');assert.equal((await rpc(alice,'delete',{id:sent.message.id})).ok,true);assert.equal((await deleted)[0].deleted,true);
    const mediaArrival=once(bob,'message');const uploaded=await fetch('http://localhost:'+port+'/api/media/'+room.id,{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'image/png','X-File-Name':encodeURIComponent('tiny.png')},body:Buffer.from([137,80,78,71,13,10,26,10])});assert.equal(uploaded.status,201);const mediaMessage=(await uploaded.json()).message;assert.equal((await mediaArrival)[0].attachment.type,'image');
    const mediaRead=await fetch('http://localhost:'+port+'/api/media/'+mediaMessage.attachment.id,{headers:{Authorization:'Bearer '+b.token}});assert.equal(mediaRead.status,200);assert.deepEqual(Buffer.from(await mediaRead.arrayBuffer()),Buffer.from([137,80,78,71,13,10,26,10]));
    const deniedMedia=await fetch('http://localhost:'+port+'/api/media/'+mediaMessage.attachment.id,{headers:{Authorization:'Bearer '+e.token}});assert.equal(deniedMedia.status,404);
    assert.equal((await rpc(alice,'delete',{id:mediaMessage.id})).ok,true);assert.equal((await fetch('http://localhost:'+port+'/api/media/'+mediaMessage.attachment.id,{headers:{Authorization:'Bearer '+b.token}})).status,404);
    const aiReply=new Promise(resolve=>bob.on('message',m=>{if(m.kind==='ai')resolve(m);}));
    await rpc(alice,'send',{roomId:room.id,text:'@gemini help us',clientId:'ai-1'});assert.equal((await aiReply).text,'Mocked AI answer');assert.equal(aiCalls,1);
    const dm=(await rpc(alice,'direct',{username:'bob'})).room;assert.equal(dm.direct,true);
    assert.match((await rpc(eve,'enter',{roomId:dm.id})).error,/not found/);
    assert.match((await rpc(eve,'send',{roomId:dm.id,text:'intrusion',clientId:'bad'})).error,/Join/);
    const dmArrival=once(bob,'message');await rpc(alice,'send',{roomId:dm.id,text:'private hello',clientId:'dm-1'});assert.equal((await dmArrival)[0].text,'private hello');
    const another=await connect(port);sockets.push(another);assert.equal((await rpc(another,'auth',{token:a.token})).user,'alice');
    const history=(await rpc(another,'enter',{roomId:room.id})).room.messages;assert.equal(history.filter(m=>m.id===sent.message.id).length,1);assert.equal(history[0].deleted,true);
    for(const s of sockets)s.disconnect();await new Promise(r=>chat.io.close(r));
    chat=createChat({dbPath});await new Promise(r=>chat.server.listen(0,r));
    const restored=await connect(chat.server.address().port);sockets.push(restored);assert.equal((await rpc(restored,'auth',{token:a.token})).user,'alice');
    assert.equal((await rpc(restored,'enter',{roomId:dm.id})).room.messages[0].text,'private hello');
    const health=await fetch('http://localhost:'+chat.server.address().port+'/api/health');assert.equal(health.status,200);
    const page=await fetch('http://localhost:'+chat.server.address().port);assert.match(await page.text(),/Your people/);
  }finally{for(const s of sockets)s.disconnect();await new Promise(r=>chat.io.close(r));rmSync(folder,{recursive:true,force:true});}
});
test('missing Gemini key is a clear error',async()=>{const key=process.env.GEMINI_API_KEY;delete process.env.GEMINI_API_KEY;try{await assert.rejects(askGemini([]),/not configured/);}finally{if(key)process.env.GEMINI_API_KEY=key;}});
