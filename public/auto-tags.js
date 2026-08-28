/* NightInk · motor local v3: selección inteligente + WD Tagger + OCR por regiones + contexto + aprendizaje. */
const ORT_VERSION = "1.27.0";
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`;
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const WD_MODEL_REVISION = "4f67de053184529fead3f0e4652b74875696a8eb";
const WD_MODEL_URL = `https://huggingface.co/KidiXDev/wd-swinv2-tagger-v3-quint8/resolve/${WD_MODEL_REVISION}/model.onnx`;
const WD_TAGS_URL = `https://huggingface.co/KidiXDev/wd-swinv2-tagger-v3-quint8/resolve/${WD_MODEL_REVISION}/selected_tags.csv`;
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

const IMAGE_SIZE = 448;
const WD_THRESHOLD = 0.18;
const MAX_CANDIDATE_IMAGES = 20;
const MAX_VISUAL_IMAGES = 10;
const MAX_OCR_PAGES = 8;
const MAX_OCR_REGIONS_PER_PAGE = 3;
const MAX_RESULTS = 36;
const MIN_RESULT_SCORE = 0.57;

let ortPromise = null;
let wdSessionPromise = null;
let wdLabelsPromise = null;
let ocrLibPromise = null;
let ocrWorkerPromise = null;
let cancelGeneration = 0;

function norm(value = "") {
  return String(value || "")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z])0([a-z])/gi, "$1o$2")
    .replace(/[‘’'`´]/g, " ")
    .replace(/[_–—-]+/g, " ")
    .replace(/[^a-z0-9ñ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function splitAliases(value = "") { return String(value || "").split(",").map(x => x.trim()).filter(Boolean); }
function clamp(v, a = 0, b = 1) { return Math.max(a, Math.min(b, Number(v || 0))); }
function nextPaint() { return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))); }
function emit(onProgress, phase, percent, text, extra = {}) {
  onProgress?.({ phase, percent: Math.round(clamp(percent, 0, 100)), text: String(text || ""), ...extra });
}
function assertNotCancelled(generation) {
  if (generation !== cancelGeneration) throw new Error("Análisis cancelado.");
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find(s => s.src === src);
    if (existing) {
      if (existing.dataset.loaded === "1" || existing.readyState === "complete") return resolve();
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error(`No se pudo cargar ${src}`)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

async function getOrt() {
  if (!ortPromise) ortPromise = (async () => {
    await loadScript(ORT_URL);
    if (!window.ort) throw new Error("ONNX Runtime no está disponible.");
    window.ort.env.wasm.wasmPaths = ORT_WASM_BASE;
    window.ort.env.wasm.proxy = true;
    window.ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
    return window.ort;
  })();
  return ortPromise;
}
function parseCsvLine(line) {
  const out = []; let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
    else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
async function getWdLabels() {
  if (!wdLabelsPromise) wdLabelsPromise = (async () => {
    const r = await fetch(WD_TAGS_URL, { cache: "force-cache" });
    if (!r.ok) throw new Error("No se pudo descargar el diccionario del tagger visual.");
    const text = await r.text(), lines = text.trim().split(/\r?\n/), header = parseCsvLine(lines.shift()).map(x => x.trim());
    const nameI = header.indexOf("name"), catI = header.indexOf("category");
    if (nameI < 0 || catI < 0) throw new Error("El diccionario del tagger tiene un formato inesperado.");
    return lines.map((line, index) => { const row = parseCsvLine(line); return { index, name: String(row[nameI] || ""), category: Number(row[catI] || -1) }; });
  })();
  return wdLabelsPromise;
}
function modelCacheDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("IndexedDB no disponible"));
    const req = indexedDB.open("nightink-model-cache", 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("models")) req.result.createObjectStore("models"); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function readCachedModel(key) {
  try {
    const db = await modelCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("models", "readonly"), req = tx.objectStore("models").get(key);
      req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}
async function writeCachedModel(key, buffer) {
  try {
    const db = await modelCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("models", "readwrite"); tx.objectStore("models").put(buffer, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } catch {}
}
async function getWdSession(onProgress, generation) {
  if (!wdSessionPromise) wdSessionPromise = (async () => {
    emit(onProgress, "modelo", 12, "Preparando el detector visual…");
    const ort = await getOrt(); await getWdLabels(); assertNotCancelled(generation);
    const cacheKey = "wd-swinv2-v3-int8-2026-01";
    let buffer = await readCachedModel(cacheKey);
    if (!buffer) {
      emit(onProgress, "modelo", 13, "Descargando el detector visual por primera vez…");
      const r = await fetch(WD_MODEL_URL, { cache: "force-cache" });
      if (!r.ok) throw new Error("No se pudo descargar el modelo visual WD Tagger.");
      buffer = await r.arrayBuffer(); writeCachedModel(cacheKey, buffer.slice(0));
    }
    assertNotCancelled(generation); emit(onProgress, "modelo", 16, "Cargando el detector visual…"); await nextPaint();
    try { return await ort.InferenceSession.create(buffer, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }); }
    catch (error) { ort.env.wasm.proxy = false; return ort.InferenceSession.create(buffer, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }); }
  })().catch(error => { wdSessionPromise = null; throw error; });
  return wdSessionPromise;
}

function imageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image(); img.decoding = "async";
    img.onload = () => resolve(img); img.onerror = () => reject(new Error("No se pudo leer una imagen para analizar.")); img.src = src;
  });
}
function sourceOf(item) { return typeof item === "string" ? item : String(item?.src || item?.url || ""); }
function pageLabelOf(item, fallback) { return Number(item?.page || item?.pageNumber || 0) || fallback; }

