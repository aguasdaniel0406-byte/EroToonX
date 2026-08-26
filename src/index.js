function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function getAdminToken(request) {
  return request.headers.get("X-Admin-Token") || "";
}

function isAdmin(request, env) {
  return Boolean(env.ADMIN_TOKEN) &&
    getAdminToken(request) === env.ADMIN_TOKEN;
}

function decodeImageDataUrl(value = "") {
  const match = String(value || "").match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  const binary = atob(match[1].replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cleanAiTag(value = "") {
  return String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/^tags?\s*:\s*/i, "")
    .replace(/^categor(?:y|ies|ía|ías)\s*:\s*/i, "")
    .replace(/^labels?\s*:\s*/i, "")
    .replace(/^[\[\]{}]+|[\[\]{}]+$/g, "")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function aiTextFromResult(result) {
  if (typeof result === "string") return result.trim();
  const candidates = [
    result?.answer,
    result?.caption,
    result?.response,
    result?.text,
    result?.result,
    result?.output_text,
    result?.choices?.[0]?.message?.content,
    result?.choices?.[0]?.text
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}


function geminiInteractionText(result) {
  const parts = [];
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  for (const step of steps) {
    if (step?.type !== "model_output") continue;
    const content = Array.isArray(step.content) ? step.content : [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function geminiSearchSources(result) {
  const out = [];
  const seen = new Set();
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  for (const step of steps) {
    if (step?.type !== "google_search_result") continue;
    const rows = Array.isArray(step.result) ? step.result : [];
    for (const row of rows) {
      const url = String(row?.url || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        title: String(row?.title || "").trim().slice(0, 220),
        url,
        snippet: String(row?.snippet || "").trim().slice(0, 500)
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function safeJsonObject(text = "") {
  let source = String(text || "").trim();
  if (!source) return {};
  source = source.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {}
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const value = JSON.parse(source.slice(first, last + 1));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {}
  }
  return {};
}

function normalizeResearchTags(values = [], existing = [], allowRelationships = false) {
  const canonical = new Map(
    (existing || [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .map((x) => [x.toLocaleLowerCase("es"), x])
  );
  const blockedAlways = /\b(child|children|kid|minor|underage|teen|teenager|young-looking|boy|girl|niñ[oa]s?|menor(?:es)?|adolescente|ethnicity|race|orientaci[oó]n|sexual orientation|rape|non[- ]?consensual)\b/i;
  const relationship = /\b(madre|hijo|hija|padre|hermana|hermano|mother|son|daughter|father|sister|brother|incest)\b/i;
  const useless = /^(adult|adults|comic|comics|nsfw|explicit|porn|pornographic|illustration|illustrated|art|artwork|image|images|sexy)$/i;
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    let tag = cleanAiTag(raw);
    if (!tag || tag.length < 2 || tag.split(/\s+/).length > 5) continue;
    if (blockedAlways.test(tag) || useless.test(tag)) continue;
    if (!allowRelationships && relationship.test(tag)) continue;
    const key = tag.toLocaleLowerCase("es");
    if (canonical.has(key)) tag = canonical.get(key);
    const finalKey = tag.toLocaleLowerCase("es");
    if (!seen.has(finalKey)) {
      seen.add(finalKey);
      out.push(tag);
    }
    if (out.length >= 16) break;
  }
  return out;
}

function imageDataUrlInfo(value = "") {
  const match = String(value || "").match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2].replace(/\s+/g, "")
  };
}

async function callGemini(env, payload) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY no está configurada en Runtime variables and secrets.");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
      "Api-Revision": "2026-05-20"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data?.error?.message || data?.message || `Gemini respondió HTTP ${response.status}`).slice(0, 500);
    throw new Error(message);
  }
  return data;
}

function parseAiTags(text = "", existing = []) {
  const canonical = new Map(
    (existing || [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .map((x) => [x.toLocaleLowerCase("es"), x])
  );

  const blocked = /\b(child|children|kid|minor|underage|teen|teenager|young-looking|boy|girl|madre|hijo|hija|padre|hermana|hermano|mother|son|daughter|father|sister|brother|incest|rape|non[- ]?consensual|ethnicity|race|orientaci[oó]n|sexual orientation)\b/i;
  const refusal = /\b(cannot|can't|unable|sorry|policy|assist|refuse|inappropriate|not able|won't|will not)\b/i;
  const useless = /^(adult|adults|comic|comics|nsfw|explicit|porn|pornographic|illustration|illustrated|art|artwork|image|images)$/i;
  const out = [];
  const seen = new Set();

  let source = String(text || "").trim();
  if (!source) return out;

  source = source.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  let pieces = [];
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) pieces = parsed;
    else if (parsed && typeof parsed === "object") {
      const arr = parsed.tags || parsed.categories || parsed.labels || parsed.keywords;
      if (Array.isArray(arr)) pieces = arr;
      else if (typeof arr === "string") pieces = arr.split(/[,;|\n]+/);
    }
  } catch {}

  if (!pieces.length) {
    source = source
      .replace(/^\s*(tags?|categories|categorías|labels?)\s*:\s*/i, "")
      .replace(/[\[\]{}]/g, "");
    pieces = source.split(/[,;|\n]+/);
  }

  for (const piece of pieces) {
    let tag = cleanAiTag(piece);
    if (!tag || tag.length < 2 || blocked.test(tag) || refusal.test(tag) || useless.test(tag)) continue;
    if (tag.split(/\s+/).length > 5) continue;
    const key = tag.toLocaleLowerCase("es");
    if (canonical.has(key)) tag = canonical.get(key);
    const finalKey = tag.toLocaleLowerCase("es");
    if (!seen.has(finalKey)) {
      out.push(tag);
      seen.add(finalKey);
    }
    if (out.length >= 12) break;
  }

  return out;
}

function toBool(value) {
  return value === true ||
    value === 1 ||
    value === "1" ||
    value === "true";
}

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function safeName(value = "file") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "file";
}

async function touchComic(env, comicId) {
  await env.DB.prepare(
    "UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  )
    .bind(comicId)
    .run();
}

async function touchChapter(env, chapterId) {
  await env.DB.prepare(
    "UPDATE chapters SET updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  )
    .bind(chapterId)
    .run();
}

async function renumberPages(env, chapterId) {
  const rows = await env.DB.prepare(
    `
    SELECT id
    FROM pages
    WHERE chapter_id = ?
    ORDER BY page_number ASC, id ASC
    `
  )
    .bind(chapterId)
    .all();

  const pages = rows.results || [];

  if (!pages.length) {
    return;
  }

  for (let i = 0; i < pages.length; i++) {
    await env.DB.prepare(
      "UPDATE pages SET page_number = ? WHERE id = ?"
    )
      .bind(-(i + 1), pages[i].id)
      .run();
  }

  for (let i = 0; i < pages.length; i++) {
    await env.DB.prepare(
      "UPDATE pages SET page_number = ? WHERE id = ?"
    )
      .bind(i + 1, pages[i].id)
      .run();
  }
}

async function deleteComicMedia(env, comicId) {
  const comic = await env.DB.prepare(
    `
    SELECT cover_key
    FROM comics
    WHERE id = ?
    `
  )
    .bind(comicId)
    .first();

  const rows = await env.DB.prepare(
    `
    SELECT p.object_key
    FROM pages p
    JOIN chapters ch
      ON ch.id = p.chapter_id
    WHERE ch.comic_id = ?
    `
  )
    .bind(comicId)
    .all();

  const keys = [];

  if (comic?.cover_key) {
    keys.push(comic.cover_key);
  }

  for (const row of rows.results || []) {
    if (row.object_key) {
      keys.push(row.object_key);
    }
  }

  if (keys.length) {
    await env.MEDIA.delete(keys);
  }
}

async function publicComics(env, url) {
  const page = Math.max(
    1,
    Number(
      url.searchParams.get("page") || 1
    )
  );

  const limit = Math.min(
    50,
    Math.max(
      1,
      Number(
        url.searchParams.get("limit") || 10
      )
    )
  );

  const sort =
    url.searchParams.get("sort") === "popular"
      ? "popular"
      : "latest";

  const q =
    (url.searchParams.get("q") || "").trim();

  const genre =
    (url.searchParams.get("genre") || "").trim();

  const tag =
    (url.searchParams.get("tag") || "").trim();

  const where = [
    "c.is_published = 1"
  ];

  const binds = [];

  if (q) {
    where.push(
      `
      (
        LOWER(c.title) LIKE LOWER(?)
        OR LOWER(c.author) LIKE LOWER(?)
        OR LOWER(c.description) LIKE LOWER(?)
        OR LOWER(COALESCE(c.tags, '')) LIKE LOWER(?)
      )
      `
    );

    const like = `%${q}%`;

    binds.push(
      like,
      like,
      like,
      like
    );
  }

  if (genre) {
    where.push(
      `
      INSTR(
        ',' || LOWER(
          REPLACE(
            REPLACE(
              REPLACE(
                COALESCE(c.genre, ''),
                ',  ', ','
              ),
              ', ', ','
            ),
            ' ,', ','
          )
        ) || ',',
        ',' || LOWER(?) || ','
      ) > 0
      `
    );

    binds.push(
      genre
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  if (tag) {
    where.push(
      `
      INSTR(
        ',' || LOWER(
          REPLACE(
            REPLACE(
              REPLACE(
                COALESCE(
                  NULLIF(TRIM(c.tags), ''),
                  c.genre,
                  ''
                ),
                ',  ', ','
              ),
              ', ', ','
            ),
            ' ,', ','
          )
        ) || ',',
        ',' || LOWER(?) || ','
      ) > 0
      `
    );

    binds.push(
      tag
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  const whereSql =
    where.join(" AND ");

  const countRow = await env.DB.prepare(
    `
    SELECT COUNT(*) AS total
    FROM comics c
    WHERE ${whereSql}
    `
  )
    .bind(...binds)
    .first();

  const total =
    Number(
      countRow?.total || 0
    );

  const totalPages =
    Math.max(
      1,
      Math.ceil(total / limit)
    );

  const safePage =
    Math.min(
      page,
      totalPages
    );

  const offset =
    (safePage - 1) * limit;

  const orderSql =
    sort === "popular"
      ? "c.views DESC, c.updated_at DESC, c.id DESC"
      : "c.updated_at DESC, c.id DESC";

  const rows = await env.DB.prepare(
    `
    SELECT
      c.*,

      (
        SELECT COUNT(*)
        FROM chapters ch
        WHERE ch.comic_id = c.id
        AND ch.is_published = 1
      ) AS part_count,

      CASE
        WHEN c.cover_key IS NOT NULL
        AND c.cover_key != ''
        THEN '/media/' || c.cover_key
        ELSE NULL
      END AS cover_url

    FROM comics c

    WHERE ${whereSql}

    ORDER BY ${orderSql}

    LIMIT ?
    OFFSET ?
    `
  )
    .bind(
      ...binds,
      limit,
      offset
    )
    .all();

  return json({
    ok: true,

    comics:
      rows.results || [],

    pagination: {
      page: safePage,
      limit,
      total,
      total_pages: totalPages
    }
  });
}

function splitTagList(value = "") {
  return String(value || "")
    .split(",")
    .map((tag) =>
      tag
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .filter((tag) =>
      !/^(artist|autor|author)\s*:/i.test(tag)
    );
}

function addCount(counts, value) {
  const clean =
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  if (!clean) {
    return;
  }

  const key =
    clean.toLocaleLowerCase("es");

  const current =
    counts.get(key);

  if (current) {
    current.count += 1;
  } else {
    counts.set(key, {
      name: clean,
      count: 1
    });
  }
}

function sortedCounts(counts) {
  return [...counts.values()]
    .sort((a, b) =>
      b.count - a.count ||
      a.name.localeCompare(
        b.name,
        "es",
        {
          sensitivity: "base"
        }
      )
    );
}

async function publicGenres(env) {
  const rows = await env.DB.prepare(
    `
    SELECT
      id,
      genre
    FROM comics
    WHERE
      is_published = 1
      AND genre IS NOT NULL
      AND TRIM(genre) != ''
    `
  ).all();

  const counts = new Map();

  for (const row of rows.results || []) {
    const seenInComic = new Set();

    for (const item of splitTagList(row.genre)) {
      const key =
        item.toLocaleLowerCase("es");

      if (seenInComic.has(key)) {
        continue;
      }

      seenInComic.add(key);
      addCount(counts, item);
    }
  }

  return json({
    ok: true,
    genres:
      sortedCounts(counts)
  });
}

async function publicTags(env) {
  const rows = await env.DB.prepare(
    `
    SELECT
      id,
      title,
      tags,
      genre,
      views,
      created_at,
      cover_key
    FROM comics
    WHERE
      is_published = 1
      AND (
        (tags IS NOT NULL AND TRIM(tags) != '')
        OR
        (genre IS NOT NULL AND TRIM(genre) != '')
      )
    `
  ).all();

  const groups = new Map();

  for (const row of rows.results || []) {
    const source = String(row.tags || "").trim() ? row.tags : row.genre;
    const seenInComic = new Set();

    for (const item of splitTagList(source)) {
      const key = item.toLocaleLowerCase("es");
      if (seenInComic.has(key)) continue;
      seenInComic.add(key);

      let group = groups.get(key);
      if (!group) {
        group = {
          name: item,
          count: 0,
          cover_url: null,
          top_comic_title: null,
          _views: -1,
          _created_at: ""
        };
        groups.set(key, group);
      }

      group.count += 1;

      if (row.cover_key) {
        const views = Number(row.views || 0);
        const created = String(row.created_at || "");
        if (
          views > group._views ||
          (views === group._views && created > group._created_at)
        ) {
          group._views = views;
          group._created_at = created;
          group.cover_url = "/media/" + row.cover_key;
          group.top_comic_title = row.title || null;
        }
      }
    }
  }

  const tags = [...groups.values()]
    .sort((a, b) =>
      b.count - a.count ||
      a.name.localeCompare(b.name, "es", { sensitivity: "base" })
    )
    .map(({ _views, _created_at, ...item }) => item);

  return json({ ok: true, tags });
}

async function adminComics(env) {
  const rows = await env.DB.prepare(
    `
    SELECT
      c.*,

      (
        SELECT COUNT(*)
        FROM chapters ch
        WHERE ch.comic_id = c.id
      ) AS part_count,

      CASE
        WHEN c.cover_key IS NOT NULL
        AND c.cover_key != ''
        THEN '/media/' || c.cover_key
        ELSE NULL
      END AS cover_url

    FROM comics c

    ORDER BY
      c.updated_at DESC,
      c.id DESC
    `
  ).all();

  return json({
    ok: true,
    comics:
      rows.results || []
  });
}


const SITE_ORIGIN = "https://erotoonx.com";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function absoluteUrl(path = "/") {
  if (!path) {
    return SITE_ORIGIN + "/";
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return SITE_ORIGIN + (path.startsWith("/") ? path : `/${path}`);
}

function isSearchCrawler(request) {
  const ua =
    request.headers.get("User-Agent") || "";

  return /Googlebot|Google-InspectionTool|GoogleOther|bingbot|BingPreview|DuckDuckBot|YandexBot/i.test(
    ua
  );
}

async function getSeoHomeComics(env, limit = 15) {
  const rows = await env.DB.prepare(
    `
    SELECT
      c.id,
      c.slug,
      c.title,
      c.description,
      c.genre,
      c.tags,
      c.author,
      c.status,
      c.views,
      c.updated_at,

      CASE
        WHEN c.cover_key IS NOT NULL
        AND c.cover_key != ''
        THEN '/media/' || c.cover_key
        ELSE NULL
      END AS cover_url,

      (
        SELECT COUNT(*)
        FROM pages p
        JOIN chapters ch
          ON ch.id = p.chapter_id
        WHERE ch.comic_id = c.id
        AND ch.is_published = 1
      ) AS page_count

    FROM comics c

    WHERE
      c.is_published = 1

    ORDER BY
      c.updated_at DESC,
      c.id DESC

    LIMIT ?
    `
  )
    .bind(limit)
    .all();

  return rows.results || [];
}

async function getSeoComic(env, slug) {
  const comic = await env.DB.prepare(
    `
    SELECT
      c.*,

      CASE
        WHEN c.cover_key IS NOT NULL
        AND c.cover_key != ''
        THEN '/media/' || c.cover_key
        ELSE NULL
      END AS cover_url,

      (
        SELECT COUNT(*)
        FROM pages p
        JOIN chapters ch
          ON ch.id = p.chapter_id
        WHERE ch.comic_id = c.id
        AND ch.is_published = 1
      ) AS page_count

    FROM comics c

    WHERE
      c.slug = ?

    AND
      c.is_published = 1

    LIMIT 1
    `
  )
    .bind(slug)
    .first();

  return comic || null;
}

function renderSeoComicCards(comics) {
  if (!comics.length) {
    return `
      <div class="empty">
        Aún no hay cómics publicados.
      </div>
    `;
  }

  return comics.map(comic => {
    const title =
      escapeHtml(comic.title || "Cómic");

    const slug =
      encodeURIComponent(comic.slug || "");

    const genre =
      escapeHtml(
        comic.genre || "Sin categoría"
      );

    const views =
      Number(comic.views || 0);

    const coverUrl =
      comic.cover_url
        ? absoluteUrl(comic.cover_url)
        : "";

    const coverStyle =
      coverUrl
        ? `background-image:url('${escapeAttr(coverUrl)}')`
        : "";

    const placeholder =
      coverUrl
        ? ""
        : `<div class="cover-placeholder">${title}</div>`;

    return `
      <a
        class="comic-card"
        href="/comic/${slug}"
        aria-label="Abrir ${escapeAttr(title)}"
      >
        <div
          class="cover"
          style="${coverStyle}"
        >
          ${placeholder}
          <span class="card-badge">Abrir</span>
        </div>

        <div class="card-body">
          <h3 class="card-title">
            ${title}
          </h3>

          <div class="card-meta">
            <span>${genre}</span>
            <span>${views} vistas</span>
          </div>
        </div>
      </a>
    `;
  }).join("");
}

function renderHomeStructuredData(comics) {
  const itemListElement =
    comics.map((comic, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url:
        `${SITE_ORIGIN}/comic/${encodeURIComponent(comic.slug)}`,
      name:
        comic.title
    }));

  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Últimos cómics de EroToonX",
    itemListElement
  }).replace(/</g, "\\u003c");
}

function renderComicStructuredData(comic) {
  const data = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name:
      comic.title,
    url:
      `${SITE_ORIGIN}/comic/${encodeURIComponent(comic.slug)}`,
    description:
      comic.description || undefined,
    genre:
      comic.tags ||
      comic.genre ||
      undefined,
    author:
      comic.author
        ? {
            "@type": "Person",
            name: comic.author
          }
        : undefined,
    image:
      comic.cover_url
        ? absoluteUrl(comic.cover_url)
        : undefined,
    dateModified:
      comic.updated_at || undefined,
    isFamilyFriendly:
      false,
    inLanguage:
      "es"
  };

  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }

  return JSON.stringify(data)
    .replace(/</g, "\\u003c");
}

function replaceHeadMetadata(
  html,
  {
    title,
    description,
    canonical,
    type = "website",
    image = null
  }
) {
  const safeTitle =
    escapeHtml(title);

  const safeDescription =
    escapeAttr(description);

  const safeCanonical =
    escapeAttr(canonical);

  html = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${safeTitle}</title>`
  );

  html = html.replace(
    /<meta id="metaDescription" name="description" content="[^"]*">/i,
    `<meta id="metaDescription" name="description" content="${safeDescription}">`
  );

  html = html.replace(
    /<link id="canonicalUrl" rel="canonical" href="[^"]*">/i,
    `<link id="canonicalUrl" rel="canonical" href="${safeCanonical}">`
  );

  html = html.replace(
    /<meta property="og:type" id="ogType" content="[^"]*">/i,
    `<meta property="og:type" id="ogType" content="${escapeAttr(type)}">`
  );

  html = html.replace(
    /<meta property="og:title" id="ogTitle" content="[^"]*">/i,
    `<meta property="og:title" id="ogTitle" content="${safeTitle}">`
  );

  html = html.replace(
    /<meta property="og:description" id="ogDescription" content="[^"]*">/i,
    `<meta property="og:description" id="ogDescription" content="${safeDescription}">`
  );

  html = html.replace(
    /<meta property="og:url" id="ogUrl" content="[^"]*">/i,
    `<meta property="og:url" id="ogUrl" content="${safeCanonical}">`
  );

  html = html.replace(
    /<meta name="twitter:title" id="twitterTitle" content="[^"]*">/i,
    `<meta name="twitter:title" id="twitterTitle" content="${safeTitle}">`
  );

  html = html.replace(
    /<meta name="twitter:description" id="twitterDescription" content="[^"]*">/i,
    `<meta name="twitter:description" id="twitterDescription" content="${safeDescription}">`
  );

  if (image) {
    const safeImage =
      escapeAttr(image);

    html = html.replace(
      "</head>",
      `
<meta property="og:image" content="${safeImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${safeImage}">
</head>`
    );
  }

  return html;
}

function skipAgeGateForCrawler(
  html,
  request
) {
  if (!isSearchCrawler(request)) {
    return html;
  }

  html = html.replace(
    "async function startEroToonX(){showAgeGate();",
    "async function startEroToonX(){"
  );

  html = html.replace(
    "</head>",
    `
<style id="crawler-agegate-bypass">
#ageGate{display:none!important}
body.age-locked{overflow:auto!important}
body.age-locked .site-header,
body.age-locked .navbar,
body.age-locked .mobile-site-header,
body.age-locked .intro-strip,
body.age-locked main,
body.age-locked footer{
  pointer-events:auto!important;
  filter:none!important;
  user-select:auto!important
}
</style>
</head>`
  );

  return html;
}

async function fetchIndexAsset(
  request,
  env
) {
  const assetUrl =
    new URL(
      "/index.html",
      request.url
    );

  const assetRequest =
    new Request(
      assetUrl.toString(),
      {
        method: "GET",
        headers: request.headers
      }
    );

  return env.ASSETS.fetch(
    assetRequest
  );
}

async function serveSeoHtml(
  request,
  env,
  url
) {
  const assetResponse =
    await fetchIndexAsset(
      request,
      env
    );

  if (!assetResponse.ok) {
    return assetResponse;
  }

  let html =
    await assetResponse.text();

  const path =
    url.pathname;

  if (
    path === "/" ||
    path === "/index.html"
  ) {
    const comics =
      await getSeoHomeComics(
        env,
        15
      );

    const cards =
      renderSeoComicCards(
        comics
      );

    html = html.replace(
      /<div id="comicGrid" class="comic-grid">[\s\S]*?<\/div><div id="pagination"/i,
      `<div id="comicGrid" class="comic-grid">${cards}</div><div id="pagination"`
    );

    const structured =
      renderHomeStructuredData(
        comics
      );

    html = html.replace(
      "</head>",
      `
<script type="application/ld+json">
${structured}
</script>
</head>`
    );

    html = replaceHeadMetadata(
      html,
      {
        title:
          "EroToonX | Cómics para adultos +18",

        description:
          "Explora EroToonX, un catálogo de cómics para adultos +18 con lectura directa, vertical y adaptada a móvil.",

        canonical:
          `${SITE_ORIGIN}/`,

        type:
          "website"
      }
    );
  }

  else {
    const match =
      path.match(
        /^\/comic\/([^/]+)\/?$/
      );

    if (match) {
      const slug =
        decodeURIComponent(
          match[1]
        );

      const comic =
        await getSeoComic(
          env,
          slug
        );

      if (!comic) {
        return new Response(
          `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,follow">
<title>Cómic no encontrado | EroToonX</title>
</head>
<body>
<h1>Cómic no encontrado</h1>
<p>El contenido solicitado no está disponible.</p>
<p><a href="/">Volver a EroToonX</a></p>
</body>
</html>`,
          {
            status: 404,
            headers: {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          }
        );
      }

      const title =
        comic.title ||
        "Cómic";

      const description =
        String(
          comic.description ||
          `Lee ${title} en EroToonX.`
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 155);

      const canonical =
        `${SITE_ORIGIN}/comic/${encodeURIComponent(comic.slug)}`;

      const image =
        comic.cover_url
          ? absoluteUrl(
              comic.cover_url
            )
          : null;

      html = replaceHeadMetadata(
        html,
        {
          title:
            `${title} | EroToonX`,

          description,

          canonical,

          type:
            "article",

          image
        }
      );

      const structured =
        renderComicStructuredData(
          comic
        );

      html = html.replace(
        "</head>",
        `
<script type="application/ld+json">
${structured}
</script>
</head>`
      );

      const pageCount =
        Number(
          comic.page_count || 0
        );

      const detail =
        `
<section
  id="serverComicSeo"
  class="wrap seo-summary"
  aria-label="Información del cómic"
>
  <h1>${escapeHtml(title)}</h1>

  <p>
    ${escapeHtml(description)}
  </p>

  <p>
    ${
      comic.tags
        ? `<strong>Etiquetas:</strong> ${escapeHtml(comic.tags)} · `
        : comic.genre
          ? `<strong>Etiquetas:</strong> ${escapeHtml(comic.genre)} · `
          : ""
    }
    ${
      comic.author
        ? `<strong>Autor:</strong> ${escapeHtml(comic.author)} · `
        : ""
    }
    <strong>Páginas:</strong> ${pageCount}
  </p>
</section>
`;

      html = html.replace(
        '<div id="reader" class="reader">',
        `${detail}<div id="reader" class="reader">`
      );
    }
  }

  html =
    skipAgeGateForCrawler(
      html,
      request
    );

  const headers =
    new Headers(
      assetResponse.headers
    );

  headers.set(
    "Content-Type",
    "text/html; charset=utf-8"
  );

  headers.set(
    "Cache-Control",
    "public, max-age=60"
  );

  headers.set(
    "Vary",
    "User-Agent"
  );

  headers.delete(
    "Content-Length"
  );

  headers.delete(
    "Content-Encoding"
  );

  headers.delete(
    "ETag"
  );

  return new Response(
    html,
    {
      status: 200,
      headers
    }
  );
}


function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sitemapDate(value) {
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

async function serveDynamicSitemap(env) {
  const rows = await env.DB.prepare(
    `
    SELECT
      slug,
      updated_at

    FROM comics

    WHERE
      is_published = 1

    ORDER BY
      updated_at DESC,
      id DESC
    `
  ).all();

  const comics =
    rows.results || [];

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const staticUrls = [
    {
      loc: `${SITE_ORIGIN}/`,
      lastmod: today,
      changefreq: "daily",
      priority: "1.0"
    },
    {
      loc: `${SITE_ORIGIN}/privacy.html`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.3"
    },
    {
      loc: `${SITE_ORIGIN}/terms.html`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.3"
    },
    {
      loc: `${SITE_ORIGIN}/legal.html`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.3"
    },
    {
      loc: `${SITE_ORIGIN}/dmca.html`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.3"
    },
    {
      loc: `${SITE_ORIGIN}/contact.html`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.3"
    }
  ];

  const comicUrls =
    comics.map(comic => ({
      loc:
        `${SITE_ORIGIN}/comic/${encodeURIComponent(comic.slug)}`,
      lastmod:
        sitemapDate(comic.updated_at),
      changefreq:
        "weekly",
      priority:
        "0.8"
    }));

  const urls =
    [...staticUrls, ...comicUrls];

  const body =
    urls.map(item => `
  <url>
    <loc>${escapeXml(item.loc)}</loc>
    <lastmod>${escapeXml(item.lastmod)}</lastmod>
    <changefreq>${escapeXml(item.changefreq)}</changefreq>
    <priority>${escapeXml(item.priority)}</priority>
  </url>`).join("");

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}
</urlset>`;

  return new Response(
    xml,
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/xml; charset=utf-8",

        "Cache-Control":
          "public, max-age=300"
      }
    }
  );
}

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(request.url);

    const path =
      url.pathname;

    const method =
      request.method.toUpperCase();

    try {

      /*
      ========================================
      DYNAMIC SITEMAP
      ========================================
      */

      if (
        method === "GET" &&
        path === "/sitemap.xml"
      ) {
        return serveDynamicSitemap(
          env
        );
      }


      /*
      ========================================
      SERVER-RENDERED SEO
      ========================================
      */

      if (
        method === "GET" &&
        (
          path === "/" ||
          path === "/index.html" ||
          /^\/comic\/[^/]+\/?$/.test(path)
        )
      ) {
        return serveSeoHtml(
          request,
          env,
          url
        );
      }


      /*
      ========================================
      HEALTH
      ========================================
      */

      if (
        method === "GET" &&
        path === "/api/health"
      ) {
        let databaseConnected =
          false;

        let mediaConnected =
          false;

        try {
          await env.DB.prepare(
            "SELECT 1 AS ok"
          ).first();

          databaseConnected =
            true;
        } catch {}

        try {
          await env.MEDIA.list({
            limit: 1
          });

          mediaConnected =
            true;
        } catch {}

        return json({
          ok: true,

          app:
            "nightink-app",

          worker:
            true,

          databaseConnected,

          mediaConnected,

          adminConfigured:
            Boolean(env.ADMIN_TOKEN)
        });
      }


      /*
      ========================================
      ADMIN LOGIN
      ========================================
      */

      if (
        method === "POST" &&
        path === "/api/admin/login"
      ) {
        const body =
          await request
            .json()
            .catch(() => ({}));

        if (
          !env.ADMIN_TOKEN ||
          body.password !== env.ADMIN_TOKEN
        ) {
          return json(
            {
              ok: false,
              error:
                "Contraseña incorrecta"
            },
            401
          );
        }

        return json({
          ok: true
        });
      }


      /*
      ========================================
      PUBLIC COMICS
      ========================================
      */

      if (
        method === "GET" &&
        path === "/api/comics"
      ) {
        return publicComics(
          env,
          url
        );
      }


      /*
      ========================================
      PUBLIC GENRES / CATEGORIES
      ========================================
      */

      if (
        method === "GET" &&
        path === "/api/genres"
      ) {
        return publicGenres(env);
      }

      if (
        method === "GET" &&
        path === "/api/tags"
      ) {
        return publicTags(env);
      }


      /*
      ========================================
      PUBLIC UPDATES
      ========================================
      */

      if (
        method === "GET" &&
        path === "/api/updates"
      ) {
        const limit =
          Math.min(
            30,
            Math.max(
              1,
              Number(
                url.searchParams.get("limit") || 8
              )
            )
          );

        const rows = await env.DB.prepare(
          `
          SELECT
            ch.id AS chapter_id,
            ch.chapter_number,
            ch.title AS chapter_title,
            ch.updated_at,

            c.id AS comic_id,
            c.slug,
            c.title AS comic_title,
            c.genre,
            c.tags,
            c.cover_key,

            CASE
              WHEN c.cover_key IS NOT NULL
              AND c.cover_key != ''
              THEN '/media/' || c.cover_key
              ELSE NULL
            END AS cover_url,

            (
              SELECT COUNT(*)
              FROM pages p
              WHERE p.chapter_id = ch.id
            ) AS page_count

          FROM chapters ch

          JOIN comics c
            ON c.id = ch.comic_id

          WHERE
            ch.is_published = 1

          AND
            c.is_published = 1

          AND EXISTS (
            SELECT 1
            FROM pages p2
            WHERE p2.chapter_id = ch.id
          )

          ORDER BY
            ch.updated_at DESC,
            ch.id DESC

          LIMIT ?
          `
        )
          .bind(limit)
          .all();

        return json({
          ok: true,
          updates:
            rows.results || []
        });
      }


      /*
      ========================================
      PUBLIC COMIC DETAIL
      ========================================
      */

      const comicPublicMatch =
        path.match(
          /^\/api\/comics\/([^/]+)$/
        );

      if (
        method === "GET" &&
        comicPublicMatch
      ) {
        const slug =
          decodeURIComponent(
            comicPublicMatch[1]
          );

        const comic = await env.DB.prepare(
          `
          SELECT
            c.*,

            CASE
              WHEN c.cover_key IS NOT NULL
              AND c.cover_key != ''
              THEN '/media/' || c.cover_key
              ELSE NULL
            END AS cover_url

          FROM comics c

          WHERE
            c.slug = ?

          AND
            c.is_published = 1
          `
        )
          .bind(slug)
          .first();

        if (!comic) {
          return json(
            {
              ok: false,
              error:
                "Cómic no encontrado"
            },
            404
          );
        }

        await env.DB.prepare(
          `
          UPDATE comics
          SET views = views + 1
          WHERE id = ?
          `
        )
          .bind(comic.id)
          .run();

        comic.views =
          Number(
            comic.views || 0
          ) + 1;

        const chapters = await env.DB.prepare(
          `
          SELECT
            ch.*,

            (
              SELECT COUNT(*)
              FROM pages p
              WHERE p.chapter_id = ch.id
            ) AS page_count

          FROM chapters ch

          WHERE
            ch.comic_id = ?

          AND
            ch.is_published = 1

          ORDER BY
            ch.chapter_number ASC,
            ch.id ASC
          `
        )
          .bind(comic.id)
          .all();

        return json({
          ok: true,
          comic,
          chapters:
            chapters.results || []
        });
      }


      /*
      ========================================
      PUBLIC READER
      ========================================
      */

      const chapterPagesPublicMatch =
        path.match(
          /^\/api\/chapters\/(\d+)\/pages$/
        );

      if (
        method === "GET" &&
        chapterPagesPublicMatch
      ) {
        const chapterId =
          Number(
            chapterPagesPublicMatch[1]
          );

        const chapter = await env.DB.prepare(
          `
          SELECT
            ch.*,
            c.title AS comic_title,
            c.slug AS comic_slug

          FROM chapters ch

          JOIN comics c
            ON c.id = ch.comic_id

          WHERE
            ch.id = ?

          AND
            ch.is_published = 1

          AND
            c.is_published = 1
          `
        )
          .bind(chapterId)
          .first();

        if (!chapter) {
          return json(
            {
              ok: false,
              error:
                "Parte no encontrada"
            },
            404
          );
        }

        const rows = await env.DB.prepare(
          `
          SELECT
            id,
            chapter_id,
            page_number,
            object_key,
            '/media/' || object_key AS url

          FROM pages

          WHERE
            chapter_id = ?

          ORDER BY
            page_number ASC,
            id ASC
          `
        )
          .bind(chapterId)
          .all();

        return json({
          ok: true,
          chapter,
          pages:
            rows.results || []
        });
      }


      /*
      ========================================
      R2 MEDIA
      ========================================
      */

      if (
        method === "GET" &&
        path.startsWith("/media/")
      ) {
        const key =
          decodeURIComponent(
            path.slice(
              "/media/".length
            )
          );

        if (!key) {
          return new Response(
            "Not found",
            {
              status: 404
            }
          );
        }

        const object =
          await env.MEDIA.get(key);

        if (!object) {
          return new Response(
            "Not found",
            {
              status: 404
            }
          );
        }

        const headers =
          new Headers();

        object.writeHttpMetadata(
          headers
        );

        headers.set(
          "ETag",
          object.httpEtag
        );

        headers.set(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );

        return new Response(
          object.body,
          {
            headers
          }
        );
      }


      /*
      ========================================
      PROTECT ADMIN ROUTES
      ========================================
      */

      if (
        path.startsWith("/api/admin/") &&
        !isAdmin(request, env)
      ) {
        return json(
          {
            ok: false,
            error:
              "No autorizado"
          },
          401
        );
      }


      /*
      ========================================
      AI TAG SUGGESTIONS · GEMINI + GOOGLE SEARCH
      ========================================
      */

      if (
        method === "POST" &&
        path === "/api/admin/ai-tags"
      ) {
        if (!env.GEMINI_API_KEY) {
          return json(
            { ok: false, error: "Gemini no está configurado. Añade GEMINI_API_KEY como Runtime Secret en Cloudflare." },
            503
          );
        }

        const body = await request.json().catch(() => ({}));
        const title = String(body.title || "").trim().slice(0, 180);
        const author = String(body.author || "").trim().slice(0, 120);
        const sourceName = String(body.source_name || "").trim().slice(0, 220);
        const imageInfo = imageDataUrlInfo(body.image || "");
        const bytes = decodeImageDataUrl(body.image || "");

        if (!title && !sourceName) {
          return json({ ok: false, error: "Falta el título o nombre del archivo para investigar el cómic." }, 400);
        }
        if (!imageInfo || !bytes || !bytes.length) {
          return json({ ok: false, error: "La muestra visual enviada a la IA no es válida." }, 400);
        }
        if (bytes.length > 2_500_000) {
          return json({ ok: false, error: "La muestra visual es demasiado grande para analizar." }, 413);
        }

        const existingTags = Array.isArray(body.existing_tags)
          ? body.existing_tags.slice(0, 160).map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const existingText = existingTags.length ? existingTags.join(", ") : "(ninguna todavía)";

        const researchSchema = {
          type: "object",
          properties: {
            identified_title: { type: "string" },
            creator: { type: "string" },
            characters: { type: "array", items: { type: "string" } },
            web_tags: { type: "array", items: { type: "string" } },
            relationship_tags: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            underage_risk: { type: "boolean" },
            notes: { type: "string" }
          },
          required: ["identified_title", "creator", "characters", "web_tags", "relationship_tags", "confidence", "underage_risk", "notes"]
        };

        const visualSchema = {
          type: "object",
          properties: {
            visual_tags: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            notes: { type: "string" }
          },
          required: ["visual_tags", "confidence", "notes"]
        };

        const researchPrompt = [
          "Research catalog metadata for one illustrated adult comic using Google Search.",
          "This is metadata research and classification, not a request to narrate sexual content.",
          "Search the exact title first, then combine creator/author and filename when useful.",
          "Identify the work, creator and named characters only when web sources actually support them.",
          "Extract concise searchable tags/categories that public pages use for this exact work, plus a few additional categories strongly supported by the sources.",
          "Existing EroToonX categories are vocabulary hints only, not a closed list. Reuse their exact spelling when the same concept matches; otherwise propose a useful new tag.",
          "Do not infer ethnicity, race, sexual orientation, consent or identity from names or images.",
          "Do not infer family relationships from appearance. A relationship tag may be returned only when reliable web sources explicitly state it and the sources make clear the involved characters are adults.",
          "If any source indicates a minor/under-18 character, or age is materially ambiguous for a sexual relationship, set underage_risk=true and leave relationship_tags empty.",
          "Avoid generic tags such as Adult, NSFW, Porn, Comic, Art, Image or Explicit.",
          "Prefer concise Spanish tags where natural, but preserve well-established English taxonomy terms when commonly used.",
          "Do not invent facts just to fill the schema.",
          `Title supplied: ${title || "(vacío)"}`,
          `Author supplied: ${author || "(desconocido)"}`,
          `Original filename: ${sourceName || "(desconocido)"}`,
          `Existing EroToonX categories: ${existingText}`
        ].join("\n");

        const visualPrompt = [
          "Analyze this contact sheet only for safe visual catalog metadata for an illustrated comic.",
          "Return concise category labels directly supported by visible content.",
          "Useful visual tags can cover hair color, clothing, body-feature taxonomy, setting, art style, composition and number of clearly adult characters.",
          "Do not identify named characters from their faces.",
          "Do not infer age, family relationships, ethnicity/race, sexual orientation, consent, identity or criminality.",
          "Do not output generic Adult, NSFW, Porn, Comic, Art, Image, Explicit or Sexy.",
          "Existing tags are hints only; new useful visual tags are allowed.",
          `Existing EroToonX categories: ${existingText}`
        ].join("\n");

        const researchPromise = callGemini(env, {
          model: "gemini-3.7-flash",
          store: false,
          input: researchPrompt,
          tools: [{ type: "google_search" }],
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: researchSchema
          }
        });

        const visualPromise = callGemini(env, {
          model: "gemini-3.7-flash",
          store: false,
          input: [
            { type: "image", data: imageInfo.base64, mime_type: imageInfo.mimeType, resolution: "medium" },
            { type: "text", text: visualPrompt }
          ],
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: visualSchema
          }
        });

        const [researchSettled, visualSettled] = await Promise.allSettled([researchPromise, visualPromise]);

        let researchData = {};
        let visualData = {};
        let researchRaw = "";
        let visualRaw = "";
        let sources = [];
        let researchError = "";
        let visualError = "";

        if (researchSettled.status === "fulfilled") {
          researchRaw = geminiInteractionText(researchSettled.value);
          researchData = safeJsonObject(researchRaw);
          sources = geminiSearchSources(researchSettled.value);
        } else {
          researchError = String(researchSettled.reason?.message || researchSettled.reason || "Error de investigación").slice(0, 500);
        }

        if (visualSettled.status === "fulfilled") {
          visualRaw = geminiInteractionText(visualSettled.value);
          visualData = safeJsonObject(visualRaw);
        } else {
          visualError = String(visualSettled.reason?.message || visualSettled.reason || "Error visual").slice(0, 500);
        }

        const underageRisk = researchData?.underage_risk === true;
        if (underageRisk) {
          return json({
            ok: false,
            error: "La investigación web encontró indicios de personajes menores de edad o una edad sexualmente ambigua. Este cómic requiere revisión manual y no recibirá categorías automáticas.",
            needs_manual_review: true,
            research: {
              identified_title: String(researchData?.identified_title || "").slice(0, 180),
              creator: String(researchData?.creator || "").slice(0, 120),
              characters: Array.isArray(researchData?.characters) ? researchData.characters.slice(0, 10) : [],
              confidence: String(researchData?.confidence || "low"),
              notes: String(researchData?.notes || "").slice(0, 800)
            },
            sources
          }, 422);
        }

        const researchTags = normalizeResearchTags(researchData?.web_tags, existingTags, false);
        const relationshipTags = normalizeResearchTags(researchData?.relationship_tags, existingTags, true);
        const characterTags = normalizeResearchTags(researchData?.characters, existingTags, false).slice(0, 4);
        const visualTags = normalizeResearchTags(visualData?.visual_tags, existingTags, false);

        const combined = [];
        const seen = new Set();
        for (const tag of [...researchTags, ...relationshipTags, ...characterTags, ...visualTags]) {
          const key = String(tag).toLocaleLowerCase("es");
          if (!key || seen.has(key)) continue;
          seen.add(key);
          combined.push(tag);
          if (combined.length >= 14) break;
        }

        if (!combined.length) {
          return json({
            ok: false,
            error: researchError && visualError
              ? "Gemini no pudo completar ni la investigación web ni el análisis visual. Revisa la API key/cuota e inténtalo de nuevo."
              : "Gemini respondió, pero no encontró categorías suficientemente fiables para este cómic.",
            diagnostic: {
              research_error: researchError,
              visual_error: visualError,
              research: researchRaw.slice(0, 250),
              visual: visualRaw.slice(0, 250)
            }
          }, 422);
        }

        const existingLookup = new Set(existingTags.map((x) => x.toLocaleLowerCase("es")));
        const newTags = combined.filter((x) => !existingLookup.has(String(x).toLocaleLowerCase("es")));
        const reusedTags = combined.filter((x) => existingLookup.has(String(x).toLocaleLowerCase("es")));

        return json({
          ok: true,
          tags: combined,
          new_tags: newTags,
          reused_tags: reusedTags,
          model: "gemini-3.7-flash + Google Search",
          research: {
            identified_title: String(researchData?.identified_title || title).slice(0, 180),
            creator: String(researchData?.creator || author).slice(0, 120),
            characters: Array.isArray(researchData?.characters) ? researchData.characters.slice(0, 10) : [],
            confidence: String(researchData?.confidence || "low"),
            notes: String(researchData?.notes || "").slice(0, 800),
            web_tags: researchTags,
            relationship_tags: relationshipTags
          },
          visual: {
            confidence: String(visualData?.confidence || "low"),
            tags: visualTags,
            notes: String(visualData?.notes || "").slice(0, 500)
          },
          sources,
          warnings: [researchError ? `Web: ${researchError}` : "", visualError ? `Visual: ${visualError}` : ""].filter(Boolean)
        });
      }


      /*
      ========================================
      ADMIN STATS
      ========================================
      */

      if (
        method === "GET" &&
        path === "/api/admin/stats"
      ) {
        const row = await env.DB.prepare(
          `
          SELECT

            (
              SELECT COUNT(*)
              FROM comics
            ) AS comics,

            (
              SELECT COUNT(*)
              FROM chapters
            ) AS chapters,

            (
              SELECT COUNT(*)
              FROM pages
            ) AS pages,

            (
              SELECT
                COALESCE(
                  SUM(views),
                  0
                )
              FROM comics
            ) AS views
          `
        ).first();

        return json({
          ok: true,

          stats:
            row || {
              comics: 0,
              chapters: 0,
              pages: 0,
              views: 0
            }
        });
      }


      /*
      ========================================
      ADMIN COMICS
      ========================================
      */

      if (
        method === "GET" &&
        path === "/api/admin/comics"
      ) {
        return adminComics(env);
      }


      /*
      ========================================
      CREATE COMIC
      ========================================
      */

      if (
        method === "POST" &&
        path === "/api/admin/comics"
      ) {
        const body =
          await request
            .json()
            .catch(() => ({}));

        const title =
          String(
            body.title || ""
          ).trim();

        if (!title) {
          return json(
            {
              ok: false,
              error:
                "El título es obligatorio"
            },
            400
          );
        }

        const slug =
          slugify(
            body.slug ||
            title
          );

        if (!slug) {
          return json(
            {
              ok: false,
              error:
                "Slug inválido"
            },
            400
          );
        }

        try {
          const result = await env.DB.prepare(
            `
            INSERT INTO comics (
              slug,
              title,
              description,
              genre,
              tags,
              author,
              status,
              is_published,
              created_at,
              updated_at
            )

            VALUES (
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
            `
          )
            .bind(
              slug,
              title,
              String(
                body.description || ""
              ),
              String(
                body.genre || ""
              ),
              String(
                body.tags || ""
              ),
              String(
                body.author || ""
              ),
              String(
                body.status ||
                "En emisión"
              ),
              toBool(
                body.is_published
              )
                ? 1
                : 0
            )
            .run();

          return json(
            {
              ok: true,
              id:
                result.meta.last_row_id,
              slug
            },
            201
          );
        }

        catch(error) {
          if (
            String(error)
              .toLowerCase()
              .includes("unique")
          ) {
            return json(
              {
                ok: false,
                error:
                  "Ese slug ya existe"
              },
              409
            );
          }

          throw error;
        }
      }


      /*
      ========================================
      UPDATE / DELETE COMIC
      ========================================
      */

      const adminComicMatch =
        path.match(
          /^\/api\/admin\/comics\/(\d+)$/
        );

      if (
        adminComicMatch &&
        method === "PUT"
      ) {
        const id =
          Number(
            adminComicMatch[1]
          );

        const body =
          await request
            .json()
            .catch(() => ({}));

        const title =
          String(
            body.title || ""
          ).trim();

        if (!title) {
          return json(
            {
              ok: false,
              error:
                "El título es obligatorio"
            },
            400
          );
        }

        const slug =
          slugify(
            body.slug ||
            title
          );

        try {
          await env.DB.prepare(
            `
            UPDATE comics

            SET
              slug = ?,
              title = ?,
              description = ?,
              genre = ?,
              tags = ?,
              author = ?,
              status = ?,
              is_published = ?,
              updated_at = CURRENT_TIMESTAMP

            WHERE
              id = ?
            `
          )
            .bind(
              slug,
              title,
              String(
                body.description || ""
              ),
              String(
                body.genre || ""
              ),
              String(
                body.tags || ""
              ),
              String(
                body.author || ""
              ),
              String(
                body.status ||
                "En emisión"
              ),
              toBool(
                body.is_published
              )
                ? 1
                : 0,
              id
            )
            .run();

          return json({
            ok: true,
            id,
            slug
          });
        }

        catch(error) {
          if (
            String(error)
              .toLowerCase()
              .includes("unique")
          ) {
            return json(
              {
                ok: false,
                error:
                  "Ese slug ya existe"
              },
              409
            );
          }

          throw error;
        }
      }

      if (
        adminComicMatch &&
        method === "DELETE"
      ) {
        const id =
          Number(
            adminComicMatch[1]
          );

        await deleteComicMedia(
          env,
          id
        );

        await env.DB.prepare(
          `
          DELETE FROM comics
          WHERE id = ?
          `
        )
          .bind(id)
          .run();

        return json({
          ok: true
        });
      }


      /*
      ========================================
      COVER
      ========================================
      */

      const coverMatch =
        path.match(
          /^\/api\/admin\/comics\/(\d+)\/cover$/
        );

      if (
        coverMatch &&
        method === "POST"
      ) {
        const comicId =
          Number(
            coverMatch[1]
          );

        const comic = await env.DB.prepare(
          `
          SELECT
            id,
            cover_key

          FROM comics

          WHERE id = ?
          `
        )
          .bind(comicId)
          .first();

        if (!comic) {
          return json(
            {
              ok: false,
              error:
                "Cómic no encontrado"
            },
            404
          );
        }

        const form =
          await request.formData();

        const file =
          form.get("cover");

        if (
          !file ||
          typeof file === "string"
        ) {
          return json(
            {
              ok: false,
              error:
                "Selecciona una portada"
            },
            400
          );
        }

        const key =
          `covers/${comicId}/${crypto.randomUUID()}-${safeName(file.name)}`;

        await env.MEDIA.put(
          key,
          file.stream(),
          {
            httpMetadata: {
              contentType:
                file.type ||
                "application/octet-stream"
            }
          }
        );

        if (
          comic.cover_key &&
          comic.cover_key !== key
        ) {
          await env.MEDIA.delete(
            comic.cover_key
          );
        }

        await env.DB.prepare(
          `
          UPDATE comics
          SET
            cover_key = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
          .bind(
            key,
            comicId
          )
          .run();

        return json({
          ok: true,
          cover_url:
            `/media/${key}`
        });
      }


      /*
      ========================================
      ADMIN COMIC CHAPTERS
      ========================================
      */

      const comicChaptersMatch =
        path.match(
          /^\/api\/admin\/comics\/(\d+)\/chapters$/
        );

      if (
        comicChaptersMatch &&
        method === "GET"
      ) {
        const comicId =
          Number(
            comicChaptersMatch[1]
          );

        const rows = await env.DB.prepare(
          `
          SELECT
            ch.*,

            (
              SELECT COUNT(*)
              FROM pages p
              WHERE p.chapter_id = ch.id
            ) AS page_count

          FROM chapters ch

          WHERE
            ch.comic_id = ?

          ORDER BY
            ch.chapter_number ASC,
            ch.id ASC
          `
        )
          .bind(comicId)
          .all();

        return json({
          ok: true,
          chapters:
            rows.results || []
        });
      }

      if (
        comicChaptersMatch &&
        method === "POST"
      ) {
        const comicId =
          Number(
            comicChaptersMatch[1]
          );

        const body =
          await request
            .json()
            .catch(() => ({}));

        const chapterNumber =
          Number(
            body.chapter_number
          );

        if (
          !Number.isFinite(
            chapterNumber
          )
        ) {
          return json(
            {
              ok: false,
              error:
                "Número de parte inválido"
            },
            400
          );
        }

        try {
          const result = await env.DB.prepare(
            `
            INSERT INTO chapters (
              comic_id,
              chapter_number,
              title,
              is_published,
              created_at,
              updated_at
            )

            VALUES (
              ?,
              ?,
              ?,
              ?,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
            `
          )
            .bind(
              comicId,
              chapterNumber,
              String(
                body.title || ""
              ),
              toBool(
                body.is_published
              )
                ? 1
                : 0
            )
            .run();

          await touchComic(
            env,
            comicId
          );

          return json(
            {
              ok: true,
              id:
                result.meta.last_row_id
            },
            201
          );
        }

        catch(error) {
          if (
            String(error)
              .toLowerCase()
              .includes("unique")
          ) {
            return json(
              {
                ok: false,
                error:
                  "Ese número de parte ya existe"
              },
              409
            );
          }

          throw error;
        }
      }


      /*
      ========================================
      UPDATE / DELETE CHAPTER
      ========================================
      */

      const adminChapterMatch =
        path.match(
          /^\/api\/admin\/chapters\/(\d+)$/
        );

      if (
        adminChapterMatch &&
        method === "PUT"
      ) {
        const id =
          Number(
            adminChapterMatch[1]
          );

        const old = await env.DB.prepare(
          `
          SELECT comic_id
          FROM chapters
          WHERE id = ?
          `
        )
          .bind(id)
          .first();

        if (!old) {
          return json(
            {
              ok: false,
              error:
                "Parte no encontrada"
            },
            404
          );
        }

        const body =
          await request
            .json()
            .catch(() => ({}));

        const chapterNumber =
          Number(
            body.chapter_number
          );

        if (
          !Number.isFinite(
            chapterNumber
          )
        ) {
          return json(
            {
              ok: false,
              error:
                "Número de parte inválido"
            },
            400
          );
        }

        try {
          await env.DB.prepare(
            `
            UPDATE chapters

            SET
              chapter_number = ?,
              title = ?,
              is_published = ?,
              updated_at = CURRENT_TIMESTAMP

            WHERE
              id = ?
            `
          )
            .bind(
              chapterNumber,
              String(
                body.title || ""
              ),
              toBool(
                body.is_published
              )
                ? 1
                : 0,
              id
            )
            .run();

          await touchComic(
            env,
            old.comic_id
          );

          return json({
            ok: true
          });
        }

        catch(error) {
          if (
            String(error)
              .toLowerCase()
              .includes("unique")
          ) {
            return json(
              {
                ok: false,
                error:
                  "Ese número de parte ya existe"
              },
              409
            );
          }

          throw error;
        }
      }

      if (
        adminChapterMatch &&
        method === "DELETE"
      ) {
        const id =
          Number(
            adminChapterMatch[1]
          );

        const chapter = await env.DB.prepare(
          `
          SELECT comic_id
          FROM chapters
          WHERE id = ?
          `
        )
          .bind(id)
          .first();

        if (!chapter) {
          return json(
            {
              ok: false,
              error:
                "Parte no encontrada"
            },
            404
          );
        }

        const pages = await env.DB.prepare(
          `
          SELECT object_key
          FROM pages
          WHERE chapter_id = ?
          `
        )
          .bind(id)
          .all();

        const keys =
          (pages.results || [])
            .map(
              row =>
                row.object_key
            )
            .filter(Boolean);

        if (keys.length) {
          await env.MEDIA.delete(
            keys
          );
        }

        await env.DB.prepare(
          `
          DELETE FROM chapters
          WHERE id = ?
          `
        )
          .bind(id)
          .run();

        await touchComic(
          env,
          chapter.comic_id
        );

        return json({
          ok: true
        });
      }


      /*
      ========================================
      ADMIN CHAPTER PAGES
      ========================================
      */

      const adminChapterPagesMatch =
        path.match(
          /^\/api\/admin\/chapters\/(\d+)\/pages$/
        );

      if (
        adminChapterPagesMatch &&
        method === "GET"
      ) {
        const chapterId =
          Number(
            adminChapterPagesMatch[1]
          );

        const rows = await env.DB.prepare(
          `
          SELECT
            id,
            chapter_id,
            page_number,
            object_key,
            '/media/' || object_key AS url

          FROM pages

          WHERE
            chapter_id = ?

          ORDER BY
            page_number ASC,
            id ASC
          `
        )
          .bind(chapterId)
          .all();

        return json({
          ok: true,
          pages:
            rows.results || []
        });
      }

      if (
        adminChapterPagesMatch &&
        method === "POST"
      ) {
        const chapterId =
          Number(
            adminChapterPagesMatch[1]
          );

        const chapter = await env.DB.prepare(
          `
          SELECT comic_id
          FROM chapters
          WHERE id = ?
          `
        )
          .bind(chapterId)
          .first();

        if (!chapter) {
          return json(
            {
              ok: false,
              error:
                "Parte no encontrada"
            },
            404
          );
        }

        const form =
          await request.formData();

        const files =
          form.getAll("pages")
            .filter(
              file =>
                file &&
                typeof file !== "string"
            );

        if (!files.length) {
          return json(
            {
              ok: false,
              error:
                "Selecciona páginas"
            },
            400
          );
        }

        const maxRow = await env.DB.prepare(
          `
          SELECT
            COALESCE(
              MAX(page_number),
              0
            ) AS max_page

          FROM pages

          WHERE
            chapter_id = ?
          `
        )
          .bind(chapterId)
          .first();

        let pageNumber =
          Number(
            maxRow?.max_page || 0
          );

        const uploaded = [];

        for (const file of files) {
          pageNumber += 1;

          const key =
            `comics/${chapter.comic_id}/chapters/${chapterId}/${crypto.randomUUID()}-${safeName(file.name)}`;

          await env.MEDIA.put(
            key,
            file.stream(),
            {
              httpMetadata: {
                contentType:
                  file.type ||
                  "application/octet-stream"
              }
            }
          );

          const result = await env.DB.prepare(
            `
            INSERT INTO pages (
              chapter_id,
              page_number,
              object_key,
              created_at
            )

            VALUES (
              ?,
              ?,
              ?,
              CURRENT_TIMESTAMP
            )
            `
          )
            .bind(
              chapterId,
              pageNumber,
              key
            )
            .run();

          uploaded.push({
            id:
              result.meta.last_row_id,

            page_number:
              pageNumber,

            url:
              `/media/${key}`
          });
        }

        await touchChapter(
          env,
          chapterId
        );

        await touchComic(
          env,
          chapter.comic_id
        );

        return json(
          {
            ok: true,
            uploaded
          },
          201
        );
      }


      /*
      ========================================
      REORDER PAGES
      ========================================
      */

      const reorderMatch =
        path.match(
          /^\/api\/admin\/chapters\/(\d+)\/pages\/reorder$/
        );

      if (
        reorderMatch &&
        method === "POST"
      ) {
        const chapterId =
          Number(
            reorderMatch[1]
          );

        const body =
          await request
            .json()
            .catch(() => ({}));

        const ids =
          Array.isArray(
            body.page_ids
          )
            ? body.page_ids
                .map(Number)
                .filter(
                  Number.isFinite
                )
            : [];

        const current = await env.DB.prepare(
          `
          SELECT id
          FROM pages
          WHERE chapter_id = ?
          ORDER BY page_number ASC
          `
        )
          .bind(chapterId)
          .all();

        const currentIds =
          (current.results || [])
            .map(
              row =>
                Number(row.id)
            );

        const requestedSorted =
          [...ids]
            .sort(
              (a, b) =>
                a - b
            )
            .join(",");

        const currentSorted =
          [...currentIds]
            .sort(
              (a, b) =>
                a - b
            )
            .join(",");

        if (
          ids.length !== currentIds.length ||
          requestedSorted !== currentSorted
        ) {
          return json(
            {
              ok: false,
              error:
                "Orden de páginas inválido"
            },
            400
          );
        }

        for (
          let i = 0;
          i < ids.length;
          i++
        ) {
          await env.DB.prepare(
            `
            UPDATE pages
            SET page_number = ?
            WHERE id = ?
            AND chapter_id = ?
            `
          )
            .bind(
              -(i + 1),
              ids[i],
              chapterId
            )
            .run();
        }

        for (
          let i = 0;
          i < ids.length;
          i++
        ) {
          await env.DB.prepare(
            `
            UPDATE pages
            SET page_number = ?
            WHERE id = ?
            AND chapter_id = ?
            `
          )
            .bind(
              i + 1,
              ids[i],
              chapterId
            )
            .run();
        }

        const chapter = await env.DB.prepare(
          `
          SELECT comic_id
          FROM chapters
          WHERE id = ?
          `
        )
          .bind(chapterId)
          .first();

        await touchChapter(
          env,
          chapterId
        );

        if (chapter) {
          await touchComic(
            env,
            chapter.comic_id
          );
        }

        return json({
          ok: true
        });
      }


      /*
      ========================================
      DELETE PAGE
      ========================================
      */

      const pageDeleteMatch =
        path.match(
          /^\/api\/admin\/pages\/(\d+)$/
        );

      if (
        pageDeleteMatch &&
        method === "DELETE"
      ) {
        const id =
          Number(
            pageDeleteMatch[1]
          );

        const page = await env.DB.prepare(
          `
          SELECT
            p.object_key,
            p.chapter_id,
            ch.comic_id

          FROM pages p

          JOIN chapters ch
            ON ch.id = p.chapter_id

          WHERE
            p.id = ?
          `
        )
          .bind(id)
          .first();

        if (!page) {
          return json(
            {
              ok: false,
              error:
                "Página no encontrada"
            },
            404
          );
        }

        if (page.object_key) {
          await env.MEDIA.delete(
            page.object_key
          );
        }

        await env.DB.prepare(
          `
          DELETE FROM pages
          WHERE id = ?
          `
        )
          .bind(id)
          .run();

        await renumberPages(
          env,
          page.chapter_id
        );

        await touchChapter(
          env,
          page.chapter_id
        );

        await touchComic(
          env,
          page.comic_id
        );

        return json({
          ok: true
        });
      }


      /*
      ========================================
      UNKNOWN API
      ========================================
      */

      if (
        path.startsWith("/api/")
      ) {
        return json(
          {
            ok: false,
            error:
              "Ruta no encontrada"
          },
          404
        );
      }


      /*
      ========================================
      STATIC SITE
      ========================================
      */

      return env.ASSETS.fetch(
        request
      );

    }

    catch(error) {
      console.error(
        "EroToonX Worker error:",
        error
      );

      return json(
        {
          ok: false,
          error:
            "Error interno del servidor"
        },
        500
      );
    }
  }
};

// deploy refresh 2026-08-21
