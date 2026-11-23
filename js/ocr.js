// OCR della data con Tesseract.js, tutto sul dispositivo. Le immagini restano in memoria
// solo per il tempo della lettura e non vengono salvate.
import { url, ocrCorePath } from './resources.js';

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
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
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

// Scala di grigi con allungamento del contrasto; variante "dots" per le stampe a punti.
function prepare(src, variant) {
  const minH = 220; // testo troppo piccolo legge male
  const k = Math.max(1, Math.min(2.5, minH / src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (variant === 'dots') ctx.filter = 'blur(1.2px)';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  ctx.filter = 'none';
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  const gray = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[j] = g; hist[g]++;
  }
  // percentili 2% e 98%
  const total = gray.length;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  // testo chiaro su fondo scuro? inverti (la maggioranza dei pixel è sfondo)
  let mean = 0;
  for (let j = 0; j < gray.length; j++) mean += gray[j];
  mean /= gray.length;
  const invert = mean < 110;
  let thr = 128;
  if (variant === 'dots') thr = otsu(hist, total, lo, span);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v = ((gray[j] - lo) * 255) / span;
    if (invert) v = 255 - v;
    if (variant === 'dots') v = v < thr ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function otsu(hist, total, lo, span) {
  // soglia sull'istogramma già stirato (approssimazione)
  const h2 = new Float64Array(256);
  for (let v = 0; v < 256; v++) { const s = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / span))); h2[s] += hist[v]; }
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * h2[v];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += h2[v]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += v * h2[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = v; }
  }
  return thr;
}

export async function recognize(canvas, variant = 'plain') {
  const worker = await getWorker();
  const img = prepare(canvas, variant);
  const { data } = await worker.recognize(img);
  img.width = img.height = 0; // libera memoria
  return data.text || '';
}
