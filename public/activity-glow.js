// Visual feedback follows existing UI state; this layer never sends messages or changes calls.
(()=>{
  const chat=document.getElementById('chat');
  const messages=document.getElementById('messages');
  const upload=document.getElementById('upload-status');
  const thinking=document.getElementById('thinking');
  const typing=document.getElementById('typing');
  if(!chat||!messages||!upload||!thinking||!typing)return;

  function syncActivity(){
    const visible=!chat.hidden;
    chat.classList.toggle('lr-processing',visible&&(!upload.hidden||!thinking.hidden||Boolean(messages.querySelector('.pending'))));
    chat.classList.toggle('lr-typing',visible&&!typing.hidden);
  }
  const observer=new MutationObserver(syncActivity);
  observer.observe(chat,{attributes:true,attributeFilter:['hidden']});
  for(const status of [upload,thinking,typing])observer.observe(status,{attributes:true,attributeFilter:['hidden']});
  observer.observe(messages,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});

  // App.js sets the person's name and visibility first. Keep that text safe, then add motion.
  if(typeof socket!=='undefined')socket.on('typing',event=>{
    if(event.roomId!==currentRoom?.id||typing.hidden)return;
    const dots=document.createElement('span');dots.className='lr-typing-dots';dots.setAttribute('aria-hidden','true');
    for(let i=0;i<3;i++)dots.append(document.createElement('i'));
    typing.append(dots);
    syncActivity();
  });
  syncActivity();
})();
