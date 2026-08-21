function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function adminOK(request, env) {
  return Boolean(env.ADMIN_TOKEN) && request.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;
}

function slugify(value = "") {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
}

async function getPublicComics(env) {
  const r = await env.DB.prepare(`
    SELECT c.id,c.slug,c.title,c.description,c.genre,c.author,c.status,c.cover_key,c.views,
           c.is_published,c.created_at,c.updated_at,
           COUNT(ch.id) AS part_count, MAX(ch.chapter_number) AS latest_part
    FROM comics c
    LEFT JOIN chapters ch ON ch.comic_id=c.id AND ch.is_published=1
    WHERE c.is_published=1
    GROUP BY c.id
    ORDER BY c.updated_at DESC,c.id DESC
  `).all();
  return (r.results || []).map(c => ({
    ...c,
    part_count: Number(c.part_count || 0),
    latest_part: c.latest_part == null ? null : Number(c.latest_part),
    cover_url: c.cover_key ? `/media/${encodeURIComponent(c.cover_key)}` : null
  }));
}

async function getAdminComics(env) {
  const r = await env.DB.prepare(`
    SELECT c.*,COUNT(ch.id) AS part_count
    FROM comics c
    LEFT JOIN chapters ch ON ch.comic_id=c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC,c.id DESC
  `).all();
  return (r.results || []).map(c => ({
    ...c,
    part_count: Number(c.part_count || 0),
    cover_url: c.cover_key ? `/media/${encodeURIComponent(c.cover_key)}` : null
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      let databaseConnected=false,mediaConnected=false;
      try { databaseConnected=(await env.DB.prepare("SELECT 1 AS ok").first())?.ok===1; } catch {}
      try { mediaConnected=Array.isArray((await env.MEDIA.list({limit:1})).objects); } catch {}
      return json({ok:databaseConnected&&mediaConnected,app:"nightink-app",worker:true,databaseConnected,mediaConnected,adminConfigured:Boolean(env.ADMIN_TOKEN)});
    }

    if (path === "/api/admin/login" && request.method === "POST") {
      let body={}; try { body=await request.json(); } catch {}
      if (!env.ADMIN_TOKEN) return json({ok:false,error:"ADMIN_TOKEN no configurado"},500);
      if ((body.password||"") !== env.ADMIN_TOKEN) return json({ok:false,error:"Clave incorrecta"},401);
      return json({ok:true});
    }

    if (path === "/api/comics" && request.method === "GET") {
      return json({ok:true,comics:await getPublicComics(env)});
    }

    const comicDetail = path.match(/^\/api\/comics\/([^/]+)$/);
    if (comicDetail && request.method === "GET") {
      const slug=decodeURIComponent(comicDetail[1]);
      const comic=await env.DB.prepare("SELECT * FROM comics WHERE slug=? AND is_published=1").bind(slug).first();
      if (!comic) return json({ok:false,error:"Cómic no encontrado"},404);
      await env.DB.prepare("UPDATE comics SET views=views+1 WHERE id=?").bind(comic.id).run();
      const chapters=await env.DB.prepare(`
        SELECT ch.id,ch.chapter_number,ch.title,ch.is_published,ch.created_at,COUNT(p.id) AS page_count
        FROM chapters ch LEFT JOIN pages p ON p.chapter_id=ch.id
        WHERE ch.comic_id=? AND ch.is_published=1
        GROUP BY ch.id ORDER BY ch.chapter_number ASC
      `).bind(comic.id).all();
      return json({ok:true,comic:{...comic,views:Number(comic.views||0)+1,cover_url:comic.cover_key?`/media/${encodeURIComponent(comic.cover_key)}`:null},chapters:(chapters.results||[]).map(ch=>({...ch,chapter_number:Number(ch.chapter_number),page_count:Number(ch.page_count||0)}))});
    }

    const chapterPages = path.match(/^\/api\/chapters\/(\d+)\/pages$/);
    if (chapterPages && request.method === "GET") {
      const id=Number(chapterPages[1]);
      const chapter=await env.DB.prepare(`
        SELECT ch.*,c.title AS comic_title,c.slug AS comic_slug
        FROM chapters ch JOIN comics c ON c.id=ch.comic_id
        WHERE ch.id=? AND ch.is_published=1 AND c.is_published=1
      `).bind(id).first();
      if (!chapter) return json({ok:false,error:"Parte no encontrada"},404);
      const pages=await env.DB.prepare("SELECT id,page_number,object_key FROM pages WHERE chapter_id=? ORDER BY page_number ASC").bind(id).all();
      return json({ok:true,chapter:{...chapter,chapter_number:Number(chapter.chapter_number)},pages:(pages.results||[]).map(p=>({id:p.id,page_number:Number(p.page_number),url:`/media/${encodeURIComponent(p.object_key)}`}))});
    }

    if (path.startsWith("/media/") && request.method === "GET") {
      const key=decodeURIComponent(path.slice(7));
      const object=await env.MEDIA.get(key);
      if (!object) return new Response("Not found",{status:404});
      const headers=new Headers(); object.writeHttpMetadata(headers); headers.set("etag",object.httpEtag); headers.set("Cache-Control","public, max-age=86400");
      return new Response(object.body,{headers});
    }

    if (path.startsWith("/api/admin/") && !adminOK(request,env)) return json({ok:false,error:"No autorizado"},401);

    if (path === "/api/admin/stats" && request.method === "GET") {
      const a=await env.DB.prepare("SELECT COUNT(*) AS n FROM comics").first();
      const b=await env.DB.prepare("SELECT COUNT(*) AS n FROM chapters").first();
      const c=await env.DB.prepare("SELECT COUNT(*) AS n FROM pages").first();
      const d=await env.DB.prepare("SELECT COALESCE(SUM(views),0) AS n FROM comics").first();
      return json({ok:true,stats:{comics:Number(a?.n||0),chapters:Number(b?.n||0),pages:Number(c?.n||0),views:Number(d?.n||0)}});
    }

    if (path === "/api/admin/comics" && request.method === "GET") return json({ok:true,comics:await getAdminComics(env)});

    if (path === "/api/admin/comics" && request.method === "POST") {
      let body={}; try { body=await request.json(); } catch {}
      const title=String(body.title||"").trim(); if(!title) return json({ok:false,error:"El título es obligatorio"},400);
      const slug=slugify(body.slug||title); if(!slug) return json({ok:false,error:"Slug inválido"},400);
      try {
        const r=await env.DB.prepare(`INSERT INTO comics (slug,title,description,genre,author,status,views,is_published,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
          .bind(slug,title,String(body.description||""),String(body.genre||""),String(body.author||""),String(body.status||"En emisión"),body.is_published?1:0).run();
        return json({ok:true,id:r.meta.last_row_id,slug});
      } catch(e) {
        if(String(e).toLowerCase().includes("unique")) return json({ok:false,error:"Ya existe una obra con ese slug"},409);
        return json({ok:false,error:"No se pudo crear la obra"},500);
      }
    }

    const adminComic = path.match(/^\/api\/admin\/comics\/(\d+)$/);
    if (adminComic) {
      const id=Number(adminComic[1]);
      if(request.method === "PUT") {
        const old=await env.DB.prepare("SELECT * FROM comics WHERE id=?").bind(id).first();
        if(!old) return json({ok:false,error:"No encontrado"},404);
        let body={}; try { body=await request.json(); } catch {}
        const title=String(body.title??old.title).trim(); const slug=slugify(body.slug??old.slug??title);
        try {
          await env.DB.prepare(`UPDATE comics SET slug=?,title=?,description=?,genre=?,author=?,status=?,is_published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .bind(slug,title,String(body.description??old.description??""),String(body.genre??old.genre??""),String(body.author??old.author??""),String(body.status??old.status??"En emisión"),body.is_published?1:0,id).run();
          return json({ok:true});
        } catch(e) { return json({ok:false,error:String(e).toLowerCase().includes("unique")?"Ese slug ya existe":"No se pudo actualizar"},409); }
      }
      if(request.method === "DELETE") {
        const pageRows=await env.DB.prepare(`SELECT p.object_key FROM pages p JOIN chapters ch ON ch.id=p.chapter_id WHERE ch.comic_id=?`).bind(id).all();
        const comic=await env.DB.prepare("SELECT cover_key FROM comics WHERE id=?").bind(id).first();
        const keys=(pageRows.results||[]).map(x=>x.object_key).filter(Boolean); if(comic?.cover_key) keys.push(comic.cover_key); if(keys.length) await env.MEDIA.delete(keys);
        await env.DB.prepare("DELETE FROM comics WHERE id=?").bind(id).run(); return json({ok:true});
      }
    }

    const cover = path.match(/^\/api\/admin\/comics\/(\d+)\/cover$/);
    if (cover && request.method === "POST") {
      const id=Number(cover[1]); const comic=await env.DB.prepare("SELECT * FROM comics WHERE id=?").bind(id).first(); if(!comic) return json({ok:false,error:"No encontrado"},404);
      const form=await request.formData(); const file=form.get("cover"); if(!(file instanceof File)) return json({ok:false,error:"Falta la portada"},400);
      const ext=(file.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,""); const key=`covers/${id}/${crypto.randomUUID()}.${ext||"jpg"}`;
      if(comic.cover_key) await env.MEDIA.delete(comic.cover_key);
      await env.MEDIA.put(key,file.stream(),{httpMetadata:{contentType:file.type||"image/jpeg"}});
      await env.DB.prepare("UPDATE comics SET cover_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(key,id).run();
      return json({ok:true,cover_url:`/media/${encodeURIComponent(key)}`});
    }

    const comicChapters = path.match(/^\/api\/admin\/comics\/(\d+)\/chapters$/);
    if (comicChapters && request.method === "GET") {
      const id=Number(comicChapters[1]); const r=await env.DB.prepare(`SELECT ch.*,COUNT(p.id) AS page_count FROM chapters ch LEFT JOIN pages p ON p.chapter_id=ch.id WHERE ch.comic_id=? GROUP BY ch.id ORDER BY ch.chapter_number ASC`).bind(id).all();
      return json({ok:true,chapters:(r.results||[]).map(ch=>({...ch,chapter_number:Number(ch.chapter_number),page_count:Number(ch.page_count||0)}))});
    }
    if (comicChapters && request.method === "POST") {
      const comicId=Number(comicChapters[1]); let body={}; try{body=await request.json()}catch{} const n=Number(body.chapter_number); if(!Number.isFinite(n)) return json({ok:false,error:"Número inválido"},400);
      try {
        const r=await env.DB.prepare(`INSERT INTO chapters (comic_id,chapter_number,title,is_published,created_at,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(comicId,n,String(body.title||""),body.is_published?1:0).run();
        await env.DB.prepare("UPDATE comics SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(comicId).run(); return json({ok:true,id:r.meta.last_row_id});
      } catch(e){ return json({ok:false,error:String(e).toLowerCase().includes("unique")?"Ya existe esa parte":"No se pudo crear la parte"},409); }
    }

    const chapterDelete = path.match(/^\/api\/admin\/chapters\/(\d+)$/);
    if(chapterDelete && request.method === "DELETE") {
      const id=Number(chapterDelete[1]); const r=await env.DB.prepare("SELECT object_key FROM pages WHERE chapter_id=?").bind(id).all(); const keys=(r.results||[]).map(x=>x.object_key).filter(Boolean); if(keys.length) await env.MEDIA.delete(keys); await env.DB.prepare("DELETE FROM chapters WHERE id=?").bind(id).run(); return json({ok:true});
    }

    const pageUpload = path.match(/^\/api\/admin\/chapters\/(\d+)\/pages$/);
    if(pageUpload && request.method === "POST") {
      const id=Number(pageUpload[1]); const ch=await env.DB.prepare("SELECT * FROM chapters WHERE id=?").bind(id).first(); if(!ch) return json({ok:false,error:"Parte no encontrada"},404);
      const max=await env.DB.prepare("SELECT COALESCE(MAX(page_number),0) AS n FROM pages WHERE chapter_id=?").bind(id).first(); let n=Number(max?.n||0);
      const form=await request.formData(); const files=form.getAll("pages").filter(x=>x instanceof File); if(!files.length) return json({ok:false,error:"Selecciona imágenes"},400);
      for(const file of files){ n++; const ext=(file.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,""); const key=`chapters/${id}/${String(n).padStart(4,"0")}-${crypto.randomUUID()}.${ext||"jpg"}`; await env.MEDIA.put(key,file.stream(),{httpMetadata:{contentType:file.type||"image/jpeg"}}); await env.DB.prepare("INSERT INTO pages (chapter_id,page_number,object_key,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)").bind(id,n,key).run(); }
      await env.DB.prepare("UPDATE comics SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(ch.comic_id).run(); return json({ok:true,count:files.length});
    }

    return env.ASSETS.fetch(request);
  }
};
