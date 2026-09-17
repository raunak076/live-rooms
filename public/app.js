const $=id=>document.getElementById(id),socket=io({transports:['websocket','polling'],tryAllTransports:true});
let currentRoom=null,user=null,chats=[],sending=false,token='',typingTimer,lastTyped=0,pendingRetry=null;
let profileData=null,selectedMessage=null,replyingTo=null,activeTab='chats';
let activeCall=null,incomingCall=null,localStream=null,callTimer=null,callStartedAt=0,speakerEnabled=true;
let swRegistration=null,installPrompt=null,notificationsEnabled=false,uploading=false,mediaRecorder=null,recordingStream=null,recordingTimer=null,ringContext=null,ringInterval=null,pendingOpen=null;
const peers=new Map();let iceServers=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}],iceConfigPromise=null;
const drafts=new Map(),unread=new Map(),mediaUrls=new Map(),avatarUrls=new Map(),params=new URLSearchParams(location.search),inviteCode=params.get('room'),requestedCallId=params.get('call');
try{
  const uiVersion='whatsapp-chat-1';
  if(localStorage.getItem('lr-ui-version')!==uiVersion){
    localStorage.removeItem('lr-token');
    localStorage.setItem('lr-ui-version',uiVersion);
  }
  token=localStorage.getItem('lr-token')||'';
}catch{}
function applyTheme(theme){document.documentElement.dataset.theme=theme;try{localStorage.setItem('lr-theme',theme);}catch{}document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='light'?'#ffffff':'#0b141a');}
function toggleTheme(){applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');}
try{applyTheme(localStorage.getItem('lr-theme')||'dark');}catch{applyTheme('dark');}
if(inviteCode)$('room-code').value=inviteCode;
function notice(text){$('notice').textContent=text;$('notice').hidden=false;}
function clearNotice(){$('notice').hidden=true;}
function base64Key(value){const padding='='.repeat((4-value.length%4)%4),raw=atob((value+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
function unlockRingtone(){if(!window.AudioContext&&!window.webkitAudioContext)return;ringContext??=new (window.AudioContext||window.webkitAudioContext)();if(ringContext.state==='suspended')ringContext.resume().catch(()=>{});}
function ringOnce(){if(!ringContext||ringContext.state!=='running')return;for(const delay of [0,.42]){const oscillator=ringContext.createOscillator(),gain=ringContext.createGain(),at=ringContext.currentTime+delay;oscillator.frequency.value=760;gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.13,at+.03);gain.gain.exponentialRampToValueAtTime(.0001,at+.28);oscillator.connect(gain).connect(ringContext.destination);oscillator.start(at);oscillator.stop(at+.3);}}
function startRingtone(){stopRingtone();unlockRingtone();ringOnce();ringInterval=setInterval(ringOnce,1900);navigator.vibrate?.([500,220,500,700]);}
function stopRingtone(){clearInterval(ringInterval);ringInterval=null;navigator.vibrate?.(0);}
async function authFetch(url,options={}){const headers=new Headers(options.headers||{});headers.set('Authorization','Bearer '+token);return fetch(url,{...options,headers});}
async function enablePush(){
  unlockRingtone();if(!swRegistration||!('Notification'in window)||!('PushManager'in window))throw new Error('Notifications are not supported in this browser.');
  const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Notification permission was not allowed. You can enable it later in browser settings.');
  const {publicKey}=await fetch('/api/push/public-key').then(r=>r.json());let subscription=await swRegistration.pushManager.getSubscription();
  subscription??=await swRegistration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64Key(publicKey)});
  const response=await authFetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(subscription)});if(!response.ok)throw new Error((await response.json()).error||'Could not enable notifications.');
  notificationsEnabled=true;$('notification-prompt').hidden=true;
}
async function showLocalNotification(payload){if(!notificationsEnabled||!swRegistration||Notification.permission!=='granted')return;await swRegistration.showNotification(payload.title||'Live Chat',{body:payload.body||'',icon:'/favicon.svg',badge:'/favicon.svg',tag:payload.tag||'live-chat',data:{roomId:payload.roomId,callId:payload.callId,type:payload.type,url:payload.url||'/'}}).catch(()=>{});}
function promptForNotifications(){if(!user||!('Notification'in window)||!('PushManager'in window))return;$('notification-prompt').hidden=true;if(Notification.permission==='granted')enablePush().catch(()=>{});}
async function setupPwa(){
  if('serviceWorker'in navigator){try{swRegistration=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});await navigator.serviceWorker.ready;if(user)promptForNotifications();}catch{}}
  $('install-app').hidden=true;
}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install-app').hidden=true;});
window.addEventListener('appinstalled',()=>{$('install-app').hidden=true;installPrompt=null;});
document.addEventListener('pointerdown',unlockRingtone,{once:true});
setupPwa();
function rpc(event,payload){return new Promise((resolve,reject)=>{
  if(!socket.connected)return reject(new Error('Connection lost. Wait for reconnection.'));
  socket.timeout(8000).emit(event,payload,(err,res)=>err?reject(new Error('No confirmation yet. You can retry the same message safely.')):res?.error?reject(new Error(res.error)):resolve(res));
});}
function callRpc(event,payload){return new Promise((resolve,reject)=>{
  if(!socket.connected)return reject(new Error('Connection lost. The call cannot connect.'));
  socket.timeout(8000).emit(event,payload,(err,res)=>err?reject(new Error('Call setup timed out. Please retry.')):res?.error?reject(new Error(res.error)):resolve(res));
});}
function updateCallCount(count){$('call-participants').textContent=count+' participant'+(count===1?'':'s');}
async function ensureIceServers(){if(!iceConfigPromise)iceConfigPromise=fetch('/api/webrtc-config').then(response=>response.ok?response.json():null).then(config=>{if(config?.iceServers?.length)iceServers=config.iceServers;}).catch(()=>{});await iceConfigPromise;}
function closePeer(socketId){const peer=peers.get(socketId);if(!peer)return;peer.close();peers.delete(socketId);document.getElementById('audio-'+socketId)?.remove();updateCallCount(peers.size+1);}
function showCallScreen(){
  const title=currentRoom?.name||'Voice call';
  $('call-peer').textContent=currentRoom?.displayName||title;
  $('call-avatar').textContent=title.trim().charAt(0).toUpperCase()||'#';
  $('active-call').hidden=false;document.body.classList.add('call-open');
}
function resetCallUi(){stopRingtone();clearInterval(callTimer);callTimer=null;callStartedAt=0;for(const id of [...peers.keys()])closePeer(id);localStream?.getTracks().forEach(track=>track.stop());localStream=null;activeCall=null;incomingCall=null;speakerEnabled=true;$('call-banner').hidden=true;$('active-call').hidden=true;document.body.classList.remove('call-open');$('chat').classList.remove('voice-connected');$('voice-call').textContent='☎ Voice';$('mute-label').textContent='Mute';$('mute-call').classList.remove('muted');$('mute-call').setAttribute('aria-pressed','false');$('speaker-label').textContent='Speaker';$('speaker-call').classList.remove('speaker-off');$('speaker-call').setAttribute('aria-pressed','true');}
async function sendSignal(target,signal){if(!activeCall)return;await callRpc('call:signal',{roomId:activeCall.roomId,callId:activeCall.callId,target,signal});}
function createPeer(socketId,initiator=false){
  if(peers.has(socketId))return peers.get(socketId);
  const peer=new RTCPeerConnection({iceServers});peer.pendingCandidates=[];peers.set(socketId,peer);localStream?.getTracks().forEach(track=>peer.addTrack(track,localStream));
  peer.onicecandidate=e=>{if(e.candidate)sendSignal(socketId,{candidate:e.candidate}).catch(()=>{});};
  peer.ontrack=e=>{let audio=document.getElementById('audio-'+socketId);if(!audio){audio=document.createElement('audio');audio.id='audio-'+socketId;audio.autoplay=true;audio.playsInline=true;$('remote-audio').append(audio);}audio.muted=!speakerEnabled;audio.srcObject=e.streams[0];audio.play().catch(()=>{});};
  peer.onconnectionstatechange=()=>{if(peer.connectionState==='connected')$('call-status').textContent='Connected';if(['failed','closed'].includes(peer.connectionState))closePeer(socketId);};
  if(initiator)peer.createOffer().then(offer=>peer.setLocalDescription(offer)).then(()=>sendSignal(socketId,{description:peer.localDescription})).catch(e=>notice(e.message));
  updateCallCount(peers.size+1);return peer;
}
async function joinVoiceCall(){
  if(!currentRoom||activeCall)return;
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Voice calls need HTTPS or localhost and a supported browser.');
  stopRingtone();await ensureIceServers();
  localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  try{
    const result=await callRpc('call:join',{roomId:currentRoom.id,expectedCallId:incomingCall?.callId});activeCall={roomId:currentRoom.id,callId:result.callId};incomingCall=null;$('call-banner').hidden=true;$('call-status').textContent=result.created?'Calling…':'Connected';showCallScreen();$('chat').classList.add('voice-connected');$('voice-call').textContent='☎ In call';callStartedAt=Date.now();
    const tick=()=>{const seconds=Math.floor((Date.now()-callStartedAt)/1000);$('call-time').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');};tick();callTimer=setInterval(tick,1000);updateCallCount(result.participants.length+1);
    for(const participant of result.participants)createPeer(participant.socketId,true);
  }catch(error){localStream.getTracks().forEach(track=>track.stop());localStream=null;throw error;}
}
async function leaveVoiceCall({forEveryone=false}={}){const roomId=activeCall?.roomId;if(roomId)try{await callRpc(forEveryone?'call:end':'call:leave',{roomId});}catch{}resetCallUi();}
async function loadAvatar(img,username,updated){
  if(!updated||!img)return;const reveal=()=>{img.hidden=false;if(img.id==='profile-avatar')$('profile-avatar-placeholder').hidden=true;};const key=username+':'+updated;if(avatarUrls.has(key)){img.src=avatarUrls.get(key);reveal();return;}
  try{const response=await authFetch('/api/profile/avatar/'+encodeURIComponent(username));if(!response.ok)return;const url=URL.createObjectURL(await response.blob());avatarUrls.set(key,url);img.src=url;reveal();}catch{}
}
function chatAvatar(chat){const wrap=document.createElement('span');wrap.className='chat-avatar';wrap.textContent=chat.direct?(chat.displayName||chat.name).charAt(0).toUpperCase():'#';if(chat.direct&&chat.avatarUpdated){const img=document.createElement('img');img.alt='';img.hidden=true;wrap.append(img);loadAvatar(img,chat.name,chat.avatarUpdated);}return wrap;}
function drawChats(){
  $('chat-list').replaceChildren();$('lobby-chat-list').replaceChildren();
  if(!chats.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No chats yet. Search for a contact or create a group.';$('lobby-chat-list').append(empty);}
  for(const chat of chats){const button=document.createElement('button');button.type='button';button.className=currentRoom?.id===chat.id?'active':'';button.textContent=chat.displayName||chat.name;
    if(unread.get(chat.id)){const badge=document.createElement('span');badge.className='unread';badge.textContent=unread.get(chat.id);button.append(badge);}
    button.onclick=()=>enter({roomId:chat.id}).catch(e=>notice(e.message));$('chat-list').append(button);
    const row=document.createElement('button');row.type='button';row.className='lobby-chat-item';row.dataset.kind=chat.direct?'direct':'group';row.dataset.unread=unread.get(chat.id)?'true':'false';row.dataset.search=((chat.displayName||chat.name)+' '+(chat.lastMessage||'')).toLowerCase();const copy=document.createElement('span');copy.className='chat-copy';const titleLine=document.createElement('span');titleLine.className='chat-title-line';const title=document.createElement('strong');title.textContent=chat.displayName||chat.name;const stamp=document.createElement('time');stamp.textContent=chat.lastAt?formatChatTime(chat.lastAt):'';titleLine.append(title,stamp);const subtitle=document.createElement('small');subtitle.textContent=chat.blockedByMe?'Blocked contact':chat.blockedMe?'This contact blocked you':chat.lastMessage||'No messages yet';copy.append(titleLine,subtitle);row.append(chatAvatar(chat),copy);if(unread.get(chat.id)){const badge=document.createElement('span');badge.className='unread';badge.textContent=unread.get(chat.id);row.append(badge);}row.onclick=()=>enter({roomId:chat.id}).catch(e=>notice(e.message));$('lobby-chat-list').append(row);}
  applyChatFilter();
}
function formatChatTime(value){const date=new Date(value),today=new Date();return date.toDateString()===today.toDateString()?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):date.toLocaleDateString([],{day:'2-digit',month:'short'});}
function applyChatFilter(){const query=($('chat-search')?.value||'').trim().toLowerCase(),mode=document.querySelector('.filter-chips .active')?.id||'filter-all';for(const row of $('lobby-chat-list').querySelectorAll('.lobby-chat-item'))row.hidden=Boolean(query&&!row.dataset.search.includes(query))||(mode==='filter-groups'&&row.dataset.kind!=='group')||(mode==='filter-unread'&&row.dataset.unread!=='true');}
function showTab(tab){activeTab=tab;for(const name of ['chats','calls','profile'])$('tab-'+name).classList.toggle('active',name===tab);$('lobby').hidden=tab!=='chats';$('calls-view').hidden=tab!=='calls';$('profile-view').hidden=tab!=='profile';if(tab==='calls')loadCallLogs();if(tab==='profile')showProfile();}
function showLobby(){if(currentRoom)drafts.set(currentRoom.id,$('message').value);if(activeCall)leaveVoiceCall({forEveryone:true});currentRoom=null;cancelReply();document.body.classList.remove('chat-open');$('auth-panel').hidden=true;$('chat').hidden=true;$('bottom-nav').hidden=false;history.replaceState(null,'','/');drawChats();showTab('chats');}
function signedIn(result){user=result.user;token=result.token||token;chats=result.chats;profileData=result.profile||{username:user,displayName:user,avatarUpdated:0};document.body.classList.add('signed-in');document.body.classList.remove('chat-open');try{localStorage.setItem('lr-token',token);}catch{}$('password').value='';$('identity').textContent=user;$('sidebar-chats').hidden=false;$('intro').hidden=true;$('auth-panel').hidden=true;$('bottom-nav').hidden=false;drawChats();showTab('chats');updateProfileVisuals();promptForNotifications();if(pendingOpen){const request=pendingOpen;pendingOpen=null;openRoomFromNotification(request);}}
function clearMediaUrls(){for(const url of mediaUrls.values())URL.revokeObjectURL(url);mediaUrls.clear();}
function formatBytes(size){return size<1048576?Math.max(1,Math.round(size/1024))+' KB':(size/1048576).toFixed(1)+' MB';}
async function loadAttachment(element,attachment){
  if(mediaUrls.has(attachment.id)){element.src=mediaUrls.get(attachment.id);return;}
  try{const response=await authFetch('/api/media/'+encodeURIComponent(attachment.id));if(!response.ok)throw new Error();const url=URL.createObjectURL(await response.blob());mediaUrls.set(attachment.id,url);if(element.isConnected)element.src=url;else URL.revokeObjectURL(url);}catch{element.replaceWith(document.createTextNode('Attachment unavailable'));}
}
function setUploadState(active,text=''){uploading=active;$('upload-status').hidden=!active;$('upload-status').textContent=text;for(const id of ['attachment-button','attach-image','attach-audio','record-audio'])$(id).disabled=active;$('send').disabled=active||!socket.connected;}
async function uploadMedia(file){
  if(!currentRoom||uploading)return;if(!file?.size)return;if(file.size>8*1024*1024)throw new Error('Keep each image or audio file under 8 MB.');
  const roomId=currentRoom.id;setUploadState(true,file.type.startsWith('image/')?'Sending photo…':'Sending audio…');clearNotice();
  try{const response=await authFetch('/api/media/'+encodeURIComponent(roomId),{method:'POST',headers:{'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name||'attachment')},body:file});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||(response.status===413?'Keep each image or audio file under 8 MB.':'Upload failed.'));if(currentRoom?.id===roomId)renderMessage(result.message);}
  finally{setUploadState(false);}
}
async function startVoiceNote(){
  if(activeCall)throw new Error('End the call before recording a voice note.');if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Voice-note recording is not supported in this browser.');
  recordingStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type))||'';const chunks=[];
  mediaRecorder=new MediaRecorder(recordingStream,mime?{mimeType:mime}:undefined);mediaRecorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
  mediaRecorder.onstop=()=>{clearTimeout(recordingTimer);recordingTimer=null;recordingStream?.getTracks().forEach(track=>track.stop());recordingStream=null;const type=mediaRecorder.mimeType.split(';')[0]||'audio/webm',blob=new Blob(chunks,{type});mediaRecorder=null;$('record-audio').classList.remove('recording');$('record-audio').setAttribute('aria-pressed','false');$('attachment-button').classList.remove('recording');$('attachment-button').textContent='＋';if(blob.size)uploadMedia(new File([blob],'voice-note.'+(type.includes('ogg')?'ogg':'webm'),{type})).catch(error=>notice(error.message));};
  mediaRecorder.start(500);$('record-audio').classList.add('recording');$('record-audio').setAttribute('aria-pressed','true');$('attachment-button').classList.add('recording');$('attachment-button').textContent='■';recordingTimer=setTimeout(()=>mediaRecorder?.state==='recording'&&mediaRecorder.stop(),60000);
}
function stopVoiceNote(){if(mediaRecorder?.state==='recording')mediaRecorder.stop();}
function closeMessageActions(){selectedMessage=null;$('message-actions').hidden=true;document.querySelector('.message.selected')?.classList.remove('selected');}
function chooseReply(message){replyingTo=message;$('reply-name').textContent='Replying to '+message.name;$('reply-text').textContent=message.text||message.attachment?.name||'Attachment';$('reply-preview').hidden=false;if(message.senderId&&message.senderId!==user&&!$('message').value.includes('@'+message.name))$('message').value='@'+message.name+' '+$('message').value;$('message').focus();closeMessageActions();}
function cancelReply(){replyingTo=null;$('reply-preview').hidden=true;}
function openMessageActions(message,element){selectedMessage=message;document.querySelector('.message.selected')?.classList.remove('selected');element.classList.add('selected');$('action-edit').hidden=message.senderId!==user||message.deleted||Boolean(message.attachment);$('action-delete').hidden=message.deleted;$('message-actions').hidden=false;}
function bindMessageGestures(element,message){
  let startX=0,startY=0,timer=null,swiped=false;
  element.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('button,audio'))return;startX=event.clientX;startY=event.clientY;swiped=false;timer=setTimeout(()=>openMessageActions(message,element),520);});
  element.addEventListener('pointermove',event=>{if(!timer)return;const dx=event.clientX-startX,dy=event.clientY-startY;if(Math.abs(dy)>25)clearTimeout(timer);if(dx>20&&Math.abs(dy)<45){clearTimeout(timer);element.classList.add('swiping');element.style.transform='translateX('+Math.min(dx,82)+'px)';if(dx>68)swiped=true;}});
  const finish=()=>{clearTimeout(timer);timer=null;element.classList.remove('swiping');element.style.transform='';if(swiped)chooseReply(message);swiped=false;};element.addEventListener('pointerup',finish);element.addEventListener('pointercancel',finish);
  element.addEventListener('contextmenu',event=>{event.preventDefault();openMessageActions(message,element);});
}
function renderMessage(m,{pending=false}={}){
  if(m.roomId!==currentRoom?.id)return;
  $('messages').querySelector('.empty')?.remove();
  const existing=document.getElementById('msg-'+m.id);
  const el=document.createElement('article');el.id='msg-'+m.id;el.className='message '+m.kind+(m.senderId===user?' own':'')+(m.deleted?' deleted':'')+(pending?' pending':'');
  const meta=document.createElement('div');meta.className='meta';const name=document.createElement('strong');name.textContent=(m.kind==='ai'?'✦ ':'')+m.name;
  const time=document.createElement('time');time.dateTime=new Date(m.at).toISOString();time.textContent=new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});meta.append(name,time);if(m.edited){const edited=document.createElement('span');edited.className='edited-label';edited.textContent='edited';meta.append(edited);}
  const bubble=document.createElement('div');bubble.className='bubble';if(m.reply&&!m.deleted){const quote=document.createElement('div');quote.className='reply-quote';const replyName=document.createElement('strong');replyName.textContent=m.reply.name;const replyText=document.createElement('span');replyText.textContent=m.reply.text;quote.append(replyName,replyText);bubble.append(quote);}if(m.text)bubble.append(document.createTextNode(m.text));
  if(m.attachment&&!m.deleted){const mediaWrap=document.createElement('div');mediaWrap.className='attachment';let media;if(m.attachment.type==='image'){media=document.createElement('img');media.alt=m.attachment.name||'Shared image';media.loading='lazy';media.onclick=()=>{if(!media.src)return;$('full-image').src=media.src;$('full-image').alt=media.alt;$('image-viewer').hidden=false;};}else{media=document.createElement('audio');media.controls=true;media.preload='metadata';}const detail=document.createElement('small');detail.textContent=(m.attachment.name||'Attachment')+' · '+formatBytes(m.attachment.size);mediaWrap.append(media,detail);bubble.append(mediaWrap);loadAttachment(media,m.attachment);}
  el.append(meta,bubble);
  if(!pending)bindMessageGestures(el,m);
  const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<130;
  if(existing)existing.replaceWith(el);else $('messages').append(el);
  if(nearBottom||m.senderId===user)$('messages').scrollTop=$('messages').scrollHeight;
}
function showRoom(room){
  if(activeCall&&activeCall.roomId!==room.id)leaveVoiceCall();incomingCall=null;$('call-banner').hidden=true;
  if(currentRoom)drafts.set(currentRoom.id,$('message').value);$('message').value=drafts.get(room.id)||'';
  clearMediaUrls();currentRoom=room;unread.delete(room.id);document.body.classList.add('chat-open');$('lobby').hidden=true;$('calls-view').hidden=true;$('profile-view').hidden=true;$('chat').hidden=false;$('room-title').textContent=room.displayName||room.name;$('invite').hidden=room.direct;$('block-contact').hidden=!room.direct;$('block-contact').textContent=room.blockedByMe?'Unblock':'Block';const headerAvatar=$('chat-header-avatar');headerAvatar.replaceChildren(document.createTextNode(room.direct?(room.displayName||room.name).charAt(0).toUpperCase():'#'));if(room.direct&&room.avatarUpdated){const img=document.createElement('img');img.alt='';img.hidden=true;headerAvatar.append(img);loadAvatar(img,room.name,room.avatarUpdated);}
  $('messages').replaceChildren();if(!room.messages.length){const el=document.createElement('div');el.className='empty';const strong=document.createElement('strong');strong.textContent=room.direct?'Say a little hello.':'The room is yours.';el.append(strong,document.createTextNode(room.direct?'Your conversation starts here.':'Share an invite and start the conversation.'));$('messages').append(el);}
  room.messages.forEach(m=>renderMessage(m));$('messages').scrollTop=$('messages').scrollHeight;$('thinking').hidden=!room.thinking;$('typing').hidden=true;
  const blocked=room.blockedByMe||room.blockedMe;$('members').textContent=blocked?(room.blockedByMe?'You blocked this contact':'This contact blocked you'):room.direct?(room.members.includes(room.name)?'online':'tap for info'):room.members.length+' online';for(const id of ['message','send','attachment-button','attach-image','attach-audio','record-audio','voice-call'])$(id).disabled=blocked;$('message').placeholder=blocked?'Messaging unavailable while blocked':'Message';
  history.replaceState(null,'',room.direct?'/':'?room='+room.id);drawChats();
}
async function enter(payload){clearNotice();const result=await rpc('enter',payload);showRoom(result.room);}
async function loadCallLogs(){
  $('call-log-list').replaceChildren();try{const {logs}=await rpc('call:logs',{});if(!logs.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No calls yet.';$('call-log-list').append(empty);return;}for(const log of logs){const row=document.createElement('div');row.className='call-log-item';const icon=document.createElement('span');icon.className='chat-avatar';icon.textContent='☎';const copy=document.createElement('span');copy.className='call-copy';const title=document.createElement('strong');title.textContent=log.name;const when=document.createElement('small');when.textContent=(log.startedBy===user?'Outgoing':'Incoming')+' · '+new Date(log.startedAt).toLocaleString()+(log.endedAt?' · '+Math.max(0,Math.round((log.endedAt-log.startedAt)/1000))+' sec':' · ended');copy.append(title,when);const call=document.createElement('button');call.type='button';call.className='plain';call.textContent='Call';call.onclick=async()=>{await enter({roomId:log.roomId});$('voice-call').click();};row.append(icon,copy,call);$('call-log-list').append(row);}}catch(error){notice(error.message);}
}
function updateProfileVisuals(){if(!profileData)return;$('profile-name').value=profileData.displayName||user;$('profile-avatar-placeholder').textContent=(profileData.displayName||user).charAt(0).toUpperCase();if(profileData.avatarUpdated)loadAvatar($('profile-avatar'),user,profileData.avatarUpdated);}
function showProfile(){updateProfileVisuals();}
function showIncomingCall(payload){if(activeCall)return;incomingCall=payload;$('call-title').textContent='Incoming voice call';$('call-subtitle').textContent=payload.by?payload.by+' is calling':'Tap Join call to answer';$('call-banner').hidden=false;startRingtone();}
async function openRoomFromNotification(request){
  if(!request?.roomId)return;if(!user){pendingOpen=request;return;}
  try{if(currentRoom?.id!==request.roomId)await enter({roomId:request.roomId});if(request.joinCall){showIncomingCall({roomId:request.roomId,callId:request.callId});}}catch(error){notice(error.message);}
}
$('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();clearNotice();const buttons=[...e.currentTarget.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{signedIn(await rpc('auth',{username:$('username').value,password:$('password').value,register:e.submitter?.value==='register'}));if(inviteCode){await enter({roomId:inviteCode});if(requestedCallId)showIncomingCall({roomId:inviteCode,callId:requestedCallId});}}catch(err){notice(err.message);}finally{buttons.forEach(b=>b.disabled=false);}
});
for(const[form,join]of[['create-form',false],['join-form',true]])$(form).addEventListener('submit',async e=>{
  e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;
  try{let code=$('room-code').value.trim();if(join&&/^https?:\/\//i.test(code))code=new URL(code).searchParams.get('room')||'';if(join&&!/^[a-f0-9]{24}$/.test(code))throw new Error('Paste a valid room invite link or code.');await enter(join?{roomId:code}:{roomName:$('room-name').value.trim()});}catch(err){notice(err.message);}finally{button.disabled=false;}
});
$('contact-form').addEventListener('submit',async e=>{e.preventDefault();try{clearNotice();const result=await rpc('direct',{username:$('contact').value});showRoom(result.room);}catch(err){notice(err.message);}});
socket.on('connect',async()=>{
  $('connection').textContent='● Connected';$('send').disabled=false;
  if(token)try{const active=currentRoom?.id;signedIn(await rpc('auth',{token}));if(active||inviteCode){await enter({roomId:active||inviteCode});if(requestedCallId)showIncomingCall({roomId:active||inviteCode,callId:requestedCallId});}}catch(err){token='';user=null;currentRoom=null;try{localStorage.removeItem('lr-token');}catch{}$('auth-panel').hidden=false;$('lobby').hidden=true;$('chat').hidden=true;$('sidebar-chats').hidden=true;$('intro').hidden=false;notice(err.message);}
});
socket.on('disconnect',()=>{if(activeCall)resetCallUi();$('connection').textContent='Reconnecting…';$('send').disabled=true;});
socket.on('connect_error',()=>{$('connection').textContent='Unable to connect';});
socket.on('chats',data=>{chats=data;drawChats();});
socket.on('message',m=>{if(m.roomId===currentRoom?.id){renderMessage(m);$('typing').hidden=true;}else{unread.set(m.roomId,(unread.get(m.roomId)||0)+1);drawChats();if(m.senderId&&m.senderId!==user&&document.visibilityState==='visible')showLocalNotification({type:'message',title:m.name,body:m.attachment?(m.attachment.type==='image'?'Sent a photo':'Sent an audio message'):m.text,roomId:m.roomId,url:'/?room='+m.roomId,tag:'message-'+m.id});}});
socket.on('deleted',m=>renderMessage(m));
socket.on('message:updated',m=>renderMessage(m));
socket.on('block:updated',p=>{if(currentRoom?.id===p.roomId)enter({roomId:p.roomId}).catch(error=>notice(error.message));});
socket.on('profile:updated',p=>{if(p.username===user){profileData={...profileData,avatarUpdated:p.avatarUpdated};updateProfileVisuals();}});
socket.on('members',p=>{if(p.roomId===currentRoom?.id)$('members').textContent=currentRoom.direct?(p.members.includes(currentRoom.name)?'online':'tap for info'):p.members.length+' online';});
socket.on('thinking',p=>{if(p.roomId===currentRoom?.id)$('thinking').hidden=!p.busy;});
socket.on('typing',p=>{if(p.roomId!==currentRoom?.id)return;$('typing').textContent=p.user+' is typing…';$('typing').hidden=false;clearTimeout(typingTimer);typingTimer=setTimeout(()=>$('typing').hidden=true,2200);});
socket.on('call:ring',p=>{if(activeCall)return;if(p.roomId===currentRoom?.id)showIncomingCall(p);else if(document.visibilityState==='visible')showLocalNotification({type:'call',title:'Incoming call from '+p.by,body:'Tap to open and join',roomId:p.roomId,callId:p.callId,url:'/?room='+p.roomId+'&call='+p.callId,tag:'call-'+p.callId});});
socket.on('call:participant-joined',p=>{if(activeCall?.callId===p.callId){$('call-status').textContent='Connected';updateCallCount(Math.max(p.participants,peers.size+1));}else if(!activeCall&&p.roomId===currentRoom?.id){incomingCall=p;$('call-title').textContent='Voice call in progress';$('call-subtitle').textContent='Join '+p.participants+' participant'+(p.participants===1?'':'s');$('call-banner').hidden=false;startRingtone();}});
socket.on('call:participant-left',p=>{if(activeCall?.callId!==p.callId)return;closePeer(p.socketId);updateCallCount(Math.max(p.participants,peers.size+1));});
socket.on('call:ended',p=>{if(activeCall?.callId===p.callId){resetCallUi();notice('Voice call ended.');}else if(incomingCall?.callId===p.callId){stopRingtone();incomingCall=null;$('call-banner').hidden=true;}});
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
  try{const result=await rpc('send',{roomId,text,clientId,replyTo:replyingTo?.id});renderMessage(result.message);pendingRetry=null;drafts.delete(roomId);cancelReply();if(currentRoom?.id===roomId&&$('message').value===text)$('message').value='';}
  catch(err){pendingRetry={text,roomId,clientId};document.getElementById('msg-'+id)?.classList.replace('pending','failed');notice(err.message);}
  finally{sending=false;$('send').disabled=!socket.connected;$('message').focus();}
});
$('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('message-form').requestSubmit();}});
$('message').addEventListener('input',()=>{if(currentRoom&&Date.now()-lastTyped>2000){lastTyped=Date.now();rpc('typing',{roomId:currentRoom.id}).catch(()=>{});}});
$('mention').onclick=()=>{$('message').value+=($('message').value?' ':'')+'@gemini ';$('message').focus();};
$('attachment-button').onclick=()=>{$('attachment-menu').hidden=!$('attachment-menu').hidden;$('chat-menu').hidden=true;};
$('attachment-image').onclick=()=>{$('attachment-menu').hidden=true;$('attach-image').click();};
$('attachment-audio').onclick=()=>{$('attachment-menu').hidden=true;$('attach-audio').click();};
$('attachment-record').onclick=()=>{$('attachment-menu').hidden=true;$('record-audio').click();};
$('attach-image').onclick=()=>$('image-picker').click();
$('attach-audio').onclick=()=>$('audio-picker').click();
for(const id of ['image-picker','audio-picker'])$(id).onchange=event=>{const file=event.target.files?.[0];event.target.value='';if(file)uploadMedia(file).catch(error=>notice(error.message));};
$('record-audio').onclick=()=>{if(mediaRecorder?.state==='recording')stopVoiceNote();else startVoiceNote().catch(error=>notice(error.name==='NotAllowedError'?'Microphone permission is required for voice notes.':error.message));};
$('voice-call').onclick=()=>{if(activeCall)return;joinVoiceCall().catch(e=>notice(e.name==='NotAllowedError'?'Microphone permission is required for voice calls.':e.message));};
$('join-call').onclick=()=>joinVoiceCall().catch(e=>notice(e.name==='NotAllowedError'?'Microphone permission is required for voice calls.':e.message));
$('decline-call').onclick=()=>{stopRingtone();incomingCall=null;$('call-banner').hidden=true;};
$('speaker-call').onclick=()=>{speakerEnabled=!speakerEnabled;for(const audio of $('remote-audio').querySelectorAll('audio'))audio.muted=!speakerEnabled;$('speaker-label').textContent=speakerEnabled?'Speaker':'Speaker off';$('speaker-call').classList.toggle('speaker-off',!speakerEnabled);$('speaker-call').setAttribute('aria-pressed',String(speakerEnabled));};
$('mute-call').onclick=()=>{if(!localStream)return;const enabled=!localStream.getAudioTracks()[0]?.enabled;localStream.getAudioTracks().forEach(track=>track.enabled=enabled);$('mute-label').textContent=enabled?'Mute':'Unmute';$('mute-call').classList.toggle('muted',!enabled);$('mute-call').setAttribute('aria-pressed',String(!enabled));};
$('end-call').onclick=()=>leaveVoiceCall({forEveryone:true});
$('block-contact').onclick=async()=>{if(!currentRoom?.direct)return;try{const result=await rpc('block',{roomId:currentRoom.id,blocked:!currentRoom.blockedByMe});showRoom(result.room);notice(result.room.blockedByMe?'Contact blocked.':'Contact unblocked.');}catch(error){notice(error.message);}};
$('clear-chat').onclick=async()=>{if(!currentRoom||!confirm('Clear all messages in this chat for you?'))return;try{await rpc('clear:chat',{roomId:currentRoom.id});$('messages').replaceChildren();const empty=document.createElement('div');empty.className='empty';empty.textContent='No messages yet';$('messages').append(empty);$('chat-menu').hidden=true;}catch(error){notice(error.message);}};
$('invite').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+'/?room='+currentRoom.id);$('invite').textContent='Copied!';setTimeout(()=>$('invite').textContent='Copy invite',2000);}catch{notice('Copy this invite: '+location.origin+'/?room='+currentRoom.id);}};
$('leave').onclick=$('new-chat').onclick=()=>{showLobby();clearNotice();};
$('cancel-reply').onclick=cancelReply;
$('action-cancel').onclick=closeMessageActions;
$('action-reply').onclick=()=>selectedMessage&&chooseReply(selectedMessage);
$('action-edit').onclick=async()=>{const message=selectedMessage;if(!message)return;const text=prompt('Edit message',message.text||'');if(text===null)return;closeMessageActions();try{await rpc('message:edit',{id:message.id,text});}catch(error){notice(error.message);}};
$('action-delete').onclick=()=>{if(!selectedMessage)return;$('message-actions').hidden=true;$('delete-everyone').hidden=selectedMessage.senderId!==user;$('delete-actions').hidden=false;};
$('delete-cancel').onclick=()=>{$('delete-actions').hidden=true;closeMessageActions();};
$('delete-me').onclick=async()=>{const message=selectedMessage;if(!message)return;try{await rpc('delete',{id:message.id,scope:'me'});document.getElementById('msg-'+message.id)?.remove();}catch(error){notice(error.message);}finally{$('delete-actions').hidden=true;closeMessageActions();}};
$('delete-everyone').onclick=async()=>{const message=selectedMessage;if(!message)return;try{await rpc('delete',{id:message.id,scope:'everyone'});}catch(error){notice(error.message);}finally{$('delete-actions').hidden=true;closeMessageActions();}};
$('message-actions').onclick=event=>{if(event.target===$('message-actions'))closeMessageActions();};
$('delete-actions').onclick=event=>{if(event.target===$('delete-actions')){$('delete-actions').hidden=true;closeMessageActions();}};
$('close-image').onclick=()=>{$('image-viewer').hidden=true;$('full-image').removeAttribute('src');};$('image-viewer').onclick=event=>{if(event.target===$('image-viewer'))$('close-image').click();};
function toggleLobbyPanel(name){for(const panel of $('lobby-panels').querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==name;const target=$('lobby-panels').querySelector('[data-panel="'+name+'"] input');target?.focus();}
$('toolbar-create').onclick=()=>{$('home-menu').hidden=true;toggleLobbyPanel('create');};$('toolbar-join').onclick=()=>{$('home-menu').hidden=true;toggleLobbyPanel('join');};$('toolbar-search').onclick=()=>toggleLobbyPanel('search');$('toolbar-logout').onclick=()=>$('logout').click();
for(const tab of ['chats','calls','profile'])$('tab-'+tab).onclick=()=>showTab(tab);$('profile-shortcut').onclick=()=>$('tab-profile').click();
$('home-menu-button').onclick=()=>{$('home-menu').hidden=!$('home-menu').hidden;};$('chat-menu-button').onclick=()=>{$('chat-menu').hidden=!$('chat-menu').hidden;$('attachment-menu').hidden=true;};
$('home-theme').onclick=toggleTheme;$('chat-theme').onclick=()=>{toggleTheme();$('chat-menu').hidden=true;};
$('menu-notifications').onclick=()=>{$('home-menu').hidden=true;$('enable-notifications').click();};
$('chat-search').oninput=applyChatFilter;for(const button of document.querySelectorAll('.filter-chips button:not(#toolbar-search)'))button.onclick=()=>{document.querySelector('.filter-chips .active')?.classList.remove('active');button.classList.add('active');applyChatFilter();};
document.addEventListener('click',event=>{if(!event.target.closest('#home-menu,#home-menu-button'))$('home-menu').hidden=true;if(!event.target.closest('#chat-menu,#chat-menu-button'))$('chat-menu').hidden=true;if(!event.target.closest('#attachment-menu,#attachment-button'))$('attachment-menu').hidden=true;});
$('profile-photo-button').onclick=()=>$('profile-photo-picker').click();
$('profile-photo-picker').onchange=async event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;if(file.size>3*1024*1024)return notice('Keep the profile photo under 3 MB.');try{const response=await authFetch('/api/profile/avatar',{method:'POST',headers:{'Content-Type':file.type},body:file});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Photo upload failed.');profileData={...profileData,avatarUpdated:result.avatarUpdated};updateProfileVisuals();notice('Profile photo updated.');}catch(error){notice(error.message);}};
$('profile-form').onsubmit=async event=>{event.preventDefault();try{const result=await rpc('profile:update',{displayName:$('profile-name').value});profileData=result.profile;updateProfileVisuals();notice('Profile updated.');}catch(error){notice(error.message);}};
$('install-app').onclick=()=>{location.href='/LiveRooms.apk';};
$('enable-notifications').onclick=()=>enablePush().then(()=>notice('Notifications are on for messages and calls.')).catch(error=>notice(error.message));
$('dismiss-notifications').onclick=()=>{$('notification-prompt').hidden=true;};
navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='open-room')openRoomFromNotification(event.data);});
$('logout').onclick=async()=>{if(activeCall)await leaveVoiceCall();try{const subscription=await swRegistration?.pushManager.getSubscription();if(subscription){await authFetch('/api/push/subscribe',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:subscription.endpoint})});await subscription.unsubscribe();}}catch{}try{await rpc('logout',{token});}catch{}try{localStorage.removeItem('lr-token');}catch{}location.href='/';};
