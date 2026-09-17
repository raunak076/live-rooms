// Mobile/PWA reliability fixes layered on top of the existing chat app.
// Keep this file small so the locked login -> contacts -> chat flow stays untouched.

let callVibrationTimer=null;
let installWatchTimer=null;

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

function isStandalone(){
  return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
}

function refreshInstallButton(){
  if(isStandalone()){
    $('install-app').hidden=true;
    $('install-app').disabled=false;
    $('install-app').textContent='⬇ Install app';
    return;
  }
  const isMobile=/android|iphone|ipad|ipod/i.test(navigator.userAgent);
  $('install-app').hidden=!isMobile&&!installPrompt;
}

function installConfirmed(){
  clearTimeout(installWatchTimer);
  installWatchTimer=null;
  installPrompt=null;
  $('install-app').disabled=false;
  $('install-app').textContent='⬇ Install app';
  $('install-app').hidden=true;
  notice('Live Rooms is installed. Open it from your Android app drawer or home screen.');
}

refreshInstallButton();
window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  installPrompt=event;
  $('install-app').hidden=false;
  $('install-app').disabled=false;
  $('install-app').textContent='⬇ Install app';
});
window.addEventListener('appinstalled',installConfirmed);
window.addEventListener('pageshow',refreshInstallButton);

$('install-app').onclick=async()=>{
  if(isStandalone()){installConfirmed();return;}

  if(installPrompt){
    const prompt=installPrompt;
    $('install-app').disabled=true;
    $('install-app').textContent='Installing…';
    await prompt.prompt();
    const choice=await prompt.userChoice.catch(()=>null);

    if(choice?.outcome!=='accepted'){
      $('install-app').disabled=false;
      $('install-app').textContent='⬇ Install app';
      installPrompt=null;
      notice('Installation was cancelled. Tap Install app when you want to try again.');
      return;
    }

    // Android may accept the prompt before the WebAPK is actually installed.
    // Do not report success until Chrome fires appinstalled / standalone mode is observed.
    installWatchTimer=setTimeout(()=>{
      if(isStandalone()){installConfirmed();return;}
      $('install-app').disabled=false;
      $('install-app').textContent='⬇ Install app';
      notice('Android accepted the install request but did not finish creating the app. In Chrome, open ⋮ → Install app / Add to Home screen and retry. If Chrome stays on “Installing…”, update Chrome and Google Play services, then retry.');
    },12000);
    return;
  }

  if(/android/i.test(navigator.userAgent)){
    notice('Chrome has not exposed the Android install prompt yet. Keep this page open briefly, then use ⋮ → Install app. If Chrome only shows “Installing…” and no app appears in the app drawer, the WebAPK install is failing at Android/Chrome level rather than inside Live Rooms.');
  }else if(/iphone|ipad|ipod/i.test(navigator.userAgent)){
    notice('On iPhone/iPad: tap Share, then “Add to Home Screen”.');
  }else{
    notice('Use your browser menu and choose “Install app” or “Add to Home screen”.');
  }
};

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    refreshInstallButton();
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
