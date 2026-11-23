// Guscio dello scanner: video a tutto schermo, cornice, messaggi, azioni in basso.
// Usato sia per il singolo prodotto sia per la spesa intera.
import { h, icon, clear, sheet } from '../util.js';
import { t } from '../i18n.js';
import * as camera from '../camera.js';
import * as barcode from '../barcode.js';
import * as ocr from '../ocr.js';
import * as resources from '../resources.js';
import { formatExpiry, expiryEnd, startOfDay } from '../dates.js';
import { itemForm } from './forms.js';

export function createScanner({ onClose, title = '', hires = false }) {
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const still = h('canvas', { class: 'scan-still', hidden: true });
  const frame = h('div', { class: 'scan-frame', dataset: { mode: 'barcode' } }, h('span', { class: 'scan-line' }));
  const titleEl = h('div', { class: 'scan-title' }, title);
  const topRight = h('div', { class: 'scan-top-right' });
  const torchBtn = h('button', { type: 'button', class: 'icon-btn on-dark', hidden: true, 'aria-label': t('scan.torch'), 'aria-pressed': 'false' }, icon('torch'));
  const closeBtn = h('button', { type: 'button', class: 'icon-btn on-dark', 'aria-label': t('common.close'), onclick: () => onClose?.() }, icon('close'));
  const msg = h('div', { class: 'scan-msg', 'aria-live': 'polite' });
  const res = h('div', { class: 'scan-res', 'aria-live': 'polite' });
  const actions = h('div', { class: 'scan-actions' });
  const fallback = h('div', { class: 'scan-fallback', hidden: true });
  const overlay = h('div', { class: 'scan-overlay' });
  const el = h('div', { class: 'scanner' },
    h('div', { class: 'scan-stage' }, video, still, frame, fallback),
    h('div', { class: 'scan-top' }, closeBtn, titleEl, topRight, torchBtn),
    h('div', { class: 'scan-mid' }, msg, res),
    h('div', { class: 'scan-bottom' }, actions),
    overlay);

  torchBtn.addEventListener('click', async () => torchBtn.setAttribute('aria-pressed', String(await camera.toggleTorch())));

  let camOk = false;
  const api = {
    el, video, frame, overlay,
    get cameraOk() { return camOk; },
    setTitle(node) { clear(titleEl).append(node); },
    setMode(m) { frame.dataset.mode = m; },
    setTopRight(node) { clear(topRight); if (node) topRight.append(node); },
    setMessage(text, tone = '') { msg.className = 'scan-msg ' + tone; clear(msg); if (text) msg.append(text); },
    setResources(node) { clear(res); if (node) res.append(node); },
    setActions(...nodes) { clear(actions).append(...nodes.flat().filter(Boolean)); },
    async startCamera() {
      try {
        await camera.start(video, { hires });
        camOk = true;
        fallback.hidden = true; frame.hidden = false;
        torchBtn.hidden = !camera.torchSupported();
        return { ok: true };
      } catch (e) {
        camOk = false;
        frame.hidden = true;
        fallback.hidden = false;
        clear(fallback).append(
          h('p', { class: 'fb-title' }, t('camera.' + (e.code || 'error') + '.title')),
          h('p', { class: 'fb-text' }, t('camera.' + (e.code || 'error') + '.text')));
        return { ok: false, code: e.code || 'error' };
      }
    },
    stopCamera() { camera.stop(); camOk = false; },
    // Dopo la fotocamera di sistema iOS può aver sospeso il flusso: lo riprende o lo riavvia.
    async resumeCamera() {
      const tr = video.srcObject && video.srcObject.getVideoTracks()[0];
      if (!tr || tr.readyState === 'ended') { camera.stop(); return api.startCamera(); }
      try { await video.play(); } catch {}
      return { ok: true };
    },
    freeze(canvas) {
      if (!canvas) { still.hidden = true; return; }
      still.width = canvas.width; still.height = canvas.height;
      still.getContext('2d').drawImage(canvas, 0, 0);
      still.hidden = false;
    },
    destroy() { camera.stop(); el.remove(); },
  };
  return api;
}

// Scansione continua del codice nella cornice. Ritorna una funzione per fermarla.
export function liveBarcode(scanner, onCode, accept = () => true) {
  let stopped = false, busy = false, last = null, lastAt = 0;
  const tick = async () => {
    if (stopped) return;
    if (!busy && scanner.cameraOk && scanner.video.readyState >= 2) {
      busy = true;
      try {
        const c = camera.grabRegion(scanner.video, scanner.frame, 1280);
        const code = c ? await barcode.readOne(c) : null;
        if (code && !stopped && accept(code) && (code !== last || Date.now() - lastAt > 2500)) {
          last = code; lastAt = Date.now();
          stopped = true;
          onCode(code);
        }
      } catch (e) { /* frame non leggibile: si riprova */ }
      busy = false;
    }
    if (!stopped) setTimeout(tick, 140);
  };
  tick();
  return () => { stopped = true; };
}

