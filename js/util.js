// Piccoli helper DOM e componenti condivisi (toast, sheet, dialoghi).
import { t } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export const nowISO = () => new Date().toISOString();

// Icone SVG inline (tratto semplice, nessuna libreria esterna)
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  scan: '<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3"/><path d="M8 9v6M11 9v6M14 9v6M16.5 9v6"/>',
  list: '<path d="M5 7h14M5 12h10M5 17h6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  photo: '<rect x="3.5" y="6.5" width="17" height="13" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8.5 6.5l1.5-2.5h4l1.5 2.5"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8"/>',
  skip: '<path d="M6 6l7 6-7 6M16 6v12"/>',
  torch: '<path d="M8 3h8l-1.5 5h-5zM9.5 8h5v11a2.5 2.5 0 01-5 0z"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 15V6a2 2 0 012-2h8"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  open: '<path d="M5 10h14v9H5zM5 10l2-5h10l2 5"/>',
  dots: '<circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/>',
  fridge: '<rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M6 10h12M9 6.5v1.5M9 13v2.5"/>',
  freezer: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5"/>',
  pantry: '<path d="M8 4h8v2.5a2 2 0 001 1.7l.3.2A3 3 0 0119 11v7a2.5 2.5 0 01-2.5 2.5h-9A2.5 2.5 0 015 18v-7a3 3 0 011.7-2.6l.3-.2a2 2 0 001-1.7z"/><path d="M5 13h14"/>',
  bag: '<path d="M5 8h14l-1.2 11.2a2 2 0 01-2 1.8H8.2a2 2 0 01-2-1.8z"/><path d="M9 10V7a3 3 0 016 0v3"/>',
  pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/><path d="M14 7l3 3"/>',
  move: '<path d="M4 12h14M14 7l5 5-5 5"/>',
  bin: '<path d="M4 7h16M9 7V4.5h6V7M6 7l1.2 13h9.6L18 7"/><path d="M10 11v6M14 11v6"/>',
  home: '<path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19.5z"/><path d="M10 21v-6h4v6"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

// ---------- Toast con azione (es. Annulla) ----------
let toastTimer;
export function toast(message, { action, onAction, duration = 5000 } = {}) {
  const host = document.getElementById('toast');
  clear(host);
  clearTimeout(toastTimer);
  const box = h('div', { class: 'toast-box', role: 'status' },
    h('span', { class: 'toast-msg' }, message),
    action ? h('button', { class: 'toast-act', type: 'button', onclick: () => { hide(); onAction?.(); } }, action) : null);
  host.append(box);
  host.classList.add('show');
  function hide() { host.classList.remove('show'); clearTimeout(toastTimer); }
  toastTimer = setTimeout(hide, duration);
  return hide;
}

// ---------- Bottom sheet modale, basato su Promise ----------
// build(close, body) riceve close(value) per chiudere e risolvere.
export function sheet(build, { className = '', dismissValue = null, host } = {}) {
  return new Promise((resolve) => {
    const root = host || document.getElementById('overlay');
    const backdrop = h('div', { class: 'sheet-backdrop' });
    const panel = h('div', { class: 'sheet ' + className, role: 'dialog', 'aria-modal': 'true' });
    const wrap = h('div', { class: 'sheet-wrap' }, backdrop, panel);
    let done = false;
    const close = (value) => {
      if (done) return; done = true;
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), 160);
      resolve(value);
    };
    backdrop.addEventListener('click', () => close(dismissValue));
    document.getElementById('toast')?.classList.remove('show'); // il toast non deve coprire i pulsanti
    build(close, panel);
    root.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
  });
}

export function confirmDialog({ title, message, confirm, cancel = t('common.cancel'), danger = false }) {
  return sheet((close, panel) => {
    panel.append(
      h('h2', { class: 'sheet-title' }, title),
      message ? h('p', { class: 'sheet-text' }, message) : null,
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), type: 'button', onclick: () => close(true) }, confirm),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(false) }, cancel)));
  }, { dismissValue: false });
}

export function vibrate(ms = 30) { try { navigator.vibrate?.(ms); } catch { /* iOS non supporta */ } }

export function formatBytes(n) {
  if (n >= 1e6) return (n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB';
  return Math.round(n / 1e3) + ' kB';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
