// Operazioni sulle confezioni: creazione, salvataggio, consumo con annullamento.
import * as db from './db.js';
import { uid, nowISO } from './util.js';
import { remember, normalizeEan } from './products.js';
import { ymd } from './dates.js';

export const LOCATIONS = ['fridge', 'freezer', 'pantry'];

export function newItem(partial = {}) {
  const now = nowISO();
  return {
    id: uid(), ean: null, name: '', brand: '',
    expiry: null, expiryKind: 'unknown', noDate: false,
    location: null, shelf: '', qty: 1,
    openedAt: null, openDays: null,
    status: 'active', consumedAt: null, wastedAt: null, batchId: null,
    createdAt: now, updatedAt: now,
    ...partial,
  };
}

// Cosa manca per considerare completa una confezione.
export function missing(item) {
  const m = [];
  if (!item.expiry && !item.noDate) m.push('date');
  if (!item.name) m.push('name');
  return m;
}
export const isIncomplete = (item) => missing(item).length > 0;

let persistAsked = false;
async function askPersist() {
  if (persistAsked) return; persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

export async function save(item) {
  const it = { ...item, updatedAt: nowISO() };
  if (it.ean) it.ean = normalizeEan(it.ean);
  await db.items.put(it);
  if (it.ean && it.name) await remember(it.ean, it.name, it.brand);
  askPersist();
  return it;
}

// Un tap: scala una unità; all'ultima segna come consumato. Ritorna la funzione di annullamento.
export async function consumeOne(item) {
  const before = { ...item };
  let after;
  if (item.qty > 1) after = { ...item, qty: item.qty - 1, updatedAt: nowISO() };
  else after = { ...item, status: 'consumed', consumedAt: nowISO(), updatedAt: nowISO() };
  await db.items.put(after);
  return { after, undo: () => db.items.put(before) };
}

// Buttato: esce dalla lista come «consumato», ma conta a parte nelle statistiche.
export async function waste(item) {
  const before = { ...item };
  await db.items.put({ ...item, status: 'wasted', wastedAt: nowISO(), updatedAt: nowISO() });
  return () => db.items.put(before);
}

export async function remove(item) {
  await db.items.delete(item.id);
  return () => db.items.put(item);
}

export function markOpened(item, days) {
  return { ...item, openedAt: item.openedAt || ymd(new Date()), openDays: days || item.openDays || null };
}

export async function shelvesByLocation() {
  const all = await db.items.all();
  const map = { fridge: new Set(), freezer: new Set(), pantry: new Set() };
  for (const i of all) if (i.location && i.shelf) map[i.location]?.add(i.shelf);
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort((a, b) => a.localeCompare(b))]));
}
