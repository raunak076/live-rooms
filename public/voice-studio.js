// Typed text playground for the user's own approved singer voice.
// Loaded after app.js so it can reuse authFetch() and the existing preview endpoint.
(()=>{
  if(typeof previewVoice!=='function'||typeof authFetch!=='function')return;
  let activeVoice=null,playingAudio=null,playingUrl='',busy=false;

  const escapeText=value=>String(value||'').slice(0,160);
  function ensureStudio(){
    let root=document.getElementById('voice-studio');
    if(root)return root;
    root=document.createElement('div');
    root.id='voice-studio';root.className='voice-studio-backdrop';root.hidden=true;
    root.innerHTML=`<section class="voice-studio" role="dialog" aria-modal="true" aria-labelledby="voice-studio-title">
      <header><button id="voice-studio-close" class="voice-studio-back" type="button" aria-label="Close">‹</button><div><strong id="voice-studio-title">Voice Studio</strong><small id="voice-studio-owner"></small></div><span class="voice-studio-badge">AI voice</span></header>
      <div id="voice-studio-messages" class="voice-studio-messages"><div class="voice-studio-empty"><span>♫</span><strong>Type anything below</strong><small>Hindi, English and Hinglish text can be tested directly without microphone transcription.</small></div></div>
      <form id="voice-studio-form" class="voice-studio-composer"><textarea id="voice-studio-text" rows="1" maxlength="160" placeholder="Type what this voice should say…" required></textarea><button id="voice-studio-speak" type="submit" aria-label="Speak text">▶</button></form>
    </section>`;
    document.body.append(root);
    root.querySelector('#voice-studio-close').onclick=closeStudio;
    root.addEventListener('click',event=>{if(event.target===root)closeStudio();});
    root.querySelector('#voice-studio-form').onsubmit=async event=>{event.preventDefault();const input=root.querySelector('#voice-studio-text'),text=escapeText(input.value.trim());if(!text||busy||!activeVoice)return;input.value='';await speakText(text);};
    root.querySelector('#voice-studio-text').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();root.querySelector('#voice-studio-form').requestSubmit();}});
    return root;
  }
  function closeStudio(){const root=document.getElementById('voice-studio');if(root)root.hidden=true;playingAudio?.pause();}
  function addBubble(kind,text,{loading=false,audioUrl=''}={}){
    const root=ensureStudio(),list=root.querySelector('#voice-studio-messages');list.querySelector('.voice-studio-empty')?.remove();
    const row=document.createElement('div');row.className='voice-studio-row '+kind;
    const bubble=document.createElement('div');bubble.className='voice-studio-bubble';
    if(kind==='voice'){const label=document.createElement('strong');label.textContent=activeVoice?.name||'Voice';bubble.append(label);}
    const copy=document.createElement('span');copy.textContent=loading?'Generating voice…':text;bubble.append(copy);
    if(audioUrl){const replay=document.createElement('button');replay.type='button';replay.className='voice-studio-replay';replay.textContent='▶ Play again';replay.onclick=()=>{playingAudio?.pause();playingAudio=new Audio(audioUrl);playingAudio.play().catch(()=>{});};bubble.append(replay);}
    row.append(bubble);list.append(row);list.scrollTop=list.scrollHeight;return{row,bubble,copy};
  }
  async function speakText(text){
    const root=ensureStudio(),button=root.querySelector('#voice-studio-speak');busy=true;button.disabled=true;addBubble('me',text);const pending=addBubble('voice','',{loading:true});
    try{
      const response=await authFetch('/api/voices/'+encodeURIComponent(activeVoice.id)+'/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
      if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||'Voice generation failed.');}
      const blob=await response.blob(),url=URL.createObjectURL(blob);if(playingUrl)URL.revokeObjectURL(playingUrl);playingUrl=url;pending.row.remove();addBubble('voice',text,{audioUrl:url});playingAudio?.pause();playingAudio=new Audio(url);await playingAudio.play();
    }catch(error){pending.copy.textContent=error.message||'Could not generate this voice.';pending.row.classList.add('error');}
    finally{busy=false;button.disabled=false;root.querySelector('#voice-studio-text').focus();}
  }
  function openStudio(voice){
    activeVoice=voice;const root=ensureStudio();root.querySelector('#voice-studio-title').textContent=voice.name;root.querySelector('#voice-studio-owner').textContent='@'+voice.owner+' · typed text test';root.hidden=false;requestAnimationFrame(()=>root.classList.add('ready'));root.querySelector('#voice-studio-text').focus();
  }

  const originalPreview=previewVoice;
  previewVoice=async function(voice,button){
    if(!voice?.id)return originalPreview(voice,button);
    openStudio(voice);
  };
})();