function tileTextScore(data, width, height, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(width, Math.ceil(x1)); y1 = Math.min(height, Math.ceil(y1));
  const step = 2; let bright = 0, dark = 0, total = 0, transitions = 0, pairs = 0;
  for (let y = y0; y < y1; y += step) {
    let prev = null;
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4, lum = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];
      if (lum > 205) bright++; if (lum < 95) dark++; total++;
      const cur = lum < 125 ? 0 : lum > 185 ? 2 : 1;
      if (prev !== null) { pairs++; if ((prev === 0 && cur === 2) || (prev === 2 && cur === 0)) transitions++; }
      prev = cur;
    }
  }
  const brightRatio = total ? bright / total : 0, darkRatio = total ? dark / total : 0, tr = pairs ? transitions / pairs : 0;
  const whiteFit = brightRatio > .18 && brightRatio < .97 ? 1 : .35;
  const inkFit = darkRatio > .006 && darkRatio < .38 ? 1 : .35;
  return clamp(tr * 5.2 + Math.min(.35, darkRatio * 2.6) + Math.min(.26, brightRatio * .32)) * whiteFit * inkFit;
}
async function inspectPage(item, index, total) {
  const src = sourceOf(item), img = await imageElement(src), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const targetW = Math.min(520, w), scale = targetW / Math.max(1, w), cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(img, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data, regions = [];
  const cols = 3, rows = 5;
  for (let ry = 0; ry < rows; ry++) for (let rx = 0; rx < cols; rx++) {
    const x0 = rx * cw / cols, y0 = ry * ch / rows, x1 = (rx + 1) * cw / cols, y1 = (ry + 1) * ch / rows;
    const score = tileTextScore(data, cw, ch, x0, y0, x1, y1);
    regions.push({ x: rx / cols, y: ry / rows, w: 1 / cols, h: 1 / rows, score });
  }
  regions.sort((a, b) => b.score - a.score);
  const bestRegions = [];
  for (const r of regions) {
    if (r.score < .16) continue;
    const overlaps = bestRegions.some(a => Math.abs(a.x - r.x) < .12 && Math.abs(a.y - r.y) < .12);
    if (!overlaps) bestRegions.push(r);
    if (bestRegions.length >= MAX_OCR_REGIONS_PER_PAGE) break;
  }
  const pageScore = bestRegions.length ? bestRegions.reduce((s, r, i) => s + r.score * (i === 0 ? .58 : i === 1 ? .27 : .15), 0) : tileTextScore(data, cw, ch, 0, 0, cw, ch) * .55;
  return { item, src, index, page: pageLabelOf(item, index + 1), total, score: pageScore, regions: bestRegions, width: w, height: h };
}
function pickSmartPages(infos, maxPages = MAX_OCR_PAGES) {
  if (!infos.length) return [];
  const selected = new Map();
  const add = info => { if (info) selected.set(info.index, info); };
  add(infos[0]);
  if (infos.length > 2) add(infos[Math.floor(infos.length / 2)]);
  if (infos.length > 1) add(infos[infos.length - 1]);
  [...infos].sort((a, b) => b.score - a.score).forEach(info => { if (selected.size < maxPages) add(info); });
  return [...selected.values()].sort((a, b) => a.index - b.index).slice(0, maxPages);
}
function pickVisualPages(infos, maxPages = MAX_VISUAL_IMAGES) {
  if (infos.length <= maxPages) return infos;
  const idx = new Set([0, infos.length - 1]);
  for (let i = 0; i < maxPages; i++) idx.add(Math.round(i * (infos.length - 1) / Math.max(1, maxPages - 1)));
  return [...idx].sort((a, b) => a - b).slice(0, maxPages).map(i => infos[i]).filter(Boolean);
}
async function inspectCandidates(images, onProgress, generation) {
  const usable = (images || []).filter(x => sourceOf(x)).slice(0, MAX_CANDIDATE_IMAGES), infos = [];
  for (let i = 0; i < usable.length; i++) {
    assertNotCancelled(generation);
    emit(onProgress, "seleccion", 3 + (i / Math.max(1, usable.length)) * 8, `Buscando páginas con diálogo ${i + 1}/${usable.length}…`);
    try { infos.push(await inspectPage(usable[i], i, usable.length)); } catch {}
    if (i % 2 === 1) await nextPaint();
  }
  return infos;
}

async function wdTensorFromImage(src, ort) {
  const img = await imageElement(src), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas"); canvas.width = IMAGE_SIZE; canvas.height = IMAGE_SIZE;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const scale = IMAGE_SIZE / Math.max(w, h), dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  ctx.drawImage(img, Math.floor((IMAGE_SIZE - dw) / 2), Math.floor((IMAGE_SIZE - dh) / 2), dw, dh);
  const rgba = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data, out = new Float32Array(IMAGE_SIZE * IMAGE_SIZE * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4) { out[j++] = rgba[i + 2]; out[j++] = rgba[i + 1]; out[j++] = rgba[i]; }
  return new ort.Tensor("float32", out, [1, IMAGE_SIZE, IMAGE_SIZE, 3]);
}
function buildRegistry(categories = []) {
  const exact = new Map();
  for (const c of categories || []) {
    if (!Number(c?.is_active || 0)) continue;
    const mode = String(c.detection_mode || "manual").toLowerCase();
    for (const raw of [c.name, ...splitAliases(c.aliases)]) {
      const key = norm(raw); if (key && !exact.has(key)) exact.set(key, { name: c.name, mode });
    }
  }
  return { exact };
}
function registryMatch(rawTag, registry, modes = ["visual", "ambas"]) {
  const direct = registry.exact.get(norm(rawTag)); return direct && modes.includes(direct.mode) ? direct.name : null;
}
function newEvidence() { return new Map(); }
function addContribution(map, name, score, source, hit = "", meta = {}) {
  if (!name) return;
  const key = norm(name); let row = map.get(key);
  if (!row) { row = { tag: name, contributions: [], hits: [], meta: {} }; map.set(key, row); }
  row.contributions.push({ score: clamp(score), source, hit, page: meta.page || null, raw: meta.raw || null, ocrConfidence: meta.ocrConfidence || null });
  if (hit && row.hits.length < 12 && !row.hits.includes(hit)) row.hits.push(hit);
  Object.assign(row.meta, meta || {});
}
async function visualEvidence(infos, categories, onProgress, generation) {
  const evidence = newEvidence(), registry = buildRegistry(categories), labels = await getWdLabels(), general = labels.filter(x => x.category === 0);
  if (!general.length || !infos.length) return evidence;
  const ort = await getOrt(), session = await getWdSession(onProgress, generation), picked = pickVisualPages(infos);
  for (let p = 0; p < picked.length; p++) {
    assertNotCancelled(generation);
    const info = picked[p]; emit(onProgress, "visual", 17 + (p / Math.max(1, picked.length)) * 28, `Analizando contenido visual ${p + 1}/${picked.length}…`); await nextPaint();
    const tensor = await wdTensorFromImage(info.src, ort), output = await session.run({ [session.inputNames[0]]: tensor }), data = output[session.outputNames[0]]?.data;
    if (!data) continue;
    for (let i = 0; i < general.length; i++) {
      const label = general[i], score = Number(data[label.index] || 0);
      if (score < WD_THRESHOLD) continue;
      const canonical = registryMatch(label.name, registry); if (!canonical) continue;
      const confidence = clamp(.43 + score * .54, .50, .985);
      addContribution(evidence, canonical, confidence, "imagen", label.name.replaceAll("_", " "), { page: info.page, raw: score, visualTotal: picked.length });
    }
  }
  return evidence;
}

async function getOcrWorker(onProgress, generation) {
  if (!ocrLibPromise) ocrLibPromise = (async () => { await loadScript(TESSERACT_URL); if (!window.Tesseract) throw new Error("El OCR no se pudo cargar."); return window.Tesseract; })();
  if (!ocrWorkerPromise) ocrWorkerPromise = (async () => {
    const T = await ocrLibPromise; assertNotCancelled(generation); emit(onProgress, "ocr", 47, "Preparando el lector de globos…");
    return T.createWorker("eng+spa", 1, { logger: () => {} });
  })().catch(error => { ocrWorkerPromise = null; throw error; });
  return ocrWorkerPromise;
}
async function cropAndPreprocess(src, region = null, thresholdMode = false) {
  const img = await imageElement(src), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const rx = region ? Math.max(0, region.x - .025) : 0, ry = region ? Math.max(0, region.y - .02) : 0;
  const rw = region ? Math.min(1 - rx, region.w + .05) : 1, rh = region ? Math.min(1 - ry, region.h + .04) : 1;
  const sx = Math.floor(rx * w), sy = Math.floor(ry * h), sw = Math.max(1, Math.floor(rw * w)), sh = Math.max(1, Math.floor(rh * h));
  const targetW = region ? Math.min(1500, Math.max(900, sw * 2.3)) : Math.min(1800, Math.max(1300, sw * 1.8));
  const scale = targetW / Math.max(1, sw), cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
  const image = ctx.getImageData(0, 0, cw, ch), d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2];
    let v = Math.max(0, Math.min(255, (y - 128) * 1.72 + 128));
    if (thresholdMode) v = y > 174 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0); return canvas.toDataURL("image/jpeg", .90);
}
function textQuality(text = "", confidence = 0) {
  const cleaned = norm(text), letters = (cleaned.match(/[a-zñ]/g) || []).length, words = cleaned.split(/\s+/).filter(x => x.length >= 2).length;
  return letters + words * 3 + Number(confidence || 0) * .18;
}
function dedupeTextChunks(chunks = []) {
  const out = [], seen = new Set();
  for (const raw of chunks) {
    const t = String(raw || "").trim(); if (!t) continue;
    const key = norm(t).slice(0, 180); if (!key || seen.has(key)) continue;
    seen.add(key); out.push(t);
  }
  return out;
}
function isNegatedAt(text, start) {
  const before = norm(text.slice(Math.max(0, start - 52), start));
  return /(^|\s)(not my|is not|isnt|was not|wasnt|no es|no soy|no era|no fue|nunca fue|nunca|jamas)(\s|$)/i.test(before);
}
function phraseOccurrences(text, phrase) {
  const t = norm(text), p = norm(phrase); if (p.length < 3) return [];
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`(^|[^a-z0-9])(${escaped})($|[^a-z0-9])`, "gi"), hits = []; let m;
  while ((m = re.exec(t)) && hits.length < 8) {
    const start = m.index + String(m[1] || "").length; if (!isNegatedAt(t, start)) hits.push(start);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return hits;
}
function contextMatches(text, categories, source, evidence, baseScore, meta = {}) {
  if (!text) return;
  for (const c of categories || []) {
    if (!Number(c?.is_active || 0)) continue;
    const mode = String(c.detection_mode || "manual").toLowerCase(); if (!["contexto", "ambas"].includes(mode)) continue;
    const tokens = [c.name, ...splitAliases(c.aliases)].filter(x => norm(x).length >= 3);
    let totalHits = 0, bestPhrase = "";
    for (const token of tokens) {
      const occ = phraseOccurrences(text, token); if (!occ.length) continue;
      totalHits += occ.length; if (!bestPhrase || norm(token).length > norm(bestPhrase).length) bestPhrase = token;
    }
    if (!totalHits) continue;
    const specificity = Math.min(.045, Math.max(0, norm(bestPhrase).split(" ").length - 1) * .02);
    const repetition = Math.min(.055, (totalHits - 1) * .018);
    addContribution(evidence, c.name, clamp(baseScore + specificity + repetition), source, bestPhrase, meta);
  }
}
function activeCategoryByName(categories, name) { return (categories || []).find(c => Number(c?.is_active || 0) && norm(c.name) === norm(name)); }
function hasAny(text, values) { return values.some(v => phraseOccurrences(text, v).length); }
function relationSignals(text) {
  const groups = [
    { a: ["mother", "mom", "mommy", "mum", "madre", "mama"], b: ["son", "hijo"], label: "madre e hijo" },
    { a: ["father", "dad", "daddy", "padre", "papa"], b: ["daughter", "hija"], label: "padre e hija" },
    { a: ["brother", "hermano"], b: ["sister", "hermana"], label: "hermano y hermana" },
    { a: ["stepmom", "stepmother", "madrastra"], b: ["stepson", "hijastro"], label: "madrastra e hijastro" },
    { a: ["stepdad", "stepfather", "padrastro"], b: ["stepdaughter", "hijastra"], label: "padrastro e hijastra" }
  ];
  return groups.filter(g => hasAny(text, g.a) && hasAny(text, g.b)).map(g => g.label);
}
function sexualVisualStrength(visualEvidenceMap) {
  const names = new Set(["anal", "blowjob", "handjob", "cunnilingus", "doggystyle", "cowgirl", "reverse cowgirl", "misionero", "deepthroat", "creampie", "facial", "cumshot", "paizuri", "fingering", "doble penetracion", "threesome", "gangbang", "orgia"]);
  let best = 0;
  for (const row of visualEvidenceMap.values()) if (names.has(norm(row.tag))) for (const c of row.contributions) best = Math.max(best, c.score);
  return best;
}
function inferNarrative(text, categories, evidence, source, visualStrength, meta = {}) {
  const relations = relationSignals(text); if (!relations.length || visualStrength < .63) return;
  const inc = activeCategoryByName(categories, "Incesto");
  if (inc && ["contexto", "ambas"].includes(String(inc.detection_mode || "").toLowerCase())) {
    addContribution(evidence, inc.name, source === "título" ? .90 : .81, source, `parentesco explícito: ${relations[0]}`, meta);
  }
}
async function ocrPage(info, worker, T, onProgress, generation, progressBase, progressSpan) {
  const chunks = [], regionResults = [], regions = info.regions.length ? info.regions.slice(0, MAX_OCR_REGIONS_PER_PAGE) : [null];
  try { await worker.setParameters({ tessedit_pageseg_mode: T.PSM?.SINGLE_BLOCK || "6", preserve_interword_spaces: "1" }); } catch {}
  for (let r = 0; r < regions.length; r++) {
    assertNotCancelled(generation);
    emit(onProgress, "ocr", progressBase + progressSpan * (r / Math.max(1, regions.length + 1)), `Leyendo globos · página ${info.page} · zona ${r + 1}/${regions.length}…`); await nextPaint();
    try {
      const img = await cropAndPreprocess(info.src, regions[r], false), res = await worker.recognize(img), text = String(res?.data?.text || "").trim(), confidence = Number(res?.data?.confidence || 0);
      if (textQuality(text, confidence) > 12) { chunks.push(text); regionResults.push({ region: r + 1, text, confidence: Math.round(confidence) }); }
    } catch {}
  }
  const current = dedupeTextChunks(chunks), joined = current.join("\n");
  if (textQuality(joined, regionResults.reduce((m, x) => Math.max(m, x.confidence), 0)) < 55) {
    assertNotCancelled(generation); emit(onProgress, "ocr", progressBase + progressSpan * .86, `Revisando la página ${info.page} completa…`);
    try {
      await worker.setParameters({ tessedit_pageseg_mode: T.PSM?.SPARSE_TEXT || "11", preserve_interword_spaces: "1" });
      const full = await cropAndPreprocess(info.src, null, true), res = await worker.recognize(full), text = String(res?.data?.text || "").trim(), confidence = Number(res?.data?.confidence || 0);
      if (textQuality(text, confidence) > 12) { current.push(text); regionResults.push({ region: "completa", text, confidence: Math.round(confidence) }); }
    } catch {}
  }
  const final = dedupeTextChunks(current).join("\n");
  const avgConfidence = regionResults.length ? Math.round(regionResults.reduce((s, x) => s + Number(x.confidence || 0), 0) / regionResults.length) : 0;
  return { page: info.page, text: final, confidence: avgConfidence, regionResults, selectionScore: Number(info.score.toFixed(3)) };
}
async function ocrEvidence(ocrInfos, title, sourceName, categories, onProgress, generation, visualStrength) {
  const evidence = newEvidence(), rawTitle = `${title || ""} ${sourceName || ""}`, titleText = norm(rawTitle);
  emit(onProgress, "titulo", 2, "Analizando título y nombre del archivo…");
  contextMatches(titleText, categories, "título", evidence, .965, { page: "título" });
  inferNarrative(titleText, categories, evidence, "título", visualStrength, { page: "título" }); await nextPaint();
  if (!ocrInfos.length) return { evidence, text: "", pages: [] };
  let worker, T;
  try { T = await (ocrLibPromise || (ocrLibPromise = (async () => { await loadScript(TESSERACT_URL); return window.Tesseract; })())); worker = await getOcrWorker(onProgress, generation); }
  catch { return { evidence, text: "", pages: [] }; }
  const pages = [], chunks = [];
  for (let i = 0; i < ocrInfos.length; i++) {
    assertNotCancelled(generation);
    const base = 49 + (i / Math.max(1, ocrInfos.length)) * 38, span = 38 / Math.max(1, ocrInfos.length);
    const page = await ocrPage(ocrInfos[i], worker, T, onProgress, generation, base, span);
    if (!page.text) continue;
    pages.push(page); chunks.push(page.text);
    const baseScore = clamp(.69 + Math.min(.16, page.confidence / 100 * .16));
    contextMatches(page.text, categories, "diálogo", evidence, baseScore, { page: page.page, ocrConfidence: page.confidence });
    inferNarrative(page.text, categories, evidence, "diálogo", visualStrength, { page: page.page, ocrConfidence: page.confidence });
  }
  return { evidence, text: chunks.join("\n\n").slice(0, 22000), pages };
}

