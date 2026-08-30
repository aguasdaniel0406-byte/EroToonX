# NightInk / EroToonX

**Release estable: 1.2.1**

Proyecto Cloudflare Workers + D1 + R2 con catálogo/lector de cómics para adultos, administración privada, categorías, series/capítulos, carga individual/masiva, clasificación local en navegador, modo claro/oscuro y backups automáticos.

## Estructura principal

- `src/index.js` — Worker/API.
- `public/index.html` — aplicación web principal.
- `public/auto-tags.js` — clasificación/OCR en navegador.
- `public/theme.js` / `public/theme.css` — modo claro/oscuro compartido y preferencia local.
- `public/*.html` — páginas legales y de contacto.
- `wrangler.toml` — configuración de Cloudflare.
- `backup-nightink.mjs` — backup D1 + inventario R2; `--full-media` añade copia física de objetos referenciados.
- `.github/workflows/nightink-backup.yml` — backup semanal/manual, Artifact y aviso por correo.

## Comandos

```bash
npm install
npm run check
npm run deploy
npm run backup
npm run backup:full
```

## Cloudflare

Bindings configurados:

- D1: `DB` → `nightink-db`
- R2: `MEDIA` → `nightink-media`
- Assets: `ASSETS` → `./public`

`ADMIN_TOKEN` debe existir como secreto/variable de entorno de producción de Cloudflare. No debe guardarse en el repositorio.

## GitHub Actions

Secrets usados por el workflow:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `MAIL_USERNAME`
- `MAIL_PASSWORD`
- `BACKUP_EMAIL_TO`

El token de Cloudflare que ya fue probado para este proyecto usa:

- Account → D1 → Edit
- Account → Workers R2 Storage → Read
- User → User Details → Read
- User → Memberships → Read

No copies valores de secrets dentro de archivos del repositorio.

## Backups

El workflow `NightInk Backup` se ejecuta los domingos a las 04:17 UTC y también puede lanzarse manualmente. El Artifact se configura con 90 días de retención. En ejecución manual puede activarse `full_media`.

El correo es una capa adicional: el Artifact se crea primero. Si el correo falla, el backup principal no se pierde.

Consulta `docs/BACKUPS.txt`, `docs/CHANGELOG.md` y `docs/MANTENIMIENTO.md`.

## Esquema D1 reproducible

El esquema inicial está versionado en `migrations/0001_initial_schema.sql`.
Cloudflare Wrangler usa la carpeta `migrations/` configurada en `wrangler.toml`.

Comandos útiles:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Antes de aplicar migraciones remotas, conserva un backup D1 reciente.

## Contacto y reportes

`/contact.html` y `/dmca.html` usan un formulario interno del propio Worker.
Las solicitudes se guardan en D1 y pueden revisarse desde **Admin → Mensajes**.
No es necesario publicar ni inventar un correo de contacto. El sistema almacena
solo un hash de la IP para control básico de abuso; no guarda la IP original.

## Tema y ventanas modales

El modo oscuro sigue siendo el predeterminado. El botón de tema permite cambiar a
modo claro y la elección queda guardada en este navegador. La misma preferencia
se aplica al catálogo, lector, administración y páginas legales.

Mientras cualquier ventana `.modal` está abierta, el documento de fondo queda
bloqueado. La ventana conserva su propio desplazamiento, evitando que al llegar
al principio o al final se mueva la página situada detrás.

## Validación sin desplegar

```bash
npm run check
npm run dry-run
```

`dry-run` compila el Worker con Wrangler y genera la salida en `dist/` sin
publicarla en Cloudflare.

## Release 1.2.1

La release mantiene las funciones de v1.2 y añade endurecimiento de mantenimiento: dependencias externas fijadas, Node 24 en CI, validación mensual, Dependabot y headers de seguridad. No introduce cambios de comportamiento en el lector, series, uploads o backups.
