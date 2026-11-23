// Riconoscimento prodotti: prima la cache locale, poi Open Food Facts se c'è rete.
import * as db from './db.js';
import { nowISO } from './util.js';

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const inflight = new Map();

export function normalizeEan(code) {
  const c = String(code || '').replace(/\D/g, '');
  return c.length === 12 ? '0' + c : c; // UPC-A → EAN-13
}

export function isValidEan(code) {
  const c = String(code || '');
  if (!/^\d{8}$|^\d{12,14}$/.test(c)) return false;
  const digits = c.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

// Ritorna {status: 'local'|'online'|'notfound'|'offline'|'error', product}
export function lookup(ean) {
  ean = normalizeEan(ean);
  if (inflight.has(ean)) return inflight.get(ean);
  const p = doLookup(ean).finally(() => inflight.delete(ean));
  inflight.set(ean, p);
  return p;
}

async function doLookup(ean) {
  const local = await db.products.get(ean);
  if (local && local.name) return { status: 'local', product: local };
  if (!navigator.onLine) return { status: 'offline', product: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${OFF_URL}${encodeURIComponent(ean)}.json?fields=product_name,product_name_it,generic_name_it,brands,quantity`, { signal: ctrl.signal });
    if (res.status === 404) return { status: 'notfound', product: null };
    if (!res.ok) return { status: 'error', product: null };
    const data = await res.json();
    const pr = data && data.status === 1 ? data.product : null;
    const name = pr && (pr.product_name_it || pr.product_name || pr.generic_name_it || '').trim();
    if (!name) return { status: 'notfound', product: null };
    const product = {
      ean, name,
      brand: (pr.brands || '').split(',')[0].trim(),
      quantity: (pr.quantity || '').trim(),
      source: 'off', updatedAt: nowISO(),
    };
    await db.products.put(product);
    return { status: 'online', product };
  } catch (e) {
    return { status: navigator.onLine ? 'error' : 'offline', product: null };
  } finally {
    clearTimeout(timer);
  }
}

// Ricorda il nome scritto dall'utente per le scansioni successive (vince sui dati online).
export async function remember(ean, name, brand = '') {
  ean = normalizeEan(ean);
  if (!ean || !name) return;
  const prev = await db.products.get(ean);
  if (prev && prev.name === name && (prev.brand || '') === (brand || '')) return;
  await db.products.put({ ...(prev || {}), ean, name, brand: brand || '', source: 'user', updatedAt: nowISO() });
}
