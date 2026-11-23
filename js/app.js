// Avvio dell'app: lingua, router, service worker, preparazione delle risorse offline.
import { t, setLang, applyStatic } from './i18n.js';
import * as db from './db.js';
import * as resources from './resources.js';
import { h, clear, icon } from './util.js';
import { noteNavigation } from './router.js';
import * as home from './views/home.js';
import * as todo from './views/todo.js';
import * as item from './views/item.js';
import * as scan from './views/scan.js';
import * as batch from './views/batch.js';
import * as settings from './views/settings.js';

const ROUTES = {
  '': { view: home, tab: 'list' },
  todo: { view: todo, tab: 'list' },
  item: { view: item, tab: 'list' },
  add: { view: item, tab: 'list' },
  'add-again': { view: item, tab: 'list' },
  scan: { view: scan, full: true },
  batch: { view: batch, full: true },
  settings: { view: settings, tab: 'settings' },
};

const viewEl = () => document.getElementById('view');
let cleanup = null;
let routing = Promise.resolve();

function parse() {
  const [name = '', arg = null] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: ROUTES[name] ? name : '', arg: arg ? decodeURIComponent(arg) : null };
}

async function route() {
  const { name, arg } = parse();
  const r = ROUTES[name];
  if (cleanup) { try { await cleanup(); } catch (e) { console.warn(e); } cleanup = null; }
  document.body.classList.toggle('is-full', !!r.full);
  document.querySelectorAll('#tabbar [data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === r.tab ? 'page' : 'false'));
  const root = viewEl();
  clear(root);
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    cleanup = (await r.view.render(root, arg)) || null;
  } catch (e) {
    console.error(e);
    root.append(h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, t('error.title')), h('p', { class: 'empty-text' }, String(e && e.message || e))));
  }
}

export function rerender() { routing = routing.then(route); return routing; }

function buildTabbar() {
  const bar = document.getElementById('tabbar');
  clear(bar);
  bar.append(
    h('a', { href: '#/', class: 'tab', dataset: { tab: 'list' } }, icon('list'), h('span', {}, t('nav.list'))),
    h('a', { href: '#/scan', class: 'tab tab-scan', dataset: { tab: 'scan' } }, icon('scan'), h('span', {}, t('nav.scan'))),
    h('a', { href: '#/settings', class: 'tab', dataset: { tab: 'settings' } }, icon('gear'), h('span', {}, t('nav.settings'))));
}

let updating = false;
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (w) => {
      const box = document.getElementById('update');
      clear(box).append(h('span', {}, t('update.ready')),
        h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => { updating = true; w.postMessage('skipWaiting'); } }, t('update.apply')));
      box.hidden = false;
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch((e) => console.warn('SW', e));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating && !reloaded) { reloaded = true; location.reload(); } });
}

function offlineBadge() {
  const el = document.getElementById('net');
  const upd = () => { el.hidden = navigator.onLine; el.textContent = t('net.offline'); };
  window.addEventListener('online', upd); window.addEventListener('offline', upd);
  upd();
}

async function start() {
  let s;
  try {
    await db.openDB();
    s = await db.getSettings();
  } catch (e) {
    document.getElementById('view').textContent = 'IndexedDB non disponibile: ' + (e && e.message);
    return;
  }
  setLang(s.lang);
  applyStatic();
  buildTabbar();
  offlineBadge();
  window.addEventListener('hashchange', () => { noteNavigation(); rerender(); });
  await rerender();
  registerSW();
  // Prepara in background le risorse di scansione per l'uso offline.
  if (s.autoDownload && navigator.onLine && 'caches' in self) {
    setTimeout(async () => {
      await resources.ensure('barcode');
      await resources.ensure('ocr');
    }, 2500);
  } else if ('caches' in self) { resources.check('barcode'); resources.check('ocr'); }
}

start();
