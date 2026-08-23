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
      )
      `
    );

    const like = `%${q}%`;

    binds.push(
      like,
      like,
      like
    );
  }

  if (genre) {
    where.push(
      "LOWER(c.genre) = LOWER(?)"
    );

    binds.push(
      genre
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

async function publicGenres(env) {
  const rows = await env.DB.prepare(
    `
    SELECT
      TRIM(genre) AS genre,
      COUNT(*) AS comic_count
    FROM comics
    WHERE
      is_published = 1
      AND genre IS NOT NULL
      AND TRIM(genre) != ''
    GROUP BY LOWER(TRIM(genre))
    ORDER BY comic_count DESC, genre COLLATE NOCASE ASC
    `
  ).all();

  return json({
    ok: true,
    genres: (rows.results || []).map((row) => ({
      name: row.genre,
      count: Number(row.comic_count || 0)
    }))
  });
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
      comic.genre || undefined,
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
      comic.genre
        ? `<strong>Categoría:</strong> ${escapeHtml(comic.genre)} · `
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
