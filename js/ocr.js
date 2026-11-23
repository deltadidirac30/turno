// OCR della data con Tesseract.js, tutto sul dispositivo. Le immagini restano in memoria
// solo per il tempo della lettura e non vengono salvate.
//
// Una sola foto viene letta più volte con preparazioni diverse (contrasto, soglia locale
// per luce irregolare e riflessi, punti uniti per la stampa a getto d'inchiostro, sole cifre):
// le date trovate più volte guadagnano fiducia. Ci si ferma appena la lettura è sicura.
import { url, ocrCorePath } from './resources.js';
import { extractDates, mergeResults, isConfident } from './ocr-parse.js';
import * as P from './ocr-prep.js';

let workerP = null;

function loadScript(src) {
  if (self.Tesseract) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('script'));
    document.head.append(s);
  });
}

export function getWorker(onProgress) {
  if (!workerP) {
    workerP = (async () => {
      await loadScript(url('vendor/tesseract/tesseract.min.js'));
      const worker = await self.Tesseract.createWorker('ita', 1 /* LSTM */, {
        workerPath: url('vendor/tesseract/worker.min.js'),
        corePath: url(ocrCorePath()),
        langPath: url('vendor/tesseract/lang').replace(/\/$/, ''),
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
        logger: (m) => onProgress?.(m),
      });
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })().catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}

export async function release() {
  if (!workerP) return;
  const p = workerP; workerP = null;
  try { (await p).terminate(); } catch {}
}

// ---------- Preparazione dell'immagine (scala di grigi in un array) ----------
function toGray(src, targetH, maxW) {
  const sw = src.width, sh = src.height;
  let k = targetH / sh;
  if (sw * k > maxW) k = maxW / sw;
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  c.width = c.height = 0;
  return { w, h, g };
}

// Contrasto (percentili 2–98) e inversione se il testo è chiaro su fondo scuro.
function normalize({ w, h, g }) {
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let j = 0; j < g.length; j++) { hist[g[j]]++; sum += g[j]; }
  const n = g.length;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  // Il fondo è la maggioranza dei pixel: se la mediana è scura, il testo è chiaro.
  acc = 0; let median = 128;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) { median = v; break; } }
  const invert = median < (lo + hi) / 2;
  const out = new Uint8ClampedArray(n);
  for (let j = 0; j < n; j++) {
    const v = ((g[j] - lo) * 255) / span;
    out[j] = invert ? 255 - v : v;
  }
  return { w, h, g: out, mean: sum / n };
}

// Sfocatura a scatola separabile (due passate ≈ gaussiana): unisce i punti della stampa a getto.
function blur({ w, h, g }, r) {
  if (r < 1) return { w, h, g };
  let a = Float32Array.from(g), b = new Float32Array(g.length);
  const win = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = s / win;
        s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / win;
        s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return { w, h, g: Uint8ClampedArray.from(a) };
}

// Soglia locale (Bradley): regge luce irregolare, riflessi e sfondi colorati.
function adaptive({ w, h, g }, t = 0.13) {
  const s = Math.max(15, Math.min(151, Math.round(h / 4) | 1));
  const half = s >> 1;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Uint8ClampedArray(g.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * (w + 1) + x1 + 1] - integral[y0 * (w + 1) + x1 + 1] - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      out[y * w + x] = g[y * w + x] * count < sum * (1 - t) ? 0 : 255;
    }
  }
  return { w, h, g: out };
}

function toCanvas({ w, h, g }, pad = 16) {
  // Un margine bianco aiuta Tesseract con il testo vicino ai bordi.
  const c = document.createElement('canvas');
  c.width = w + 2 * pad; c.height = h + 2 * pad;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const img = ctx.createImageData(w, h);
  for (let j = 0, i = 0; j < g.length; j++, i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = g[j]; img.data[i + 3] = 255; }
  ctx.putImageData(img, pad, pad);
  return c;
}

const DIGITS = '0123456789/.-:';

function grayOf(src, targetH, maxW) {
  const sw = src.width, sh = src.height;
  let k = targetH / sh;
  if (sw * k > maxW) k = maxW / sw;
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const g = P.grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
  c.width = c.height = 0;
  return g;
}

