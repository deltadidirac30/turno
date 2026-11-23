// Guscio dello scanner: video a tutto schermo, cornice, messaggi, azioni in basso.
// Usato sia per il singolo prodotto sia per la spesa intera.
import { h, icon, clear, sheet } from '../util.js';
import { t } from '../i18n.js';
import * as camera from '../camera.js';
import * as barcode from '../barcode.js';
import * as ocr from '../ocr.js';
import * as resources from '../resources.js';
import { extractDates } from '../ocr-parse.js';
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

// Scatta, legge e interpreta la data. Ritorna {status: 'ok'|'none'|'unavailable'|'error', candidates}
export async function readDate(scanner, { onStage } = {}) {
  const ready = await resources.check('ocr');
  if (ready.status !== 'ready' && ready.status !== 'nocache') {
    if (!navigator.onLine) return { status: 'unavailable' };
    onStage?.('download');
    const ok = await resources.ensure('ocr');
    if (!ok) return { status: 'unavailable' };
  }
  const canvas = camera.grabRegion(scanner.video, scanner.frame, 1600);
  if (!canvas) return { status: 'error' };
  // Fermo immagine identico all'inquadratura: l'utente vede cosa è stato letto.
  const full = camera.grabFull(scanner.video);
  scanner.freeze(full);
  full.width = full.height = 0;
  try {
    onStage?.('read');
    const text1 = await ocr.recognize(canvas, 'plain');
    self.__turnoLastOcr = text1; // utile per diagnosi (solo in memoria)
    let r = extractDates(text1);
    if (!r.candidates.length) {
      onStage?.('retry');
      const text2 = await ocr.recognize(canvas, 'dots');
      const r2 = extractDates(text1 + '\n' + text2);
      r = r2;
    }
    return { status: r.candidates.length ? 'ok' : 'none', candidates: r.candidates, lines: r.lines };
  } catch (e) {
    console.warn('OCR', e);
    return { status: 'error' };
  } finally {
    canvas.width = canvas.height = 0; // la foto viene scartata
  }
}

export function kindLabel(kind) { return t('kind.' + kind); }

// Scelta tra più date lette, con il testo vicino.
export function chooseDate(host, candidates) {
  return sheet((close, panel) => {
    panel.append(
      h('h2', { class: 'sheet-title' }, t('choose.title')),
      h('p', { class: 'sheet-text' }, t('choose.text')),
      h('div', { class: 'choices' }, candidates.slice(0, 5).map((c, i) =>
        h('button', { type: 'button', class: 'choice' + (i === 0 ? ' is-top' : ''), onclick: () => close(c) },
          h('span', { class: 'choice-date' }, formatExpiry(c.exp)),
          h('span', { class: 'choice-kind' }, [kindLabel(c.kind), c.exp.d == null ? t('date.monthOnlyShort') : '', expiryEnd(c.exp) < startOfDay() ? t('choose.past') : ''].filter(Boolean).join(' · ')),
          h('span', { class: 'choice-ctx' }, '“' + c.context + '”')))),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close('none') }, t('choose.none')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close('retake') }, t('choose.retake'))));
  }, { host, dismissValue: 'retake', className: 'sheet-dark-safe' });
}

// Conferma/correzione prima del salvataggio. Ritorna {action, item, dateSource}.
export function confirmItem(host, item, { source = null, shelves = {}, title, primary, secondary, extra = [] } = {}) {
  return sheet((close, panel) => {
    const form = itemForm(item, { compact: true, shelves, source });
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