// Riga di stato delle risorse (mostra chiaramente quando serve ancora scaricare).
export function resourceStatus(name) {
  const node = h('span', { class: 'res-pill' });
  const render = (s) => {
    const st = s[name] || s;
    node.className = 'res-pill';
    if (st.status === 'ready' || st.status === 'nocache') { node.hidden = true; return; }
    node.hidden = false;
    if (st.status === 'downloading') node.textContent = t(`res.${name}.downloading`, { pct: Math.round(st.progress * 100) });
    else if (st.status === 'error') { node.textContent = t(`res.${name}.error`); node.classList.add('is-warn'); }
    else if (!navigator.onLine) { node.textContent = t(`res.${name}.offline`); node.classList.add('is-warn'); }
    else node.textContent = t(`res.${name}.missing`);
  };
  render({ [name]: resources.getState(name) });
  const off = resources.onChange(render);
  resources.check(name);
  node.dispose = off;
  return node;
}

async function ensureOcr(onStage) {
  const ready = await resources.check('ocr');
  if (ready.status === 'ready' || ready.status === 'nocache') return true;
  if (!navigator.onLine) return false;
  onStage?.('download');
  return resources.ensure('ocr');
}

// Il testo letto più lungo, accorciato: mostrato quando non si trova una data,
// così si capisce se la foto era sfocata o se la data è in un formato non previsto.
function readSnippet(texts) {
  const best = (texts || []).map((x) => x.replace(/\s+/g, ' ').trim()).sort((a, b) => b.length - a.length)[0] || '';
  return best.length > 60 ? best.slice(0, 60) + '…' : best;
}

// Scatta, legge e interpreta la data. Ritorna {status: 'ok'|'none'|'unavailable'|'error', candidates, snippet}
export async function readDate(scanner, { onStage } = {}) {
  if (!(await ensureOcr(onStage))) return { status: 'unavailable' };
  const canvas = camera.grabRegion(scanner.video, scanner.frame, 2000);
  if (!canvas) return { status: 'error' };
  // Fermo immagine identico all'inquadratura: l'utente vede cosa è stato letto.
  const full = camera.grabFull(scanner.video);
  scanner.freeze(full);
  full.width = full.height = 0;
  try {
    onStage?.('read', { i: 1, n: 5 });
    const r = await ocr.readDatesFrom(canvas, { onPass: (i, n) => onStage?.('read', { i, n }) });
    self.__turnoLastOcr = r.texts.join('\n'); // utile per diagnosi (solo in memoria)
    return { status: r.candidates.length ? 'ok' : 'none', candidates: r.candidates, snippet: readSnippet(r.texts) };
  } catch (e) {
    console.warn('OCR', e);
    return { status: 'error' };
  } finally {
    canvas.width = canvas.height = 0; // la foto viene scartata
  }
}

// Foto a piena risoluzione con la fotocamera di sistema (messa a fuoco ravvicinata migliore).
// L'utente tocca la data sulla foto: si legge solo quella fascia, come nella cornice.
export async function readDateFromFile(file, { onStage, host } = {}) {
  if (!(await ensureOcr(onStage))) return { status: 'unavailable' };
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
    const pick = host ? await pickRegion(host, bmp) : { whole: true };
    if (!pick) return { status: 'cancel' };
    let src = bmp;
    if (!pick.whole) {
      const c = document.createElement('canvas');
      c.width = pick.w; c.height = pick.h;
      c.getContext('2d').drawImage(bmp, pick.x, pick.y, pick.w, pick.h, 0, 0, pick.w, pick.h);
      src = c;
    }
    onStage?.('read', { i: 1, n: 5 });
    const r = await ocr.readDatesFrom(src, { whole: !!pick.whole, onPass: (i, n) => onStage?.('read', { i, n }) });
    if (src !== bmp) src.width = src.height = 0;
    self.__turnoLastOcr = r.texts.join('\n');
    return { status: r.candidates.length ? 'ok' : 'none', candidates: r.candidates, snippet: readSnippet(r.texts) };
  } catch (e) {
    console.warn('OCR foto', e);
    return { status: 'error' };
  } finally {
    bmp?.close?.(); // la foto viene scartata
  }
}