function bitmapCanvas(bm, pad = 12) {
  // riga binaria → canvas scalato all'altezza giusta per Tesseract, con margine bianco
  const src = toCanvas(bm, 0);
  const w = Math.max(1, Math.round(bm.w * bm.scale)), h = Math.max(1, Math.round(bm.h * bm.scale));
  const c = document.createElement('canvas');
  c.width = w + 2 * pad; c.height = h + 2 * pad;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, pad, pad, w, h);
  src.width = src.height = 0;
  return c;
}

const LINE_PASSES = [
  { psm: '7' },
  { psm: '13' },
  { psm: '7', digits: true },
];

// Legge le date da un ritaglio (la cornice dello scanner) o da una foto intera.
// Ritorna {candidates, all, texts}.
export async function readDatesFrom(src, { onPass, now = new Date(), whole = false, signal } = {}) {
  const worker = await getWorker();
  const gray = whole ? grayOf(src, 1000, 1400) : grayOf(src, 300, 1600);
  const { lines, flat } = P.candidateLines(gray, { whole });
  const top = lines.slice(0, whole ? 12 : 6);
  const results = [];
  const texts = [];
  let params = '';
  const setP = async (p) => {
    const want = JSON.stringify(p);
    if (want !== params) { await worker.setParameters(p); params = want; }
  };
  const total = top.length + (whole ? 0 : 1);
  let step = 0;
  // 1. tutto il ritaglio insieme: serve a trovare le diciture («da consumarsi entro»)
  if (!whole) {
    onPass?.(++step, total);
    await setP({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
    const c = toCanvas(flat);
    const { data } = await worker.recognize(c);
    c.width = c.height = 0;
    texts.push(data.text || '');
    results.push({ ...extractDates(data.text || '', { now }), src: 'crop' });
  }
  // 2. le righe candidate una alla volta, dalla più promettente
  const lineText = new Map();
  for (const L of top) {
    if (signal?.aborted) break;
    onPass?.(++step, total);
    const c = bitmapCanvas(P.lineBitmap(L));
    for (const p of LINE_PASSES) {
      await setP({ tessedit_pageseg_mode: p.psm, tessedit_char_whitelist: p.digits ? DIGITS : '' });
      const { data } = await worker.recognize(c);
      const text = (data.text || '').trim();
      if (!text) continue;
      texts.push(text);
      if (!lineText.has(L)) lineText.set(L, text);
      results.push({ ...extractDates(text, { now }), src: 'line' + L.box.map((v) => Math.round(v / 20)).join(',') });
    }
    c.width = c.height = 0;
    if (isConfident(mergeResults(results))) break;
  }
  // 3. le righe nell'ordine della confezione: una dicitura sopra la data vale anche per lei
  const doc = [...lineText.entries()].sort((a, b) => a[0].box[1] - b[0].box[1]).map(([, t]) => t).join('\n');
  if (doc) results.push({ ...extractDates(doc, { now }), src: 'doc' });
  // 4. se non basta, tutto il ritaglio con i filtri classici (soglia locale, punti sfocati)
  if (!whole && !mergeResults(results).candidates.length) {
    const base = normalize(toGray(src, Math.max(240, Math.min(420, src.height * 3)), 2200));
    for (const prep of ['adaptive', 'dots']) {
      if (signal?.aborted) break;
      await setP({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
      const img = prep === 'adaptive' ? toCanvas(adaptive(base)) : toCanvas(adaptive(normalize(blur(base, Math.max(2, Math.min(5, Math.round(base.h / 110))))), 0.1));
      const { data } = await worker.recognize(img);
      img.width = img.height = 0;
      texts.push(data.text || '');
      results.push({ ...extractDates(data.text || '', { now }), src: prep });
      if (isConfident(mergeResults(results))) break;
    }
  }
  await setP({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
  return { ...mergeResults(results), texts };
}

// Compatibilità: singola lettura semplice.
export async function recognize(canvas) {
  const worker = await getWorker();
  const { data } = await worker.recognize(toCanvas(normalize(toGray(canvas, 360, 2200))));
  return data.text || '';
}

// Solo per i test del banco di prova.
export const _debug = { toGray, normalize, blur, adaptive, toCanvas, getWorker, P };
