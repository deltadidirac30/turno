// Risorse pesanti (lettore codici e OCR): scaricate una volta e conservate nella Cache API,
// così funzionano anche offline. Lo stato è visibile nell'interfaccia.
export const RES_CACHE = 'turno-res-v1';
export const ROOT = new URL('../', import.meta.url);

const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export const hasSimd = (() => { try { return WebAssembly.validate(SIMD_TEST); } catch { return false; } })();

export function ocrCorePath() {
  return hasSimd ? 'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js' : 'vendor/tesseract/core/tesseract-core-lstm.wasm.js';
}

export const GROUPS = {
  barcode: {
    files: [
      ['vendor/zxing/reader/index.js', 40593],
      ['vendor/zxing/share.js', 11435],
      ['vendor/zxing/zxing_reader.wasm', 946598],
    ],
  },
  ocr: {
    files: [
      ['vendor/tesseract/tesseract.min.js', 62920],
      ['vendor/tesseract/worker.min.js', 111269],
      [ocrCorePath(), hasSimd ? 3899472 : 3896484],
      ['vendor/tesseract/lang/ita.traineddata.gz', 1660998],
    ],
  },
};

export const url = (path) => new URL(path, ROOT).href;
export function groupSize(name) { return GROUPS[name].files.reduce((s, [, n]) => s + n, 0); }

// Stato per gruppo: 'ready' | 'missing' | 'downloading' | 'error' (+ progress 0..1)
const state = { barcode: { status: 'unknown', progress: 0 }, ocr: { status: 'unknown', progress: 0 } };
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((fn) => { try { fn(state); } catch {} }); }
export function getState(name) { return state[name]; }

export async function check(name) {
  if (!('caches' in self)) { state[name] = { status: 'nocache', progress: 0 }; emit(); return state[name]; }
  if (state[name].status === 'downloading') return state[name];
  const cache = await caches.open(RES_CACHE);
  let have = 0;
  for (const [p] of GROUPS[name].files) if (await cache.match(url(p))) have++;
  state[name] = { status: have === GROUPS[name].files.length ? 'ready' : 'missing', progress: have / GROUPS[name].files.length };
  emit();
  return state[name];
}

const running = {};
export function download(name) {
  if (running[name]) return running[name];
  running[name] = (async () => {
    const cache = await caches.open(RES_CACHE);
    const total = groupSize(name);
    let done = 0;
    state[name] = { status: 'downloading', progress: 0 };
    emit();
    try {
      for (const [p, size] of GROUPS[name].files) {
        const u = url(p);
        if (await cache.match(u)) { done += size; continue; }
        const res = await fetch(u, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${res.status} ${p}`);
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        let body;
        if (reader) {
          const chunks = [];
          let got = 0;
          for (;;) {
            const { done: end, value } = await reader.read();
            if (end) break;
            chunks.push(value); got += value.length;
            state[name] = { status: 'downloading', progress: Math.min(0.99, (done + Math.min(got, size)) / total) };
            emit();
          }
          body = new Blob(chunks);
        } else {
          body = await res.blob();
        }
        await cache.put(u, new Response(body, { headers: { 'Content-Type': res.headers.get('Content-Type') || contentType(p) } }));
        done += size;
      }
      state[name] = { status: 'ready', progress: 1 };
    } catch (e) {
      state[name] = { status: navigator.onLine ? 'error' : 'missing', progress: done / total, error: String(e) };
    } finally {
      running[name] = null;
      emit();
    }
    return state[name];
  })();
  return running[name];
}

function contentType(p) {
  if (p.endsWith('.wasm')) return 'application/wasm';
  if (p.endsWith('.js')) return 'text/javascript';
  return 'application/octet-stream';
}

// Prepara un gruppo se serve: ritorna true se pronto, false se non disponibile (offline).
export async function ensure(name) {
  const s = await check(name);
  if (s.status === 'ready' || s.status === 'nocache') return true;
  if (!navigator.onLine) return false;
  const r = await download(name);
  return r.status === 'ready';
}
