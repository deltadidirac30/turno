// Backup JSON: esportazione e verifica completa prima di toccare i dati.
import * as db from './db.js';
import { isValidExpiry } from './dates.js';

export const FORMAT = 1;
const LOCATIONS = ['fridge', 'freezer', 'pantry', null];
const KINDS = ['use_by', 'best_before', 'unknown'];
const STATUSES = ['active', 'consumed'];

export async function exportData() {
  const [items, products, settings, stats] = await Promise.all([
    db.items.all(), db.products.all(), db.kv.get('settings', {}), db.kv.get('stats', null)]);
  return { app: 'turno', format: FORMAT, exportedAt: new Date().toISOString(), items, products, settings, stats };
}

const isStr = (v) => typeof v === 'string';
const isOptStr = (v) => v == null || typeof v === 'string';
const isDateStr = (v) => v == null || (isStr(v) && /^\d{4}-\d{2}-\d{2}/.test(v));

// Verifica il contenuto senza modificare nulla. Ritorna {ok, errors, data, summary}.
export function validate(raw) {
  const errors = [];
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { ok: false, errors: ['json'] }; }
  }
  if (!obj || typeof obj !== 'object' || obj.app !== 'turno') return { ok: false, errors: ['notTurno'] };
  if (obj.format !== FORMAT) return { ok: false, errors: ['format'] };
  if (!Array.isArray(obj.items) || !Array.isArray(obj.products)) return { ok: false, errors: ['structure'] };

  const ids = new Set();
  const items = [];
  obj.items.forEach((it, i) => {
    const where = `#${i + 1}`;
    if (!it || typeof it !== 'object') { errors.push(`item ${where}`); return; }
    const bad = [];
    if (!isStr(it.id) || !it.id) bad.push('id');
    if (ids.has(it.id)) bad.push('id duplicato');
    if (!isOptStr(it.name)) bad.push('name');
    if (!isOptStr(it.brand)) bad.push('brand');
    if (it.ean != null && !(isStr(it.ean) && /^\d{6,14}$/.test(it.ean))) bad.push('ean');
    if (it.expiry != null && !(typeof it.expiry === 'object' && isValidExpiry(it.expiry))) bad.push('expiry');
    if (it.expiryKind != null && !KINDS.includes(it.expiryKind)) bad.push('expiryKind');
    if (!LOCATIONS.includes(it.location ?? null)) bad.push('location');
    if (!(Number.isInteger(it.qty) && it.qty >= 1 && it.qty <= 999)) bad.push('qty');
    if (!STATUSES.includes(it.status)) bad.push('status');
    if (!isDateStr(it.openedAt)) bad.push('openedAt');
    if (it.openDays != null && !(Number.isInteger(it.openDays) && it.openDays >= 1 && it.openDays <= 365)) bad.push('openDays');
    if (bad.length) { errors.push(`item ${where}: ${bad.join(', ')}`); return; }
    ids.add(it.id);
    items.push({
      id: it.id, ean: it.ean || null, name: it.name || '', brand: it.brand || '',
      expiry: it.expiry ? { y: it.expiry.y, m: it.expiry.m ?? null, d: it.expiry.d ?? null } : null,
      expiryKind: it.expiryKind || 'unknown', noDate: !!it.noDate,
      location: it.location ?? null, shelf: isStr(it.shelf) ? it.shelf : '', qty: it.qty,
      openedAt: it.openedAt || null, openDays: it.openDays ?? null,
      status: it.status, consumedAt: it.consumedAt || null, batchId: null,
      createdAt: it.createdAt || new Date().toISOString(), updatedAt: it.updatedAt || new Date().toISOString(),
    });
  });
  const products = [];
  obj.products.forEach((p, i) => {
    if (!p || !isStr(p.ean) || !/^\d{6,14}$/.test(p.ean) || !isStr(p.name)) { errors.push(`product #${i + 1}`); return; }
    products.push({ ean: p.ean, name: p.name, brand: isStr(p.brand) ? p.brand : '', source: p.source === 'off' ? 'off' : 'user', updatedAt: p.updatedAt || null });
  });
  if (errors.length) return { ok: false, errors };
  const settings = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
  return {
    ok: true, errors: [],
    data: { items, products, settings, stats: obj.stats || null },
    summary: { items: items.length, active: items.filter((i) => i.status === 'active').length, products: products.length, exportedAt: obj.exportedAt || null },
  };
}

export async function restore(data) {
  const rows = [{ key: 'settings', value: data.settings }];
  if (data.stats) rows.push({ key: 'stats', value: data.stats });
  await db.replaceAll({ items: data.items, products: data.products, kv: rows });
}
