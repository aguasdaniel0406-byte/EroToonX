# Mantenimiento de NightInk

La versión 1.3.1 está preparada como release de bajo mantenimiento, no como software que deba ignorarse indefinidamente.

## Rutina recomendada

- Revisar GitHub Actions cuando llegue una notificación de fallo.
- Una vez por trimestre: comprobar que `NightInk Validate` y `NightInk Backup` siguen en verde.
- Revisar los PR de Dependabot antes de fusionarlos; no actualizar dependencias sin pasar validación.
- Conservar siempre los backups D1/R2 y los Artifacts existentes.
- Antes de una migración D1 remota, generar un backup reciente.

## Node / Wrangler

Los workflows usan Node 24 y Wrangler 4.127.0 de forma explícita. Una futura subida de Wrangler debe hacerse como cambio separado y pasar `NightInk Validate`.

## Cloudflare compatibility_date

No actualizar `compatibility_date` solo porque exista una fecha más nueva. Cambiarla únicamente después de revisar los cambios de compatibilidad y validar la aplicación.

## Dependencias del navegador

ONNX Runtime, Tesseract, JSZip y el modelo visual están fijados para impedir cambios silenciosos de terceros. Si se actualizan, probar especialmente análisis automático/OCR y carga masiva.

## Seguridad

No introducir secretos en el repositorio. Mantener `ADMIN_TOKEN` en Cloudflare y credenciales de backup/correo como Secrets de GitHub.
