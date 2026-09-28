// Production reliability layer for voice calls, notifications and Android UX.

// Never create a duplicate local notification while the chat is already visible.
showLocalNotification=async function(payload){
  if(document.visibilityState==='visible')return;
  if(!notificationsEnabled||!swRegistration||Notification.permission!=='granted')return;
  await swRegistration.showNotification(payload.title||'Live Chat',{
    body:payload.body||'',icon:'/icon-192.png',badge:'/icon-192.png',tag:payload.tag||'live-chat',
    data:{roomId:payload.roomId,callId:payload.callId,type:payload.type,url:payload.url||'/'}
  }).catch(()=>{});
};

// Tune Opus for speech resilience. TURN controls reachability; these settings
// improve intelligibility when packets are lost or bandwidth fluctuates.
function lrTuneOpusSdp(sdp){
  if(!sdp)return sdp;
  const match=sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if(!match)return sdp;
  const pt=match[1],wanted=['minptime=10','useinbandfec=1','usedtx=1','maxaveragebitrate=64000'];
  const fmtp=new RegExp('a=fmtp:'+pt+' ([^\\r\\n]*)','i');
  if(fmtp.test(sdp))return sdp.replace(fmtp,(line,params)=>{
    const lower=params.toLowerCase();
    const missing=wanted.filter(item=>!lower.includes(item.split('=')[0].toLowerCase()+'='));
    return missing.length?line+';'+missing.join(';'):line;
  });
  const rtpmap=new RegExp('(a=rtpmap:'+pt+' opus\\/48000\\/2[^\\r\\n]*)(\\r?\\n)','i');
  return sdp.replace(rtpmap,'$1$2a=fmtp:'+pt+' '+wanted.join(';')+'$2');
}

if(window.RTCPeerConnection&&!RTCPeerConnection.prototype.__liveRoomsAudioTuned){
  const proto=RTCPeerConnection.prototype,nativeSetLocalDescription=proto.setLocalDescription;
  proto.setLocalDescription=function(description){
    if(description?.sdp&&/^(offer|answer)$/.test(description.type||''))description={type:description.type,sdp:lrTuneOpusSdp(description.sdp)};
    return nativeSetLocalDescription.call(this,description);
  };
  Object.defineProperty(proto,'__liveRoomsAudioTuned',{value:true});
}

function lrTuneCallSender(peer){
  const sender=peer?.getSenders?.().find(item=>item.track?.kind==='audio'),track=sender?.track;
  if(track){
    try{track.contentHint='speech';}catch{}
    track.applyConstraints?.({echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:48000}).catch(()=>{});
  }
  if(!sender?.getParameters||!sender?.setParameters)return;
  try{
    const parameters=sender.getParameters();
    parameters.encodings=parameters.encodings?.length?parameters.encodings:[{}];
    parameters.encodings[0].maxBitrate=64000;
    parameters.encodings[0].priority='high';
    sender.setParameters(parameters).catch(()=>{});
  }catch{}
}

const lrBaseCreatePeer=createPeer;
createPeer=function(socketId,initiator=false){const peer=lrBaseCreatePeer(socketId,initiator);lrTuneCallSender(peer);return peer;};
const lrBaseJoinVoiceCall=joinVoiceCall;
joinVoiceCall=async function(...args){
  await lrBaseJoinVoiceCall(...args);
  const track=localStream?.getAudioTracks?.()[0];
  if(track){try{track.contentHint='speech';}catch{}track.applyConstraints?.({echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:48000}).catch(()=>{});}
  for(const peer of peers.values())lrTuneCallSender(peer);
};

// Keep expensive visual effects away from active scrolling on Android.
if(nativeAndroid){
  let scrollIdle;
  const markScrolling=()=>{document.body.classList.add('android-scrolling');clearTimeout(scrollIdle);scrollIdle=setTimeout(()=>document.body.classList.remove('android-scrolling'),120);};
  for(const element of [$('messages'),$('lobby'),$('calls-view'),$('profile-view')])element?.addEventListener('scroll',markScrolling,{passive:true});
}