// Mostra la foto e chiede di toccare la data. Ritorna la fascia da leggere, {whole:true} o null.
function pickRegion(host, bmp) {
  return new Promise((resolve) => {
    const W = bmp.width, H = bmp.height;
    const cv = h('canvas', { class: 'pick-img' });
    const k = Math.min(1, 1600 / Math.max(W, H));
    cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const mark = h('div', { class: 'pick-mark', hidden: true });
    const done = (v) => { wrap.remove(); cv.width = cv.height = 0; resolve(v); };
    const wrap = h('div', { class: 'pick' },
      h('div', { class: 'pick-stage' }, cv, mark),
      h('p', { class: 'pick-hint' }, t('scan.pickHint')),
      h('div', { class: 'pick-actions' },
        h('button', { type: 'button', class: 'pill', onclick: () => done(null) }, t('common.cancel')),
        h('button', { type: 'button', class: 'pill', onclick: () => done({ whole: true }) }, t('scan.pickWhole'))));
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      // il canvas è mostrato con object-fit: contain
      const s = Math.min(r.width / cv.width, r.height / cv.height);
      const ox = (r.width - cv.width * s) / 2, oy = (r.height - cv.height * s) / 2;
      const px = (e.clientX - r.left - ox) / s / k, py = (e.clientY - r.top - oy) / s / k;
      if (px < 0 || py < 0 || px > W || py > H) return;
      // fascia larga quanto quasi tutta la foto e alta ~1/7: come la cornice dello scanner
      const bw = Math.round(W * 0.9), bh = Math.round(Math.min(H, W) * 0.2);
      const x = Math.max(0, Math.min(W - bw, Math.round(px - bw / 2)));
      const y = Math.max(0, Math.min(H - bh, Math.round(py - bh / 2)));
      Object.assign(mark.style, { left: `${ox + x * k * s}px`, top: `${oy + y * k * s}px`, width: `${bw * k * s}px`, height: `${bh * k * s}px` });
      mark.hidden = false;
      setTimeout(() => done({ x, y, w: bw, h: bh }), 180);
    });
    host.append(wrap);
  });
}

// Strumenti del passo «data»: zoom (se la fotocamera lo consente) e foto nitida di sistema.
export function dateTools(onFile) {
  const nodes = [];
  const zc = camera.zoomRange();
  if (zc && zc.max >= 1.8) {
    const levels = [zc.min, Math.min(2, zc.max), Math.min(3, zc.max)].filter((v, i, a) => a.indexOf(v) === i);
    let k = 0;
    const b = h('button', { type: 'button', class: 'pill pill-sm', 'aria-label': t('scan.zoom') }, '1×');
    b.addEventListener('click', async () => { k = (k + 1) % levels.length; await camera.setZoom(levels[k]); b.textContent = `${Math.round(levels[k] * 10) / 10}×`; });
    nodes.push(b);
  }
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  file.addEventListener('change', () => { const f = file.files && file.files[0]; file.value = ''; if (f) onFile(f); });
  nodes.push(h('button', { type: 'button', class: 'pill pill-sm', onclick: () => file.click() }, icon('photo'), t('scan.sharpPhoto')), file);
  return h('div', { class: 'tools-row' }, nodes);
}

export function kindLabel(kind) { return t('kind.' + kind); }

export function noDateMessage(r, key) {
  return h('span', {}, t(key), r.snippet ? h('span', { class: 'snippet' }, t('scan.readSnippet', { text: r.snippet })) : null);
}

// Scelta tra più date lette, con il testo vicino.
export function chooseDate(host, candidates) {
  return sheet((close, panel) => {
    panel.append(
      h('h2', { class: 'sheet-title' }, t('choose.title')),
      h('p', { class: 'sheet-text' }, t('choose.text')),
      h('div', { class: 'choices' }, candidates.slice(0, 5).map((c, i) =>
        h('button', { type: 'button', class: 'choice' + (i === 0 ? ' is-top' : ''), onclick: () => close(c) },
          h('span', { class: 'choice-date' }, formatExpiry(c.exp)),
          h('span', { class: 'choice-kind' }, [kindLabel(c.kind), c.exp.d == null ? t('date.monthOnlyShort') : '', expiryEnd(c.exp) < startOfDay() ? t('choose.past') : ''].filter(Boolean).join(', ')),
          h('span', { class: 'choice-ctx' }, '“' + c.context + '”')))),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close('none') }, t('choose.none')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close('retake') }, t('choose.retake'))));
  }, { host, dismissValue: 'retake', className: 'sheet-dark-safe' });
}

// Conferma/correzione prima del salvataggio. Ritorna {action, item, dateSource}.
export function confirmItem(host, item, { source = null, yearInferred = false, shelves = {}, title, primary, secondary, extra = [] } = {}) {
  return sheet((close, panel) => {
    const form = itemForm(item, { compact: true, shelves, source, yearInferred });
    const err = h('p', { class: 'form-err', 'aria-live': 'assertive' });
    const submit = (action) => {
      const r = form.read();
      if (!r.ok) { err.textContent = t('date.err.fix'); form.dates.focus(); return; }
      close({ action, item: r.item, dateSource: r.dateSource });
    };
    panel.append(
      h('div', { class: 'sheet-head' },
        h('h2', { class: 'sheet-title' }, title || t('confirm.title')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.back'), onclick: () => close({ action: 'cancel' }) }, icon('close'))),
      form.el, err,
      h('div', { class: 'sheet-actions sticky' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => submit('next') }, primary || t('confirm.saveNext')),
        secondary ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => submit('done') }, secondary) : null,
        ...extra.map(([label, action]) => h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close({ action }) }, label))));
  }, { host, dismissValue: { action: 'cancel' }, className: 'sheet-tall' });
}
