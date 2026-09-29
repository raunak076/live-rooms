// Mobile/PWA reliability fixes layered on top of the existing chat app.
// Keep this file small so the locked login -> contacts -> chat flow stays untouched.

let callVibrationTimer=null;

if(nativeAndroid)document.body.classList.add('native-android');
if(!document.querySelector('link[data-voice-studio]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/voice-studio.css?v=1';link.dataset.voiceStudio='1';document.head.append(link);}
if(!document.querySelector('script[data-voice-studio]')){const script=document.createElement('script');script.src='/voice-studio.js?v=1';script.defer=true;script.dataset.voiceStudio='1';document.head.append(script);}

// Reconnects should never sign the user out because a room refresh or socket RPC timed out.
// /api/sync is authoritative: it only clears the saved session on a real HTTP 401.
socket.off('connect');
socket.on('connect',async()=>{
  $('connection').textContent='Restoring your chats…';$('send').disabled=true;
  if(!token){$('connection').textContent='● Connected';finishBoot();return;}
  const active=currentRoom?.id||'';
  try{
    await syncSession();
    if(!token)return;
    if(!user){
      // A temporary HTTP failure must keep the splash visible, not expose the
      // sign-in form while a saved session is still being checked.
      setTimeout(()=>{if(token&&socket.connected&&!user){socket.disconnect();socket.connect();}},3000);
      return;
    }
    // HTTP restores the view, but each new Socket.IO connection must join the
    // user's rooms before any chat, call, or message RPC is sent.
    await rpc('auth',{token});
    $('connection').textContent='● Connected';
    $('send').disabled=Boolean(currentRoom?.blockedByMe||currentRoom?.blockedMe);
    setTimeout(()=>{if(user&&socket.connected)loadCallLogs({silent:true});},200);
    if(!active&&inviteCode){
      try{const result=await rpc('enter',{roomId:inviteCode});showRoom(result.room);}
      catch(error){notice(error.message);showLobby({skipAnimation:true});}
    }
    if(requestedCallId&&currentRoom?.id)showIncomingCall({roomId:currentRoom.id,callId:requestedCallId});
  }catch(error){
    console.warn('Session reconnect retry:',error.message);
    $('connection').textContent='Reconnecting…';
    if(token&&socket.connected)setTimeout(()=>{if(token&&socket.connected)rpc('auth',{token}).then(()=>{$('connection').textContent='● Connected';$('send').disabled=Boolean(currentRoom?.blockedByMe||currentRoom?.blockedMe);}).catch(()=>{});},2000);
  }finally{if(user||!token)finishBoot();}
});

// Voice recording reliability: both the red stop control and the normal Send button
// stop the recorder. MediaRecorder.onstop in app.js then finalizes and uploads the blob.
const recordingStyle=document.createElement('style');
recordingStyle.textContent=`
  #attachment-button.recording,#record-audio.recording{
    background:#d93025!important;color:#fff!important;border-color:#d93025!important;
    box-shadow:0 0 0 3px rgba(217,48,37,.16)!important;
    animation:lr-record-pulse 1.15s ease-in-out infinite;
  }
  body.voice-recording #send{opacity:1!important;pointer-events:auto!important;}
  @keyframes lr-record-pulse{50%{transform:scale(.94);box-shadow:0 0 0 7px rgba(217,48,37,.08)}}
`;
document.head.append(recordingStyle);

const baseStartVoiceNote=startVoiceNote;
startVoiceNote=async function(...args){
  await baseStartVoiceNote(...args);
  if(mediaRecorder?.state==='recording'){
    document.body.classList.add('voice-recording');
    $('attachment-button').setAttribute('aria-label','Stop and send voice note');
    $('attachment-button').title='Stop & send';
    $('send').disabled=false;
    const activeRecorder=mediaRecorder;
    activeRecorder.addEventListener('stop',()=>{
      document.body.classList.remove('voice-recording');
      $('attachment-button').setAttribute('aria-label','Add attachment');
      $('attachment-button').removeAttribute('title');
      if(socket.connected&&!uploading)$('send').disabled=false;
    },{once:true});
  }
};

// Capture submit before the normal text-message submit handler. While recording,
// Send means "stop and send this voice note" even when the textarea is empty.
$('message-form').addEventListener('submit',event=>{
  if(mediaRecorder?.state!=='recording')return;
  event.preventDefault();
  event.stopImmediatePropagation();
  stopVoiceNote();
},{capture:true});

// A selected custom voice must only send converted audio. If conversion fails,
// surface the real error and keep the original recording out of the chat.
uploadClonedVoice=async function(file,modelId){
  if(!currentRoom||uploading||!modelId||!file?.size)return;
  if(file.size>8*1024*1024)throw new Error('Keep the source voice note under 8 MB.');
  const roomId=currentRoom.id;
  setUploadState(true,'Converting custom singing voice…');clearNotice();
  try{
    const response=await authFetch('/api/voices/'+encodeURIComponent(modelId)+'/clone/'+encodeURIComponent(roomId),{
      method:'POST',headers:{'Content-Type':file.type},body:file
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||'Custom voice conversion failed. Original audio was not sent.');
    if(currentRoom?.id===roomId)renderMessage(result.message);
  }finally{
    setUploadState(false);
  }
};

function sameApplicationServerKey(subscription,publicKey){
  const current=subscription?.options?.applicationServerKey;
  if(!current)return false;
  const left=new Uint8Array(current),right=base64Key(publicKey);
  if(left.length!==right.length)return false;
  for(let i=0;i<left.length;i++)if(left[i]!==right[i])return false;
  return true;
}

const baseStartRingtone=startRingtone;
const baseStopRingtone=stopRingtone;

startRingtone=function(){
  baseStartRingtone();
  clearInterval(callVibrationTimer);
  const vibrate=()=>navigator.vibrate?.([700,250,700,250,900]);
  vibrate();
  callVibrationTimer=setInterval(vibrate,3000);
};

stopRingtone=function(){
  clearInterval(callVibrationTimer);
  callVibrationTimer=null;
  baseStopRingtone();
};

enablePush=async function(){
  if(nativeAndroid&&window.LiveRoomsNative){
    window.LiveRoomsNative.startNotifications(token,user||'');
    notificationsEnabled=true;
    $('notification-prompt').hidden=true;
    return;
  }
  unlockRingtone();
  if(!swRegistration||!('Notification'in window)||!('PushManager'in window))throw new Error('Notifications are not supported in this browser.');
  const permission=await Notification.requestPermission();
  if(permission!=='granted')throw new Error('Notification permission was not allowed. You can enable it later in browser settings.');

  await swRegistration.update().catch(()=>{});
  const response=await fetch('/api/push/public-key');
  if(!response.ok)throw new Error('Could not load notification settings.');
  const {publicKey}=await response.json();
  if(!publicKey)throw new Error('Notification settings are incomplete.');

  let subscription=await swRegistration.pushManager.getSubscription();
  if(subscription&&!sameApplicationServerKey(subscription,publicKey)){
    await subscription.unsubscribe().catch(()=>{});
    subscription=null;
  }
  if(!subscription){
    subscription=await swRegistration.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:base64Key(publicKey)
    });
  }

  const saved=await authFetch('/api/push/subscribe',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(subscription)
  });
  if(!saved.ok)throw new Error((await saved.json().catch(()=>({}))).error||'Could not enable notifications.');
  notificationsEnabled=true;
  $('notification-prompt').hidden=true;
};

$('install-app').hidden=true;

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    if(incomingCall&&!activeCall)startRingtone();
  }
});

navigator.serviceWorker?.addEventListener('message',event=>{
  if(event.data?.type!=='push-received')return;
  const payload=event.data.payload;
  if(payload?.type==='call'&&!activeCall&&payload.roomId===currentRoom?.id&&incomingCall?.callId!==payload.callId){
    showIncomingCall(payload);
  }
});

// Load the small production polish layer after all base globals above are ready.
if(!document.querySelector('script[data-production-polish]')){const script=document.createElement('script');script.src='/production-polish.js?v=1';script.defer=true;script.dataset.productionPolish='1';document.head.append(script);}
