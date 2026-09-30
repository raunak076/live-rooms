import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { io as client } from 'socket.io-client';
import { createChat } from '../server.js';
const rpc=(s,event,payload={})=>new Promise((resolve,reject)=>s.timeout(3000).emit(event,payload,(e,r)=>e?reject(e):resolve(r)));
test('history survives 100 messages; pagination, privacy, group control, mute, delivery and recovery',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'chat-upgrades-')),dbPath=join(folder,'chat.db'),pushes=[];
  const chat=createChat({dbPath,pushNotification:async(_sub,p)=>pushes.push(p)});await new Promise(resolve=>chat.server.listen(0,resolve));
  const url='http://localhost:'+chat.server.address().port,sockets=[];let db;
  async function user(name,register=true,password='strong-password'){const s=client(url,{transports:['websocket'],forceNew:true});sockets.push(s);await once(s,'connect');const auth=await rpc(s,'auth',{username:name,password,register});return {s,auth};}
  try{
    const a=await user('alice'),b=await user('bob'),e=await user('eve');db=new DatabaseSync(dbPath);
    const {room}=await rpc(a.s,'enter',{roomName:'Group'});await rpc(b.s,'enter',{roomId:room.id});
    // Seed prior history, then send through the real handler to catch destructive pruning.
    for(let n=0;n<135;n++){const message={id:'old-'+n,roomId:room.id,name:'alice',senderId:'alice',text:'history '+n,kind:'user',at:Date.now()-10000+n};db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(message.id,room.id,JSON.stringify(message),message.at);}
    const sent=await rpc(a.s,'send',{roomId:room.id,text:'latest',clientId:'new-1'});assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE room_id=?').get(room.id).n,136);
    const snap=(await rpc(a.s,'enter',{roomId:room.id})).room;assert.equal(snap.messages.length,100);assert.equal(snap.hasMore,true);
    const older=await rpc(a.s,'messages:history',{roomId:room.id,before:snap.messages[0].id});assert.equal(older.messages.length,36);assert.equal(older.messages[0].id,'old-0');assert.equal(older.hasMore,false);
    assert.ok((await rpc(e.s,'messages:history',{roomId:room.id})).error);
    await rpc(b.s,'delete',{id:'old-0',scope:'me'});const search=await rpc(b.s,'messages:history',{roomId:room.id,query:'history 0'});assert.equal(search.messages.length,0);
    assert.equal((await rpc(a.s,'message:star',{id:'old-0',starred:true})).message.starred,true);
    assert.equal((await rpc(a.s,'messages:history',{roomId:room.id,starred:true})).messages.length,1);
    assert.equal((await rpc(b.s,'messages:history',{roomId:room.id,starred:true})).messages.length,0);
    const delivered=once(a.s,'message:delivered');await rpc(b.s,'message:delivered',{id:sent.message.id});assert.equal((await delivered)[0].username,'bob');assert.deepEqual((await rpc(a.s,'enter',{roomId:room.id})).room.messages.at(-1).deliveredTo,['bob']);
    const info=(await rpc(a.s,'chat:info',{roomId:room.id})).info;assert.equal(info.owner,'alice');assert.equal(info.people.length,2);
    assert.ok((await rpc(b.s,'group:update',{roomId:room.id,action:'remove',username:'alice'})).error);
    assert.equal((await rpc(a.s,'group:update',{roomId:room.id,action:'rename',name:'Renamed'})).info.name,'Renamed');
    const rotated=await rpc(a.s,'group:update',{roomId:room.id,action:'invite'});assert.notEqual(rotated.info.inviteCode,info.inviteCode);
    assert.ok((await rpc(e.s,'enter',{roomId:info.inviteCode})).error);assert.ok((await rpc(e.s,'enter',{roomId:room.id})).error);
    assert.equal((await rpc(e.s,'enter',{roomId:rotated.info.inviteCode})).room.id,room.id);
    await rpc(a.s,'group:update',{roomId:room.id,action:'remove',username:'eve'});assert.ok((await rpc(e.s,'send',{roomId:room.id,text:'denied',clientId:'denied'})).error);
    await fetch(url+'/api/push/subscribe',{method:'POST',headers:{Authorization:'Bearer '+b.auth.token,'Content-Type':'application/json'},body:JSON.stringify({endpoint:'https://push.example/test',keys:{p256dh:'test',auth:'test'}})});
    await rpc(b.s,'chat:mute',{roomId:room.id,hours:1});const beforePush=pushes.length;await rpc(a.s,'send',{roomId:room.id,text:'muted',clientId:'muted'});await new Promise(resolve=>setImmediate(resolve));assert.equal(pushes.length,beforePush);
    await rpc(b.s,'chat:mute',{roomId:room.id,hours:0});await rpc(a.s,'send',{roomId:room.id,text:'unmuted',clientId:'unmuted'});await new Promise(resolve=>setImmediate(resolve));assert.ok(pushes.some(p=>p.body==='unmuted'));
    const privateRoom=(await rpc(a.s,'direct',{username:'bob'})).room;const forwarded=await rpc(a.s,'message:forward',{id:'old-1',roomId:privateRoom.id,clientId:'forward'});assert.equal(forwarded.message.forwarded,true);assert.equal((await rpc(a.s,'message:forward',{id:'old-1',roomId:privateRoom.id,clientId:'forward'})).message.id,forwarded.message.id);
    const doc=await fetch(url+'/api/media/'+privateRoom.id,{method:'POST',headers:{Authorization:'Bearer '+a.auth.token,'Content-Type':'application/pdf','X-File-Name':'notes.pdf'},body:Buffer.from('%PDF-1.4 example')});assert.equal(doc.status,201);const attachment=(await doc.json()).message.attachment;assert.equal(attachment.type,'document');
    const download=await fetch(url+'/api/media/'+attachment.id,{headers:{Authorization:'Bearer '+b.auth.token}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);
    assert.equal((await fetch(url+'/api/media/'+attachment.id,{headers:{Authorization:'Bearer '+e.auth.token}})).status,404);
    const documentMessage=db.prepare('SELECT message_id FROM media WHERE id=?').get(attachment.id).message_id;const forwardedDoc=await rpc(a.s,'message:forward',{id:documentMessage,roomId:room.id,clientId:'forward-doc'});assert.equal(forwardedDoc.message.attachment.type,'document');assert.notEqual(forwardedDoc.message.attachment.id,attachment.id);assert.equal((await fetch(url+'/api/media/'+forwardedDoc.message.attachment.id,{headers:{Authorization:'Bearer '+b.auth.token}})).status,200);
    const call=await rpc(a.s,'call:join',{roomId:privateRoom.id});const declined=once(a.s,'call:declined');const decline=await fetch(url+'/api/calls/decline',{method:'POST',headers:{Authorization:'Bearer '+b.auth.token,'Content-Type':'application/json'},body:JSON.stringify({roomId:privateRoom.id,callId:call.callId})});assert.equal((await decline.json()).ok,true);assert.equal((await declined)[0].by,'bob');
    assert.ok((await rpc(a.s,'account:recovery-code',{password:'wrong'})).error);const code=(await rpc(a.s,'account:recovery-code',{password:'strong-password'})).code;assert.equal(code.length,48);
    const anon=client(url,{transports:['websocket'],forceNew:true});sockets.push(anon);await once(anon,'connect');assert.ok((await rpc(anon,'account:recover',{username:'alice',code:'wrong',password:'new-password'})).error);
    assert.equal((await rpc(anon,'account:recover',{username:'alice',code,password:'new-password'})).ok,true);assert.ok((await rpc(anon,'account:recover',{username:'alice',code,password:'another-password'})).error);
    await new Promise(resolve=>setTimeout(resolve,80));assert.equal((await fetch(url+'/api/sync',{headers:{Authorization:'Bearer '+a.auth.token}})).status,401);
    const newAlice=await user('alice',false,'new-password');assert.equal(newAlice.auth.user,'alice');
    const staleCode=(await rpc(newAlice.s,'account:recovery-code',{password:'new-password'})).code;assert.equal((await rpc(newAlice.s,'account:delete',{password:'new-password'})).ok,true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recovery_codes WHERE username=?').get('alice').n,0);assert.equal((await rpc(b.s,'chat:info',{roomId:room.id})).info.owner,'bob');
    const replacement=await user('alice');assert.equal(replacement.auth.user,'alice');assert.ok((await rpc(anon,'account:recover',{username:'alice',code:staleCode,password:'hijack-password'})).error);
  }finally{db?.close();for(const s of sockets)s.disconnect();await new Promise(resolve=>chat.io.close(resolve));rmSync(folder,{recursive:true,force:true});}
});
