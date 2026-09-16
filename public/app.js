const $=id=>document.getElementById(id),socket=io({transports:['websocket','polling'],tryAllTransports:true});
let currentRoom=null,user=null,chats=[],sending=false,token='',typingTimer,lastTyped=0,pendingRetry=null;
let activeCall=null,incomingCall=null,localStream=null,callTimer=null,callStartedAt=0;
const peers=new Map(),iceServers=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
const drafts=new Map(),unread=new Map(),inviteCode=new URLSearchParams(location.search).get('room');
const mobile=()=>matchMedia('(max-width:760px)').matches;
try{token=localStorage.getItem('lr-token')||'';}catch{}
if(inviteCode)$('room-code').value=inviteCode;
function notice(text){$('notice').textContent=text;$('notice').hidden=false;}
function clearNotice(){$('notice').hidden=true;}
function setMobileView(view){if(mobile())document.body.dataset.mobileView=view;else delete document.body.dataset.mobileView;}
function rpc(event,payload){return new Promise((resolve,reject)=>{
  if(!socket.connected)return reject(new Error('Connection lost. Wait for reconnection.'));
  socket.timeout(8000).emit(event,payload,(err,res)=>err?reject(new Error('No confirmation yet. You can retry the same message safely.')):res?.error?reject(new Error(res.error)):resolve(res));
});}
function callRpc(event,payload){return new Promise((resolve,reject)=>{
  if(!socket.connected)return reject(new Error('Connection lost. The call cannot connect.'));
  socket.timeout(8000).emit(event,payload,(err,res)=>err?reject(new Error('Call setup timed out. Please retry.')):res?.error?reject(new Error(res.error)):resolve(res));
});}
function updateCallCount(count){$('call-participants').textContent=count+' participant'+(count===1?'':'s');}
function closePeer(socketId){const peer=peers.get(socketId);if(!peer)return;peer.close();peers.delete(socketId);document.getElementById('audio-'+socketId)?.remove();updateCallCount(peers.size+1);}
function resetCallUi(){clearInterval(callTimer);callTimer=null;callStartedAt=0;for(const id of [...peers.keys()])closePeer(id);localStream?.getTracks().forEach(track=>track.stop());localStream=null;activeCall=null;incomingCall=null;$('call-banner').hidden=true;$('active-call').hidden=true;$('chat').classList.remove('voice-connected');$('voice-call').textContent='☎ Voice';$('mute-call').textContent='Mute';$('mute-call').classList.remove('muted');}
async function sendSignal(target,signal){if(!activeCall)return;await callRpc('call:signal',{roomId:activeCall.roomId,callId:activeCall.callId,target,signal});}
function createPeer(socketId,initiator=false){
  if(peers.has(socketId))return peers.get(socketId);
  const peer=new RTCPeerConnection({iceServers});peer.pendingCandidates=[];peers.set(socketId,peer);localStream?.getTracks().forEach(track=>peer.addTrack(track,localStream));
  peer.onicecandidate=e=>{if(e.candidate)sendSignal(socketId,{candidate:e.candidate}).catch(()=>{});};
  peer.ontrack=e=>{let audio=document.getElementById('audio-'+socketId);if(!audio){audio=document.createElement('audio');audio.id='audio-'+socketId;audio.autoplay=true;audio.playsInline=true;$('remote-audio').append(audio);}audio.srcObject=e.streams[0];audio.play().catch(()=>{});};
  peer.onconnectionstatechange=()=>{if(['failed','closed'].includes(peer.connectionState))closePeer(socketId);};
  if(initiator)peer.createOffer().then(offer=>peer.setLocalDescription(offer)).then(()=>sendSignal(socketId,{description:peer.localDescription})).catch(e=>notice(e.message));
  updateCallCount(peers.size+1);return peer;
}
async function joinVoiceCall(){
  if(!currentRoom||activeCall)return;
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Voice calls need HTTPS or localhost and a supported browser.');
  localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  try{
    const result=await callRpc('call:join',{roomId:currentRoom.id});activeCall={roomId:currentRoom.id,callId:result.callId};incomingCall=null;$('call-banner').hidden=true;$('active-call').hidden=false;$('chat').classList.add('voice-connected');$('voice-call').textContent='☎ In call';callStartedAt=Date.now();
    const tick=()=>{const seconds=Math.floor((Date.now()-callStartedAt)/1000);$('call-time').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');};tick();callTimer=setInterval(tick,1000);updateCallCount(result.participants.length+1);
    for(const participant of result.participants)createPeer(participant.socketId,true);
  }catch(error){localStream.getTracks().forEach(track=>track.stop());localStream=null;throw error;}
}
async function leaveVoiceCall(){const roomId=activeCall?.roomId;if(roomId)try{await callRpc('call:leave',{roomId});}catch{}resetCallUi();}
function drawChats(){
  const nav=$('chat-list'),q=($('chat-search')?.value||'').trim().toLowerCase();nav.replaceChildren();
  const visible=chats.filter(chat=>!q||chat.name.toLowerCase().includes(q)||(chat.direct?'private direct username':'group room').includes(q));
  if(!visible.length){const empty=document.createElement('div');empty.className='chat-list-empty';empty.textContent=q?'No chats match your search.':'No conversations yet. Tap + to start one.';nav.append(empty);return;}
  for(const chat of visible){
    const button=document.createElement('button');button.type='button';button.className=currentRoom?.id===chat.id?'active':'';button.dataset.roomId=chat.id;
    const avatar=document.createElement('span');avatar.className='chat-avatar';avatar.textContent=(chat.name||'?').slice(0,1);
    const copy=document.createElement('span');copy.className='chat-copy';
    const name=document.createElement('span');name.className='chat-name';name.textContent=(chat.direct?'@':'# ')+chat.name;
    const subtitle=document.createElement('span');subtitle.className='chat-subtitle';subtitle.textContent=chat.direct?'Private chat':'Room conversation';copy.append(name,subtitle);button.append(avatar,copy);
    if(unread.get(chat.id)){const badge=document.createElement('span');badge.className='unread';badge.textContent=unread.get(chat.id);button.append(badge);}
    button.onclick=()=>enter({roomId:chat.id},{pushHistory:true}).catch(e=>notice(e.message));nav.append(button);
  }
}
function showChats({replaceHistory=false}={}){
  if(currentRoom)drafts.set(currentRoom.id,$('message').value);if(activeCall)leaveVoiceCall();currentRoom=null;$('auth-panel').hidden=true;$('chat').hidden=true;$('lobby').hidden=true;setMobileView('chats');drawChats();
  if(mobile()){const state={mobileView:'chats'};replaceHistory?history.replaceState(state,'','/'):history.pushState(state,'','/');}
  else{$('lobby').hidden=false;history.replaceState(null,'','/');}
}
function showLobby(){
  if(currentRoom)drafts.set(currentRoom.id,$('message').value);if(activeCall)leaveVoiceCall();currentRoom=null;$('auth-panel').hidden=true;$('chat').hidden=true;$('lobby').hidden=false;setMobileView(mobile()?'lobby':'');history.replaceState(mobile()?{mobileView:'lobby'}:null,'','/');drawChats();
}
function signedIn(result){
  user=result.user;token=result.token||token;chats=result.chats;try{localStorage.setItem('lr-token',token);}catch{}$('password').value='';$('identity').textContent='@'+user;$('sidebar-chats').hidden=false;$('intro').hidden=true;$('auth-panel').hidden=true;drawChats();
  if(mobile()){$('lobby').hidden=true;$('chat').hidden=true;setMobileView('chats');history.replaceState({mobileView:'chats'},'','/');}
  else{$('lobby').hidden=false;setMobileView('');}
}
function renderMessage(m,{pending=false}={}){
  if(m.roomId!==currentRoom?.id)return;
  $('messages').querySelector('.empty')?.remove();
  const existing=document.getElementById('msg-'+m.id);
  const el=document.createElement('article');el.id='msg-'+m.id;el.className='message '+m.kind+(m.senderId===user?' own':'')+(m.deleted?' deleted':'')+(pending?' pending':'')+(m.streaming?' streaming':'');
  const meta=document.createElement('div');meta.className='meta';const name=document.createElement('strong');name.textContent=(m.kind==='ai'?'✦ ':'@')+m.name;
  const time=document.createElement('time');time.dateTime=new Date(m.at).toISOString();time.textContent=new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});meta.append(name,time);
  if(m.senderId===user&&!m.deleted&&!pending){const del=document.createElement('button');del.className='delete-message';del.type='button';del.textContent='Delete for everyone';del.onclick=async()=>{if(!confirm('Delete this message for everyone?'))return;try{await rpc('delete',{id:m.id});}catch(e){notice(e.message);}};meta.append(del);}
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=m.text;el.append(meta,bubble);
  const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<130;
  if(existing)existing.replaceWith(el);else $('messages').append(el);
  if(nearBottom||m.senderId===user||m.kind==='ai')$('messages').scrollTop=$('messages').scrollHeight;
}
function showRoom(room,{pushHistory=false}={}){
  if(activeCall&&activeCall.roomId!==room.id)leaveVoiceCall();incomingCall=null;$('call-banner').hidden=true;
  if(currentRoom)drafts.set(currentRoom.id,$('message').value);$('message').value=drafts.get(room.id)||'';
  currentRoom=room;unread.delete(room.id);$('lobby').hidden=true;$('chat').hidden=false;$('room-title').textContent=(room.direct?'@':'# ')+room.name;$('invite').hidden=room.direct;setMobileView(mobile()?'chat':'');
  $('messages').replaceChildren();if(!room.messages.length){const el=document.createElement('div');el.className='empty';const strong=document.createElement('strong');strong.textContent=room.direct?'Say a little hello.':'The room is yours.';el.append(strong,document.createTextNode(room.direct?'Your conversation starts here.':'Share an invite and start the conversation.'));$('messages').append(el);}
  room.messages.forEach(m=>renderMessage(m));$('messages').scrollTop=$('messages').scrollHeight;$('thinking').hidden=!room.thinking;$('typing').hidden=true;
  $('members').textContent=room.members.length+' online · '+room.members.map(u=>'@'+u).join(', ');
  const url=room.direct?'/':'?room='+room.id;
  if(mobile()&&pushHistory)history.pushState({mobileView:'chat',roomId:room.id},'',url);else history.replaceState(mobile()?{mobileView:'chat',roomId:room.id}:null,'',url);
  drawChats();$('message').focus();
}
async function enter(payload,options={}){clearNotice();const result=await rpc('enter',payload);showRoom(result.room,options);}
$('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();clearNotice();const buttons=[...e.currentTarget.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{signedIn(await rpc('auth',{username:$('username').value,password:$('password').value,register:e.submitter?.value==='register'}));if(inviteCode)await enter({roomId:inviteCode},{pushHistory:true});}catch(err){notice(err.message);}finally{buttons.forEach(b=>b.disabled=false);}
});
for(const[form,join]of[['create-form',false],['join-form',true]])$(form).addEventListener('submit',async e=>{
  e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;
  try{let code=$('room-code').value.trim();if(join&&/^https?:\/\//i.test(code))code=new URL(code).searchParams.get('room')||'';if(join&&!/^[a-f0-9]{24}$/.test(code))throw new Error('Paste a valid room invite link or code.');await enter(join?{roomId:code}:{roomName:$('room-name').value.trim()},{pushHistory:mobile()});}catch(err){notice(err.message);}finally{button.disabled=false;}
});
$('contact-form').addEventListener('submit',async e=>{e.preventDefault();try{clearNotice();const result=await rpc('direct',{username:$('contact').value});showRoom(result.room,{pushHistory:mobile()});}catch(err){notice(err.message);}});
$('chat-search').addEventListener('input',drawChats);
socket.on('connect',async()=>{
  $('connection').textContent='● Connected';$('send').disabled=false;
  if(token)try{const active=currentRoom?.id;signedIn(await rpc('auth',{token}));if(active||inviteCode)await enter({roomId:active||inviteCode},{pushHistory:false});}catch(err){token='';user=null;currentRoom=null;try{localStorage.removeItem('lr-token');}catch{}delete document.body.dataset.mobileView;$('auth-panel').hidden=false;$('lobby').hidden=true;$('chat').hidden=true;$('sidebar-chats').hidden=true;$('intro').hidden=false;notice(err.message);}
});
socket.on('disconnect',()=>{if(activeCall)resetCallUi();$('connection').textContent='Reconnecting…';$('send').disabled=true;});
socket.on('connect_error',()=>{$('connection').textContent='Unable to connect';});
socket.on('chats',data=>{chats=data;drawChats();});
socket.on('message',m=>{if(m.roomId===currentRoom?.id){renderMessage(m);$('typing').hidden=true;}else{unread.set(m.roomId,(unread.get(m.roomId)||0)+1);drawChats();}});
socket.on('ai:stream',m=>{if(m.roomId===currentRoom?.id){renderMessage(m);$('thinking').hidden=true;}});
socket.on('deleted',m=>renderMessage(m));
socket.on('members',p=>{if(p.roomId===currentRoom?.id)$('members').textContent=p.members.length+' online · '+p.members.map(u=>'@'+u).join(', ');});
socket.on('thinking',p=>{if(p.roomId===currentRoom?.id)$('thinking').hidden=!p.busy;});
socket.on('typing',p=>{if(p.roomId!==currentRoom?.id)return;$('typing').textContent='@'+p.user+' is typing…';$('typing').hidden=false;clearTimeout(typingTimer);typingTimer=setTimeout(()=>$('typing').hidden=true,2200);});
socket.on('call:ring',p=>{if(activeCall||p.roomId!==currentRoom?.id)return;incomingCall=p;$('call-title').textContent='Incoming voice call';$('call-subtitle').textContent='@'+p.by+' started a call';$('call-banner').hidden=false;});
socket.on('call:participant-joined',p=>{if(activeCall?.callId===p.callId)updateCallCount(Math.max(p.participants,peers.size+1));else if(!activeCall&&p.roomId===currentRoom?.id){incomingCall=p;$('call-title').textContent='Voice call in progress';$('call-subtitle').textContent='Join '+p.participants+' participant'+(p.participants===1?'':'s');$('call-banner').hidden=false;}});
socket.on('call:participant-left',p=>{if(activeCall?.callId!==p.callId)return;closePeer(p.socketId);updateCallCount(Math.max(p.participants,peers.size+1));});
socket.on('call:ended',p=>{if(activeCall?.callId===p.callId){resetCallUi();notice('Voice call ended.');}else if(incomingCall?.callId===p.callId){incomingCall=null;$('call-banner').hidden=true;}});
socket.on('call:signal',async p=>{
  if(activeCall?.callId!==p.callId)return;const peer=createPeer(p.from,false);
  try{
    if(p.signal.description){await peer.setRemoteDescription(p.signal.description);for(const candidate of peer.pendingCandidates.splice(0))await peer.addIceCandidate(candidate);if(p.signal.description.type==='offer'){const answer=await peer.createAnswer();await peer.setLocalDescription(answer);await sendSignal(p.from,{description:peer.localDescription});}}
    else if(p.signal.candidate){if(peer.remoteDescription)await peer.addIceCandidate(p.signal.candidate);else peer.pendingCandidates.push(p.signal.candidate);}
  }catch(error){notice('Voice connection failed: '+error.message);closePeer(p.from);}
});
$('message-form').addEventListener('submit',async e=>{
  e.preventDefault();if(sending||!currentRoom)return;const text=$('message').value;if(!text.trim())return;const roomId=currentRoom.id;
  const clientId=pendingRetry?.text===text&&pendingRetry?.roomId===roomId?pendingRetry.clientId:crypto.randomUUID();const id=user+':'+clientId;
  sending=true;$('send').disabled=true;clearNotice();renderMessage({id,roomId,name:user,senderId:user,text,kind:'user',at:Date.now()},{pending:true});
  try{const result=await rpc('send',{roomId,text,clientId});renderMessage(result.message);pendingRetry=null;drafts.delete(roomId);if(currentRoom?.id===roomId&&$('message').value===text)$('message').value='';}
  catch(err){pendingRetry={text,roomId,clientId};document.getElementById('msg-'+id)?.classList.replace('pending','failed');notice(err.message);}
  finally{sending=false;$('send').disabled=!socket.connected;$('message').focus();}
});
$('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('message-form').requestSubmit();}});
$('message').addEventListener('input',()=>{if(currentRoom&&Date.now()-lastTyped>2000){lastTyped=Date.now();rpc('typing',{roomId:currentRoom.id}).catch(()=>{});}});
$('mention').onclick=()=>{$('message').value+=($('message').value?' ':'')+'@gemini ';$('message').focus();};
$('voice-call').onclick=()=>{if(activeCall)return;joinVoiceCall().catch(e=>notice(e.name==='NotAllowedError'?'Microphone permission is required for voice calls.':e.message));};
$('join-call').onclick=()=>joinVoiceCall().catch(e=>notice(e.name==='NotAllowedError'?'Microphone permission is required for voice calls.':e.message));
$('decline-call').onclick=()=>{incomingCall=null;$('call-banner').hidden=true;};
$('mute-call').onclick=()=>{if(!localStream)return;const enabled=!localStream.getAudioTracks()[0]?.enabled;localStream.getAudioTracks().forEach(track=>track.enabled=enabled);$('mute-call').textContent=enabled?'Mute':'Unmute';$('mute-call').classList.toggle('muted',!enabled);};
$('end-call').onclick=()=>leaveVoiceCall();
$('invite').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+'/?room='+currentRoom.id);$('invite').textContent='Copied!';setTimeout(()=>$('invite').textContent='Copy invite',2000);}catch{notice('Copy this invite: '+location.origin+'/?room='+currentRoom.id);}};
$('leave').onclick=()=>mobile()?showChats({replaceHistory:true}):(showLobby(),clearNotice());
$('mobile-back').onclick=()=>{if(history.length>1)history.back();else showChats({replaceHistory:true});};
$('mobile-lobby-back').onclick=()=>showChats({replaceHistory:true});
$('new-chat').onclick=()=>{showLobby();clearNotice();};
window.addEventListener('popstate',()=>{if(!mobile()||!user)return;if(currentRoom||!$('lobby').hidden){if(activeCall)leaveVoiceCall();currentRoom=null;$('chat').hidden=true;$('lobby').hidden=true;setMobileView('chats');drawChats();}});
window.addEventListener('resize',()=>{if(!user)return;if(mobile()){if(currentRoom)setMobileView('chat');else if(!$('lobby').hidden)setMobileView('lobby');else setMobileView('chats');}else{delete document.body.dataset.mobileView;if(!currentRoom)$('lobby').hidden=false;}});
$('logout').onclick=async()=>{if(activeCall)await leaveVoiceCall();try{await rpc('logout',{token});}catch{}try{localStorage.removeItem('lr-token');}catch{}location.href='/';};
