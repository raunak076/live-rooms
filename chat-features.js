import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback),digest=value=>createHash('sha256').update(value).digest('hex');

export function setupChatFeatures({db,app,io,sessionUser,hasRoom,profile,refresh,presence,endCall,append,notifyRoom,isBlocked}) {
  const run=(q,...a)=>db.prepare(q).run(...a),get=(q,...a)=>db.prepare(q).get(...a),all=(q,...a)=>db.prepare(q).all(...a);
  db.exec(`CREATE TABLE IF NOT EXISTS group_settings(room_id TEXT PRIMARY KEY,owner TEXT,invite_code TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS message_deliveries(message_id TEXT,username TEXT,at INTEGER,PRIMARY KEY(message_id,username));
    CREATE TABLE IF NOT EXISTS message_stars(message_id TEXT,username TEXT,PRIMARY KEY(message_id,username));
    CREATE TABLE IF NOT EXISTS recovery_codes(username TEXT PRIMARY KEY,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_mutes(room_id TEXT,username TEXT,until_at INTEGER,PRIMARY KEY(room_id,username));`);
  // Give existing groups a stable owner without changing membership or history.
  for(const room of all('SELECT id FROM rooms WHERE direct_key IS NULL'))ensureGroup(room.id);
  function ensureGroup(id,owner){
    let row=get('SELECT * FROM group_settings WHERE room_id=?',id);
    if(!row){owner??=get('SELECT username FROM memberships WHERE room_id=? ORDER BY rowid LIMIT 1',id)?.username;
      if(owner){run('INSERT INTO group_settings VALUES (?,?,?)',id,owner,randomBytes(18).toString('hex'));row=get('SELECT * FROM group_settings WHERE room_id=?',id);}}
    return row;
  }
  const muted=(id,user)=>Boolean(get('SELECT 1 FROM chat_mutes WHERE room_id=? AND username=? AND until_at>?',id,user,Date.now()));
  function decorate(message,user){return {...message,starred:Boolean(get('SELECT 1 FROM message_stars WHERE message_id=? AND username=?',message.id,user)),deliveredTo:all('SELECT username FROM message_deliveries WHERE message_id=?',message.id).map(row=>row.username)};}
  function groupInfo(id,user){
    const room=get('SELECT * FROM rooms WHERE id=?',id);if(!room||!hasRoom(id,user))throw new Error('Chat not found.');
    const group=room.direct_key?null:ensureGroup(id);
    return {id,name:room.name,direct:Boolean(room.direct_key),owner:group?.owner,inviteCode:group?.invite_code,
      mutedUntil:get('SELECT until_at FROM chat_mutes WHERE room_id=? AND username=?',id,user)?.until_at||0,
      people:all('SELECT username FROM memberships WHERE room_id=?',id).map(row=>profile(row.username)).filter(Boolean)};
  }
  function history(id,user,{before,query='',starred=false}={}){
    if(!hasRoom(id,user))throw new Error('Join this chat first.');
    let where='m.room_id=? AND m.id NOT IN (SELECT message_id FROM message_hides WHERE username=?)',args=[id,user];
    if(before){const cursor=get('SELECT rowid,at FROM messages WHERE id=? AND room_id=?',before,id);if(!cursor)throw new Error('Message cursor not found.');where+=' AND (m.at<? OR (m.at=? AND m.rowid<?))';args.push(cursor.at,cursor.at,cursor.rowid);}
    const needle=String(query).trim().toLowerCase().slice(0,120);
    if(needle){where+=" AND COALESCE(json_extract(m.body,'$.deleted'),0)=0 AND instr(lower(COALESCE(json_extract(m.body,'$.text'),'') || ' ' || COALESCE(json_extract(m.body,'$.attachment.name'),'')),?)>0";args.push(needle);}
    if(starred){where+=" AND COALESCE(json_extract(m.body,'$.deleted'),0)=0 AND EXISTS(SELECT 1 FROM message_stars s WHERE s.message_id=m.id AND s.username=?)";args.push(user);}
    const rows=all('SELECT m.body FROM messages m WHERE '+where+' ORDER BY m.at DESC,m.rowid DESC LIMIT 51',...args);
    return {messages:rows.slice(0,50).reverse().map(row=>decorate(JSON.parse(row.body),user)),hasMore:rows.length>50};
  }
  app.post('/api/calls/decline',app.locals.jsonParser,(req,res)=>{
    const user=sessionUser(req);if(!user)return res.status(401).json({error:'Sign in again.'});
    if(!hasRoom(req.body?.roomId,user))return res.status(403).json({error:'Chat not found.'});
    // The socket handler also verifies the exact call ID; share that operation.
    res.json({ok:decline(req.body.roomId,req.body.callId,user)});
  });
  let decline=()=>false;
  function register(baseHandler,socket,joinUser){
    const handler=(event,fn,options)=>baseHandler(event,async(p,ack)=>{try{await fn(p,ack);}catch(error){ack({error:error.code?'Request failed. Please try again.':error.message});}},options);
    const user=()=>socket.data.user;
    handler('messages:history',(p,ack)=>ack(history(p.roomId,user(),p)));
    handler('chat:info',(p,ack)=>ack({info:groupInfo(p.roomId,user())}));
    handler('chat:mute',(p,ack)=>{
      if(!hasRoom(p.roomId,user()))throw new Error('Chat not found.');
      const hours=Number(p.hours);if(![0,1,8,24,168].includes(hours))throw new Error('Choose a valid mute duration.');
      run('INSERT OR REPLACE INTO chat_mutes VALUES (?,?,?)',p.roomId,user(),hours?Date.now()+hours*3600000:0);ack({ok:true,info:groupInfo(p.roomId,user())});refresh(user());
    });
    handler('message:delivered',(p,ack)=>{
      const row=get('SELECT body FROM messages WHERE id=?',p.id);if(!row)throw new Error('Message not found.');const m=JSON.parse(row.body);
      if(!hasRoom(m.roomId,user())||m.senderId===user())return ack({ok:true});
      run('INSERT OR IGNORE INTO message_deliveries VALUES (?,?,?)',m.id,user(),Date.now());
      io.to('user:'+m.senderId).emit('message:delivered',{id:m.id,roomId:m.roomId,username:user()});ack({ok:true});
    });
    handler('message:star',(p,ack)=>{
      const row=get('SELECT body FROM messages WHERE id=?',p.id);if(!row)throw new Error('Message not found.');const m=JSON.parse(row.body);
      if(!hasRoom(m.roomId,user())||m.deleted)throw new Error('Message unavailable.');
      if(p.starred)run('INSERT OR IGNORE INTO message_stars VALUES (?,?)',p.id,user());else run('DELETE FROM message_stars WHERE message_id=? AND username=?',p.id,user());ack({message:decorate(m,user())});
    });
    handler('message:forward',(p,ack)=>{
      const row=get('SELECT body FROM messages WHERE id=?',p.id);if(!row)throw new Error('Message not found.');const m=JSON.parse(row.body);
      if(!hasRoom(m.roomId,user())||m.deleted||get('SELECT 1 FROM message_hides WHERE message_id=? AND username=?',m.id,user()))throw new Error('Message unavailable.');
      if(!hasRoom(p.roomId,user())||isBlocked(p.roomId,user()))throw new Error('Destination unavailable.');

      if(typeof p.clientId!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(p.clientId))throw new Error('Invalid message identifier.');
      const id=user()+':'+p.clientId,existing=get('SELECT body FROM messages WHERE id=?',id);
      let attachment=m.attachment?{...m.attachment}:undefined;
      if(attachment&&!existing){const media=get('SELECT * FROM media WHERE id=?',attachment.id);if(!media)throw new Error('Attachment unavailable.');attachment.id=randomUUID();run('INSERT INTO media VALUES (?,?,?,?,?,?,?,?)',attachment.id,p.roomId,user(),media.file_name,media.mime,media.original_name,media.size,id);}
      const message=existing?JSON.parse(existing.body):append(p.roomId,{id,name:user(),senderId:user(),kind:'user',text:m.text,sticker:m.sticker,stickerAsset:m.stickerAsset,attachment,forwarded:true});ack({message});
      if(!existing)void notifyRoom(p.roomId,user(),{type:'message',title:user(),body:'Forwarded a message',roomId:p.roomId,url:'/?room='+p.roomId,tag:'message-'+message.id});
    });
    handler('group:update',(p,ack)=>{
      const info=groupInfo(p.roomId,user());if(info.direct)throw new Error('This is a private chat.');
      const owner=info.owner===user();
      if(p.action!=='leave'&&!owner)throw new Error('Only the group admin can do this.');
      if(p.action==='rename'){const name=String(p.name||'').trim();if(!name||name.length>48)throw new Error('Use a group name of 1–48 characters.');run('UPDATE rooms SET name=? WHERE id=?',name,p.roomId);}
      else if(p.action==='invite'){run('UPDATE group_settings SET invite_code=? WHERE room_id=?',randomBytes(18).toString('hex'),p.roomId);run('INSERT OR REPLACE INTO settings VALUES (?,?)','invite-rotated:'+p.roomId,'1');}
      else if(p.action==='add'){if(!profile(p.username))throw new Error('Username not found.');if(info.people.length>=50)throw new Error('Group limit is 50 members.');joinUser(p.username,p.roomId);}
      else if(p.action==='remove'||p.action==='leave'){
        const target=p.action==='leave'?user():p.username;if(target===info.owner&&p.action==='remove')throw new Error('The admin can leave or transfer ownership.');
        if(!hasRoom(p.roomId,target))throw new Error('Member not found.');endCall(p.roomId,target);
        run('DELETE FROM memberships WHERE room_id=? AND username=?',p.roomId,target);
        if(target===info.owner){const next=get('SELECT username FROM memberships WHERE room_id=? ORDER BY rowid LIMIT 1',p.roomId)?.username;
          run('UPDATE group_settings SET owner=?,invite_code=? WHERE room_id=?',next||null,randomBytes(18).toString('hex'),p.roomId);}
        for(const s of io.sockets.sockets.values())if(s.data.user===target){s.leave(p.roomId);s.emit('group:removed',{roomId:p.roomId});}refresh(target);
      }else throw new Error('Unknown group action.');
      for(const member of all('SELECT username FROM memberships WHERE room_id=?',p.roomId))refresh(member.username);presence(p.roomId);
      ack({ok:true,info:hasRoom(p.roomId,user())?groupInfo(p.roomId,user()):null});
    });
    async function checkPassword(password){const row=get('SELECT salt,hash FROM users WHERE username=?',user());if(typeof password!=='string'||password.length>128||!row)throw new Error('Enter your current password.');const hash=await scrypt(password,row.salt,64);if(!timingSafeEqual(hash,Buffer.from(row.hash,'hex')))throw new Error('Current password is incorrect.');}
    async function changePassword(username,password){if(typeof password!=='string'||password.length<8||password.length>128)throw new Error('Use a password of 8–128 characters.');const salt=randomBytes(16).toString('hex'),hash=await scrypt(password,salt,64);run('UPDATE users SET salt=?,hash=? WHERE username=?',salt,hash.toString('hex'),username);run('DELETE FROM sessions WHERE username=?',username);setTimeout(()=>{io.to('user:'+username).emit('session:expired');io.in('user:'+username).disconnectSockets(true);},50).unref();}
    handler('account:password',async(p,ack)=>{await checkPassword(p.currentPassword);const name=user();await changePassword(name,p.password);ack({ok:true});});
    handler('account:recovery-code',async(p,ack)=>{await checkPassword(p.password);const code=randomBytes(24).toString('hex');run('INSERT OR REPLACE INTO recovery_codes VALUES (?,?)',user(),digest(code));ack({code});});
    handler('account:recover',async(p,ack)=>{
      const name=String(p.username||'').toLowerCase().trim(),code=String(p.code||'');
      if(!/^[a-z0-9_]{3,24}$/.test(name)||!code||code.length>128||!get('SELECT 1 FROM recovery_codes WHERE username=? AND hash=?',name,digest(code)))throw new Error('Invalid username or recovery code.');
      // Consume before the first await, preventing concurrent reuse.
      if(typeof p.password!=='string'||p.password.length<8||p.password.length>128)throw new Error('Use a password of 8–128 characters.');
      run('DELETE FROM recovery_codes WHERE username=?',name);await changePassword(name,p.password);ack({ok:true});
    },{auth:false});
  }
  function deleteAccount(username){for(const group of all('SELECT room_id FROM group_settings WHERE owner=?',username)){const next=get('SELECT username FROM memberships WHERE room_id=? AND username<>? ORDER BY rowid LIMIT 1',group.room_id,username)?.username;run('UPDATE group_settings SET owner=?,invite_code=? WHERE room_id=?',next||null,randomBytes(18).toString('hex'),group.room_id);run('INSERT OR REPLACE INTO settings VALUES (?,?)','invite-rotated:'+group.room_id,'1');}for(const table of ['recovery_codes','message_stars','message_deliveries','chat_mutes'])run('DELETE FROM '+table+' WHERE username=?',username);}
  return {register,decorate,history,groupInfo,ensureGroup,muted,deleteAccount,setDecline:fn=>{decline=fn;}};
}
