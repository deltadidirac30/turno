// Controlli statici: chiavi di traduzione presenti e file dell'app tutti in cache nel service worker.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { _strings } from '../js/i18n.js';
const root = new URL('..', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
let fail = 0;
const it = _strings.it;
const src = walk(join(root, 'js')).map((f) => readFileSync(f, 'utf8')).join('\n');
const used = new Set([...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
const dyn = {
  'camera.': ['denied', 'nocamera', 'unsupported', 'error'].flatMap((c) => [`${c}.title`, `${c}.text`]),
  'date.err.': ['digits', 'year', 'month', 'invalid', 'fix'],
  'kind.': ['use_by', 'best_before', 'unknown'], 'loc.': ['fridge', 'freezer', 'pantry'],
  'row.todo.': ['date', 'name'], 'scan.stage.': ['download', 'read', 'retry'],
  'sec.': ['expired', 'today', 'soon', 'week', 'later', 'none'],
  'settings.res.': ['ready', 'missing', 'downloading', 'error', 'nocache', 'unknown', 'barcode', 'ocr', 'barcodeDesc', 'ocrDesc'],
  'res.': ['barcode', 'ocr'].flatMap((n) => ['downloading', 'error', 'missing', 'offline'].map((s) => `${n}.${s}`)),
  'backup.err.': ['json', 'notTurno', 'format', 'structure', 'item', 'product'],
};
for (const [p, list] of Object.entries(dyn)) list.forEach((k) => used.add(p + k));
for (const k of used) if (!(k in it)) { console.log('FAIL chiave mancante:', k); fail++; }
for (const k of Object.keys(it)) if (!used.has(k) && !['app.name', 'app.tagline'].includes(k)) console.log('nota: chiave non usata', k);
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
const files = [...walk(join(root, 'js')), ...walk(join(root, 'css')), ...walk(join(root, 'icons'))].map((f) => f.slice(root.length));
for (const f of files) if (!listed.has(f)) { console.log('FAIL non in cache SW:', f); fail++; }
for (const f of listed) if (f !== './' && !files.includes(f) && !['index.html', 'manifest.webmanifest'].includes(f)) { console.log('FAIL in SW ma inesistente:', f); fail++; }
const v1 = /VERSION = '([^']+)'/.exec(sw)[1]; const v2 = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'js/version.js'), 'utf8'))[1];
if (v1 !== v2) { console.log('FAIL versioni diverse', v1, v2); fail++; }
console.log(fail ? `${fail} errori` : 'ok: chiavi e cache coerenti');
process.exit(fail ? 1 : 0);
