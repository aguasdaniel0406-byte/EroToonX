# Changelog NightInk / EroToonX

## 1.3.0 — Mezcla editorial de recientes

- Nuevo control en Admin para mezclar los últimos 20/30/50/75/100 cómics publicados.
- La mezcla usa un orden visual separado y no modifica `created_at` ni `updated_at`.
- Los cómics subidos después de una mezcla siguen apareciendo por encima como nuevos.
- Se intenta reducir la repetición consecutiva del mismo autor/categoría.
- Botón para restaurar inmediatamente el orden normal por fecha.
- Nueva migración `0002_catalog_display_order.sql`.

## 1.2.1 — Release estable

- Dependencias del clasificador fijadas a versiones/revisión exactas.
- Node 24 LTS en GitHub Actions y `.nvmrc`.
- Validación mensual con sintaxis, migraciones D1 locales y Wrangler dry-run.
- Dependabot mensual para npm y GitHub Actions.
- Headers de seguridad para assets y respuestas generadas por el Worker.
- Limpieza conservadora de CSS legado sin uso.
- Sin cambios funcionales en lector, series, categorías, uploads, autenticación o backups.

## 1.2.0

- Nuevo/Editar cómic permite seleccionar categorías maestras existentes.
- Creación rápida de una categoría maestra desde el mismo modal.
- La nueva categoría se selecciona y sincroniza con gestor general y carga masiva.

## 1.1.0

- Modo oscuro/claro compartido con preferencia local.
- Bloqueo del scroll de fondo mientras cualquier modal está abierto.
- El contenido del modal conserva su propio desplazamiento.