function categoryNamesSet(categories) { return new Set((categories || []).filter(c => Number(c?.is_active || 0)).map(c => norm(c.name))); }
function memoryEvidence(memoryTags, categories, evidence) {
  const allowed = categoryNamesSet(categories);
  for (const tag of memoryTags || []) if (allowed.has(norm(tag))) addContribution(evidence, tag, .82, "serie", "confirmado manualmente en la serie", { memory: "accepted" });
}
function mergeRawEvidence(...maps) {
  const merged = newEvidence();
  for (const map of maps) for (const row of map.values()) {
    for (const c of row.contributions) addContribution(merged, row.tag, c.score, c.source, c.hit, { page: c.page, raw: c.raw, ocrConfidence: c.ocrConfidence, ...row.meta });
  }
  return merged;
}
function finalizeEvidence(merged, rejectedTags = []) {
  const rejected = new Set((rejectedTags || []).map(norm)), out = [];
  for (const row of merged.values()) {
    const contributions = [...row.contributions].sort((a, b) => b.score - a.score), best = contributions[0]?.score || 0;
    const sources = [...new Set(contributions.map(c => c.source))];
    const dialoguePages = new Set(contributions.filter(c => c.source === "diálogo" && c.page).map(c => c.page));
    const visualPages = new Set(contributions.filter(c => c.source === "imagen" && c.page).map(c => c.page));
    const visualTotal = Math.max(1, ...contributions.map(c => Number(row.meta.visualTotal || c.visualTotal || 0)), visualPages.size || 1);
    const titleDialogue = sources.includes("título") && sources.includes("diálogo");
    let score = best;
    score += Math.min(.10, Math.max(0, dialoguePages.size - 1) * .027);
    score += Math.min(.075, Math.max(0, visualPages.size - 1) * .014);
    score += Math.min(.06, (visualPages.size / visualTotal) * .06);
    score += Math.min(.075, Math.max(0, sources.length - 1) * .032);
    if (titleDialogue) score += .03;
    if (sources.includes("serie")) score += .015;
    const wasRejected = rejected.has(norm(row.tag));
    if (wasRejected && !sources.includes("título")) score -= .24;
    else if (wasRejected) score -= .10;
    score = clamp(score, 0, .995);
    out.push({
      tag: row.tag, score: Number(score.toFixed(3)), confidence: Math.round(score * 100), sources,
      hits: row.hits.slice(0, 8), recommendation: score >= .90 ? "aplicar" : score >= .68 ? "sugerir" : "revisar",
      evidenceCount: contributions.length, dialoguePages: dialoguePages.size, visualPages: visualPages.size, rejectedByMemory: wasRejected,
      contributions: contributions.slice(0, 12).map(c => ({ source: c.source, page: c.page, confidence: Math.round(c.score * 100), hit: c.hit || "" }))
    });
  }
  return out.filter(x => x.score >= MIN_RESULT_SCORE).sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag, "es")).slice(0, MAX_RESULTS);
}
function seriesKey(value = "") {
  return norm(value)
    .replace(/\b(part|parte|chapter|capitulo|cap|episode|episodio|ep|vol|volume|tomo)\s*[#nº°.-]*\s*\d+[a-z]?\b/g, " ")
    .replace(/\b\d{1,4}\b$/g, " ")
    .replace(/\s+/g, " ").trim();
}
async function analyze({ images = [], title = "", sourceName = "", categories = [], memoryTags = [], rejectedTags = [], onProgress } = {}) {
  const generation = ++cancelGeneration, usable = (images || []).filter(x => sourceOf(x)).slice(0, MAX_CANDIDATE_IMAGES);
  if (!usable.length && !title && !sourceName) throw new Error("No hay imágenes ni título para analizar.");
  if (!Array.isArray(categories) || !categories.length) throw new Error("No hay categorías activas configuradas en el administrador.");
  emit(onProgress, "inicio", 1, "Iniciando análisis inteligente…"); await nextPaint();

  const infos = usable.length ? await inspectCandidates(usable, onProgress, generation) : [];
  const ocrInfos = pickSmartPages(infos, MAX_OCR_PAGES);
  emit(onProgress, "seleccion", 11, `Seleccionadas ${ocrInfos.length} páginas con mayor probabilidad de diálogo.`); await nextPaint();

  let visual = newEvidence(), visualError = "";
  if (infos.length) {
    try { visual = await visualEvidence(infos, categories, onProgress, generation); }
    catch (e) { if (String(e?.message || e) === "Análisis cancelado.") throw e; visualError = String(e?.message || e); }
  }
  assertNotCancelled(generation);
  const visualStrength = sexualVisualStrength(visual);
  const ocr = await ocrEvidence(ocrInfos, title, sourceName, categories, onProgress, generation, visualStrength);
  assertNotCancelled(generation);
  const memory = newEvidence(); memoryEvidence(memoryTags, categories, memory);

  emit(onProgress, "fusion", 90, "Sumando evidencias y comprobando coincidencias entre páginas…"); await nextPaint();
  const details = finalizeEvidence(mergeRawEvidence(visual, ocr.evidence, memory), rejectedTags);
  const autoTags = details.filter(x => x.recommendation === "aplicar" || (x.recommendation === "sugerir" && x.confidence >= 74)).map(x => x.tag);
  emit(onProgress, "fin", 100, "Análisis terminado.");
  return {
    tags: autoTags, details, ocrText: ocr.text, ocrPages: ocr.pages, visualError, local: true,
    selectedPages: ocrInfos.map(x => ({ page: x.page, score: Number(x.score.toFixed(3)), regions: x.regions.length })),
    seriesKey: seriesKey(title || sourceName), engine: "NightInk v3 · WD + OCR por regiones + contexto + aprendizaje"
  };
}
async function preload({ onProgress } = {}) {
  const generation = cancelGeneration; emit(onProgress, "preload", 1, "Preparando componentes del analizador…");
  await Promise.allSettled([getWdLabels(), getOrt(), loadScript(TESSERACT_URL)]);
  if (generation !== cancelGeneration) return; emit(onProgress, "preload", 100, "Componentes preparados.");
}
async function cancel() {
  cancelGeneration += 1;
  try { const worker = await Promise.resolve(ocrWorkerPromise); if (worker?.terminate) await worker.terminate(); } catch {}
  ocrWorkerPromise = null;
}
async function classify(image, options = {}) {
  return analyze({ images: [image], title: options.title || "", sourceName: options.sourceName || "", categories: options.categories || [], memoryTags: options.memoryTags || [], rejectedTags: options.rejectedTags || [], onProgress: options.onProgress });
}
window.NightInkAutoTags = Object.freeze({ analyze, classify, preload, cancel, seriesKey, norm });
