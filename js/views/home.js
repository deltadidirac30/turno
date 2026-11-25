// «Da usare prima»: riquadri di stato (anche filtri), ricerca, luoghi e lista ordinata per termine.
import { h, icon, clear, toast } from '../util.js';
import { t, lang } from '../i18n.js';
import * as db from '../db.js';
import { urgency, sortKey, formatShort, precision } from '../dates.js';
import { consumeOne, isIncomplete, missing } from '../store.js';
import { navigate } from '../router.js';

const ui = { query: '', loc: 'all', shelf: '', tile: null }; // filtri conservati durante la sessione

const SECTIONS = ['expired', 'today', 'soon', 'week', 'later', 'none'];
const TILES = [
  { id: 'now', cls: 'tile-red', levels: ['expired', 'today'] },
  { id: 'soon', cls: 'tile-orange', levels: ['soon'] },
  { id: 'ok', cls: 'tile-green', levels: ['week', 'later'] },
];
export const PLACE_ICON = { fridge: 'fridge', freezer: 'freezer', pantry: 'pantry' };

export function brandRow(right) {
  return h('div', { class: 'brandrow' },
    h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('span')),
    h('span', { class: 'wordmark' }, t('app.name')),
    right);
}

// Piccola illustrazione per gli stati vuoti: un frigo con un bollino.
export function emptyArt() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 128 128');
  s.setAttribute('class', 'empty-art');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<circle cx="64" cy="64" r="60" fill="var(--green-soft)"/>
    <rect x="38" y="20" width="52" height="88" rx="10" fill="var(--surface)" stroke="var(--ink)" stroke-width="3"/>
    <path d="M38 52h52" stroke="var(--ink)" stroke-width="3"/><path d="M48 32v10M48 62v14" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>
    <g transform="rotate(-8 84 78)"><rect x="66" y="66" width="40" height="26" rx="6" fill="var(--orange)"/><path d="M73 79h26" stroke="#fff" stroke-width="4" stroke-linecap="round"/></g>`;
  return s;
}

export async function render(root) {
  const items = (await db.items.active());
  const batch = await db.kv.get('batch', null);
  clear(root);

  const levelOf = new Map(items.map((i) => [i.id, urgency(i).level]));
  const countIn = (levels) => items.filter((i) => levels.includes(levelOf.get(i.id))).length;
  const incomplete = items.filter(isIncomplete);
  const today = new Intl.DateTimeFormat(lang(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  root.append(h('header', { class: 'top top-home' },
    brandRow(h('span', { class: 'today' }, today)),
    h('h1', {}, t('home.title')),
    h('p', { class: 'summary' }, summaryText(countIn(['expired', 'today']), countIn(['soon']), items.length))));

  if (!items.length) {
    root.append(h('div', { class: 'empty' }, emptyArt(),
      h('p', { class: 'empty-title' }, t('home.emptyTitle')),
      h('p', { class: 'empty-text' }, t('home.emptyText')),
      h('div', { class: 'empty-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => navigate('#/scan') }, icon('scan'), t('home.scanOne')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => navigate('#/batch') }, icon('bag'), t('home.batchStart')),
        h('button', { type: 'button', class: 'link-btn', onclick: () => navigate('#/add') }, icon('plus'), t('home.addManual')))));
    return;
  }

  // Riquadri: quanti sono da usare subito, a breve, con calma. Toccandoli si filtra la lista.
  const tiles = h('div', { class: 'tiles' });
  const drawTiles = () => {
    clear(tiles);
    for (const tl of TILES) {
      const n = countIn(tl.levels);
      tiles.append(h('button', { type: 'button', class: `tile ${tl.cls}${n ? '' : ' is-zero'}`, 'aria-pressed': String(ui.tile === tl.id),
        onclick: () => { ui.tile = ui.tile === tl.id ? null : tl.id; drawTiles(); drawList(); } },
        h('span', { class: 'tile-n' }, String(n)), h('span', { class: 'tile-l' }, t('home.tile.' + tl.id))));
    }
  };
  root.append(tiles);

  const banners = h('div', { class: 'banners' });
  if (batch && batch.entries?.length) {
    const left = batch.entries.filter((e) => !e.done).length;
    banners.append(h('button', { type: 'button', class: 'banner banner-strong', onclick: () => navigate('#/batch') }, icon('bag'),
      h('span', { class: 'banner-text' }, h('strong', {}, t('home.batchTitle')), t(batch.phase === 'queue' ? 'home.batchQueue' : 'home.batchReview', { n: left })),
      h('span', { class: 'banner-go' }, t('home.resume'))));
  }
  if (incomplete.length) {
    banners.append(h('button', { type: 'button', class: 'banner', onclick: () => navigate('#/todo') }, icon('pencil'),
      h('span', { class: 'banner-text' }, h('strong', {}, t('home.todoTitle')), t('home.todoCount', { n: incomplete.length })),
      h('span', { class: 'banner-go' }, t('home.open'))));
  }
  root.append(banners);

  const search = h('input', { type: 'search', class: 'in search-in', placeholder: t('home.search'), value: ui.query, 'aria-label': t('home.search'), enterkeyhint: 'search' });
  const filters = h('div', { class: 'chips', role: 'tablist', 'aria-label': t('home.filter') });
  const shelfRow = h('div', { class: 'chips chips-sub' });
  const listHost = h('div', { class: 'list-host' });
  root.append(h('div', { class: 'tools' }, h('label', { class: 'search' }, icon('search'), search), filters, shelfRow), listHost);

  const drawFilters = () => {
    clear(filters);
    for (const loc of ['all', 'fridge', 'freezer', 'pantry']) {
      const n = loc === 'all' ? items.length : items.filter((i) => i.location === loc).length;
      filters.append(h('button', { type: 'button', role: 'tab', class: 'chip', 'aria-selected': String(ui.loc === loc),
        onclick: () => { ui.loc = loc; ui.shelf = ''; drawFilters(); drawList(); } },
        loc === 'all' ? null : icon(PLACE_ICON[loc]), loc === 'all' ? t('home.all') : t('loc.' + loc), h('span', { class: 'chip-n' }, String(n))));
    }
    clear(shelfRow);
    const pool = ui.loc === 'all' ? items : items.filter((i) => i.location === ui.loc);
    const shelves = [...new Set(pool.map((i) => i.shelf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    shelfRow.hidden = !shelves.length || ui.loc === 'all';
    if (!shelfRow.hidden) {
      for (const s of ['', ...shelves]) {
        shelfRow.append(h('button', { type: 'button', class: 'chip chip-sm', 'aria-pressed': String(ui.shelf === s),
          onclick: () => { ui.shelf = s; drawFilters(); drawList(); } }, s || t('home.allShelves')));
      }
    }
  };

  const drawList = () => {
    clear(listHost);
    const q = ui.query.trim().toLowerCase();
    const tile = TILES.find((x) => x.id === ui.tile);
    const shown = items
      .filter((i) => ui.loc === 'all' || i.location === ui.loc)
      .filter((i) => !ui.shelf || i.shelf === ui.shelf)
      .filter((i) => !tile || tile.levels.includes(levelOf.get(i.id)))
      .filter((i) => !q || `${i.name} ${i.brand}`.toLowerCase().includes(q))
      .sort((a, b) => sortKey(a) - sortKey(b) || (a.name || '').localeCompare(b.name || ''));
    if (!shown.length) { listHost.append(h('p', { class: 'empty-text pad' }, t('home.noMatch'))); return; }
    const groups = new Map(SECTIONS.map((s) => [s, []]));
    shown.forEach((i) => groups.get(levelOf.get(i.id)).push(i));
    for (const [sec, list] of groups) {
      if (!list.length) continue;
      listHost.append(h('section', { class: 'sec sec-' + sec },
        h('h2', { class: 'sec-title' }, h('span', { class: 'sec-dot' }), t('sec.' + sec), h('span', { class: 'sec-n' }, String(list.length))),
        h('ul', { class: 'rows' }, list.map((i) => row(i, () => render(root))))));
    }
  };

  search.addEventListener('input', () => { ui.query = search.value; drawList(); });
  drawTiles();
  drawFilters();
  drawList();
}

function summaryText(now, soon, total) {
  if (!total) return t('home.summaryEmpty');
  if (now) return t('home.sumNow', { n: now });
  if (soon) return t('home.sumSoonOnly', { n: soon });
  return t('home.sumCalm');
}

// Etichetta della scadenza come un bollino: data grande e stato a parole
// (il colore non è mai l'unico segnale).
export function whenLabel(item) {
  const u = urgency(item);
  if (u.level === 'none') return { big: '—', small: missing(item).includes('date') ? t('row.stkMissing') : t('row.stkNoDate') };
  const p = u.dl.precision;
  if (p !== 'day') {
    // Solo mese/anno: niente giorno inventato.
    const big = p === 'month' ? `${String(item.expiry.m).padStart(2, '0')}.${String(item.expiry.y).slice(2)}` : String(item.expiry.y);
    return { big, small: u.level === 'expired' ? t('row.expired') : t(p === 'month' ? 'row.monthOnly' : 'row.yearOnly') };
  }
  const d = u.dl.date;
  const big = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (u.level === 'expired') return { big, small: u.days === -1 ? t('row.expiredYesterday') : t('row.expiredDays', { n: -u.days }) };
  if (u.level === 'today') return { big, small: t('row.today') };
  if (u.days === 1) return { big, small: t('row.tomorrow') };
  if (u.days <= 45) return { big, small: t('row.inDays', { n: u.days }) };
  return { big, small: String(d.getFullYear()) };
}

export function sticker(item) {
  const w = whenLabel(item);
  return h('span', { class: 'stk' }, h('span', { class: 'stk-big' }, w.big), h('span', { class: 'stk-small' }, w.small));
}

export function placeText(item) {
  if (!item.location) return '';
  return t('loc.' + item.location) + (item.shelf ? ', ' + item.shelf : '');
}

export function row(item, onChange) {
  const u = urgency(item);
  const meta = [placeText(item)];
  if (item.qty > 1) meta.push('×' + item.qty);
  if (item.brand) meta.unshift(item.brand);
  const miss = missing(item);

  const eat = h('button', { type: 'button', class: 'eat', 'aria-label': t('row.consumeAria', { name: item.name || t('item.unnamed') }) },
    icon('check'), h('span', {}, t('row.consume')));
  eat.addEventListener('click', async () => {
    eat.disabled = true;
    const { after, undo } = await consumeOne(item);
    const name = item.name || t('item.unnamed');
    toast(after.status === 'consumed' ? t('toast.consumed', { name }) : t('toast.consumedOne', { name, n: after.qty }), {
      action: t('common.undo'), onAction: async () => { await undo(); onChange(); },
    });
    onChange();
  });

  let tag = null;
  if (miss.length) tag = h('span', { class: 'tag tag-todo' }, t('row.todo.' + miss[0]));
  else if (item.openedAt) tag = h('span', { class: 'tag tag-open' }, u.dl?.source === 'opened' ? t('row.openedUntil', { date: formatShort(u.dl.date, lang()) }) : t('row.opened'));
  else if (item.expiryKind === 'best_before' && precision(item.expiry) !== 'none' && (u.level === 'expired')) tag = h('span', { class: 'tag tag-open' }, t('row.bestBeforePassed'));

  return h('li', { class: `row lv-${u.level}${miss.length ? ' is-incomplete' : ''}` },
    h('a', { class: 'row-main', href: '#/item/' + item.id },
      sticker(item),
      h('span', { class: 'what' },
        h('span', { class: 'name' }, item.name || h('em', {}, t('item.unnamed'))),
        meta.filter(Boolean).length ? h('span', { class: 'meta' }, item.location ? icon(PLACE_ICON[item.location]) : null, h('span', { class: 'meta-t' }, meta.filter(Boolean).join(', '))) : null,
        tag)),
    eat);
}
