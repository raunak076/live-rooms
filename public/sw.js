const CACHE='live-rooms-shell-v4';
const SHELL=['/','/style.css?v=android-push-call-2','/mobile-fix.css?v=android-push-call-2','/features.css?v=android-push-call-2','/app.js?v=android-push-call-2','/manifest.webmanifest','/favicon.svg','/icon-192.png','/icon-512.png'];

self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/socket.io/'))return;
  event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}return response;}).catch(()=>caches.match(event.request).then(cached=>cached||caches.match('/'))));
});
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let data={};try{data=event.data?.json()||{};}catch{data={title:'Live Rooms',body:event.data?.text()||'You have a new update.'};}
    if(data.type==='call-ended'){for(const notification of await self.registration.getNotifications({tag:data.tag}))notification.close();return;}
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const focused=clients.some(client=>client.focused||client.visibilityState==='visible');
    for(const client of clients)client.postMessage({type:'push-received',payload:data});
    if(focused&&data.type!=='call')return;
    await self.registration.showNotification(data.title||'Live Rooms',{
      body:data.body||'',icon:'/icon-192.png',badge:'/icon-192.png',tag:data.tag||'live-rooms',renotify:data.type==='call',requireInteraction:data.type==='call',silent:false,timestamp:data.at||Date.now(),vibrate:data.type==='call'?[700,250,700,650,700]:[180,80,180],
      data:{url:data.url||'/',roomId:data.roomId,callId:data.callId,type:data.type,by:data.by},actions:data.type==='call'?[{action:'join',title:'Answer'},{action:'decline',title:'Decline'}]:[{action:'open',title:'Open'}]
    });
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();if(event.action==='decline')return;
  event.waitUntil((async()=>{
    const data=event.notification.data||{},windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    if(windows.length){windows[0].postMessage({type:'open-room',roomId:data.roomId,callId:data.callId,joinCall:data.type==='call'});return windows[0].focus();}
    return self.clients.openWindow(data.url||'/');
  })());
});
