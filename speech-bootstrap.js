// Speech-accuracy bootstrap. Runs before fish-bootstrap.js and improves voice-note transcription
// without changing the established voice provider pipeline.
const baseFetch=globalThis.fetch.bind(globalThis);
const GEMINI_HOST='https://generativelanguage.googleapis.com/';

function candidateText(data){return data?.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('').trim()||'';}
function transcriptionRequest(body){
  if(!body||typeof body!=='object')return null;
  for(const content of body.contents||[])for(const part of content.parts||[]){
    const text=String(part.text||'');
    if(/transcribe this audio exactly/i.test(text)){
      const audio=(content.parts||[]).find(item=>item.inlineData?.data||item.inline_data?.data);
      if(audio)return{content,audio,text};
    }
  }
  return null;
}
function normalizedAudio(part){const source=part.inlineData||part.inline_data;return{inlineData:{mimeType:source.mimeType||source.mime_type||'audio/webm',data:source.data}};}
async function tryDedicatedTranscribe(originalInit,audioPart){
  const key=new Headers(originalInit.headers||{}).get('x-goog-api-key');if(!key)return null;
  const response=await baseFetch(GEMINI_HOST+'v1beta/models/gemini-3.5-transcribe:generateContent',{
    method:'POST',signal:AbortSignal.timeout(120000),headers:{'Content-Type':'application/json','x-goog-api-key':key},
    body:JSON.stringify({contents:[{role:'user',parts:[normalizedAudio(audioPart)]}],generationConfig:{audioTranscriptionConfig:{languageCodes:[],mode:'VERBATIM'}}})
  });
  const data=await response.json().catch(()=>({}));
  if(response.ok&&candidateText(data))return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  return null;
}

globalThis.fetch=async function speechAwareFetch(input,init={}){
  const url=String(input);
  if(!url.startsWith(GEMINI_HOST)||typeof init.body!=='string')return baseFetch(input,init);
  let body;try{body=JSON.parse(init.body);}catch{return baseFetch(input,init);}
  const request=transcriptionRequest(body);if(!request)return baseFetch(input,init);

  try{const dedicated=await tryDedicatedTranscribe(init,request.audio);if(dedicated)return dedicated;}catch(error){console.warn('Dedicated Gemini transcription fallback:',error.message);}

  const strict='Transcribe the recording verbatim. The speaker may use Hindi (hi-IN), Indian English (en-IN), or Hinglish/code-switching inside the same sentence. Preserve the actual spoken words and language switches. Do not translate, paraphrase, summarize, autocorrect into different words, or invent words that were not spoken. Preserve names and proper nouns as heard. For clearly spoken Hindi, use natural Devanagari; keep English words in Latin script. If a tiny portion is genuinely unintelligible, omit only that uncertain portion instead of guessing. Return only the transcript, with no explanation.';
  request.content.parts=request.content.parts.map(part=>part===request.audio?normalizedAudio(part):part.text!==undefined?{text:strict}:part);
  body.generationConfig={...(body.generationConfig||{}),temperature:0};
  return baseFetch(input,{...init,body:JSON.stringify(body)});
};

await import('./fish-bootstrap.js');