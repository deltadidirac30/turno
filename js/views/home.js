// Lista «Da usare prima»: ordinata per termine, con ricerca, filtri e Consumato in un tap.
import { h, icon, clear, toast } from '../util.js';
import { t, lang } from '../i18n.js';
import * as db from '../db.js';
import { urgency, sortKey, formatShort, precision } from '../dates.js';
import { consumeOne, isIncomplete, missing } from '../store.js';
import { navigate } from '../router.js';

const ui = { query: '', loc: 'all', shelf: '' }; // filtri conservati durante la sessione

const SECTIONS = ['expired', 'today', 'soon', 'week', 'later', 'none'];

export async function render(root) {
  const items = (await db.items.active());
  const batch = await db.kv.get('batch', null);
  clear(root);

  const counts = { expired: 0, today: 0, soon: 0 };
  items.forEach((i) => { const u = urgency(i).level; if (u in counts) counts[u]++; });
  const incomplete = items.filter(isIncomplete);

  const summary = h('p', { class: 'summary' }, summaryText(counts, items.length));
  const today = new Intl.DateTimeFormat(lang(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const header = h('header', { class: 'top top-home' },
    h('div', { class: 'brandrow' },
      h('span', { class: 'wordmark' }, t('app.name')),
      h('span', { class: 'today' }, today),
      h('button', { type: 'button', class: 'link-btn', onclick: () => navigate('#/add') }, icon('plus'), t('home.addManual'))),
    h('h1', {}, t('home.title')),
    summary);

  const banners = h('div', { class: 'banners' });
  if (batch && batch.entries?.length) {
    const left = batch.entries.filter((e) => !e.done).length;
    banners.append(h('button', { type: 'button', class: 'banner banner-strong', onclick: () => navigate('#/batch') },
      h('span', {}, h('strong', {}, t('home.batchTitle')), ' ', t(batch.phase === 'queue' ? 'home.batchQueue' : 'home.batchReview', { n: left })),
      h('span', { class: 'banner-go' }, t('home.resume'))));
  }
  if (incomplete.length) {
    banners.append(h('button', { type: 'button', class: 'banner', onclick: () => navigate('#/todo') },
      h('span', {}, h('strong', {}, t('home.todoTitle')), ' ', t('home.todoCount', { n: incomplete.length })),
      h('span', { class: 'banner-go' }, t('home.open'))));
  }

  const search = h('input', { type: 'search', class: 'in search-in', placeholder: t('home.search'), value: ui.query, 'aria-label': t('home.search'), enterkeyhint: 'search' });
  const filters = h('div', { class: 'chips', role: 'tablist', 'aria-label': t('home.filter') });
  const shelfRow = h('div', { class: 'chips chips-sub' });
  const listHost = h('div', { class: 'list-host' });

  root.append(header, banners);
  if (items.length) root.append(h('div', { class: 'tools' }, h('label', { class: 'search' }, icon('search'), search), filters, shelfRow));
  root.append(listHost);

  if (!items.length) {
    listHost.append(h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, t('home.emptyTitle')),
      h('p', { class: 'empty-text' }, t('home.emptyText')),
      h('div', { class: 'empty-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => navigate('#/scan') }, icon('scan'), t('nav.scan')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => navigate('#/batch') }, t('home.batchStart')))));
    return;
  }

  const drawFilters = () => {
    clear(filters);
    for (const loc of ['all', 'fridge', 'freezer', 'pantry']) {
      const n = loc === 'all' ? items.length : items.filter((i) => i.location === loc).length;
      filters.append(h('button', { type: 'button', role: 'tab', class: 'chip', 'aria-selected': String(ui.loc === loc),
        onclick: () => { ui.loc = loc; ui.shelf = ''; drawFilters(); drawList(); } },
        loc === 'all' ? t('home.all') : t('loc.' + loc), h('span', { class: 'chip-n' }, String(n))));
    }
    clear(shelfRow);
    const pool = ui.loc === 'all' ? items : items.filter((i) => i.location === ui.loc);
    const shelves = [...new Set(pool.map((i) => i.shelf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    shelfRow.hidden = !shelves.length || ui.loc === 'all';
    if (!shelfRow.hidden) {
      shelfRow.append(h('span', { class: 'chips-label' }, t('form.shelf')));
      for (const s of ['', ...shelves]) {
        shelfRow.append(h('button', { type: 'button', class: 'chip chip-sm', 'aria-pressed': String(ui.shelf === s),
          onclick: () => { ui.shelf = s; drawFilters(); drawList(); } }, s || t('home.allShelves')));
      }
    }
  };

  const drawList = () => {
    clear(listHost);
    const q = ui.query.trim().toLowerCase();
    const shown = items
      .filter((i) => ui.loc === 'all' || i.location === ui.loc)
      .filter((i) => !ui.shelf || i.shelf === ui.shelf)
      .filter((i) => !q || `${i.name} ${i.brand}`.toLowerCase().includes(q))
      .sort((a, b) => sortKey(a) - sortKey(b) || (a.name || '').localeCompare(b.name || ''));
    if (!shown.length) { listHost.append(h('p', { class: 'empty-text pad' }, t('home.noMatch'))); return; }
    const groups = new Map(SECTIONS.map((s) => [s, []]));
    shown.forEach((i) => groups.get(urgency(i).level).push(i));
    for (const [sec, list] of groups) {
      if (!list.length) continue;
      listHost.append(h('section', { class: 'sec sec-' + sec },
        h('h2', { class: 'sec-title' }, t('sec.' + sec), h('span', { class: 'sec-n' }, String(list.length))),
        h('ul', { class: 'rows' }, list.map((i) => row(i, () => render(root))))));
    }
  };

  search.addEventListener('input', () => { ui.query = search.value; drawList(); });
  drawFilters();
  drawList();
}

function summaryText(c, total) {
  if (!total) return t('home.summaryEmpty');
  const parts = [];
  if (c.expired) parts.push(t('home.sumExpired', { n: c.expired }));
  if (c.today) parts.push(t('home.sumToday', { n: c.today }));
  if (c.soon) parts.push(t('home.sumSoon', { n: c.soon }));
  return parts.length ? parts.join(', ') : t('home.sumCalm');
}

// Etichetta della scadenza come un bollino da supermercato: data grande e stato a parole
// (il colore non è mai l'unico segnale).
export function whenLabel(item) {
  const u = urgency(item);
  if (u.level === 'none') return { big: '—', small: missing(item).includes('date') ? t('row.missingDate') : t('row.noDate') };
  const p = u.dl.precision;
  if (p !== 'day') {
    // Solo mese/anno: niente giorno inventato.
    const big = p === 'month' ? `${String(item.expiry.m).padStart(2, '0')}.${item.expiry.y}` : String(item.expiry.y);
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

export function row(item, onChange) {
  const u = urgency(item);
  const w = whenLabel(item);
  const meta = [];
  if (item.location) meta.push(t('loc.' + item.location) + (item.shelf ? ', ' + item.shelf : ''));
  if (item.qty > 1) meta.push('×' + item.qty);
  if (item.openedAt) meta.push(u.dl?.source === 'opened' ? t('row.openedUntil', { date: formatShort(u.dl.date, lang()) }) : t('row.opened'));
  if (item.expiryKind === 'best_before' && precision(item.expiry) !== 'none') meta.push(t('kind.best_before_short'));
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

  return h('li', { class: `row lv-${u.level}${miss.length ? ' is-incomplete' : ''}` },
    h('a', { class: 'row-main', href: '#/item/' + item.id },
      h('span', { class: 'stk' }, h('span', { class: 'stk-big' }, w.big), h('span', { class: 'stk-small' }, w.small)),
      h('span', { class: 'what' },
        h('span', { class: 'name' }, item.name || h('em', {}, t('item.unnamed'))),
        h('span', { class: 'meta' }, [item.brand, ...meta].filter(Boolean).join(', ')),
        miss.length ? h('span', { class: 'tag tag-todo' }, t('row.todo.' + miss[0])) : null)),
    eat);
}
