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

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

async function deleteComicMedia(env, comicId) {
  const pages = await env.DB.prepare(`
    SELECT p.object_key
    FROM pages p
    JOIN chapters ch
      ON ch.id = p.chapter_id
    WHERE ch.comic_id = ?
  `)
  .bind(comicId)
  .all();

  const comic = await env.DB.prepare(`
    SELECT cover_key
    FROM comics
    WHERE id = ?
  `)
  .bind(comicId)
  .first();

  const keys = [];

  if (comic?.cover_key) {
    keys.push(comic.cover_key);
  }

  for (const page of pages.results || []) {
    if (page.object_key) {
      keys.push(page.object_key);
    }
  }

  if (keys.length) {
    await env.MEDIA.delete(keys);
  }
}

async function touchComic(env, comicId) {
  await env.DB.prepare(`
    UPDATE comics
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
  .bind(comicId)
  .run();
}

async function touchChapter(env, chapterId) {
  await env.DB.prepare(`
    UPDATE chapters
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
  .bind(chapterId)
  .run();
}

async function renumberPages(env, chapterId) {
  const result = await env.DB.prepare(`
    SELECT id
    FROM pages
    WHERE chapter_id = ?
    ORDER BY page_number ASC, id ASC
  `)
  .bind(chapterId)
  .all();

  const pages = result.results || [];

  if (!pages.length) {
    return;
  }

  const tempStatements = pages.map((page, index) =>
    env.DB.prepare(`
      UPDATE pages
      SET page_number = ?
      WHERE id = ?
    `)
    .bind(-(index + 1), page.id)
  );

  await env.DB.batch(tempStatements);

  const finalStatements = pages.map((page, index) =>
    env.DB.prepare(`
      UPDATE pages
      SET page_number = ?
      WHERE id = ?
    `)
    .bind(index + 1, page.id)
  );

  await env.DB.batch(finalStatements);
}

async function publicComics(env, url) {
  const requestedPage = Math.max(
    1,
    Number(url.searchParams.get("page") || 1)
  );

  const limit = Math.min(
    50,
    Math.max(
      1,
      Number(url.searchParams.get("limit") || 20)
    )
  );

  const sort =
    url.searchParams.get("sort") === "popular"
      ? "popular"
      : "latest";

  const search = String(
    url.searchParams.get("q") || ""
  ).trim();

  const genre = String(
    url.searchParams.get("genre") || ""
  ).trim();

  const where = [
    "c.is_published = 1"
  ];

  const bindings = [];

  if (search) {
    where.push(`
      (
        c.title LIKE ?
        OR c.author LIKE ?
        OR c.description LIKE ?
      )
    `);

    const value = `%${search}%`;

    bindings.push(
      value,
      value,
      value
    );
  }

  if (genre) {
    where.push(`
      LOWER(c.genre) = LOWER(?)
    `);

    bindings.push(genre);
  }

  const whereSql = where.join(" AND ");

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM comics c
    WHERE ${whereSql}
  `)
  .bind(...bindings)
  .first();

  const total = Number(
    countResult?.total || 0
  );

  const totalPages = Math.max(
    1,
    Math.ceil(total / limit)
  );

  const page = Math.min(
    requestedPage,
    totalPages
  );

  const offset =
    (page - 1) * limit;

  const orderSql =
    sort === "popular"
      ? `
        c.views DESC,
        c.updated_at DESC,
        c.id DESC
      `
      : `
        c.updated_at DESC,
        c.id DESC
      `;

  const result = await env.DB.prepare(`
    SELECT
      c.id,
      c.slug,
      c.title,
      c.description,
      c.genre,
      c.author,
      c.status,
      c.cover_key,
      c.views,
      c.is_published,
      c.created_at,
      c.updated_at,

      COUNT(ch.id) AS part_count,

      MAX(ch.chapter_number) AS latest_part

    FROM comics c

    LEFT JOIN chapters ch
      ON ch.comic_id = c.id
      AND ch.is_published = 1

    WHERE ${whereSql}

    GROUP BY c.id

    ORDER BY ${orderSql}

    LIMIT ?
    OFFSET ?
  `)
  .bind(
    ...bindings,
    limit,
    offset
  )
  .all();

  const comics = (result.results || []).map(comic => ({
    ...comic,

    cover_url:
      comic.cover_key
        ? `/media/${encodeURIComponent(comic.cover_key)}`
        : null,

    views:
      Number(comic.views || 0),

    part_count:
      Number(comic.part_count || 0),

    latest_part:
      comic.latest_part == null
        ? null
        : Number(comic.latest_part)
  }));

  return {
    comics,

    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages
    }
  };
}

async function adminComics(env) {
  const result = await env.DB.prepare(`
    SELECT
      c.*,
      COUNT(ch.id) AS part_count
    FROM comics c
    LEFT JOIN chapters ch
      ON ch.comic_id = c.id
    GROUP BY c.id
    ORDER BY
      c.updated_at DESC,
      c.id DESC
  `)
  .all();

  return (result.results || []).map(comic => ({
    ...comic,

    cover_url:
      comic.cover_key
        ? `/media/${encodeURIComponent(comic.cover_key)}`
        : null,

    views:
      Number(comic.views || 0),

    part_count:
      Number(comic.part_count || 0)
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;


    /* =====================================
       HEALTH
    ===================================== */

    if (
      path === "/api/health" &&
      request.method === "GET"
    ) {
      let databaseConnected = false;
      let mediaConnected = false;

      try {
        const result = await env.DB
          .prepare("SELECT 1 AS ok")
          .first();

        databaseConnected =
          result?.ok === 1;
      } catch {}

      try {
        const result = await env.MEDIA.list({
          limit: 1
        });

        mediaConnected =
          Array.isArray(result.objects);
      } catch {}

      return json({
        ok:
          databaseConnected &&
          mediaConnected,

        app: "nightink-app",

        worker: true,

        databaseConnected,

        mediaConnected,

        adminConfigured:
          Boolean(env.ADMIN_TOKEN)
      });
    }


    /* =====================================
       ADMIN LOGIN
    ===================================== */

    if (
      path === "/api/admin/login" &&
      request.method === "POST"
    ) {
      let body = {};

      try {
        body = await request.json();
      } catch {}

      if (!env.ADMIN_TOKEN) {
        return json(
          {
            ok: false,
            error:
              "ADMIN_TOKEN no configurado"
          },
          500
        );
      }

      if (
        (body.password || "") !==
        env.ADMIN_TOKEN
      ) {
        return json(
          {
            ok: false,
            error:
              "Clave incorrecta"
          },
          401
        );
      }

      return json({
        ok: true
      });
    }


    /* =====================================
       PUBLIC COMICS + PAGINATION
    ===================================== */

    if (
      path === "/api/comics" &&
      request.method === "GET"
    ) {
      const result =
        await publicComics(
          env,
          url
        );

      return json({
        ok: true,

        comics:
          result.comics,

        pagination:
          result.pagination
      });
    }


    /* =====================================
       LATEST UPDATES
    ===================================== */

    if (
      path === "/api/updates" &&
      request.method === "GET"
    ) {
      const limit = Math.min(
        30,
        Math.max(
          1,
          Number(
            url.searchParams.get("limit") || 10
          )
        )
      );

      const result = await env.DB.prepare(`
        SELECT

          ch.id AS chapter_id,

          ch.chapter_number,

          ch.title AS chapter_title,

          ch.updated_at,

          c.id AS comic_id,

          c.slug,

          c.title AS comic_title,

          c.genre,

          c.author,

          c.cover_key,

          c.views,

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
          AND c.is_published = 1

        ORDER BY
          ch.updated_at DESC,
          ch.id DESC

        LIMIT ?
      `)
      .bind(limit)
      .all();

      return json({
        ok: true,

        updates:
          (result.results || [])
          .map(item => ({
            ...item,

            chapter_number:
              Number(
                item.chapter_number
              ),

            views:
              Number(
                item.views || 0
              ),

            page_count:
              Number(
                item.page_count || 0
              ),

            cover_url:
              item.cover_key
                ? `/media/${encodeURIComponent(item.cover_key)}`
                : null
          }))
      });
    }


    /* =====================================
       PUBLIC COMIC DETAIL
    ===================================== */

    const publicComicMatch =
      path.match(
        /^\/api\/comics\/([^/]+)$/
      );

    if (
      publicComicMatch &&
      request.method === "GET"
    ) {
      const slug =
        decodeURIComponent(
          publicComicMatch[1]
        );

      const comic =
        await env.DB.prepare(`
          SELECT *
          FROM comics
          WHERE slug = ?
            AND is_published = 1
        `)
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

      await env.DB.prepare(`
        UPDATE comics
        SET views = views + 1
        WHERE id = ?
      `)
      .bind(comic.id)
      .run();

      const chapters =
        await env.DB.prepare(`
          SELECT

            ch.id,

            ch.chapter_number,

            ch.title,

            ch.is_published,

            ch.created_at,

            ch.updated_at,

            COUNT(p.id)
              AS page_count

          FROM chapters ch

          LEFT JOIN pages p
            ON p.chapter_id = ch.id

          WHERE
            ch.comic_id = ?
            AND ch.is_published = 1

          GROUP BY ch.id

          ORDER BY
            ch.chapter_number ASC
        `)
        .bind(comic.id)
        .all();

      return json({
        ok: true,

        comic: {
          ...comic,

          views:
            Number(
              comic.views || 0
            ) + 1,

          cover_url:
            comic.cover_key
              ? `/media/${encodeURIComponent(comic.cover_key)}`
              : null
        },

        chapters:
          (chapters.results || [])
          .map(chapter => ({
            ...chapter,

            chapter_number:
              Number(
                chapter.chapter_number
              ),

            page_count:
              Number(
                chapter.page_count || 0
              )
          }))
      });
    }


    /* =====================================
       PUBLIC CHAPTER PAGES
    ===================================== */

    const publicChapterMatch =
      path.match(
        /^\/api\/chapters\/(\d+)\/pages$/
      );

    if (
      publicChapterMatch &&
      request.method === "GET"
    ) {
      const chapterId =
        Number(
          publicChapterMatch[1]
        );

      const chapter =
        await env.DB.prepare(`
          SELECT

            ch.*,

            c.title
              AS comic_title,

            c.slug
              AS comic_slug

          FROM chapters ch

          JOIN comics c
            ON c.id =
               ch.comic_id

          WHERE
            ch.id = ?
            AND ch.is_published = 1
            AND c.is_published = 1
        `)
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

      const pages =
        await env.DB.prepare(`
          SELECT
            id,
            page_number,
            object_key
          FROM pages
          WHERE chapter_id = ?
          ORDER BY
            page_number ASC,
            id ASC
        `)
        .bind(chapterId)
        .all();

      return json({
        ok: true,

        chapter: {
          ...chapter,

          chapter_number:
            Number(
              chapter.chapter_number
            )
        },

        pages:
          (pages.results || [])
          .map(page => ({
            id:
              Number(page.id),

            page_number:
              Number(
                page.page_number
              ),

            url:
              `/media/${encodeURIComponent(page.object_key)}`
          }))
      });
    }


    /* =====================================
       MEDIA
    ===================================== */

    if (
      path.startsWith("/media/") &&
      request.method === "GET"
    ) {
      const key =
        decodeURIComponent(
          path.slice(
            "/media/".length
          )
        );

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
        "etag",
        object.httpEtag
      );

      headers.set(
        "Cache-Control",
        "public, max-age=86400"
      );

      return new Response(
        object.body,
        {
          headers
        }
      );
    }


    /* =====================================
       ADMIN SECURITY
    ===================================== */

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


    /* =====================================
       ADMIN STATS
    ===================================== */

    if (
      path === "/api/admin/stats" &&
      request.method === "GET"
    ) {
      const comics =
        await env.DB.prepare(`
          SELECT COUNT(*) AS n
          FROM comics
        `)
        .first();

      const chapters =
        await env.DB.prepare(`
          SELECT COUNT(*) AS n
          FROM chapters
        `)
        .first();

      const pages =
        await env.DB.prepare(`
          SELECT COUNT(*) AS n
          FROM pages
        `)
        .first();

      const views =
        await env.DB.prepare(`
          SELECT
            COALESCE(
              SUM(views),
              0
            ) AS n
          FROM comics
        `)
        .first();

      return json({
        ok: true,

        stats: {
          comics:
            Number(
              comics?.n || 0
            ),

          chapters:
            Number(
              chapters?.n || 0
            ),

          pages:
            Number(
              pages?.n || 0
            ),

          views:
            Number(
              views?.n || 0
            )
        }
      });
    }


    /* =====================================
       ADMIN COMICS LIST
    ===================================== */

    if (
      path === "/api/admin/comics" &&
      request.method === "GET"
    ) {
      return json({
        ok: true,

        comics:
          await adminComics(env)
      });
    }


    /* =====================================
       CREATE COMIC
    ===================================== */

    if (
      path === "/api/admin/comics" &&
      request.method === "POST"
    ) {
      let body = {};

      try {
        body = await request.json();
      } catch {}

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
          body.slug || title
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
        const result =
          await env.DB.prepare(`
            INSERT INTO comics
            (
              slug,
              title,
              description,
              genre,
              author,
              status,
              views,
              is_published,
              created_at,
              updated_at
            )
            VALUES
            (
              ?, ?, ?, ?, ?, ?,
              0,
              ?,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
          `)
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
            body.is_published
              ? 1
              : 0
          )
          .run();

        return json({
          ok: true,

          id:
            result.meta
            .last_row_id,

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
                "Ya existe una obra con ese título o slug"
            },
            409
          );
        }

        return json(
          {
            ok: false,
            error:
              "No se pudo crear el cómic"
          },
          500
        );
      }
    }


    /* =====================================
       UPDATE / DELETE COMIC
    ===================================== */

    const adminComicMatch =
      path.match(
        /^\/api\/admin\/comics\/(\d+)$/
      );

    if (adminComicMatch) {
      const id =
        Number(
          adminComicMatch[1]
        );

      if (
        request.method === "PUT"
      ) {
        let body = {};

        try {
          body =
            await request.json();
        } catch {}

        const existing =
          await env.DB.prepare(`
            SELECT *
            FROM comics
            WHERE id = ?
          `)
          .bind(id)
          .first();

        if (!existing) {
          return json(
            {
              ok: false,
              error:
                "Cómic no encontrado"
            },
            404
          );
        }

        const title =
          String(
            body.title ??
            existing.title
          ).trim();

        const slug =
          slugify(
            body.slug ??
            existing.slug ??
            title
          );

        try {
          await env.DB.prepare(`
            UPDATE comics
            SET
              slug = ?,
              title = ?,
              description = ?,
              genre = ?,
              author = ?,
              status = ?,
              is_published = ?,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            slug,

            title,

            String(
              body.description ??
              existing.description ??
              ""
            ),

            String(
              body.genre ??
              existing.genre ??
              ""
            ),

            String(
              body.author ??
              existing.author ??
              ""
            ),

            String(
              body.status ??
              existing.status ??
              "En emisión"
            ),

            body.is_published
              ? 1
              : 0,

            id
          )
          .run();

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
                  "Ese slug ya existe"
              },
              409
            );
          }

          return json(
            {
              ok: false,
              error:
                "No se pudo actualizar"
            },
            500
          );
        }
      }

      if (
        request.method === "DELETE"
      ) {
        await deleteComicMedia(
          env,
          id
        );

        await env.DB.prepare(`
          DELETE FROM comics
          WHERE id = ?
        `)
        .bind(id)
        .run();

        return json({
          ok: true
        });
      }
    }


    /* =====================================
       COVER
    ===================================== */

    const coverMatch =
      path.match(
        /^\/api\/admin\/comics\/(\d+)\/cover$/
      );

    if (
      coverMatch &&
      request.method === "POST"
    ) {
      const comicId =
        Number(
          coverMatch[1]
        );

      const comic =
        await env.DB.prepare(`
          SELECT *
          FROM comics
          WHERE id = ?
        `)
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

      if (!(file instanceof File)) {
        return json(
          {
            ok: false,
            error:
              "Falta la portada"
          },
          400
        );
      }

      const extension =
        (
          file.name
          .split(".")
          .pop() ||
          "jpg"
        )
        .toLowerCase()
        .replace(
          /[^a-z0-9]/g,
          ""
        );

      const key =
        `covers/${comicId}/${crypto.randomUUID()}.${extension || "jpg"}`;

      if (comic.cover_key) {
        await env.MEDIA.delete(
          comic.cover_key
        );
      }

      await env.MEDIA.put(
        key,
        file.stream(),
        {
          httpMetadata: {
            contentType:
              file.type ||
              "image/jpeg"
          }
        }
      );

      await env.DB.prepare(`
        UPDATE comics
        SET
          cover_key = ?,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        key,
        comicId
      )
      .run();

      return json({
        ok: true,

        cover_url:
          `/media/${encodeURIComponent(key)}`
      });
    }


    /* =====================================
       LIST / CREATE CHAPTERS
    ===================================== */

    const chapterListMatch =
      path.match(
        /^\/api\/admin\/comics\/(\d+)\/chapters$/
      );

    if (
      chapterListMatch &&
      request.method === "GET"
    ) {
      const comicId =
        Number(
          chapterListMatch[1]
        );

      const result =
        await env.DB.prepare(`
          SELECT

            ch.*,

            COUNT(p.id)
              AS page_count

          FROM chapters ch

          LEFT JOIN pages p
            ON p.chapter_id =
               ch.id

          WHERE
            ch.comic_id = ?

          GROUP BY ch.id

          ORDER BY
            ch.chapter_number ASC
        `)
        .bind(comicId)
        .all();

      return json({
        ok: true,

        chapters:
          (result.results || [])
          .map(chapter => ({
            ...chapter,

            chapter_number:
              Number(
                chapter.chapter_number
              ),

            page_count:
              Number(
                chapter.page_count || 0
              )
          }))
      });
    }

    if (
      chapterListMatch &&
      request.method === "POST"
    ) {
      const comicId =
        Number(
          chapterListMatch[1]
        );

      let body = {};

      try {
        body =
          await request.json();
      } catch {}

      const number =
        Number(
          body.chapter_number
        );

      if (
        !Number.isFinite(number)
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
        const result =
          await env.DB.prepare(`
            INSERT INTO chapters
            (
              comic_id,
              chapter_number,
              title,
              is_published,
              created_at,
              updated_at
            )
            VALUES
            (
              ?, ?, ?, ?,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
          `)
          .bind(
            comicId,

            number,

            String(
              body.title || ""
            ),

            body.is_published
              ? 1
              : 0
          )
          .run();

        await touchComic(
          env,
          comicId
        );

        return json({
          ok: true,

          id:
            result.meta
            .last_row_id
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
                "Ya existe esa parte"
            },
            409
          );
        }

        return json(
          {
            ok: false,
            error:
              "No se pudo crear la parte"
          },
          500
        );
      }
    }


    /* =====================================
       UPDATE / DELETE CHAPTER
    ===================================== */

    const chapterMatch =
      path.match(
        /^\/api\/admin\/chapters\/(\d+)$/
      );

    if (chapterMatch) {
      const chapterId =
        Number(
          chapterMatch[1]
        );

      if (
        request.method === "PUT"
      ) {
        const existing =
          await env.DB.prepare(`
            SELECT *
            FROM chapters
            WHERE id = ?
          `)
          .bind(chapterId)
          .first();

        if (!existing) {
          return json(
            {
              ok: false,
              error:
                "Parte no encontrada"
            },
            404
          );
        }

        let body = {};

        try {
          body =
            await request.json();
        } catch {}

        const number =
          Number(
            body.chapter_number ??
            existing.chapter_number
          );

        if (
          !Number.isFinite(number)
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
          await env.DB.prepare(`
            UPDATE chapters
            SET
              chapter_number = ?,
              title = ?,
              is_published = ?,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            number,

            String(
              body.title ??
              existing.title ??
              ""
            ),

            body.is_published
              ? 1
              : 0,

            chapterId
          )
          .run();

          await touchComic(
            env,
            existing.comic_id
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
                  "Ya existe una parte con ese número"
              },
              409
            );
          }

          return json(
            {
              ok: false,
              error:
                "No se pudo editar la parte"
            },
            500
          );
        }
      }

      if (
        request.method === "DELETE"
      ) {
        const chapter =
          await env.DB.prepare(`
            SELECT *
            FROM chapters
            WHERE id = ?
          `)
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

        const pages =
          await env.DB.prepare(`
            SELECT object_key
            FROM pages
            WHERE chapter_id = ?
          `)
          .bind(chapterId)
          .all();

        const keys =
          (pages.results || [])
          .map(
            page =>
              page.object_key
          )
          .filter(Boolean);

        if (keys.length) {
          await env.MEDIA.delete(
            keys
          );
        }

        await env.DB.prepare(`
          DELETE FROM chapters
          WHERE id = ?
        `)
        .bind(chapterId)
        .run();

        await touchComic(
          env,
          chapter.comic_id
        );

        return json({
          ok: true
        });
      }
    }


    /* =====================================
       ADMIN PAGES
    ===================================== */

    const adminPagesMatch =
      path.match(
        /^\/api\/admin\/chapters\/(\d+)\/pages$/
      );

    if (
      adminPagesMatch &&
      request.method === "GET"
    ) {
      const chapterId =
        Number(
          adminPagesMatch[1]
        );

      const chapter =
        await env.DB.prepare(`
          SELECT *
          FROM chapters
          WHERE id = ?
        `)
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

      const result =
        await env.DB.prepare(`
          SELECT
            id,
            chapter_id,
            page_number,
            object_key,
            created_at
          FROM pages
          WHERE chapter_id = ?
          ORDER BY
            page_number ASC,
            id ASC
        `)
        .bind(chapterId)
        .all();

      return json({
        ok: true,

        chapter,

        pages:
          (result.results || [])
          .map(page => ({
            ...page,

            id:
              Number(page.id),

            page_number:
              Number(
                page.page_number
              ),

            url:
              `/media/${encodeURIComponent(page.object_key)}`
          }))
      });
    }


    /* =====================================
       UPLOAD PAGES
    ===================================== */

    if (
      adminPagesMatch &&
      request.method === "POST"
    ) {
      const chapterId =
        Number(
          adminPagesMatch[1]
        );

      const chapter =
        await env.DB.prepare(`
          SELECT
            ch.*,
            c.id AS comic_id
          FROM chapters ch
          JOIN comics c
            ON c.id =
               ch.comic_id
          WHERE ch.id = ?
        `)
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

      const current =
        await env.DB.prepare(`
          SELECT
            COALESCE(
              MAX(page_number),
              0
            ) AS max_page
          FROM pages
          WHERE chapter_id = ?
        `)
        .bind(chapterId)
        .first();

      let pageNumber =
        Number(
          current?.max_page || 0
        );

      const form =
        await request.formData();

      const files =
        form.getAll("pages")
        .filter(
          value =>
            value instanceof File
        );

      if (!files.length) {
        return json(
          {
            ok: false,
            error:
              "Selecciona al menos una imagen"
          },
          400
        );
      }

      const added = [];

      for (const file of files) {
        pageNumber += 1;

        const extension =
          (
            file.name
            .split(".")
            .pop() ||
            "jpg"
          )
          .toLowerCase()
          .replace(
            /[^a-z0-9]/g,
            ""
          );

        const key =
          `chapters/${chapterId}/${String(pageNumber).padStart(4, "0")}-${crypto.randomUUID()}.${extension || "jpg"}`;

        await env.MEDIA.put(
          key,
          file.stream(),
          {
            httpMetadata: {
              contentType:
                file.type ||
                "image/jpeg"
            }
          }
        );

        const result =
          await env.DB.prepare(`
            INSERT INTO pages
            (
              chapter_id,
              page_number,
              object_key,
              created_at
            )
            VALUES
            (
              ?, ?, ?,
              CURRENT_TIMESTAMP
            )
          `)
          .bind(
            chapterId,
            pageNumber,
            key
          )
          .run();

        added.push({
          id:
            result.meta
            .last_row_id,

          page_number:
            pageNumber,

          url:
            `/media/${encodeURIComponent(key)}`
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

      return json({
        ok: true,
        added
      });
    }


    /* =====================================
       REORDER PAGES
    ===================================== */

    const reorderMatch =
      path.match(
        /^\/api\/admin\/chapters\/(\d+)\/pages\/reorder$/
      );

    if (
      reorderMatch &&
      request.method === "POST"
    ) {
      const chapterId =
        Number(
          reorderMatch[1]
        );

      let body = {};

      try {
        body =
          await request.json();
      } catch {}

      const pageIds =
        Array.isArray(
          body.page_ids
        )
        ? body.page_ids.map(Number)
        : [];

      const current =
        await env.DB.prepare(`
          SELECT id
          FROM pages
          WHERE chapter_id = ?
          ORDER BY page_number ASC
        `)
        .bind(chapterId)
        .all();

      const currentIds =
        (current.results || [])
        .map(
          page =>
            Number(page.id)
        );

      if (
        pageIds.length !==
        currentIds.length
      ) {
        return json(
          {
            ok: false,
            error:
              "La lista de páginas no coincide"
          },
          400
        );
      }

      const expected =
        [...currentIds]
        .sort((a,b) => a-b);

      const received =
        [...pageIds]
        .sort((a,b) => a-b);

      if (
        expected.join(",") !==
        received.join(",")
      ) {
        return json(
          {
            ok: false,
            error:
              "Hay páginas inválidas"
          },
          400
        );
      }

      const temporaryStatements =
        pageIds.map(
          (pageId, index) =>
            env.DB.prepare(`
              UPDATE pages
              SET page_number = ?
              WHERE id = ?
                AND chapter_id = ?
            `)
            .bind(
              -(index + 1),
              pageId,
              chapterId
            )
        );

      if (
        temporaryStatements.length
      ) {
        await env.DB.batch(
          temporaryStatements
        );
      }

      const finalStatements =
        pageIds.map(
          (pageId, index) =>
            env.DB.prepare(`
              UPDATE pages
              SET page_number = ?
              WHERE id = ?
                AND chapter_id = ?
            `)
            .bind(
              index + 1,
              pageId,
              chapterId
            )
        );

      if (
        finalStatements.length
      ) {
        await env.DB.batch(
          finalStatements
        );
      }

      const chapter =
        await env.DB.prepare(`
          SELECT comic_id
          FROM chapters
          WHERE id = ?
        `)
        .bind(chapterId)
        .first();

      await touchChapter(
        env,
        chapterId
      );

      if (chapter?.comic_id) {
        await touchComic(
          env,
          chapter.comic_id
        );
      }

      return json({
        ok: true
      });
    }


    /* =====================================
       DELETE ONE PAGE
    ===================================== */

    const deletePageMatch =
      path.match(
        /^\/api\/admin\/pages\/(\d+)$/
      );

    if (
      deletePageMatch &&
      request.method === "DELETE"
    ) {
      const pageId =
        Number(
          deletePageMatch[1]
        );

      const page =
        await env.DB.prepare(`
          SELECT *
          FROM pages
          WHERE id = ?
        `)
        .bind(pageId)
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

      await env.DB.prepare(`
        DELETE FROM pages
        WHERE id = ?
      `)
      .bind(pageId)
      .run();

      await renumberPages(
        env,
        page.chapter_id
      );

      const chapter =
        await env.DB.prepare(`
          SELECT comic_id
          FROM chapters
          WHERE id = ?
        `)
        .bind(
          page.chapter_id
        )
        .first();

      await touchChapter(
        env,
        page.chapter_id
      );

      if (
        chapter?.comic_id
      ) {
        await touchComic(
          env,
          chapter.comic_id
        );
      }

      return json({
        ok: true
      });
    }


    /* =====================================
       STATIC WEBSITE
    ===================================== */

    return env.ASSETS.fetch(
      request
    );
  }
};
