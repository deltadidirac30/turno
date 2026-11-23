// Lettura codici a barre con ZXing (WebAssembly), caricato solo quando serve.
import { url } from './resources.js';
import { normalizeEan, isValidEan } from './products.js';

const FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'];
let modP = null;

export function load() {
  if (!modP) {
    modP = (async () => {
      const mod = await import(url('vendor/zxing/reader/index.js'));
      await mod.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? url('vendor/zxing/zxing_reader.wasm') : prefix + path) },
        fireImmediately: true,
      });
      return mod;
    })().catch((e) => { modP = null; throw e; });
  }
  return modP;
}

function imageDataOf(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

function clean(results) {
  return results
    .filter((r) => r.isValid !== false && r.text)
    .map((r) => ({ ...r, ean: normalizeEan(r.text) }))
    .filter((r) => isValidEan(r.ean));
}

// Un solo codice dal fotogramma corrente (scansione dal vivo).
export async function readOne(canvas) {
  const mod = await load();
  const res = await mod.readBarcodes(imageDataOf(canvas), { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
  const ok = clean(res);
  return ok.length ? ok[0].ean : null;
}

function centerOf(pos) {
  const pts = [pos.topLeft, pos.topRight, pos.bottomRight, pos.bottomLeft];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2,
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function crop(src, sx, sy, sw, sh, maxSide) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d', { willReadFrequently: true }).drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return { canvas: c, k };
}

// Più codici da una foto (tavolo con la spesa). Due confezioni uguali in punti diversi
// restano due risultati distinti. Ritorna [{ean, x, y, w, h}] in coordinate della foto.
export async function readMany(src, { onProgress } = {}) {
  const mod = await load();
  const W = src.width || src.videoWidth, H = src.height || src.videoHeight;
  const found = [];
  const add = (results, ox, oy, k) => {
    for (const r of clean(results)) {
      const c = centerOf(r.position);
      const box = { ean: r.ean, x: ox + c.x / k, y: oy + c.y / k, w: c.w / k, h: c.h / k };
      const dup = found.find((f) => f.ean === box.ean && Math.hypot(f.x - box.x, f.y - box.y) < Math.max(40, Math.max(f.w, f.h, box.w, box.h) * 0.6));
      if (!dup) found.push(box);
    }
  };
  const opts = { formats: FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 40 };

  // 1) immagine intera ridotta
  const full = crop(src, 0, 0, W, H, 2400);
  add(await mod.readBarcodes(imageDataOf(full.canvas), opts), 0, 0, full.k);
  onProgress?.(0.25);

  // 2) riquadri sovrapposti a risoluzione più alta, per i codici piccoli
  const n = Math.max(W, H) > 2600 ? 3 : 2;
  const tw = W / n, th = H / n, ovx = tw * 0.25, ovy = th * 0.25;
  const tiles = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) tiles.push([c, r]);
  let i = 0;
  for (const [c, r] of tiles) {
    const sx = Math.max(0, c * tw - ovx), sy = Math.max(0, r * th - ovy);
    const sw = Math.min(W - sx, tw + 2 * ovx), sh = Math.min(H - sy, th + 2 * ovy);
    const t = crop(src, sx, sy, sw, sh, 1600);
    add(await mod.readBarcodes(imageDataOf(t.canvas), opts), sx, sy, t.k);
    onProgress?.(0.25 + 0.75 * (++i / tiles.length));
    await new Promise((res) => setTimeout(res, 0)); // lascia respirare l'interfaccia
  }
  // Ordine di lettura: dall'alto a sinistra
  found.sort((a, b) => (Math.abs(a.y - b.y) > Math.max(a.h, b.h) ? a.y - b.y : a.x - b.x));
  return found;
}
