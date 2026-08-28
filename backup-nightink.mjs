import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DATABASE = 'nightink-db';
const BUCKET = 'nightink-media';
const FULL_MEDIA = process.argv.includes('--full-media');
const KEEP_BACKUPS = 10;
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function runWrangler(args, { quiet = false, allowFailure = false } = {}) {
  const res = spawnSync(NPX, ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });

  if (!quiet && res.stdout?.trim()) console.log(res.stdout.trim());
  if (res.status !== 0) {
    const message = [res.stderr, res.stdout].filter(Boolean).join('\n').trim() || `Wrangler terminó con código ${res.status}`;
    if (allowFailure) return { ok: false, stdout: res.stdout || '', stderr: res.stderr || '', error: message };
    throw new Error(message);
  }
  return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function parseWranglerRows(raw) {
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const entry of entries) {
    if (Array.isArray(entry?.results)) rows.push(...entry.results);
    if (Array.isArray(entry?.result?.results)) rows.push(...entry.result.results);
    if (Array.isArray(entry?.result)) {
      for (const inner of entry.result) {
        if (Array.isArray(inner?.results)) rows.push(...inner.results);
      }
    }
  }
  return rows;
}

function queryRows(sql, { optional = false } = {}) {
  const res = runWrangler([
    'd1', 'execute', DATABASE,
    '--remote',
    '--command', sql,
    '--json'
  ], { quiet: true, allowFailure: optional });

  if (!res.ok) return [];
  try {
    return parseWranglerRows(res.stdout);
  } catch (err) {
    if (optional) return [];
    throw new Error(`No se pudo interpretar la respuesta JSON de D1: ${err.message}`);
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  return `"${s.replaceAll('"', '""')}"`;
}

function localPathForKey(base, key) {
  const parts = String(key).replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '..')) throw new Error(`Clave R2 no segura: ${key}`);
  return path.join(base, ...parts);
}

function safeWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function cleanupOldBackups(backupsRoot) {
  if (!fs.existsSync(backupsRoot)) return;
  const dirs = fs.readdirSync(backupsRoot, { withFileTypes: true })
    .filter(x => x.isDirectory() && /^NightInk_\d{4}-\d{2}-\d{2}_/.test(x.name))
    .map(x => ({ name: x.name, full: path.join(backupsRoot, x.name), mtime: fs.statSync(path.join(backupsRoot, x.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of dirs.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); }
    catch { /* no borrar si Windows tiene algún archivo abierto */ }
  }
}

async function main() {
  const root = process.cwd();
  const backupsRoot = path.join(root, 'backups');
  const backupDir = path.join(backupsRoot, `NightInk_${stamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  console.log('\n=== NightInk Backup ===');
  console.log(`D1: ${DATABASE}`);
  console.log(`R2: ${BUCKET}`);
  console.log(`Destino: ${backupDir}`);
  console.log(`Copia completa de imágenes: ${FULL_MEDIA ? 'SÍ' : 'NO'}\n`);

  console.log('1/4 Exportando D1 completo...');
  const dbSql = path.join(backupDir, 'nightink-db.sql');
  runWrangler(['d1', 'export', DATABASE, '--remote', '--output', dbSql, '--yes'], { quiet: true });
  if (!fs.existsSync(dbSql) || fs.statSync(dbSql).size === 0) throw new Error('El archivo SQL de D1 no se creó correctamente.');
  console.log(`✓ D1 guardado: ${path.basename(dbSql)}`);

  console.log('2/4 Guardando estado y Time Travel de D1...');
  const info = runWrangler(['d1', 'info', DATABASE, '--json'], { quiet: true, allowFailure: true });
  if (info.ok) safeWrite(path.join(backupDir, 'd1-info.json'), info.stdout.trim() + '\n');
  const tt = runWrangler(['d1', 'time-travel', 'info', DATABASE, '--json'], { quiet: true, allowFailure: true });
  if (tt.ok) safeWrite(path.join(backupDir, 'd1-time-travel.json'), tt.stdout.trim() + '\n');
  console.log('✓ Estado de D1 guardado');

  console.log('3/4 Creando inventario R2 desde las referencias de NightInk...');
  const keys = new Map();
  const addRows = (rows, type) => {
    for (const row of rows) {
      const key = String(row.object_key || '').trim();
      if (!key) continue;
      const existing = keys.get(key) || new Set();
      existing.add(type);
      keys.set(key, existing);
    }
  };

  addRows(queryRows("SELECT cover_key AS object_key FROM comics WHERE cover_key IS NOT NULL AND TRIM(cover_key) <> ''"), 'portada');
  addRows(queryRows("SELECT object_key FROM pages WHERE object_key IS NOT NULL AND TRIM(object_key) <> ''"), 'página');
  addRows(queryRows("SELECT source_cover_key AS object_key FROM series_group_members WHERE source_cover_key IS NOT NULL AND TRIM(source_cover_key) <> ''", { optional: true }), 'portada_origen_serie');

  const inventory = [...keys.entries()]
    .map(([object_key, types]) => ({ object_key, types: [...types].sort() }))
    .sort((a, b) => a.object_key.localeCompare(b.object_key));

  safeWrite(path.join(backupDir, 'r2-inventory.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    bucket: BUCKET,
    referenced_objects: inventory.length,
    objects: inventory
  }, null, 2) + '\n');

  const csv = ['object_key,types', ...inventory.map(x => `${csvEscape(x.object_key)},${csvEscape(x.types.join('|'))}`)].join('\n') + '\n';
  safeWrite(path.join(backupDir, 'r2-inventory.csv'), csv);
  console.log(`✓ Inventario R2: ${inventory.length} objetos referenciados`);

  let downloaded = 0;
  let failed = [];
  let mediaBytes = 0;

  if (FULL_MEDIA) {
    console.log('4/4 Descargando copia física de R2...');
    const mediaDir = path.join(backupDir, 'media');
    for (let i = 0; i < inventory.length; i++) {
      const key = inventory[i].object_key;
      const dest = localPathForKey(mediaDir, key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      process.stdout.write(`\r[${i + 1}/${inventory.length}] ${key.slice(0, 75).padEnd(75)}`);
      const res = runWrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', dest], { quiet: true, allowFailure: true });
      if (res.ok && fs.existsSync(dest)) {
        downloaded++;
        mediaBytes += fs.statSync(dest).size;
      } else {
        failed.push({ key, error: res.error || 'Error desconocido' });
      }
    }
    process.stdout.write('\n');
    if (failed.length) safeWrite(path.join(backupDir, 'media-download-errors.json'), JSON.stringify(failed, null, 2) + '\n');
    console.log(`✓ Imágenes descargadas: ${downloaded}/${inventory.length}`);
  } else {
    console.log('4/4 Backup rápido terminado (sin copiar físicamente R2).');
    console.log('    Para copia completa: node backup-nightink.mjs --full-media');
  }

  const manifest = {
    created_at: new Date().toISOString(),
    database: DATABASE,
    bucket: BUCKET,
    d1_sql_file: 'nightink-db.sql',
    r2_referenced_objects: inventory.length,
    full_media_requested: FULL_MEDIA,
    media_downloaded: downloaded,
    media_download_failures: failed.length,
    media_downloaded_bytes: mediaBytes
  };
  safeWrite(path.join(backupDir, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  safeWrite(path.join(backupDir, 'LEEME_RESTAURACION.txt'), `NIGHTINK - BACKUP\n\nEste backup contiene:\n- nightink-db.sql: esquema y datos completos de D1.\n- d1-info.json: información de D1 al momento del backup (si Wrangler la pudo obtener).\n- d1-time-travel.json: bookmark/estado de Time Travel (si disponible).\n- r2-inventory.json y r2-inventory.csv: claves R2 referenciadas por NightInk.\n${FULL_MEDIA ? '- media/: copia física de las imágenes descargadas desde R2.\n' : '- Este fue un backup rápido: NO contiene las imágenes físicas de R2.\n'}\nIMPORTANTE\nNo restaures nightink-db.sql directamente sobre la base de producción sin revisar primero el procedimiento. Para una restauración, es preferible probar el SQL en una base D1 nueva o usar Time Travel cuando el incidente sea reciente.\n`);

  cleanupOldBackups(backupsRoot);

  console.log('\n=== BACKUP COMPLETADO ===');
  console.log(backupDir);
  console.log(`D1 SQL: ${(fs.statSync(dbSql).size / 1024).toFixed(1)} KB`);
  console.log(`R2 inventario: ${inventory.length} objetos`);
  if (FULL_MEDIA) console.log(`R2 descargado: ${downloaded} objetos · ${(mediaBytes / 1024 / 1024).toFixed(2)} MB · errores: ${failed.length}`);
  console.log(`Se conservan automáticamente los ${KEEP_BACKUPS} backups más recientes.\n`);
}

main().catch(err => {
  console.error('\nBACKUP NO COMPLETADO');
  console.error(err?.message || err);
  process.exitCode = 1;
});
