// «Dispensa»: frigo, freezer e dispensa ripiano per ripiano, per vedere a colpo d'occhio cosa c'è e dove.
import { h, icon, clear } from '../util.js';
import { t } from '../i18n.js';
import * as db from '../db.js';
import { urgency, sortKey } from '../dates.js';
import { LOCATIONS } from '../store.js';
import { navigate } from '../router.js';
import { brandRow, emptyArt, whenLabel, PLACE_ICON } from './home.js';

export async function render(root) {
  const items = await db.items.active();
  clear(root);
  root.append(h('header', { class: 'top top-home' },
    brandRow(h('button', { type: 'button', class: 'link-btn', style: 'margin-left:auto', onclick: () => navigate('#/add') }, icon('plus'), t('home.addManual'))),
    h('h1', {}, t('places.title')),
    h('p', { class: 'summary' }, items.length ? t('places.summary', { n: items.length }) : t('home.summaryEmpty'))));

  if (!items.length) {
    root.append(h('div', { class: 'empty' }, emptyArt(), h('p', { class: 'empty-text' }, t('home.emptyText')),
      h('div', { class: 'empty-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => navigate('#/scan') }, icon('scan'), t('home.scanOne')))));
    return;
  }

  const groups = [...LOCATIONS.map((l) => [l, items.filter((i) => i.location === l)]), ['none', items.filter((i) => !i.location)]];
  for (const [loc, list] of groups) {
    if (loc === 'none' && !list.length) continue;
    const urgent = list.filter((i) => ['expired', 'today', 'soon'].includes(urgency(i).level)).length;
    const card = h('section', { class: 'place' },
      h('div', { class: 'place-head' },
        h('span', { class: 'place-ic' }, icon(PLACE_ICON[loc] || 'home')),
        h('div', { class: 'place-sub' }, h('h2', { class: 'place-title' }, t(loc === 'none' ? 'places.nowhere' : 'loc.' + loc)), h('span', { class: 'place-count' }, t('places.count', { n: list.length }))),
        urgent ? h('span', { class: 'place-alert' }, t('places.urgent', { n: urgent })) : null));
    if (!list.length) card.append(h('p', { class: 'place-empty' }, t('places.empty')));
    // ripiani in ordine alfabetico, «senza ripiano» per ultimo
    const shelves = new Map();
    for (const i of list.sort((a, b) => sortKey(a) - sortKey(b))) {
      const key = i.shelf || '';
      if (!shelves.has(key)) shelves.set(key, []);
      shelves.get(key).push(i);
    }
    const keys = [...shelves.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const k of keys) {
      card.append(h('div', { class: 'shelf' },
        h('p', { class: 'shelf-name' }, k || (keys.length > 1 ? t('places.noShelf') : t('places.all'))),
        h('div', { class: 'shelf-items' }, shelves.get(k).map((i) => {
          const u = urgency(i);
          const w = whenLabel(i);
          return h('a', { class: 'pill lv-' + u.level, href: '#/item/' + i.id },
            h('span', { class: 'pill-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'pill-name' }, i.name || t('item.unnamed')),
            h('span', { class: 'pill-date' }, w.big === '—' ? t('places.noDate') : w.big));
        }))));
    }
    root.append(card);
  }
}
