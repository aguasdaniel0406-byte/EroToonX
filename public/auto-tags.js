/* NightInk · categorías automáticas locales: WD Tagger + OCR + contexto. */
const ORT_VERSION="1.27.0";
const ORT_URL=`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`;
const ORT_WASM_BASE=`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const WD_MODEL_URL="https://huggingface.co/KidiXDev/wd-swinv2-tagger-v3-quint8/resolve/main/model.onnx";
const WD_TAGS_URL="https://huggingface.co/KidiXDev/wd-swinv2-tagger-v3-quint8/resolve/main/selected_tags.csv";
const TESSERACT_URL="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const IMAGE_SIZE=448;
const WD_THRESHOLD=0.24;
const MAX_VISUAL_IMAGES=8;
const MAX_OCR_IMAGES=7;
const MAX_RESULTS=25;

let ortPromise=null;
let wdSessionPromise=null;
let wdLabelsPromise=null;
let ocrLibPromise=null;
let ocrWorkerPromise=null;

function norm(value=""){
  return String(value||"")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[_-]+/g," ")
    .replace(/[^a-z0-9ñáéíóúü\s]/gi," ")
    .replace(/\s+/g," ")
    .trim();
}
function splitAliases(value=""){
  return String(value||"").split(",").map(x=>x.trim()).filter(Boolean);
}
function loadScript(src){
  return new Promise((resolve,reject)=>{
    const existing=[...document.scripts].find(s=>s.src===src);
    if(existing){if(existing.dataset.loaded==="1"||existing.readyState==="complete")return resolve();existing.addEventListener("load",resolve,{once:true});existing.addEventListener("error",reject,{once:true});return}
    const s=document.createElement("script");s.src=src;s.async=true;
    s.onload=()=>{s.dataset.loaded="1";resolve()};s.onerror=()=>reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}
async function getOrt(){
  if(!ortPromise)ortPromise=(async()=>{
    await loadScript(ORT_URL);
    if(!window.ort)throw new Error("ONNX Runtime no está disponible.");
    window.ort.env.wasm.wasmPaths=ORT_WASM_BASE;
    window.ort.env.wasm.numThreads=Math.max(1,Math.min(4,navigator.hardwareConcurrency||2));
    return window.ort;
  })();
  return ortPromise;
}
function parseCsvLine(line){
  const out=[];let cur="",quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted&&line[i+1]==='"'){cur+='"';i++}else quoted=!quoted;
    }else if(ch===","&&!quoted){out.push(cur);cur=""}else cur+=ch;
  }
  out.push(cur);return out;
}
async function getWdLabels(){
  if(!wdLabelsPromise)wdLabelsPromise=(async()=>{
    const r=await fetch(WD_TAGS_URL,{cache:"force-cache"});
    if(!r.ok)throw new Error("No se pudo descargar el diccionario del tagger visual.");
    const text=await r.text(),lines=text.trim().split(/\r?\n/),header=parseCsvLine(lines.shift()).map(x=>x.trim());
    const nameI=header.indexOf("name"),catI=header.indexOf("category");
    if(nameI<0||catI<0)throw new Error("El diccionario del tagger tiene un formato inesperado.");
    return lines.map((line,index)=>{const row=parseCsvLine(line);return{index,name:String(row[nameI]||""),category:Number(row[catI]||-1)}});
  })();
  return wdLabelsPromise;
}
async function getWdSession(onProgress){
  if(!wdSessionPromise)wdSessionPromise=(async()=>{
    onProgress?.("Descargando tagger visual por primera vez…");
    const [ort]=await Promise.all([getOrt(),getWdLabels()]);
    const r=await fetch(WD_MODEL_URL,{cache:"force-cache"});
    if(!r.ok)throw new Error("No se pudo descargar el modelo visual WD Tagger.");
    const buffer=await r.arrayBuffer();
    onProgress?.("Cargando tagger visual en el navegador…");
    return ort.InferenceSession.create(buffer,{executionProviders:["wasm"],graphOptimizationLevel:"all"});
  })();
  return wdSessionPromise;
}
function imageElement(src){
  return new Promise((resolve,reject)=>{const img=new Image();img.decoding="async";img.onload=()=>resolve(img);img.onerror=()=>reject(new Error("No se pudo leer una imagen para analizar."));img.src=src});
}
async function wdTensorFromImage(src,ort){
  const img=await imageElement(src),w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
  const canvas=document.createElement("canvas");canvas.width=IMAGE_SIZE;canvas.height=IMAGE_SIZE;
  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:true});ctx.fillStyle="#fff";ctx.fillRect(0,0,IMAGE_SIZE,IMAGE_SIZE);
  const scale=IMAGE_SIZE/Math.max(w,h),dw=Math.max(1,Math.round(w*scale)),dh=Math.max(1,Math.round(h*scale)),x=Math.floor((IMAGE_SIZE-dw)/2),y=Math.floor((IMAGE_SIZE-dh)/2);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";ctx.drawImage(img,x,y,dw,dh);
  const rgba=ctx.getImageData(0,0,IMAGE_SIZE,IMAGE_SIZE).data,out=new Float32Array(IMAGE_SIZE*IMAGE_SIZE*3);
  for(let i=0,j=0;i<rgba.length;i+=4){out[j++]=rgba[i+2];out[j++]=rgba[i+1];out[j++]=rgba[i]}
  return new ort.Tensor("float32",out,[1,IMAGE_SIZE,IMAGE_SIZE,3]);
}
function buildRegistry(categories=[]){
  const exact=new Map(),entries=[];
  for(const c of categories||[]){
    if(!Number(c?.is_active||0))continue;
    const mode=String(c.detection_mode||"manual").toLowerCase();
    const tokens=[c.name,...splitAliases(c.aliases)];
    for(const raw of tokens){const key=norm(raw);if(!key)continue;entries.push({key,name:c.name,mode});if(!exact.has(key))exact.set(key,{name:c.name,mode})}
  }
  return{exact,entries};
}
function registryMatch(rawTag,registry,modes=["visual","ambas"]){
  const key=norm(rawTag),direct=registry.exact.get(key);
  if(direct&&modes.includes(direct.mode))return direct.name;
  return null;
}
function addEvidence(map,name,score,source,hit=""){
  if(!name)return;const key=norm(name);let row=map.get(key);
  if(!row){row={tag:name,score:0,sources:new Set(),hits:[]};map.set(key,row)}
  row.score=Math.max(row.score,Number(score||0));row.sources.add(source);if(hit&&row.hits.length<8&&!row.hits.includes(hit))row.hits.push(hit);
}
async function visualEvidence(images,categories,onProgress){
  const evidence=new Map(),registry=buildRegistry(categories),labels=await getWdLabels(),general=labels.filter(x=>x.category===0);
  if(!general.length)return evidence;
  const ort=await getOrt(),session=await getWdSession(onProgress),usable=(images||[]).slice(0,MAX_VISUAL_IMAGES);
  for(let p=0;p<usable.length;p++){
    onProgress?.(`Analizando imagen ${p+1}/${usable.length}…`);
    const tensor=await wdTensorFromImage(usable[p],ort),feeds={[session.inputNames[0]]:tensor},output=await session.run(feeds),data=output[session.outputNames[0]]?.data;
    if(!data)continue;
    for(const label of general){
      const score=Number(data[label.index]||0);if(score<WD_THRESHOLD)continue;
      const canonical=registryMatch(label.name,registry);if(!canonical)continue;
      const confidence=Math.min(.98,.52+score*.48);
      addEvidence(evidence,canonical,confidence,"imagen",label.name.replaceAll("_"," "));
    }
  }
  return evidence;
}
async function getOcrWorker(onProgress){
  if(!ocrLibPromise)ocrLibPromise=(async()=>{await loadScript(TESSERACT_URL);if(!window.Tesseract)throw new Error("El OCR no se pudo cargar.");return window.Tesseract})();
  if(!ocrWorkerPromise)ocrWorkerPromise=(async()=>{const T=await ocrLibPromise;onProgress?.("Preparando lector de diálogos…");return T.createWorker("eng+spa",1,{logger:m=>{if(m?.status==="recognizing text"&&Number.isFinite(m.progress))onProgress?.(`Leyendo diálogos… ${Math.round(m.progress*100)}%`)}})})();
  return ocrWorkerPromise;
}
async function prepareOcrImage(src){
  const img=await imageElement(src),w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,maxW=1500,scale=Math.min(1,maxW/Math.max(1,w));
  const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:true});ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
  const d=ctx.getImageData(0,0,canvas.width,canvas.height);for(let i=0;i<d.data.length;i+=4){const y=.299*d.data[i]+.587*d.data[i+1]+.114*d.data[i+2];const v=Math.max(0,Math.min(255,(y-128)*1.28+128));d.data[i]=d.data[i+1]=d.data[i+2]=v}ctx.putImageData(d,0,0);return canvas.toDataURL("image/jpeg",.82);
}
function containsPhrase(text,phrase){
  const p=norm(phrase);if(p.length<3)return false;
  const escaped=p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`,"i").test(text);
}
function contextMatches(text,categories,source,evidence,baseScore){
  if(!text)return;
  for(const c of categories||[]){
    if(!Number(c?.is_active||0))continue;
    const mode=String(c.detection_mode||"manual").toLowerCase();if(!["contexto","ambas"].includes(mode))continue;
    const tokens=[c.name,...splitAliases(c.aliases)].filter(x=>norm(x).length>=3),hits=tokens.filter(t=>containsPhrase(text,t));
    if(hits.length)addEvidence(evidence,c.name,Math.min(.99,baseScore+Math.min(.08,(hits.length-1)*.02)),source,hits[0]);
  }
}
function activeCategoryByName(categories,name){return(categories||[]).find(c=>Number(c?.is_active||0)&&norm(c.name)===norm(name))}
function inferNarrative(text,categories,evidence){
  const inc=activeCategoryByName(categories,"Incesto");if(!inc||!["contexto","ambas"].includes(String(inc.detection_mode||"").toLowerCase()))return;
  const groups=[
    [["mother","mom","mum","madre","mama"],["son","hijo"]],
    [["father","dad","padre","papa"],["daughter","hija"]],
    [["brother","hermano"],["sister","hermana"]],
    [["stepmom","stepmother","madrastra"],["stepson","hijastro"]],
    [["stepdad","stepfather","padrastro"],["stepdaughter","hijastra"]]
  ];
  for(const [a,b] of groups){if(a.some(x=>containsPhrase(text,x))&&b.some(x=>containsPhrase(text,x))){addEvidence(evidence,inc.name,.9,"diálogo","parentesco explícito");break}}
}
async function ocrEvidence(images,title,sourceName,categories,onProgress){
  const evidence=new Map(),titleText=norm(`${title||""} ${sourceName||""}`);
  contextMatches(titleText,categories,"título",evidence,.94);inferNarrative(titleText,categories,evidence);
  const usable=(images||[]).slice(0,MAX_OCR_IMAGES);if(!usable.length)return{evidence,text:""};
  let worker;try{worker=await getOcrWorker(onProgress)}catch{return{evidence,text:""}}
  const chunks=[];
  for(let i=0;i<usable.length;i++){
    onProgress?.(`Leyendo diálogos ${i+1}/${usable.length}…`);
    try{const prepared=await prepareOcrImage(usable[i]),r=await worker.recognize(prepared),txt=String(r?.data?.text||"").trim();if(txt)chunks.push(txt)}catch{}
  }
  const full=norm(chunks.join("\n"));contextMatches(full,categories,"diálogo",evidence,.82);inferNarrative(full,categories,evidence);
  return{evidence,text:chunks.join("\n").slice(0,12000)};
}
function mergeEvidence(...maps){
  const merged=new Map();
  for(const map of maps)for(const row of map.values()){
    let target=merged.get(norm(row.tag));if(!target){target={tag:row.tag,score:0,sources:new Set(),hits:[]};merged.set(norm(row.tag),target)}
    target.score=Math.max(target.score,row.score);for(const s of row.sources)target.sources.add(s);for(const h of row.hits)if(target.hits.length<8&&!target.hits.includes(h))target.hits.push(h);
  }
  for(const row of merged.values())if(row.sources.size>1)row.score=Math.min(.99,row.score+.06*(row.sources.size-1));
  return merged;
}
async function analyze({images=[],title="",sourceName="",categories=[],onProgress}={}){
  const usable=(images||[]).filter(x=>typeof x==="string"&&x).slice(0,12);if(!usable.length&&!title&&!sourceName)throw new Error("No hay imágenes ni título para analizar.");
  if(!Array.isArray(categories)||!categories.length)throw new Error("No hay categorías activas configuradas en el administrador.");
  let visual=new Map(),visualError="";
  if(usable.length){try{visual=await visualEvidence(usable,categories,onProgress)}catch(e){visualError=String(e?.message||e)}}
  const ocr=await ocrEvidence(usable,title,sourceName,categories,onProgress),merged=mergeEvidence(visual,ocr.evidence),details=[...merged.values()]
    .filter(x=>x.score>=.62)
    .sort((a,b)=>b.score-a.score||a.tag.localeCompare(b.tag,"es"))
    .slice(0,MAX_RESULTS)
    .map(x=>({tag:x.tag,score:Number(x.score.toFixed(3)),sources:[...x.sources],hits:x.hits}));
  onProgress?.("Análisis terminado.");
  return{tags:details.map(x=>x.tag),details,ocrText:ocr.text,visualError,local:true,engine:"WD Tagger + OCR + contexto"};
}
/* Compatibilidad con versiones anteriores del panel. */
async function classify(image,options={}){return analyze({images:[image],title:options.title||"",sourceName:options.sourceName||"",categories:options.categories||[],onProgress:options.onProgress})}
window.NightInkAutoTags=Object.freeze({analyze,classify});
