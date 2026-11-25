// Archivio locale su IndexedDB: confezioni, prodotti riconosciuti, impostazioni e stato.
const DB_NAME = 'turno';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) {
          const s = db.createObjectStore('items', { keyPath: 'id' });
          s.createIndex('status', 'status');
          s.createIndex('ean', 'ean');
        }
        if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'ean' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloccato da un’altra scheda'));
    });
  }
  return dbPromise;
}

function reqP(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function run(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transazione annullata'));
    Promise.resolve(fn(tx)).then((r) => { result = r; }, (e) => { try { tx.abort(); } catch {} reject(e); });
  });
}

export const items = {
  all: () => run('items', 'readonly', (tx) => reqP(tx.objectStore('items').getAll())),
  get: (id) => run('items', 'readonly', (tx) => reqP(tx.objectStore('items').get(id))),
  put: (item) => run('items', 'readwrite', (tx) => { tx.objectStore('items').put(item); return item; }),
  putMany: (list) => run('items', 'readwrite', (tx) => { const s = tx.objectStore('items'); list.forEach((i) => s.put(i)); return list; }),
  delete: (id) => run('items', 'readwrite', (tx) => { tx.objectStore('items').delete(id); }),
  async active() { return (await items.all()).filter((i) => i.status === 'active'); },
};

export const products = {
  get: (ean) => run('products', 'readonly', (tx) => reqP(tx.objectStore('products').get(ean))),
  put: (p) => run('products', 'readwrite', (tx) => { tx.objectStore('products').put(p); return p; }),
  all: () => run('products', 'readonly', (tx) => reqP(tx.objectStore('products').getAll())),
};

export const kv = {
  async get(key, fallback = null) {
    const row = await run('kv', 'readonly', (tx) => reqP(tx.objectStore('kv').get(key)));
    return row ? row.value : fallback;
  },
  set: (key, value) => run('kv', 'readwrite', (tx) => { tx.objectStore('kv').put({ key, value }); return value; }),
  del: (key) => run('kv', 'readwrite', (tx) => { tx.objectStore('kv').delete(key); }),
  all: () => run('kv', 'readonly', (tx) => reqP(tx.objectStore('kv').getAll())),
};

// Sostituisce tutto in un'unica transazione: o riesce tutto o non cambia nulla.
export function replaceAll({ items: list, products: prods, kv: rows }) {
  return run(['items', 'products', 'kv'], 'readwrite', (tx) => {
    const si = tx.objectStore('items'); const sp = tx.objectStore('products'); const sk = tx.objectStore('kv');
    si.clear(); sp.clear();
    list.forEach((i) => si.put(i));
    prods.forEach((p) => sp.put(p));
    for (const r of rows) sk.put(r);
    sk.delete('batch');
  });
}

// --- Impostazioni ---
export const DEFAULT_SETTINGS = { lang: 'it', defaultLocation: 'fridge', icsDaysBefore: 1, icsHour: 9, autoDownload: true, theme: 'light' };
export async function getSettings() { return { ...DEFAULT_SETTINGS, ...(await kv.get('settings', {})) }; }
export async function saveSettings(patch) { const s = { ...(await getSettings()), ...patch }; await kv.set('settings', s); return s; }

// --- Statistiche locali per confrontare i tempi di registrazione ---
export async function bumpStats(patch) {
  const s = await kv.get('stats', { saved: 0, ocrRead: 0, ocrAccepted: 0, ocrCorrected: 0, lastBatch: null });
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number' && typeof s[k] === 'number') s[k] += v; else s[k] = v;
  }
  await kv.set('stats', s);
  return s;
}
