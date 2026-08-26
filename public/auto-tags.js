/*
  NightInk automatic visual categories
  ------------------------------------
  Runs entirely in the administrator's browser.
  No API keys, server inference, billing, or external search.

  The first use downloads the open CLIP model files from Hugging Face and the
  browser caches them. Classification is zero-shot against a CLOSED list of
  allowed catalog categories below.
*/

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.1';
const MODEL_ID = 'Xenova/clip-vit-base-patch32';

let classifierPromise = null;

const GROUPS = [
  {
    name: 'style',
    minScore: 0.52,
    maxTags: 1,
    labels: {
      'a western cartoon comic illustration': 'Cartoon',
      'an anime or manga illustration': 'Anime',
      'a 3D rendered adult comic image': '3D',
      'a realistic digital illustration': 'Realistic'
    }
  },
  {
    name: 'hair',
    minScore: 0.48,
    maxTags: 1,
    labels: {
      'a blonde adult woman': 'Blonde',
      'a brunette adult woman': 'Brunette',
      'a red-haired adult woman': 'Redhead',
      'an adult woman with black hair': 'Black Hair'
    }
  },
  {
    name: 'appearance',
    minScore: 0.42,
    maxTags: 2,
    labels: {
      'an adult woman wearing glasses': 'Glasses',
      'an adult woman with large breasts': 'Big Breasts',
      'a curvy adult woman': 'Curvy',
      'a muscular adult person': 'Muscular'
    }
  },
  {
    name: 'setting',
    minScore: 0.46,
    maxTags: 1,
    labels: {
      'an adult scene in a bedroom': 'Bedroom',
      'an adult scene in a bathroom': 'Bathroom',
      'an adult scene in an office': 'Office',
      'an adult scene outdoors': 'Outdoor',
      'an adult scene in a kitchen': 'Kitchen'
    }
  },
  {
    name: 'scene',
    minScore: 0.31,
    maxTags: 2,
    labels: {
      'consensual oral sex between adults': 'Oral',
      'consensual anal sex between adults': 'Anal',
      'consensual vaginal sex between adults': 'Vaginal',
      'consensual doggy style sex between adults': 'Doggy Style',
      'consensual missionary sex between adults': 'Missionary',
      'consensual cowgirl sex between adults': 'Cowgirl',
      'a consensual threesome between adults': 'Threesome',
      'consensual group sex between adults': 'Group',
      'consensual sex between adult women': 'Lesbian',
      'consensual sex between adult men': 'Gay'
    }
  }
];

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS_URL);
      // Allow browser cache; model is fetched only when first needed.
      env.allowLocalModels = false;
      return pipeline('zero-shot-image-classification', MODEL_ID, {
        dtype: 'q8'
      });
    })();
  }
  return classifierPromise;
}

function normalizeExisting(existingTags = []) {
  return new Map(
    existingTags
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .map(x => [x.toLowerCase(), x])
  );
}

async function classifyGroup(classifier, image, group) {
  const candidates = Object.keys(group.labels);
  const rows = await classifier(image, candidates);
  const accepted = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const score = Number(row?.score || 0);
    const tag = group.labels[row?.label];
    if (!tag || score < group.minScore) continue;
    accepted.push({ tag, score, group: group.name });
    if (accepted.length >= group.maxTags) break;
  }
  return accepted;
}

async function classify(image, { existingTags = [] } = {}) {
  if (!image || typeof image !== 'string') {
    throw new Error('No hay una muestra visual válida para clasificar.');
  }

  const classifier = await getClassifier();
  const existing = normalizeExisting(existingTags);
  const candidates = [];

  for (const group of GROUPS) {
    const result = await classifyGroup(classifier, image, group);
    candidates.push(...result);
  }

  candidates.sort((a, b) => b.score - a.score);

  const tags = [];
  const details = [];
  const seen = new Set();
  for (const item of candidates) {
    const canonical = existing.get(item.tag.toLowerCase()) || item.tag;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(canonical);
    details.push({ tag: canonical, score: Number(item.score.toFixed(4)), group: item.group });
  }

  return { tags, details, model: MODEL_ID, local: true };
}

window.NightInkAutoTags = Object.freeze({ classify });
