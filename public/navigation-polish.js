// Navigation reliability layer for Android/PWA. Loaded after app.js + voice studio.
(()=>{
  const isAndroid=/LiveRoomsAndroid\//.test(navigator.userAgent);
  if(isAndroid)document.documentElement.classList.add('native-android');

  const tabOrder=['chats','calls','profile'];
  const viewFor=tab=>tab==='chats'?document.getElementById('lobby'):document.getElementById(tab+'-view');
  const originalShowTab=typeof showTab==='function'?showTab:null;
  let tabAnimation=null,lastTab=typeof activeTab==='string'?activeTab:'chats';

  if(originalShowTab){
    showTab=function polishedShowTab(tab,{animate=true}={}){
      if(!tabOrder.includes(tab))return;
      const previous=typeof activeTab==='string'?activeTab:lastTab;
      if(tab===previous){originalShowTab(tab,{animate:false});lastTab=tab;return;}
      const direction=tabOrder.indexOf(tab)>tabOrder.indexOf(previous)?1:-1;
      tabAnimation?.cancel?.();
      originalShowTab(tab,{animate:false});
      lastTab=tab;
      const target=viewFor(tab);
      if(!target||!animate||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      target.getAnimations().forEach(animation=>{if(animation.id==='lr-tab-polish')animation.cancel();});
      tabAnimation=target.animate([
        {opacity:.94,transform:`translate3d(${direction*22}px,0,0)`},
        {opacity:1,transform:'translate3d(0,0,0)'}
      ],{duration:220,easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'});
      tabAnimation.id='lr-tab-polish';
      tabAnimation.finished.catch(()=>{}).finally(()=>{if(tabAnimation){target.style.opacity='';target.style.transform='';tabAnimation=null;}});
    };
  }

  // Never treat a call created by this same signed-in user as an incoming call.
  // This protects the WebView side when multiple sockets exist for the Android wrapper.
  if(typeof showIncomingCall==='function'){
    const baseShowIncomingCall=showIncomingCall;
    showIncomingCall=function safeIncomingCall(payload){if(payload?.by&&payload.by===user)return;baseShowIncomingCall(payload);};
  }

  // Smoother text send motion: short lift from composer + gentle target grow.
  if(typeof animateSendFlight==='function'){
    animateSendFlight=function polishedSendFlight(id,text){
      const target=document.querySelector('#'+CSS.escape('msg-'+id)+' .bubble'),source=document.getElementById('message-form');
      if(!target||!source||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      const from=source.getBoundingClientRect(),to=target.getBoundingClientRect(),ghost=document.createElement('span');
      ghost.className='send-flight';ghost.textContent=text.trim().slice(0,42);
      const startX=from.left+Math.min(from.width*.58,from.width-80),startY=from.top+8;
      const endX=to.left+Math.min(to.width*.5,72),endY=to.top+Math.min(to.height*.45,24);
      ghost.style.left=startX+'px';ghost.style.top=startY+'px';document.body.append(ghost);
      const dx=endX-startX,dy=endY-startY;
      ghost.animate([
        {opacity:0,transform:'translate3d(0,8px,0) scale(.78)'},
        {opacity:.82,transform:`translate3d(${dx*.42}px,${dy*.36-5}px,0) scale(.94)`,offset:.48},
        {opacity:0,transform:`translate3d(${dx}px,${dy}px,0) scale(.82)`}
      ],{duration:320,easing:'cubic-bezier(.2,.72,.24,1)',fill:'forwards'}).finished.finally(()=>ghost.remove());
      target.animate([{transform:'scale(.97)'},{transform:'scale(1.012)',offset:.65},{transform:'scale(1)'}],{duration:260,easing:'cubic-bezier(.18,.82,.25,1.08)'}).finished.catch(()=>{});
    };
  }

  function hideIfOpen(id){const element=document.getElementById(id);if(!element||element.hidden)return false;element.hidden=true;return true;}
  function closeVoiceStudio(){const studio=document.getElementById('voice-studio');if(!studio||studio.hidden)return false;document.getElementById('voice-studio-close')?.click();return true;}
  function closeTransientUi(){
    let closed=false;
    for(const id of ['attachment-menu','emoji-sticker-tray','chat-menu','home-menu'])closed=hideIfOpen(id)||closed;
    return closed;
  }

  window.handleNativeBack=()=>{
    if(closeVoiceStudio())return true;
    if(!document.getElementById('image-viewer')?.hidden){document.getElementById('close-image')?.click();return true;}
    if(hideIfOpen('theme-picker'))return true;
    if(!document.getElementById('message-actions')?.hidden){typeof closeMessageActions==='function'&&closeMessageActions();return true;}
    if(hideIfOpen('voice-effect-picker'))return true;
    if(!document.getElementById('delete-actions')?.hidden){hideIfOpen('delete-actions');typeof closeMessageActions==='function'&&closeMessageActions();return true;}
    if(closeTransientUi())return true;
    const panel=document.querySelector('#lobby-panels [data-panel]:not([hidden])');if(panel){panel.hidden=true;return true;}
    if(typeof activeCall!=='undefined'&&activeCall&&!document.getElementById('active-call')?.hidden){
      // Back never hangs up a live call accidentally. Keep the call screen active.
      return true;
    }
    if(typeof currentRoom!=='undefined'&&currentRoom){showLobby();typeof clearNotice==='function'&&clearNotice();return true;}
    if(typeof activeTab==='string'&&activeTab!=='chats'){showTab('chats');return true;}
    return false;
  };

  // Keep browser/PWA back aligned with the in-app stack without creating history loops.
  let handlingPop=false;
  const pushViewState=state=>{if(handlingPop)return;const current=history.state||{};if(JSON.stringify(current.lrView)===JSON.stringify(state))return;history.pushState({...current,lrView:state},'');};
  for(const tab of tabOrder){const button=document.getElementById('tab-'+tab);button?.addEventListener('click',()=>{if(tab!==''&&tab!=='chats')pushViewState({type:'tab',tab});},{capture:false});}
  document.getElementById('leave')?.addEventListener('click',()=>history.replaceState({...history.state,lrView:{type:'home'}},''),{capture:false});
  addEventListener('popstate',()=>{
    handlingPop=true;
    try{if(window.handleNativeBack?.()===false&&typeof activeTab==='string'&&activeTab!=='chats')showTab('chats');}finally{queueMicrotask(()=>{handlingPop=false;});}
  });

  // Prevent stale transform/opacity values after interrupted gestures or app resumes.
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;for(const id of ['lobby','calls-view','profile-view','chat']){const el=document.getElementById(id);if(!el)continue;if(!el.classList.contains('tab-drag-surface')&&!el.classList.contains('chat-dragging')){el.style.transform='';el.style.opacity='';}}});
})();
