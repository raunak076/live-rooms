(()=>{
  const cleanPrefix=value=>(value||'').replace(/^[@#]\s*/,'').trim();
  const cleanAllAt=value=>(value||'').replace(/@(?=\w)/g,'').trim();
  let avatar;

  function polish(){
    const identity=document.getElementById('identity');
    if(identity){
      const name=cleanPrefix(identity.textContent);
      if(name)identity.textContent=name;
      const account=identity.closest('.account');
      if(account&&!account.querySelector('.account-avatar')){
        avatar=document.createElement('span');avatar.className='account-avatar';avatar.setAttribute('aria-hidden','true');
        account.prepend(avatar);
      }
      avatar=account?.querySelector('.account-avatar');
      if(avatar&&name)avatar.textContent=name.slice(0,1).toUpperCase();
    }

    document.querySelectorAll('.chat-name').forEach(el=>{el.textContent=cleanPrefix(el.textContent);});
    const roomTitle=document.getElementById('room-title');if(roomTitle)roomTitle.textContent=cleanPrefix(roomTitle.textContent);
    const members=document.getElementById('members');if(members)members.textContent=cleanAllAt(members.textContent);
    const typing=document.getElementById('typing');if(typing)typing.textContent=cleanAllAt(typing.textContent);
    const callSubtitle=document.getElementById('call-subtitle');if(callSubtitle)callSubtitle.textContent=cleanAllAt(callSubtitle.textContent);

    document.querySelectorAll('.meta strong').forEach(el=>{
      const value=el.textContent||'';
      if(value.startsWith('✦'))el.textContent='Gemini';
      else el.textContent=cleanPrefix(value);
    });
  }

  new MutationObserver(polish).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  addEventListener('DOMContentLoaded',polish);
})();
