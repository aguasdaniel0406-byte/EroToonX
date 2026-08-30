const COMMON_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

function applyCommonSecurityHeaders(headers) {
  for (const [name, value] of Object.entries(COMMON_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

function json(data, status = 200) {
  const headers = applyCommonSecurityHeaders(new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  return new Response(JSON.stringify(data), { status, headers });
}

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_LOGIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const SITE_MESSAGE_WINDOW_MS = 30 * 60 * 1000;
const SITE_MESSAGE_BLOCK_MS = 60 * 60 * 1000;
const SITE_MESSAGE_MAX_PER_WINDOW = 5;
const SITE_MESSAGE_MAX_TEXT = 5000;
const MAX_COVER_BYTES = 12 * 1024 * 1024;
const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const MAX_PAGE_BATCH_BYTES = 25 * 1024 * 1024;
const MAX_PAGE_FILES_PER_REQUEST = 20;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif"
]);

let adminSecuritySchemaReady = false;

async function sha256Hex(value = "") {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function secureStringEqual(a, b) {
  const [left, right] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return left === right;
}

function randomAdminToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function getAdminToken(request) {
  const header = request.headers.get("X-Admin-Token") || "";
  if (header) return header.trim();
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

async function ensureAdminSecuritySchema(env) {
  if (adminSecuritySchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        client_hash TEXT NOT NULL DEFAULT ''
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
      ON admin_sessions(expires_at)
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS admin_login_limits (
        client_hash TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        window_started_at INTEGER NOT NULL,
        locked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `)
  ]);
  adminSecuritySchemaReady = true;
}

async function adminClientHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256Hex(ip);
}

async function getAdminLoginState(request, env) {
  await ensureAdminSecuritySchema(env);
  const clientHash = await adminClientHash(request);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT failures, window_started_at, locked_until
    FROM admin_login_limits
    WHERE client_hash = ?
  `).bind(clientHash).first();
  return { clientHash, now, row };
}

async function recordAdminLoginFailure(env, clientHash, row, now) {
  let failures = 1;
  let windowStartedAt = now;
  let lockedUntil = 0;

  if (row && now - Number(row.window_started_at || 0) <= ADMIN_LOGIN_WINDOW_MS) {
    failures = Number(row.failures || 0) + 1;
    windowStartedAt = Number(row.window_started_at || now);
  }

  if (failures >= ADMIN_LOGIN_MAX_FAILURES) {
    lockedUntil = now + ADMIN_LOGIN_LOCK_MS;
  }

  await env.DB.prepare(`
    INSERT INTO admin_login_limits (client_hash, failures, window_started_at, locked_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_hash) DO UPDATE SET
      failures = excluded.failures,
      window_started_at = excluded.window_started_at,
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
  `).bind(clientHash, failures, windowStartedAt, lockedUntil, now).run();

  return { failures, lockedUntil };
}

async function clearAdminLoginFailures(env, clientHash) {
  await env.DB.prepare("DELETE FROM admin_login_limits WHERE client_hash = ?").bind(clientHash).run();
}

async function createAdminSession(request, env) {
  await ensureAdminSecuritySchema(env);
  const token = randomAdminToken();
  const tokenHash = await sha256Hex(token);
  const clientHash = await adminClientHash(request);
  const now = Date.now();
  const expiresAt = now + ADMIN_SESSION_TTL_MS;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare(`
      INSERT INTO admin_sessions (token_hash, expires_at, created_at, client_hash)
      VALUES (?, ?, ?, ?)
    `).bind(tokenHash, expiresAt, now, clientHash)
  ]);

  return { token, expiresAt };
}

async function revokeAdminSession(request, env) {
  const token = getAdminToken(request);
  if (!token) return;
  await ensureAdminSecuritySchema(env);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(tokenHash).run();
}

async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const token = getAdminToken(request);
  if (!token) return false;

  await ensureAdminSecuritySchema(env);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT expires_at
    FROM admin_sessions
    WHERE token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first();

  if (!row || Number(row.expires_at || 0) <= now) {
    if (row) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(tokenHash).run();
    return false;
  }
  return true;
}

let siteMessagesSchemaReady = false;

async function ensureSiteMessagesSchema(env) {
  if (siteMessagesSchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS site_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'general',
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        content_url TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        client_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_site_messages_status_created
      ON site_messages(status, created_at DESC)
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_site_messages_kind_created
      ON site_messages(kind, created_at DESC)
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS site_message_limits (
        client_hash TEXT PRIMARY KEY,
        submissions INTEGER NOT NULL DEFAULT 0,
        window_started_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `)
  ]);
  siteMessagesSchemaReady = true;
}

function normalizeSiteMessageKind(value) {
  const kind = String(value || '').toLowerCase();
  return ['general', 'privacy', 'security', 'dmca'].includes(kind) ? kind : 'general';
}

function normalizeSiteMessageStatus(value) {
  const status = String(value || '').toLowerCase();
  return ['new', 'reviewed', 'closed'].includes(status) ? status : '';
}

function validContactEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeReportedUrl(value) {
  const raw = String(value || '').trim().slice(0, 1000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

async function siteMessageClientHash(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256Hex(ip);
}

async function checkSiteMessageRate(request, env) {
  await ensureSiteMessagesSchema(env);
  const clientHash = await siteMessageClientHash(request);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM site_message_limits WHERE updated_at < ?")
    .bind(now - 30 * 24 * 60 * 60 * 1000).run();
  const row = await env.DB.prepare(`
    SELECT submissions, window_started_at, blocked_until
    FROM site_message_limits
    WHERE client_hash = ?
  `).bind(clientHash).first();

  if (row && Number(row.blocked_until || 0) > now) {
    return { ok: false, clientHash, retryAfterMs: Number(row.blocked_until) - now };
  }

  let submissions = 0;
  let windowStartedAt = now;
  if (row && now - Number(row.window_started_at || 0) <= SITE_MESSAGE_WINDOW_MS) {
    submissions = Number(row.submissions || 0);
    windowStartedAt = Number(row.window_started_at || now);
  }

  if (submissions >= SITE_MESSAGE_MAX_PER_WINDOW) {
    const blockedUntil = now + SITE_MESSAGE_BLOCK_MS;
    await env.DB.prepare(`
      INSERT INTO site_message_limits (client_hash, submissions, window_started_at, blocked_until, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_hash) DO UPDATE SET
        submissions = excluded.submissions,
        window_started_at = excluded.window_started_at,
        blocked_until = excluded.blocked_until,
        updated_at = excluded.updated_at
    `).bind(clientHash, submissions, windowStartedAt, blockedUntil, now).run();
    return { ok: false, clientHash, retryAfterMs: SITE_MESSAGE_BLOCK_MS };
  }

  return { ok: true, clientHash, submissions, windowStartedAt, now };
}

async function recordSiteMessageSubmission(env, rate) {
  const submissions = Number(rate.submissions || 0) + 1;
  await env.DB.prepare(`
    INSERT INTO site_message_limits (client_hash, submissions, window_started_at, blocked_until, updated_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(client_hash) DO UPDATE SET
      submissions = excluded.submissions,
      window_started_at = excluded.window_started_at,
      blocked_until = 0,
      updated_at = excluded.updated_at
  `).bind(rate.clientHash, submissions, rate.windowStartedAt, rate.now).run();
}

function validateImageUpload(file, { maxBytes, label = "imagen" } = {}) {
  if (!file || typeof file === "string") return `Selecciona una ${label}`;
  const type = String(file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    return `${label[0].toUpperCase() + label.slice(1)} no válida. Usa JPG, PNG, WebP, AVIF o GIF.`;
  }
  if (Number(file.size || 0) <= 0) return `${label[0].toUpperCase() + label.slice(1)} vacía.`;
  if (Number(file.size || 0) > Number(maxBytes || 0)) {
    const mb = Math.round(Number(maxBytes || 0) / (1024 * 1024));
    return `${label[0].toUpperCase() + label.slice(1)} demasiado grande. Máximo ${mb} MB.`;
  }
  return "";
}

function toBool(value) {
  return value === true ||
    value === 1 ||
    value === "1" ||
    value === "true";
}

let catalogDisplayOrderSchemaReady = false;

async function ensureCatalogDisplayOrderSchema(env) {
  if (catalogDisplayOrderSchemaReady) return;

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS catalog_display_order (
        comic_id INTEGER PRIMARY KEY,
        sort_key INTEGER NOT NULL,
        shuffled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (comic_id) REFERENCES comics(id) ON DELETE CASCADE
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_catalog_display_order_sort
      ON catalog_display_order(sort_key DESC)
    `)
  ]);

  catalogDisplayOrderSchemaReady = true;
}

function catalogBaseSortKeySql(alias = "c") {
  return `(CAST(strftime('%s', ${alias}.updated_at) AS INTEGER) * 1000000 + ${alias}.id)`;
}

function catalogMixGroupKey(row) {
  const author = String(row?.author || "").trim().toLowerCase();
  if (author) return `author:${author}`;

  const firstTag = csvValues(row?.tags || row?.genre || "")[0];
  if (firstTag) return `tag:${String(firstTag).trim().toLowerCase()}`;

  return `comic:${Number(row?.id || 0)}`;
}

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function mixRecentComicRows(rows) {
  const groups = new Map();
  for (const row of shuffleArray(rows)) {
    const key = catalogMixGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Greedy equilibrado: mientras exista una alternativa, nunca repite el
  // mismo autor/categoría dos veces seguidas. Si un grupo domina tanto que
  // la separación es matemáticamente imposible, solo entonces repite.
  const mixed = [];
  let previousKey = "";

  while (mixed.length < rows.length) {
    let candidates = [...groups.entries()]
      .filter(([, items]) => items.length && (!previousKey || catalogMixGroupKey(items[items.length - 1]) !== previousKey));

    if (!candidates.length) {
      candidates = [...groups.entries()].filter(([, items]) => items.length);
    }

    const maxRemaining = Math.max(...candidates.map(([, items]) => items.length));
    const strongest = candidates.filter(([, items]) => items.length === maxRemaining);
    const [key, items] = strongest[Math.floor(Math.random() * strongest.length)];
    mixed.push(items.pop());
    previousKey = key;
  }

  return mixed;
}

async function shuffleRecentCatalog(env, requestedLimit) {
  await ensureCatalogDisplayOrderSchema(env);
  const limit = Math.min(100, Math.max(5, Number(requestedLimit || 30)));
  const baseKey = catalogBaseSortKeySql("c");
  const rows = await env.DB.prepare(`
    SELECT
      c.id,
      c.author,
      c.genre,
      c.tags,
      c.updated_at,
      ${baseKey} AS base_sort_key
    FROM comics c
    WHERE c.is_published = 1
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ?
  `).bind(limit).all();

  const recent = rows.results || [];
  if (recent.length < 2) {
    throw new Error("Necesitas al menos dos cómics publicados para mezclar el catálogo.");
  }

  const sortKeys = recent
    .map(row => Number(row.base_sort_key || 0))
    .sort((a, b) => b - a);
  const mixed = mixRecentComicRows(recent);

  const statements = [env.DB.prepare("DELETE FROM catalog_display_order")];
  mixed.forEach((row, index) => {
    statements.push(
      env.DB.prepare(`
        INSERT INTO catalog_display_order (comic_id, sort_key, shuffled_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `).bind(Number(row.id), sortKeys[index])
    );
  });
  await env.DB.batch(statements);

  return { count: mixed.length, limit };
}

async function resetCatalogDisplayOrder(env) {
  await ensureCatalogDisplayOrderSchema(env);
  const result = await env.DB.prepare("DELETE FROM catalog_display_order").run();
  return Number(result.meta?.changes || 0);
}

async function catalogDisplayOrderStatus(env) {
  await ensureCatalogDisplayOrderSchema(env);
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count, MAX(shuffled_at) AS shuffled_at
    FROM catalog_display_order
  `).first();
  return {
    count: Number(row?.count || 0),
    shuffled_at: row?.shuffled_at || ""
  };
}

let publicationTypeSchemaReady = false;

function normalizeContentType(value) {
  return String(value || "").toLowerCase() === "series"
    ? "series"
    : "single";
}

async function ensurePublicationTypeSchema(env) {
  if (publicationTypeSchemaReady) return;

  // IMPORTANT: content_type is an explicit editorial choice.
  // Never re-infer it on every Worker cold start from the number of internal
  // chapter rows, because older single-reading comics may contain more than
  // one internal chapter record.
  let columnWasAdded = false;

  try {
    await env.DB.prepare(
      "ALTER TABLE comics ADD COLUMN content_type TEXT NOT NULL DEFAULT 'single'"
    ).run();
    columnWasAdded = true;
  } catch (error) {
    const message = String(error || "").toLowerCase();
    if (!message.includes("duplicate column") && !message.includes("already exists")) {
      throw error;
    }
  }

  // Only on the very first legacy migration, infer obvious multi-part entries.
  // Once the column exists, the value chosen in Admin is always authoritative.
  if (columnWasAdded) {
    await env.DB.prepare(`
      UPDATE comics
      SET content_type = 'series'
      WHERE id IN (
        SELECT comic_id
        FROM chapters
        GROUP BY comic_id
        HAVING COUNT(*) > 1
      )
    `).run();
  }

  await env.DB.prepare(`
    UPDATE comics
    SET content_type = 'single'
    WHERE content_type IS NULL
       OR TRIM(content_type) = ''
       OR content_type NOT IN ('single', 'series')
  `).run();

  publicationTypeSchemaReady = true;
}


let seriesGroupingSchemaReady = false;

async function ensureSeriesGroupingSchema(env) {
  if (seriesGroupingSchemaReady) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS series_group_members (
      chapter_id INTEGER PRIMARY KEY,
      series_comic_id INTEGER NOT NULL,
      source_title TEXT NOT NULL DEFAULT '',
      source_slug TEXT NOT NULL DEFAULT '',
      source_description TEXT NOT NULL DEFAULT '',
      source_genre TEXT NOT NULL DEFAULT '',
      source_tags TEXT NOT NULL DEFAULT '',
      source_author TEXT NOT NULL DEFAULT '',
      source_status TEXT NOT NULL DEFAULT '',
      source_cover_key TEXT NOT NULL DEFAULT '',
      source_is_published INTEGER NOT NULL DEFAULT 1,
      source_views INTEGER NOT NULL DEFAULT 0,
      source_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_series_group_members_series
    ON series_group_members(series_comic_id, source_order)
  `).run();

  seriesGroupingSchemaReady = true;
}

function csvValues(value = '') {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function mergeCsvValues(...values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    for (const token of csvValues(value)) {
      const key = token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out.join(', ');
}

async function availableComicSlug(env, desired, reusableComicIds = []) {
  const base = slugify(desired) || 'serie';
  const reusable = new Set((reusableComicIds || []).map(Number).filter(Number.isFinite));
  for (let i = 0; i < 200; i++) {
    const candidate = i ? `${base}-${i + 1}` : base;
    const row = await env.DB.prepare('SELECT id FROM comics WHERE slug = ? LIMIT 1').bind(candidate).first();
    if (!row || reusable.has(Number(row.id))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

async function coverKeyStillReferenced(env, key, exceptComicId = 0, exceptSeriesId = 0) {
  const coverKey = String(key || '').trim();
  if (!coverKey) return false;
  const comic = await env.DB.prepare(`
    SELECT id FROM comics WHERE cover_key = ? AND id != ? LIMIT 1
  `).bind(coverKey, Number(exceptComicId || 0)).first();
  if (comic) return true;
  const member = await env.DB.prepare(`
    SELECT chapter_id
    FROM series_group_members
    WHERE source_cover_key = ?
      AND series_comic_id != ?
    LIMIT 1
  `).bind(coverKey, Number(exceptSeriesId || 0)).first();
  return Boolean(member);
}

async function getSeriesGroupedChapters(env, seriesComicId) {
  const rows = await env.DB.prepare(`
    SELECT ch.id, ch.comic_id, ch.chapter_number, ch.title, ch.is_published,
      gm.source_title, gm.source_slug, gm.source_description, gm.source_genre,
      gm.source_tags, gm.source_author, gm.source_status, gm.source_cover_key,
      gm.source_is_published, gm.source_views, gm.source_order
    FROM chapters ch
    LEFT JOIN series_group_members gm ON gm.chapter_id = ch.id
    WHERE ch.comic_id = ?
    ORDER BY ch.chapter_number ASC, ch.id ASC
  `).bind(seriesComicId).all();
  return rows.results || [];
}

async function groupExistingComicsIntoSeries(env, body = {}) {
  await ensureSeriesGroupingSchema(env);
  const ids = Array.from(new Set((Array.isArray(body.comic_ids) ? body.comic_ids : [])
    .map(Number).filter(id => Number.isInteger(id) && id > 0)));
  if (ids.length < 2) throw new Error('Selecciona al menos dos cómics para crear una serie.');
  if (ids.length > 50) throw new Error('Puedes agrupar hasta 50 cómics a la vez.');

  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!title) throw new Error('Escribe el nombre de la serie.');

  const placeholders = ids.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT * FROM comics WHERE id IN (${placeholders})`).bind(...ids).all();
  const byId = new Map((result.results || []).map(row => [Number(row.id), row]));
  if (byId.size !== ids.length) throw new Error('Uno de los cómics seleccionados ya no existe.');
  const comics = ids.map(id => byId.get(id));

  for (const comic of comics) {
    if (normalizeContentType(comic.content_type) !== 'single') {
      throw new Error(`"${comic.title}" ya es una serie. Solo puedes agrupar cómics únicos.`);
    }
  }

  const chapterRows = [];
  for (let i = 0; i < comics.length; i++) {
    const comic = comics[i];
    const chapters = await env.DB.prepare(`
      SELECT id, comic_id, chapter_number, title, is_published
      FROM chapters WHERE comic_id = ? ORDER BY chapter_number ASC, id ASC
    `).bind(comic.id).all();
    const list = chapters.results || [];
    if (list.length !== 1) {
      throw new Error(`"${comic.title}" debe tener una sola lectura interna para agruparlo. Ahora tiene ${list.length} partes internas.`);
    }
    chapterRows.push({ comic, chapter: list[0], order: i + 1 });
  }

  const target = comics[0];
  const targetId = Number(target.id);
  const slug = await availableComicSlug(env, body.slug || title, ids);
  const mergedTags = mergeCsvValues(...comics.map(c => c.tags || ''));
  const mergedGenre = mergeCsvValues(...comics.map(c => c.genre || ''), mergedTags);
  const totalViews = comics.reduce((sum, c) => sum + Number(c.views || 0), 0);
  const published = comics.some(c => Number(c.is_published || 0) === 1) ? 1 : 0;
  const statements = [];

  for (const item of chapterRows) {
    const c = item.comic, ch = item.chapter;
    statements.push(env.DB.prepare(`
      INSERT INTO series_group_members (
        chapter_id, series_comic_id, source_title, source_slug, source_description,
        source_genre, source_tags, source_author, source_status, source_cover_key,
        source_is_published, source_views, source_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chapter_id) DO UPDATE SET
        series_comic_id = excluded.series_comic_id,
        source_title = excluded.source_title,
        source_slug = excluded.source_slug,
        source_description = excluded.source_description,
        source_genre = excluded.source_genre,
        source_tags = excluded.source_tags,
        source_author = excluded.source_author,
        source_status = excluded.source_status,
        source_cover_key = excluded.source_cover_key,
        source_is_published = excluded.source_is_published,
        source_views = excluded.source_views,
        source_order = excluded.source_order
    `).bind(ch.id, targetId, String(c.title || ''), String(c.slug || ''), String(c.description || ''),
      String(c.genre || ''), String(c.tags || ''), String(c.author || ''), String(c.status || ''),
      String(c.cover_key || ''), Number(c.is_published || 0), Number(c.views || 0), item.order));

    statements.push(env.DB.prepare(`
      UPDATE chapters SET chapter_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(-(1000 + item.order), ch.id));
  }

  for (const item of chapterRows) {
    statements.push(env.DB.prepare(`UPDATE chapters SET comic_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(targetId, item.chapter.id));
  }
  for (const item of chapterRows) {
    statements.push(env.DB.prepare(`
      UPDATE chapters SET chapter_number = ?, title = ?, is_published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(item.order, String(item.comic.title || `Parte ${item.order}`), Number(item.comic.is_published || 0), item.chapter.id));
  }
  for (const comic of comics.slice(1)) {
    statements.push(env.DB.prepare('DELETE FROM comics WHERE id = ?').bind(comic.id));
  }
  statements.push(env.DB.prepare(`
    UPDATE comics SET slug = ?, title = ?, tags = ?, genre = ?, content_type = 'series',
      is_published = ?, views = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(slug, title, mergedTags, mergedGenre, published, totalViews, targetId));

  await env.DB.batch(statements);
  return { series_id: targetId, slug, title, chapter_count: chapterRows.length };
}

async function separateSeriesChapter(env, seriesComicId, chapterId) {
  await ensureSeriesGroupingSchema(env);
  const series = await env.DB.prepare('SELECT * FROM comics WHERE id = ? LIMIT 1').bind(seriesComicId).first();
  if (!series || normalizeContentType(series.content_type) !== 'series') throw new Error('La serie no existe.');

  const row = await env.DB.prepare(`
    SELECT ch.*, gm.source_title, gm.source_slug, gm.source_description, gm.source_genre,
      gm.source_tags, gm.source_author, gm.source_status, gm.source_cover_key,
      gm.source_is_published, gm.source_views
    FROM chapters ch
    LEFT JOIN series_group_members gm ON gm.chapter_id = ch.id
    WHERE ch.id = ? AND ch.comic_id = ? LIMIT 1
  `).bind(chapterId, seriesComicId).first();
  if (!row) throw new Error('Ese capítulo no pertenece a la serie.');

  const fallbackTitle = String(row.title || '').trim() || `${series.title} ${row.chapter_number}`;
  const title = String(row.source_title || fallbackTitle).replace(/\s+/g, ' ').trim().slice(0, 180);
  const slug = await availableComicSlug(env, row.source_slug || title, []);

  const create = await env.DB.prepare(`
    INSERT INTO comics (
      slug, title, description, genre, tags, author, status, cover_key,
      content_type, is_published, views, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'single', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    slug, title,
    String(row.source_description || series.description || ''),
    String(row.source_genre || row.source_tags || series.genre || series.tags || ''),
    String(row.source_tags || row.source_genre || series.tags || series.genre || ''),
    String(row.source_author || series.author || ''),
    String(row.source_status || series.status || 'Completo'),
    String(row.source_cover_key || ''),
    row.source_is_published == null ? Number(row.is_published || 0) : Number(row.source_is_published || 0),
    Number(row.source_views || 0)
  ).run();
  const newComicId = Number(create.meta.last_row_id);

  await env.DB.batch([
    env.DB.prepare(`UPDATE chapters SET comic_id = ?, chapter_number = 1, title = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(newComicId, chapterId),
    env.DB.prepare('DELETE FROM series_group_members WHERE chapter_id = ?').bind(chapterId),
    env.DB.prepare('UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(seriesComicId)
  ]);

  const remaining = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM chapters WHERE comic_id = ?'
  ).bind(seriesComicId).first();

  if (Number(remaining?.total || 0) === 0) {
    const oldCover = String(series.cover_key || '');
    await env.DB.prepare('DELETE FROM comics WHERE id = ?').bind(seriesComicId).run();
    if (oldCover && !(await coverKeyStillReferenced(env, oldCover, 0, 0))) {
      await env.MEDIA.delete(oldCover);
    }
  }

  return { comic_id: newComicId, slug, title };
}

async function ungroupEntireSeries(env, seriesComicId) {
  await ensureSeriesGroupingSchema(env);
  const series = await env.DB.prepare('SELECT * FROM comics WHERE id = ? LIMIT 1').bind(seriesComicId).first();
  if (!series || normalizeContentType(series.content_type) !== 'series') throw new Error('La serie no existe.');
  const chapters = await getSeriesGroupedChapters(env, seriesComicId);
  if (!chapters.length) throw new Error('La serie no tiene capítulos para separar.');

  const created = [];
  for (const chapter of chapters) created.push(await separateSeriesChapter(env, seriesComicId, Number(chapter.id)));

  const oldCover = String(series.cover_key || '');
  await env.DB.prepare('DELETE FROM comics WHERE id = ?').bind(seriesComicId).run();
  if (oldCover && !(await coverKeyStillReferenced(env, oldCover, 0))) await env.MEDIA.delete(oldCover);
  return created;
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
  await ensureSeriesGroupingSchema(env);

  const comic = await env.DB.prepare(`
    SELECT cover_key
    FROM comics
    WHERE id = ?
  `).bind(comicId).first();

  const rows = await env.DB.prepare(`
    SELECT p.object_key
    FROM pages p
    JOIN chapters ch ON ch.id = p.chapter_id
    WHERE ch.comic_id = ?
  `).bind(comicId).all();

  const groupedCovers = await env.DB.prepare(`
    SELECT source_cover_key
    FROM series_group_members
    WHERE series_comic_id = ?
  `).bind(comicId).all();

  const pageKeys = (rows.results || []).map(row => row.object_key).filter(Boolean);
  if (pageKeys.length) await env.MEDIA.delete(pageKeys);

  const coverKeys = new Set();
  if (comic?.cover_key) coverKeys.add(comic.cover_key);
  for (const row of groupedCovers.results || []) {
    if (row.source_cover_key) coverKeys.add(row.source_cover_key);
  }

  for (const key of coverKeys) {
    const shared = await coverKeyStillReferenced(env, key, comicId, comicId);
    if (!shared) await env.MEDIA.delete(key);
  }
}

async function publicComics(env, url) {
  await ensureCatalogDisplayOrderSchema(env);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 10)));

  const allowedSorts = new Set(["latest", "popular", "title_az", "title_za"]);
  const requestedSort = String(url.searchParams.get("sort") || "latest").trim();
  const sort = allowedSorts.has(requestedSort) ? requestedSort : "latest";

  const q = (url.searchParams.get("q") || "").trim();
  const genre = (url.searchParams.get("genre") || "").trim();
  const legacyTag = (url.searchParams.get("tag") || "").trim();
  const type = (url.searchParams.get("type") || "").trim().toLowerCase();

  const cleanTags = values => [...new Set(values
    .map(v => String(v || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))];

  const includeTags = cleanTags([
    ...url.searchParams.getAll("include_tag"),
    ...(legacyTag ? [legacyTag] : [])
  ]).slice(0, 12);
  const excludeTags = cleanTags(url.searchParams.getAll("exclude_tag")).slice(0, 12);

  const where = ["c.is_published = 1"];
  const binds = [];

  // Search every word independently so a query such as "clarence mom" can
  // match across title, author, tags, description, genre or chapter titles.
  if (q) {
    const terms = q.split(/\s+/).map(x => x.trim()).filter(Boolean).slice(0, 8);
    for (const term of terms) {
      where.push(`(
        LOWER(COALESCE(c.title, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(c.author, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(c.description, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(c.tags, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(c.genre, '')) LIKE LOWER(?)
        OR EXISTS (
          SELECT 1 FROM chapters sch
          WHERE sch.comic_id = c.id
          AND sch.is_published = 1
          AND LOWER(COALESCE(sch.title, '')) LIKE LOWER(?)
        )
      )`);
      const like = `%${term}%`;
      binds.push(like, like, like, like, like, like);
    }
  }

  const exactTagSql = `
    INSTR(
      ',' || LOWER(
        REPLACE(REPLACE(REPLACE(
          COALESCE(NULLIF(TRIM(c.tags), ''), c.genre, ''),
          ',  ', ','), ', ', ','), ' ,', ',')
      ) || ',',
      ',' || LOWER(?) || ','
    ) > 0
  `;

  if (genre) {
    where.push(exactTagSql);
    binds.push(genre.replace(/\s+/g, " ").trim());
  }

  for (const tag of includeTags) {
    where.push(exactTagSql);
    binds.push(tag);
  }

  for (const tag of excludeTags) {
    where.push(`NOT (${exactTagSql})`);
    binds.push(tag);
  }

  if (type === "single" || type === "series") {
    where.push("LOWER(COALESCE(c.content_type, 'single')) = ?");
    binds.push(type);
  }

  const whereSql = where.join(" AND ");
  const countRow = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM comics c
    WHERE ${whereSql}
  `).bind(...binds).first();

  const total = Number(countRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;

  const orderSql = sort === "popular"
    ? "c.views DESC, c.updated_at DESC, c.id DESC"
    : sort === "title_az"
      ? "LOWER(c.title) ASC, c.id DESC"
      : sort === "title_za"
        ? "LOWER(c.title) DESC, c.id DESC"
        : "COALESCE(cdo.sort_key, (CAST(strftime('%s', c.updated_at) AS INTEGER) * 1000000 + c.id)) DESC, c.updated_at DESC, c.id DESC";

  const rows = await env.DB.prepare(`
    SELECT
      c.*,
      (
        SELECT COUNT(*)
        FROM chapters ch
        WHERE ch.comic_id = c.id
        AND ch.is_published = 1
      ) AS part_count,
      CASE
        WHEN c.cover_key IS NOT NULL AND c.cover_key != ''
        THEN '/media/' || c.cover_key
        ELSE NULL
      END AS cover_url
    FROM comics c
    LEFT JOIN catalog_display_order cdo ON cdo.comic_id = c.id
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all();

  return json({
    ok: true,
    comics: rows.results || [],
    pagination: { page: safePage, limit, total, total_pages: totalPages },
    filters: { q, sort, type, include_tags: includeTags, exclude_tags: excludeTags }
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


const DEFAULT_CATEGORY_SEED = [["anal", "Anal", "anal sex, anal_sex", "visual"], ["blowjob", "Blowjob", "oral, fellatio, mamada, sexo oral masculino", "visual"], ["handjob", "Handjob", "hand job, masturbación manual", "visual"], ["cunnilingus", "Cunnilingus", "pussy licking, sexo oral femenino", "visual"], ["doggystyle", "Doggystyle", "doggy style, from behind, perrito", "visual"], ["cowgirl", "Cowgirl", "woman on top, chica arriba", "visual"], ["reverse-cowgirl", "Reverse Cowgirl", "reverse cowgirl, reverse_cowgirl", "visual"], ["misionero", "Misionero", "missionary, missionary position", "visual"], ["deepthroat", "Deepthroat", "deep throat, garganta profunda", "visual"], ["creampie", "Creampie", "internal ejaculation, eyaculación interna", "visual"], ["facial", "Facial", "facial ejaculation, eyaculación facial", "visual"], ["cumshot", "Cumshot", "ejaculation, cum shot", "visual"], ["paizuri", "Paizuri", "titjob, titfuck, breast sex", "visual"], ["fingering", "Fingering", "fingered, masturbación con dedos", "visual"], ["doble-penetracion", "Doble penetración", "double penetration, dp", "visual"], ["threesome", "Threesome", "threesome sex, trío", "visual"], ["gangbang", "Gangbang", "gang bang", "visual"], ["orgia", "Orgía", "orgy, group sex", "visual"], ["rubia", "Rubia", "blonde, blond hair", "visual"], ["morena", "Morena", "brunette, brown hair", "visual"], ["pelirroja", "Pelirroja", "redhead, red hair", "visual"], ["cabello-negro", "Cabello negro", "black hair", "visual"], ["gafas", "Gafas", "glasses, eyewear", "visual"], ["pechos-grandes", "Pechos grandes", "big breasts, large breasts, big boobs", "visual"], ["culo-grande", "Culo grande", "big ass, large ass", "visual"], ["curvilinea", "Curvilínea", "curvy, voluptuous", "visual"], ["musculosa", "Musculosa", "muscular female, muscular woman", "visual"], ["tatuajes", "Tatuajes", "tattoo, tattooed", "visual"], ["piercings", "Piercings", "piercing, pierced", "visual"], ["solo", "Solo", "solo", "visual"], ["pareja", "Pareja", "couple, 1 male 1 female", "visual"], ["trio", "Trío", "three people", "visual"], ["grupo", "Grupo", "group, multiple people", "visual"], ["lesbico", "Lésbico", "lesbian, yuri", "visual"], ["gay", "Gay", "male male, yaoi", "visual"], ["milf", "MILF", "milf", "ambas"], ["dormitorio", "Dormitorio", "bedroom, bed", "visual"], ["bano", "Baño", "bathroom, shower", "visual"], ["oficina", "Oficina", "office, workplace", "visual"], ["cocina", "Cocina", "kitchen", "visual"], ["hotel", "Hotel", "hotel room", "visual"], ["exterior", "Exterior", "outdoors, outside", "visual"], ["playa", "Playa", "beach", "visual"], ["piscina", "Piscina", "pool, swimming pool", "visual"], ["gimnasio", "Gimnasio", "gym", "visual"], ["coche", "Coche", "car, vehicle", "visual"], ["3d", "3D", "3d render, cgi", "visual"], ["hentai", "Hentai", "hentai", "visual"], ["anime", "Anime", "anime", "visual"], ["cartoon", "Cartoon", "cartoon", "visual"], ["comic-occidental", "Cómic occidental", "western comic", "visual"], ["realista", "Realista", "realistic, photorealistic", "visual"], ["incesto", "Incesto", "incest, incestuous", "contexto"], ["madrastra", "Madrastra", "stepmom, stepmother", "contexto"], ["padrastro", "Padrastro", "stepdad, stepfather", "contexto"], ["hermanastros", "Hermanastros", "stepsister, stepbrother, step siblings", "contexto"], ["madre-e-hijo", "Madre e hijo", "mother and son, mom and son", "contexto"], ["padre-e-hija", "Padre e hija", "father and daughter, dad and daughter", "contexto"], ["infidelidad", "Infidelidad", "cheating, cheating wife, cheating husband, affair", "contexto"], ["esposa", "Esposa", "wife, married woman", "contexto"], ["marido", "Marido", "husband", "contexto"], ["jefe", "Jefe", "boss", "contexto"], ["vecina", "Vecina", "neighbor, neighbour", "contexto"], ["chantaje", "Chantaje", "blackmail, threatened", "contexto"], ["voyeurismo", "Voyeurismo", "voyeur, spying, watching secretly", "ambas"]];

async function ensureCategoryTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      aliases TEXT NOT NULL DEFAULT '',
      detection_mode TEXT NOT NULL DEFAULT 'manual',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM categories").first();
  if (Number(row?.total || 0) === 0) {
    for (const [slug, name, aliases, mode] of DEFAULT_CATEGORY_SEED) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO categories (slug, name, aliases, detection_mode, is_active)
        VALUES (?, ?, ?, ?, 1)
      `).bind(slug, name, aliases, mode).run();
    }
  }

  /* Migraciones únicas: añaden vocabulario nuevo sin volver a crear categorías
     que el administrador elimine voluntariamente después. */
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS category_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const vocabularyMigration = "context-vocabulary-v2";
  const alreadyApplied = await env.DB.prepare(
    "SELECT migration_key FROM category_migrations WHERE migration_key = ?"
  ).bind(vocabularyMigration).first();

  if (!alreadyApplied) {
    const extraCategories = [
      ["madre", "Madre", "mamá, mama, mom, mommy, mother, mum, momma", "contexto"],
      ["padre", "Padre", "papá, papa, dad, daddy, father", "contexto"],
      ["hijo", "Hijo", "son, hijo", "contexto"],
      ["hija", "Hija", "daughter, hija", "contexto"],
      ["hermana", "Hermana", "sister, hermana", "contexto"],
      ["hermano", "Hermano", "brother, hermano", "contexto"],
      ["hermanastra", "Hermanastra", "stepsister, hermanastra", "contexto"],
      ["hermanastro", "Hermanastro", "stepbrother, hermanastro", "contexto"],
      ["hijastra", "Hijastra", "stepdaughter, hijastra", "contexto"],
      ["hijastro", "Hijastro", "stepson, hijastro", "contexto"],
      ["profesora", "Profesora", "female teacher, teacher, profesora, maestra", "contexto"],
      ["profesor", "Profesor", "male teacher, profesor, maestro", "contexto"]
    ];
    for (const [slug, name, aliases, mode] of extraCategories) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO categories (slug, name, aliases, detection_mode, is_active)
        VALUES (?, ?, ?, ?, 1)
      `).bind(slug, name, aliases, mode).run();
    }
    await env.DB.prepare(
      "INSERT OR IGNORE INTO category_migrations (migration_key) VALUES (?)"
    ).bind(vocabularyMigration).run();
  }
}

function cleanCategoryAliases(value = "") {
  const out = [];
  const seen = new Set();
  for (const raw of String(value || "").split(",")) {
    const item = raw.replace(/\s+/g, " ").trim();
    const key = item.toLocaleLowerCase("es");
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.join(", ");
}

function categoryTokens(category) {
  return [category?.name, ...splitTagList(category?.aliases || "")]
    .map(x => String(x || "").trim())
    .filter(Boolean);
}

async function listAdminCategories(env) {
  await ensureCategoryTable(env);
  const rows = await env.DB.prepare(`
    SELECT id, slug, name, aliases, detection_mode, is_active, created_at, updated_at
    FROM categories
    ORDER BY is_active DESC, name COLLATE NOCASE ASC
  `).all();
  return rows.results || [];
}

async function replaceCategoryInComics(env, oldCategory, newName = "") {
  const tokens = new Set(categoryTokens(oldCategory).map(x => x.toLocaleLowerCase("es")));
  if (!tokens.size) return 0;
  const rows = await env.DB.prepare("SELECT id, tags, genre FROM comics").all();
  let changed = 0;

  for (const row of rows.results || []) {
    let touched = false;
    const rewrite = (value) => {
      const out = [];
      const seen = new Set();
      for (const item of splitTagList(value || "")) {
        const key = item.toLocaleLowerCase("es");
        const replacement = tokens.has(key) ? String(newName || "").trim() : item;
        if (tokens.has(key)) touched = true;
        if (!replacement) continue;
        const rkey = replacement.toLocaleLowerCase("es");
        if (seen.has(rkey)) continue;
        seen.add(rkey);
        out.push(replacement);
      }
      return out.join(", ");
    };

    const tags = rewrite(row.tags);
    const genre = rewrite(row.genre);
    if (touched) {
      await env.DB.prepare(`
        UPDATE comics SET tags = ?, genre = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(tags, genre, row.id).run();
      changed += 1;
    }
  }
  return changed;
}

async function createAdminCategory(env, body) {
  await ensureCategoryTable(env);
  const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("El nombre de la categoría es obligatorio.");
  const slug = slugify(body.slug || name);
  if (!slug) throw new Error("El nombre no genera un identificador válido.");
  const aliases = cleanCategoryAliases(body.aliases || "");
  const mode = ["visual", "contexto", "ambas", "manual"].includes(body.detection_mode) ? body.detection_mode : "manual";
  const result = await env.DB.prepare(`
    INSERT INTO categories (slug, name, aliases, detection_mode, is_active)
    VALUES (?, ?, ?, ?, ?)
  `).bind(slug, name, aliases, mode, toBool(body.is_active ?? true) ? 1 : 0).run();
  return env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(result.meta.last_row_id).first();
}

async function updateAdminCategory(env, id, body) {
  await ensureCategoryTable(env);
  const current = await env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first();
  if (!current) return null;
  const name = String(body.name ?? current.name).replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("El nombre de la categoría es obligatorio.");
  const slug = slugify(body.slug || name);
  const aliases = cleanCategoryAliases(body.aliases ?? current.aliases);
  const mode = ["visual", "contexto", "ambas", "manual"].includes(body.detection_mode) ? body.detection_mode : current.detection_mode;
  const active = body.is_active === undefined ? Number(current.is_active || 0) : (toBool(body.is_active) ? 1 : 0);

  if (name.toLocaleLowerCase("es") !== String(current.name).toLocaleLowerCase("es")) {
    await replaceCategoryInComics(env, current, name);
  }

  await env.DB.prepare(`
    UPDATE categories
    SET slug = ?, name = ?, aliases = ?, detection_mode = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(slug, name, aliases, mode, active, id).run();
  return env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first();
}

async function deleteAdminCategory(env, id) {
  await ensureCategoryTable(env);
  const current = await env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first();
  if (!current) return null;
  const affectedComics = await replaceCategoryInComics(env, current, "");
  await env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
  return { category: current, affected_comics: affectedComics };
}

async function ensureAnalysisMemoryTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS analysis_memory (
      series_key TEXT PRIMARY KEY,
      series_title TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      rejected_tags TEXT NOT NULL DEFAULT '',
      memory_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  /* Compatibilidad con instalaciones que ya tenían la memoria v2. */
  const info = await env.DB.prepare("PRAGMA table_info(analysis_memory)").all();
  const names = new Set((info.results || []).map(x => String(x.name || "")));
  if (!names.has("rejected_tags")) {
    await env.DB.prepare("ALTER TABLE analysis_memory ADD COLUMN rejected_tags TEXT NOT NULL DEFAULT ''").run();
  }
  if (!names.has("memory_version")) {
    await env.DB.prepare("ALTER TABLE analysis_memory ADD COLUMN memory_version INTEGER NOT NULL DEFAULT 1").run();
  }
}

function cleanAnalysisMemoryTags(value) {
  const source = Array.isArray(value) ? value : splitTagList(value || "");
  const out = [];
  const seen = new Set();
  for (const raw of source) {
    const item = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const key = item.toLocaleLowerCase("es");
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 50) break;
  }
  return out;
}

async function getAnalysisMemory(env, seriesKey) {
  await ensureAnalysisMemoryTable(env);
  const key = String(seriesKey || "").trim().slice(0, 180);
  if (!key) return { series_key: "", series_title: "", tags: [], rejected_tags: [], memory_version: 3 };
  const row = await env.DB.prepare(`
    SELECT series_key, series_title, tags, rejected_tags, memory_version, updated_at
    FROM analysis_memory WHERE series_key = ?
  `).bind(key).first();
  if (!row) return { series_key: key, series_title: "", tags: [], rejected_tags: [], memory_version: 3 };

  /* La memoria v2 se alimentaba también de sugerencias automáticas. No se usa
     como confirmación en v3 hasta que el administrador vuelva a guardar/corregir. */
  const trusted = Number(row.memory_version || 0) >= 3;
  return {
    ...row,
    tags: trusted ? splitTagList(row.tags || "") : [],
    rejected_tags: trusted ? splitTagList(row.rejected_tags || "") : [],
    legacy_ignored: !trusted
  };
}

async function saveAnalysisMemory(env, body) {
  await ensureAnalysisMemoryTable(env);
  const key = String(body.series_key || "").trim().slice(0, 180);
  if (!key) throw new Error("Falta el identificador de la serie.");
  const title = String(body.series_title || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const incomingAccepted = cleanAnalysisMemoryTags(body.tags || []);
  const incomingRejected = cleanAnalysisMemoryTags(body.rejected_tags || []);
  const merge = body.merge === undefined ? true : toBool(body.merge);

  const accepted = new Map();
  const rejected = new Map();
  if (merge) {
    const current = await getAnalysisMemory(env, key);
    for (const tag of current.tags || []) accepted.set(tag.toLocaleLowerCase("es"), tag);
    for (const tag of current.rejected_tags || []) rejected.set(tag.toLocaleLowerCase("es"), tag);
  }

  for (const tag of incomingAccepted) {
    const k = tag.toLocaleLowerCase("es");
    accepted.set(k, tag);
    rejected.delete(k);
  }
  for (const tag of incomingRejected) {
    const k = tag.toLocaleLowerCase("es");
    rejected.set(k, tag);
    accepted.delete(k);
  }

  const acceptedList = [...accepted.values()].slice(0, 50);
  const rejectedList = [...rejected.values()].slice(0, 50);
  await env.DB.prepare(`
    INSERT INTO analysis_memory (series_key, series_title, tags, rejected_tags, memory_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(series_key) DO UPDATE SET
      series_title = excluded.series_title,
      tags = excluded.tags,
      rejected_tags = excluded.rejected_tags,
      memory_version = 3,
      updated_at = CURRENT_TIMESTAMP
  `).bind(key, title, acceptedList.join(", "), rejectedList.join(", ")).run();
  return getAnalysisMemory(env, key);
}

async function deleteAnalysisMemory(env, seriesKey) {
  await ensureAnalysisMemoryTable(env);
  const key = String(seriesKey || "").trim().slice(0, 180);
  if (!key) return false;
  const result = await env.DB.prepare("DELETE FROM analysis_memory WHERE series_key = ?").bind(key).run();
  return Number(result.meta?.changes || 0) > 0;
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
  await ensureCatalogDisplayOrderSchema(env);
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
    LEFT JOIN catalog_display_order cdo ON cdo.comic_id = c.id

    WHERE
      c.is_published = 1

    ORDER BY
      COALESCE(cdo.sort_key, (CAST(strftime('%s', c.updated_at) AS INTEGER) * 1000000 + c.id)) DESC,
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

  applyCommonSecurityHeaders(headers);

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

  const headers = applyCommonSecurityHeaders(new Headers({
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=300"
  }));

  return new Response(xml, { status: 200, headers });
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

      if (path.startsWith("/api/") || path === "/" || path === "/index.html" || /^\/comic\/[^/]+\/?$/.test(path)) {
        await ensurePublicationTypeSchema(env);
        await ensureSeriesGroupingSchema(env);
      }

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
        const body = await request.json().catch(() => ({}));
        const { clientHash, now, row } = await getAdminLoginState(request, env);

        if (row && Number(row.locked_until || 0) > now) {
          const retryAfter = Math.max(1, Math.ceil((Number(row.locked_until) - now) / 1000));
          return json({
            ok: false,
            error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(retryAfter / 60)} min.`,
            retry_after: retryAfter
          }, 429);
        }

        const passwordOk = Boolean(env.ADMIN_TOKEN) &&
          await secureStringEqual(String(body.password || ""), String(env.ADMIN_TOKEN || ""));

        if (!passwordOk) {
          const state = await recordAdminLoginFailure(env, clientHash, row, now);
          if (state.lockedUntil > now) {
            return json({
              ok: false,
              error: "Demasiados intentos incorrectos. Acceso bloqueado temporalmente.",
              retry_after: Math.ceil((state.lockedUntil - now) / 1000)
            }, 429);
          }
          return json({ ok: false, error: "Contraseña incorrecta" }, 401);
        }

        await clearAdminLoginFailures(env, clientHash);
        const session = await createAdminSession(request, env);
        return json({
          ok: true,
          session: session.token,
          expires_at: session.expiresAt,
          expires_in: Math.floor(ADMIN_SESSION_TTL_MS / 1000)
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
            c.content_type,
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
            gm.source_title AS grouped_source_title,
            gm.source_order AS grouped_source_order,

            (
              SELECT COUNT(*)
              FROM pages p
              WHERE p.chapter_id = ch.id
            ) AS page_count

          FROM chapters ch

          LEFT JOIN series_group_members gm
            ON gm.chapter_id = ch.id

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

        const siblings = await env.DB.prepare(
          `
          SELECT
            ch.id,
            ch.chapter_number,
            ch.title,
            ch.is_published,
            (
              SELECT COUNT(*)
              FROM pages p
              WHERE p.chapter_id = ch.id
            ) AS page_count
          FROM chapters ch
          WHERE ch.comic_id = ?
          AND ch.is_published = 1
          AND EXISTS (
            SELECT 1
            FROM pages p2
            WHERE p2.chapter_id = ch.id
          )
          ORDER BY ch.chapter_number ASC, ch.id ASC
          `
        )
          .bind(chapter.comic_id)
          .all();

        const chapterList = siblings.results || [];
        const chapterIndex = chapterList.findIndex(
          item => Number(item.id) === Number(chapterId)
        );

        return json({
          ok: true,
          chapter,
          pages:
            rows.results || [],
          chapters: chapterList,
          previous_chapter:
            chapterIndex > 0
              ? chapterList[chapterIndex - 1]
              : null,
          next_chapter:
            chapterIndex >= 0 &&
            chapterIndex < chapterList.length - 1
              ? chapterList[chapterIndex + 1]
              : null
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
        headers.set(
          "X-Content-Type-Options",
          "nosniff"
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
      PUBLIC CONTACT / PRIVACY / DMCA REPORTS
      ========================================
      */

      if (method === "POST" && path === "/api/contact") {
        await ensureSiteMessagesSchema(env);
        const body = await request.json().catch(() => ({}));

        // Honeypot: los usuarios reales no ven ni completan este campo.
        if (String(body.website || '').trim()) {
          return json({ ok: true, received: true });
        }

        const kind = normalizeSiteMessageKind(body.kind);
        const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        const email = String(body.email || '').trim().slice(0, 254);
        const subject = String(body.subject || '').trim().replace(/\s+/g, ' ').slice(0, 200);
        const message = String(body.message || '').trim().slice(0, SITE_MESSAGE_MAX_TEXT);
        const rawUrl = String(body.content_url || '').trim();
        const contentUrl = normalizeReportedUrl(rawUrl);

        if (!validContactEmail(email)) {
          return json({ ok: false, error: "Introduce un correo electrónico válido." }, 400);
        }
        if (kind === 'dmca' && !name) {
          return json({ ok: false, error: "Indica el nombre del titular o representante." }, 400);
        }
        if (message.length < 20) {
          return json({ ok: false, error: "Explica la solicitud con al menos 20 caracteres." }, 400);
        }
        if (rawUrl && !contentUrl) {
          return json({ ok: false, error: "La URL indicada no es válida." }, 400);
        }

        const rate = await checkSiteMessageRate(request, env);
        if (!rate.ok) {
          const minutes = Math.max(1, Math.ceil(Number(rate.retryAfterMs || 0) / 60000));
          return json({ ok: false, error: `Demasiados envíos. Inténtalo de nuevo en aproximadamente ${minutes} minuto(s).` }, 429);
        }

        const result = await env.DB.prepare(`
          INSERT INTO site_messages (
            kind, name, email, subject, content_url, message, status, client_hash,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'new', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(kind, name, email, subject, contentUrl, message, rate.clientHash).run();

        await recordSiteMessageSubmission(env, rate);

        return json({
          ok: true,
          received: true,
          reference: Number(result.meta.last_row_id || 0)
        }, 201);
      }

      /*
      ========================================
      PROTECT ADMIN ROUTES
      ========================================
      */

      if (
        path.startsWith("/api/admin/") &&
        !(await isAdmin(request, env))
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




      if (method === "POST" && path === "/api/admin/logout") {
        await revokeAdminSession(request, env);
        return json({ ok: true });
      }


      /*
      ========================================
      ADMIN SITE MESSAGES
      ========================================
      */

      if (method === "GET" && path === "/api/admin/messages") {
        await ensureSiteMessagesSchema(env);
        const requestedStatus = normalizeSiteMessageStatus(url.searchParams.get('status'));
        const requestedKindRaw = String(url.searchParams.get('kind') || '').toLowerCase();
        const requestedKind = ['general', 'privacy', 'security', 'dmca'].includes(requestedKindRaw)
          ? requestedKindRaw
          : '';
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));

        const conditions = [];
        const bindings = [];
        if (requestedStatus) {
          conditions.push('status = ?');
          bindings.push(requestedStatus);
        }
        if (requestedKind) {
          conditions.push('kind = ?');
          bindings.push(requestedKind);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await env.DB.prepare(`
          SELECT id, kind, name, email, subject, content_url, message, status, created_at, updated_at
          FROM site_messages
          ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).bind(...bindings, limit).all();

        return json({ ok: true, messages: rows.results || [] });
      }

      const adminMessageMatch = path.match(/^\/api\/admin\/messages\/(\d+)$/);
      if (adminMessageMatch && method === "PUT") {
        await ensureSiteMessagesSchema(env);
        const id = Number(adminMessageMatch[1]);
        const body = await request.json().catch(() => ({}));
        const status = normalizeSiteMessageStatus(body.status);
        if (!status) return json({ ok: false, error: "Estado de mensaje inválido." }, 400);
        const result = await env.DB.prepare(`
          UPDATE site_messages
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(status, id).run();
        if (!Number(result.meta.changes || 0)) return json({ ok: false, error: "Mensaje no encontrado." }, 404);
        return json({ ok: true });
      }

      if (adminMessageMatch && method === "DELETE") {
        await ensureSiteMessagesSchema(env);
        const id = Number(adminMessageMatch[1]);
        const result = await env.DB.prepare("DELETE FROM site_messages WHERE id = ?").bind(id).run();
        if (!Number(result.meta.changes || 0)) return json({ ok: false, error: "Mensaje no encontrado." }, 404);
        return json({ ok: true });
      }

      /*
      ========================================
      ADMIN CATEGORIES
      ========================================
      */

      if (method === "GET" && path === "/api/admin/categories") {
        return json({ ok: true, categories: await listAdminCategories(env) });
      }

      if (method === "POST" && path === "/api/admin/categories") {
        const body = await request.json().catch(() => ({}));
        try {
          const category = await createAdminCategory(env, body);
          return json({ ok: true, category }, 201);
        } catch (error) {
          const message = String(error?.message || error);
          return json({ ok: false, error: /UNIQUE|constraint/i.test(message) ? "Ya existe una categoría con ese nombre o identificador." : message }, 400);
        }
      }

      const adminCategoryMatch = path.match(/^\/api\/admin\/categories\/(\d+)$/);
      if (adminCategoryMatch && method === "PUT") {
        const body = await request.json().catch(() => ({}));
        try {
          const category = await updateAdminCategory(env, Number(adminCategoryMatch[1]), body);
          return category ? json({ ok: true, category }) : json({ ok: false, error: "Categoría no encontrada." }, 404);
        } catch (error) {
          const message = String(error?.message || error);
          return json({ ok: false, error: /UNIQUE|constraint/i.test(message) ? "Ya existe una categoría con ese nombre o identificador." : message }, 400);
        }
      }

      if (adminCategoryMatch && method === "DELETE") {
        const result = await deleteAdminCategory(env, Number(adminCategoryMatch[1]));
        return result ? json({ ok: true, ...result }) : json({ ok: false, error: "Categoría no encontrada." }, 404);
      }

      /*
      ========================================
      ANALYSIS MEMORY · SERIES
      ========================================
      */

      if (path === "/api/admin/analysis-memory" && method === "GET") {
        const seriesKey = url.searchParams.get("series_key") || "";
        return json({ ok: true, memory: await getAnalysisMemory(env, seriesKey) });
      }

      if (path === "/api/admin/analysis-memory" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        try {
          return json({ ok: true, memory: await saveAnalysisMemory(env, body) });
        } catch (error) {
          return json({ ok: false, error: String(error?.message || error) }, 400);
        }
      }

      if (path === "/api/admin/analysis-memory" && method === "DELETE") {
        const seriesKey = url.searchParams.get("series_key") || "";
        const deleted = await deleteAnalysisMemory(env, seriesKey);
        return json({ ok: true, deleted });
      }

      /*
      ========================================
      ADMIN CATALOG DISPLAY ORDER
      ========================================
      */

      if (method === "GET" && path === "/api/admin/catalog-order") {
        return json({ ok: true, ...(await catalogDisplayOrderStatus(env)) });
      }

      if (method === "POST" && path === "/api/admin/catalog-order/shuffle") {
        const body = await request.json().catch(() => ({}));
        try {
          const result = await shuffleRecentCatalog(env, body.limit);
          return json({ ok: true, ...result, ...(await catalogDisplayOrderStatus(env)) });
        } catch (error) {
          return json({ ok: false, error: String(error?.message || error) }, 400);
        }
      }

      if (method === "POST" && path === "/api/admin/catalog-order/reset") {
        const restored = await resetCatalogDisplayOrder(env);
        return json({ ok: true, restored, ...(await catalogDisplayOrderStatus(env)) });
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
              FROM comics
              WHERE content_type = 'single'
            ) AS single_comics,

            (
              SELECT COUNT(*)
              FROM comics
              WHERE content_type = 'series'
            ) AS series,

            (
              SELECT COUNT(*)
              FROM chapters ch
              JOIN comics c ON c.id = ch.comic_id
              WHERE c.content_type = 'series'
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
              single_comics: 0,
              series: 0,
              chapters: 0,
              pages: 0,
              views: 0
            }
        });
      }



      /*
      ========================================
      GROUP EXISTING COMICS / UNGROUP SERIES
      ========================================
      */

      if (method === "POST" && path === "/api/admin/series/group") {
        const body = await request.json().catch(() => ({}));
        try {
          const series = await groupExistingComicsIntoSeries(env, body);
          return json({ ok: true, series }, 201);
        } catch (error) {
          return json({ ok: false, error: String(error?.message || error) }, 400);
        }
      }

      const ungroupSeriesMatch = path.match(/^\/api\/admin\/series\/(\d+)\/ungroup$/);
      if (ungroupSeriesMatch && method === "POST") {
        const seriesId = Number(ungroupSeriesMatch[1]);
        const body = await request.json().catch(() => ({}));
        try {
          if (toBool(body.all)) {
            const comics = await ungroupEntireSeries(env, seriesId);
            return json({ ok: true, comics });
          }
          const chapterId = Number(body.chapter_id);
          if (!Number.isInteger(chapterId) || chapterId <= 0) {
            return json({ ok: false, error: "Selecciona el capítulo que quieres convertir en cómic independiente." }, 400);
          }
          const comic = await separateSeriesChapter(env, seriesId, chapterId);
          return json({ ok: true, comic }, 201);
        } catch (error) {
          return json({ ok: false, error: String(error?.message || error) }, 400);
        }
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
              content_type,
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
              normalizeContentType(body.content_type),
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
              content_type = COALESCE(?, content_type),
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
              body.content_type == null ? null : normalizeContentType(body.content_type),
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
          `DELETE FROM series_group_members WHERE series_comic_id = ?`
        ).bind(id).run();

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

        const coverError = validateImageUpload(file, {
          maxBytes: MAX_COVER_BYTES,
          label: "portada"
        });
        if (coverError) return json({ ok: false, error: coverError }, 400);

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
          const reserved = await coverKeyStillReferenced(env, comic.cover_key, comicId);
          if (!reserved) {
            await env.MEDIA.delete(comic.cover_key);
          }
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

          const chapterCountRow = await env.DB.prepare(
            "SELECT COUNT(*) AS total FROM chapters WHERE comic_id = ?"
          ).bind(comicId).first();

          if (Number(chapterCountRow?.total || 0) > 1) {
            await env.DB.prepare(
              "UPDATE comics SET content_type = 'series', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).bind(comicId).run();
          } else {
            await touchComic(
              env,
              comicId
            );
          }

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

        const groupedSource = await env.DB.prepare(
          `SELECT source_cover_key, series_comic_id FROM series_group_members WHERE chapter_id = ? LIMIT 1`
        ).bind(id).first();

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
          `DELETE FROM series_group_members WHERE chapter_id = ?`
        ).bind(id).run();

        await env.DB.prepare(
          `
          DELETE FROM chapters
          WHERE id = ?
          `
        )
          .bind(id)
          .run();

        if (groupedSource?.source_cover_key) {
          const shared = await coverKeyStillReferenced(env, groupedSource.source_cover_key, 0, 0);
          if (!shared) await env.MEDIA.delete(groupedSource.source_cover_key);
        }

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

        if (files.length > MAX_PAGE_FILES_PER_REQUEST) {
          return json({
            ok: false,
            error: `Demasiadas páginas en una sola petición. Máximo ${MAX_PAGE_FILES_PER_REQUEST}.`
          }, 400);
        }

        let totalUploadBytes = 0;
        for (const file of files) {
          const pageError = validateImageUpload(file, {
            maxBytes: MAX_PAGE_BYTES,
            label: "página"
          });
          if (pageError) return json({ ok: false, error: `${safeName(file.name)}: ${pageError}` }, 400);
          totalUploadBytes += Number(file.size || 0);
        }
        if (totalUploadBytes > MAX_PAGE_BATCH_BYTES) {
          return json({
            ok: false,
            error: `El lote de páginas es demasiado grande. Máximo ${Math.round(MAX_PAGE_BATCH_BYTES / (1024 * 1024))} MB por envío.`
          }, 400);
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
