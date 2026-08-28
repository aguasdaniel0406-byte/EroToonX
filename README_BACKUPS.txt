NIGHTINK / EROTOONX - BACKUPS
==============================

COLOCACION
Copia backup-nightink.mjs en la carpeta principal de NightInk, la misma donde tienes wrangler.toml.
El archivo backup-nightink.cmd es opcional y sirve para ejecutarlo con doble clic si ambos archivos estan juntos.

BACKUP NORMAL (recomendado frecuentemente)
Abre la terminal en la carpeta de NightInk y ejecuta:

node backup-nightink.mjs

Crea automaticamente:
backups/NightInk_FECHA_HORA/

Incluye:
- nightink-db.sql -> base D1 completa (estructura + datos)
- d1-info.json
- d1-time-travel.json
- r2-inventory.json
- r2-inventory.csv
- backup-manifest.json

BACKUP COMPLETO DE IMAGENES
Cuando quieras guardar tambien una copia fisica de portadas y paginas de R2:

node backup-nightink.mjs --full-media

Esto crea ademas la carpeta media/ dentro del backup y descarga uno por uno los archivos R2 utilizados por NightInk.
Puede ocupar bastante espacio y tardar mas si tu catalogo es grande.

DOBLE CLIC EN WINDOWS
Si colocas backup-nightink.cmd y backup-nightink.mjs en la raiz del proyecto, puedes abrir backup-nightink.cmd con doble clic para hacer el backup normal.
Para backup completo es mas facil usar la terminal con --full-media.

RETENCION
La herramienta conserva automaticamente los 10 backups NightInk mas recientes dentro de /backups y elimina los mas antiguos.

SEGURIDAD
La herramienta no borra ni modifica D1 ni R2. Solo exporta D1, consulta referencias y, con --full-media, descarga objetos.
No contiene contrasenas ni tokens de Cloudflare.
Usa la sesion de Wrangler que ya tienes iniciada en tu computadora.

RESTAURACION
No ejecutes una restauracion sobre produccion sin revisar primero el backup.
D1 puede restaurarse a partir del SQL en una base adecuada, y Cloudflare tambien dispone de Time Travel para incidentes recientes.
Para R2, una copia --full-media conserva las rutas originales de los objetos para facilitar una restauracion posterior.
