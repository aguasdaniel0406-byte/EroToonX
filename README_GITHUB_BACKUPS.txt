NIGHTINK - BACKUPS AUTOMÁTICOS CON GITHUB ACTIONS
=================================================

ARCHIVOS QUE DEBEN ESTAR EN EL REPOSITORIO
------------------------------------------
1. backup-nightink.mjs                       -> raíz del repositorio
2. .github/workflows/nightink-backup.yml    -> exactamente en esa ruta

NO subas contraseñas ni tokens al repositorio.

SECRETOS NECESARIOS EN GITHUB
-----------------------------
Repository > Settings > Secrets and variables > Actions > New repository secret

Crea exactamente estos dos secretos:
- CLOUDFLARE_ACCOUNT_ID
- CLOUDFLARE_API_TOKEN

El API token de Cloudflare debe estar limitado a la cuenta de NightInk y tener permisos de solo lectura suficientes para:
- D1 Read
- Workers R2 Storage Read

BACKUP AUTOMÁTICO
-----------------
GitHub ejecutará un backup rápido cada domingo a las 04:17 UTC.
Incluye:
- D1 completo en nightink-db.sql
- Información/Time Travel de D1 cuando esté disponible
- Inventario JSON/CSV de los objetos R2 usados por NightInk
- Manifest y archivo de restauración

BACKUP MANUAL
-------------
GitHub > pestaña Actions > NightInk Backup > Run workflow

Deja "Incluir copia física..." desmarcado para un backup rápido.
Márcalo para descargar también las imágenes referenciadas de R2.

DESCARGAR UN BACKUP
-------------------
GitHub > Actions > abre el run terminado > sección Artifacts > NightInk-backup-...

Los artefactos se conservan 90 días, sujeto al límite configurado en GitHub.
