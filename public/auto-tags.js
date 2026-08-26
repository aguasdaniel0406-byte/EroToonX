/* NightInk · motor local de categorías: WD Tagger + OCR + título + memoria de serie. */
const ORT_VERSION="1.27.0";
const ORT_URL=`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`;
const ORT_WASM_BASE=`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const WD_MODEL_URL="https://huggingface.co/KidiXDev/wd-swinv2-tagger-v3-quint8/resolve/main/model.onnx";
const WD_TAGS_URL="https://huggingface.co/KidiXDev/wd-swinv2-tagger-v3-quint8/resolve/main/selected_tags.csv";
const TESSERACT_URL="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const IMAGE_SIZE=448;
const WD_THRESHOLD=0.20;
const MAX_VISUAL_IMAGES=8;
const MAX_OCR_IMAGES=10;
const MAX_RESULTS=32;
const MIN_RESULT_SCORE=0.58;

let ortPromise=null;
let wdSessionPromise=null;
let wdLabelsPromise=null;
let ocrLibPromise=null;
let ocrWorkerPromise=null;
let cancelGeneration=0;

function norm(value=""){
  return String(value||"")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/['’`´]/g," ")
    .replace(/[_–—-]+/g," ")
    .replace(/[^a-z0-9ñ\s]/gi," ")
    .replace(/\s+/g," ")
    .trim();
}
function splitAliases(value=""){return String(value||"").split(",").map(x=>x.trim()).filter(Boolean)}
function sleep(ms=0){return new Promise(resolve=>setTimeout(resolve,ms))}
function nextPaint(){return new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)))}
function emit(onProgress,phase,percent,text,extra={}){
  onProgress?.({phase,percent:Math.max(0,Math.min(100,Math.round(percent||0))),text:String(text||""),...extra});
}
function assertNotCancelled(generation){if(generation!==cancelGeneration)throw new Error("Análisis cancelado.")}
function loadScript(src){
  return new Promise((resolve,reject)=>{
    const existing=[...document.scripts].find(s=>s.src===src);
    if(existing){if(existing.dataset.loaded==="1"||existing.readyState==="complete")return resolve();existing.addEventListener("load",resolve,{once:true});existing.addEventListener("error",()=>reject(new Error(`No se pudo cargar ${src}`)),{once:true});return}
    const s=document.createElement("script");s.src=src;s.async=true;
    s.onload=()=>{s.dataset.loaded="1";resolve()};s.onerror=()=>reject(new Error(`No se pudo cargar ${src}`));document.head.appendChild(s);
  });
}
async function getOrt(){
  if(!ortPromise)ortPromise=(async()=>{await loadScript(ORT_URL);if(!window.ort)throw new Error("ONNX Runtime no está disponible.");window.ort.env.wasm.wasmPaths=ORT_WASM_BASE;window.ort.env.wasm.proxy=true;window.ort.env.wasm.numThreads=globalThis.crossOriginIsolated?Math.max(1,Math.min(4,navigator.hardwareConcurrency||2)):1;return window.ort})();
  return ortPromise;
}
function parseCsvLine(line){const out=[];let cur="",quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(quoted&&line[i+1]==='"'){cur+='"';i++}else quoted=!quoted}else if(ch===","&&!quoted){out.push(cur);cur=""}else cur+=ch}out.push(cur);return out}
async function getWdLabels(){
  if(!wdLabelsPromise)wdLabelsPromise=(async()=>{const r=await fetch(WD_TAGS_URL,{cache:"force-cache"});if(!r.ok)throw new Error("No se pudo descargar el diccionario del tagger visual.");const text=await r.text(),lines=text.trim().split(/\r?\n/),header=parseCsvLine(lines.shift()).map(x=>x.trim()),nameI=header.indexOf("name"),catI=header.indexOf("category");if(nameI<0||catI<0)throw new Error("El diccionario del tagger tiene un formato inesperado.");return lines.map((line,index)=>{const row=parseCsvLine(line);return{index,name:String(row[nameI]||""),category:Number(row[catI]||-1)}})})();
  return wdLabelsPromise;
}
function modelCacheDb(){return new Promise((resolve,reject)=>{if(!globalThis.indexedDB)return reject(new Error("IndexedDB no disponible"));const req=indexedDB.open("nightink-model-cache",1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains("models"))req.result.createObjectStore("models")};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function readCachedModel(key){try{const db=await modelCacheDb();return await new Promise((resolve,reject)=>{const tx=db.transaction("models","readonly"),req=tx.objectStore("models").get(key);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)})}catch{return null}}
async function writeCachedModel(key,buffer){try{const db=await modelCacheDb();await new Promise((resolve,reject)=>{const tx=db.transaction("models","readwrite");tx.objectStore("models").put(buffer,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}catch{}}

async function getWdSession(onProgress,generation){
  if(!wdSessionPromise)wdSessionPromise=(async()=>{
    emit(onProgress,"modelo",8,"Descargando el tagger visual por primera vez…");
    const [ort]=await Promise.all([getOrt(),getWdLabels()]);assertNotCancelled(generation);
    const cacheKey="wd-swinv2-v3-int8-2026-01";let buffer=await readCachedModel(cacheKey);
    if(buffer){emit(onProgress,"modelo",12,"Cargando el tagger visual desde la caché…")}else{const r=await fetch(WD_MODEL_URL,{cache:"force-cache"});if(!r.ok)throw new Error("No se pudo descargar el modelo visual WD Tagger.");buffer=await r.arrayBuffer();writeCachedModel(cacheKey,buffer.slice(0));}
    assertNotCancelled(generation);emit(onProgress,"modelo",18,"Preparando el tagger visual…");await nextPaint();
    try{return await ort.InferenceSession.create(buffer,{executionProviders:["wasm"],graphOptimizationLevel:"all"})}catch(error){/* Si un CSP bloquea el proxy, reintenta sin él. */ort.env.wasm.proxy=false;return ort.InferenceSession.create(buffer,{executionProviders:["wasm"],graphOptimizationLevel:"all"})}
  })().catch(error=>{wdSessionPromise=null;throw error});
  return wdSessionPromise;
}
function imageElement(src){return new Promise((resolve,reject)=>{const img=new Image();img.decoding="async";img.onload=()=>resolve(img);img.onerror=()=>reject(new Error("No se pudo leer una imagen para analizar."));img.src=src})}
async function wdTensorFromImage(src,ort){
  const img=await imageElement(src),w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,canvas=document.createElement("canvas");canvas.width=IMAGE_SIZE;canvas.height=IMAGE_SIZE;
  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:true});ctx.fillStyle="#fff";ctx.fillRect(0,0,IMAGE_SIZE,IMAGE_SIZE);const scale=IMAGE_SIZE/Math.max(w,h),dw=Math.max(1,Math.round(w*scale)),dh=Math.max(1,Math.round(h*scale)),x=Math.floor((IMAGE_SIZE-dw)/2),y=Math.floor((IMAGE_SIZE-dh)/2);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";ctx.drawImage(img,x,y,dw,dh);
  const rgba=ctx.getImageData(0,0,IMAGE_SIZE,IMAGE_SIZE).data,out=new Float32Array(IMAGE_SIZE*IMAGE_SIZE*3);for(let i=0,j=0;i<rgba.length;i+=4){out[j++]=rgba[i+2];out[j++]=rgba[i+1];out[j++]=rgba[i]}return new ort.Tensor("float32",out,[1,IMAGE_SIZE,IMAGE_SIZE,3]);
}
function buildRegistry(categories=[]){
  const exact=new Map();for(const c of categories||[]){if(!Number(c?.is_active||0))continue;const mode=String(c.detection_mode||"manual").toLowerCase();for(const raw of [c.name,...splitAliases(c.aliases)]){const key=norm(raw);if(key&&!exact.has(key))exact.set(key,{name:c.name,mode})}}return{exact};
}
function registryMatch(rawTag,registry,modes=["visual","ambas"]){const direct=registry.exact.get(norm(rawTag));return direct&&modes.includes(direct.mode)?direct.name:null}
function addEvidence(map,name,score,source,hit="",meta={}){
  if(!name)return;const key=norm(name);let row=map.get(key);if(!row){row={tag:name,score:0,sources:new Set(),hits:[],meta:{}};map.set(key,row)}row.score=Math.max(row.score,Number(score||0));row.sources.add(source);if(hit&&row.hits.length<10&&!row.hits.includes(hit))row.hits.push(hit);Object.assign(row.meta,meta||{});
}
async function visualEvidence(images,categories,onProgress,generation){
  const evidence=new Map(),registry=buildRegistry(categories),labels=await getWdLabels(),general=labels.filter(x=>x.category===0);if(!general.length)return evidence;
  const ort=await getOrt(),session=await getWdSession(onProgress,generation),usable=(images||[]).slice(0,MAX_VISUAL_IMAGES);
  for(let p=0;p<usable.length;p++){assertNotCancelled(generation);emit(onProgress,"visual",20+(p/Math.max(1,usable.length))*32,`Analizando imagen ${p+1}/${usable.length}…`,{current:p+1,total:usable.length});await nextPaint();const tensor=await wdTensorFromImage(usable[p],ort),feeds={[session.inputNames[0]]:tensor},output=await session.run(feeds),data=output[session.outputNames[0]]?.data;if(!data)continue;for(const label of general){const score=Number(data[label.index]||0);if(score<WD_THRESHOLD)continue;const canonical=registryMatch(label.name,registry);if(!canonical)continue;const confidence=Math.min(.985,.49+score*.51);addEvidence(evidence,canonical,confidence,"imagen",label.name.replaceAll("_"," "))}}
  return evidence;
}
async function getOcrWorker(onProgress,generation){
  if(!ocrLibPromise)ocrLibPromise=(async()=>{await loadScript(TESSERACT_URL);if(!window.Tesseract)throw new Error("El OCR no se pudo cargar.");return window.Tesseract})();
  if(!ocrWorkerPromise)ocrWorkerPromise=(async()=>{const T=await ocrLibPromise;assertNotCancelled(generation);emit(onProgress,"ocr",54,"Preparando el lector de diálogos…");const worker=await T.createWorker("eng+spa",1,{logger:m=>{if(m?.status==="recognizing text"&&Number.isFinite(m.progress))emit(onProgress,"ocr",56+m.progress*34,`Leyendo diálogos… ${Math.round(m.progress*100)}%`)}});try{await worker.setParameters({tessedit_pageseg_mode:T.PSM?.SPARSE_TEXT||"11",preserve_interword_spaces:"1"})}catch{}return worker})().catch(error=>{ocrWorkerPromise=null;throw error});
  return ocrWorkerPromise;
}
async function prepareOcrVariants(src){
  const img=await imageElement(src),w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,targetW=Math.min(1900,Math.max(w,1500)),scale=Math.min(2.35,targetW/Math.max(1,w)),cw=Math.max(1,Math.round(w*scale)),ch=Math.max(1,Math.round(h*scale)),canvas=document.createElement("canvas");canvas.width=cw;canvas.height=ch;const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:true});ctx.fillStyle="#fff";ctx.fillRect(0,0,cw,ch);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";ctx.drawImage(img,0,0,cw,ch);
  const original=ctx.getImageData(0,0,cw,ch),contrast=new ImageData(new Uint8ClampedArray(original.data),cw,ch),threshold=new ImageData(new Uint8ClampedArray(original.data),cw,ch);
  for(let i=0;i<original.data.length;i+=4){const y=.299*original.data[i]+.587*original.data[i+1]+.114*original.data[i+2],v=Math.max(0,Math.min(255,(y-128)*1.55+128)),t=y>178?255:0;contrast.data[i]=contrast.data[i+1]=contrast.data[i+2]=v;contrast.data[i+3]=255;threshold.data[i]=threshold.data[i+1]=threshold.data[i+2]=t;threshold.data[i+3]=255}
  const c1=document.createElement("canvas");c1.width=cw;c1.height=ch;c1.getContext("2d",{alpha:false}).putImageData(contrast,0,0);const c2=document.createElement("canvas");c2.width=cw;c2.height=ch;c2.getContext("2d",{alpha:false}).putImageData(threshold,0,0);return[c1.toDataURL("image/jpeg",.88),c2.toDataURL("image/jpeg",.88)];
}
function isNegated(text,phrase){
  const t=norm(text),p=norm(phrase),idx=t.indexOf(p);if(idx<0)return false;const before=t.slice(Math.max(0,idx-42),idx);return/(^|\s)(no|not|never|nunca|jamas|isnt|is not|not my|no es|no soy|no eres|no era|no fue)(\s|$)/i.test(before);
}
function containsPhrase(text,phrase){
  const t=norm(text),p=norm(phrase);if(p.length<3)return false;const escaped=p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+");const hit=new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`,"i").test(t);return hit&&!isNegated(t,p);
}
function contextMatches(text,categories,source,evidence,baseScore){
  if(!text)return;for(const c of categories||[]){if(!Number(c?.is_active||0))continue;const mode=String(c.detection_mode||"manual").toLowerCase();if(!["contexto","ambas"].includes(mode))continue;const tokens=[c.name,...splitAliases(c.aliases)].filter(x=>norm(x).length>=3),hits=tokens.filter(t=>containsPhrase(text,t));if(hits.length)addEvidence(evidence,c.name,Math.min(.995,baseScore+Math.min(.09,(hits.length-1)*.025)),source,hits[0],{matched:hits.slice(0,4)})}
}
function activeCategoryByName(categories,name){return(categories||[]).find(c=>Number(c?.is_active||0)&&norm(c.name)===norm(name))}
function relationSignals(text){
  const groups=[
    {a:["mother","mom","mommy","mum","madre","mama"],b:["son","hijo"],label:"madre e hijo"},
    {a:["father","dad","daddy","padre","papa"],b:["daughter","hija"],label:"padre e hija"},
    {a:["brother","hermano"],b:["sister","hermana"],label:"hermano y hermana"},
    {a:["stepmom","stepmother","madrastra"],b:["stepson","hijastro"],label:"madrastra e hijastro"},
    {a:["stepdad","stepfather","padrastro"],b:["stepdaughter","hijastra"],label:"padrastro e hijastra"}
  ];
  return groups.filter(g=>g.a.some(x=>containsPhrase(text,x))&&g.b.some(x=>containsPhrase(text,x))).map(g=>g.label);
}
function hasSexualVisualEvidence(visual){
  const sexual=["anal","blowjob","handjob","cunnilingus","doggystyle","cowgirl","reverse cowgirl","misionero","deepthroat","creampie","facial","cumshot","paizuri","fingering","doble penetracion","threesome","gangbang","orgia"];
  for(const row of visual.values())if(sexual.includes(norm(row.tag))&&row.score>=.62)return true;return false;
}
function inferNarrative(text,categories,evidence,source,visualSexual){
  const signals=relationSignals(text);if(!signals.length)return;const inc=activeCategoryByName(categories,"Incesto");if(inc&&["contexto","ambas"].includes(String(inc.detection_mode||"").toLowerCase())&&visualSexual)addEvidence(evidence,inc.name,source==="título"?.93:.86,source,"parentesco explícito + contexto sexual",{relation:signals[0]});
}
function categoryNamesSet(categories){return new Set((categories||[]).filter(c=>Number(c?.is_active||0)).map(c=>norm(c.name)))}
function memoryEvidence(memoryTags,categories,evidence){const allowed=categoryNamesSet(categories);for(const tag of memoryTags||[])if(allowed.has(norm(tag)))addEvidence(evidence,tag,.84,"serie","confirmado anteriormente")}
async function ocrEvidence(images,title,sourceName,categories,onProgress,generation,visualSexual){
  const evidence=new Map(),rawTitle=`${title||""} ${sourceName||""}`,titleText=norm(rawTitle);emit(onProgress,"titulo",5,"Analizando título y nombre del archivo…");contextMatches(titleText,categories,"título",evidence,.965);inferNarrative(titleText,categories,evidence,"título",visualSexual);await nextPaint();
  const usable=(images||[]).slice(0,MAX_OCR_IMAGES);if(!usable.length)return{evidence,text:"",pages:[]};let worker;try{worker=await getOcrWorker(onProgress,generation)}catch{return{evidence,text:"",pages:[]}}
  const chunks=[],pages=[];
  for(let i=0;i<usable.length;i++){assertNotCancelled(generation);emit(onProgress,"ocr",56+(i/Math.max(1,usable.length))*34,`Leyendo diálogos ${i+1}/${usable.length}…`,{current:i+1,total:usable.length});await nextPaint();try{const [contrast,threshold]=await prepareOcrVariants(usable[i]),r1=await worker.recognize(contrast),t1=String(r1?.data?.text||"").trim(),conf1=Number(r1?.data?.confidence||0);let final=t1,conf=conf1;if(t1.replace(/\s/g,"").length<18||conf1<48){assertNotCancelled(generation);const r2=await worker.recognize(threshold),t2=String(r2?.data?.text||"").trim(),conf2=Number(r2?.data?.confidence||0);if(t2&&(!final||conf2>conf1+5||t2.length>final.length*1.25)){final=t2;conf=conf2}}if(final){chunks.push(final);pages.push({page:i+1,text:final.slice(0,1200),confidence:Math.round(conf)})}}catch{}}
  const full=norm(chunks.join("\n"));contextMatches(full,categories,"diálogo",evidence,.84);inferNarrative(full,categories,evidence,"diálogo",visualSexual);return{evidence,text:chunks.join("\n").slice(0,18000),pages};
}
function mergeEvidence(...maps){
  const merged=new Map();for(const map of maps)for(const row of map.values()){let target=merged.get(norm(row.tag));if(!target){target={tag:row.tag,score:0,sources:new Set(),hits:[],meta:{}};merged.set(norm(row.tag),target)}target.score=Math.max(target.score,row.score);for(const s of row.sources)target.sources.add(s);for(const h of row.hits)if(target.hits.length<10&&!target.hits.includes(h))target.hits.push(h);Object.assign(target.meta,row.meta||{})}for(const row of merged.values()){if(row.sources.size>1)row.score=Math.min(.995,row.score+.055*(row.sources.size-1));if(row.sources.has("título")&&row.sources.has("diálogo"))row.score=Math.min(.995,row.score+.025)}return merged;
}
function recommendation(score){return score>=.88?"aplicar":score>=.66?"sugerir":"revisar"}
function seriesKey(value=""){
  return norm(value)
    .replace(/\b(part|parte|chapter|capitulo|cap|episode|episodio|ep|vol|volume|tomo)\s*[#nº°.-]*\s*\d+[a-z]?\b/g," ")
    .replace(/\b\d{1,4}\b$/g," ")
    .replace(/\s+/g," ").trim();
}
async function analyze({images=[],title="",sourceName="",categories=[],memoryTags=[],onProgress}={}){
  const generation=++cancelGeneration,usable=(images||[]).filter(x=>typeof x==="string"&&x).slice(0,12);if(!usable.length&&!title&&!sourceName)throw new Error("No hay imágenes ni título para analizar.");if(!Array.isArray(categories)||!categories.length)throw new Error("No hay categorías activas configuradas en el administrador.");
  emit(onProgress,"inicio",1,"Iniciando análisis…");await nextPaint();
  let visual=new Map(),visualError="";if(usable.length){try{visual=await visualEvidence(usable,categories,onProgress,generation)}catch(e){if(String(e?.message||e)==="Análisis cancelado.")throw e;visualError=String(e?.message||e)}}assertNotCancelled(generation);
  const visualSexual=hasSexualVisualEvidence(visual),ocr=await ocrEvidence(usable,title,sourceName,categories,onProgress,generation,visualSexual);assertNotCancelled(generation);
  const memory=new Map();memoryEvidence(memoryTags,categories,memory);emit(onProgress,"fusion",93,"Combinando imagen, diálogos, título y memoria…");await nextPaint();
  const merged=mergeEvidence(visual,ocr.evidence,memory),details=[...merged.values()].filter(x=>x.score>=MIN_RESULT_SCORE).sort((a,b)=>b.score-a.score||a.tag.localeCompare(b.tag,"es")).slice(0,MAX_RESULTS).map(x=>({tag:x.tag,score:Number(x.score.toFixed(3)),confidence:Math.round(x.score*100),sources:[...x.sources],hits:x.hits,recommendation:recommendation(x.score),meta:x.meta||{}}));
  emit(onProgress,"fin",100,"Análisis terminado.");return{tags:details.filter(x=>x.recommendation!=="revisar").map(x=>x.tag),details,ocrText:ocr.text,ocrPages:ocr.pages,visualError,local:true,seriesKey:seriesKey(title||sourceName),engine:"WD Tagger + OCR + título + memoria"};
}
async function preload({onProgress}={}){const generation=cancelGeneration;emit(onProgress,"preload",1,"Preparando componentes del analizador…");await Promise.allSettled([getWdLabels(),getOrt(),loadScript(TESSERACT_URL)]);if(generation!==cancelGeneration)return;emit(onProgress,"preload",100,"Componentes preparados.")}
async function cancel(){cancelGeneration+=1;try{const worker=await Promise.resolve(ocrWorkerPromise);if(worker?.terminate)await worker.terminate()}catch{}ocrWorkerPromise=null}
async function classify(image,options={}){return analyze({images:[image],title:options.title||"",sourceName:options.sourceName||"",categories:options.categories||[],memoryTags:options.memoryTags||[],onProgress:options.onProgress})}
window.NightInkAutoTags=Object.freeze({analyze,classify,preload,cancel,seriesKey,norm});
