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
  $('connection').textContent='● Connected';$('send').disabled=false;
  if(!token){finishBoot();return;}
  const active=currentRoom?.id||'';
  try{
    await syncSession();
    if(!token||!user)return;
    if(!active&&inviteCode){
      try{const result=await rpc('enter',{roomId:inviteCode});showRoom(result.room);}
      catch(error){notice(error.message);showLobby({skipAnimation:true});}
    }
    if(requestedCallId&&currentRoom?.id)showIncomingCall({roomId:currentRoom.id,callId:requestedCallId});
  }catch(error){
    console.warn('Session reconnect retry:',error.message);
    $('connection').textContent='Reconnecting…';
  }finally{finishBoot();}
});

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
