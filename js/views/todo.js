// «Da completare»: confezioni senza data (saltata) o senza nome.
import { h, icon, clear } from '../util.js';
import { t } from '../i18n.js';
import * as db from '../db.js';
import { isIncomplete, missing } from '../store.js';
import { navigate, back } from '../router.js';

export async function render(root) {
  const list = (await db.items.active()).filter(isIncomplete).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  clear(root);
  root.append(h('header', { class: 'top' },
    h('div', { class: 'top-row' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.back'), onclick: () => back('#/') }, icon('back')),
      h('h1', {}, t('todo.title'))),
    h('p', { class: 'summary' }, list.length ? t('todo.summary', { n: list.length }) : t('todo.none'))));
  if (!list.length) {
    root.append(h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, t('todo.emptyText')),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => navigate('#/') }, t('todo.toList'))));
    return;
  }
  root.append(h('ul', { class: 'rows rows-todo' }, list.map((i) => {
    const miss = missing(i);
    return h('li', { class: 'row is-incomplete' },
      h('a', { class: 'row-main', href: '#/item/' + i.id },
        h('span', { class: 'what' },
          h('span', { class: 'name' }, i.name || h('em', {}, t('item.unnamed'))),
          h('span', { class: 'meta' }, [i.brand, i.location ? t('loc.' + i.location) : '', i.ean ? i.ean : ''].filter(Boolean).join(', ')),
          h('span', { class: 'tag tag-todo' }, miss.map((m) => t('row.todo.' + m)).join(', ')))),
      miss.includes('date')
        ? h('button', { type: 'button', class: 'eat eat-alt', onclick: () => navigate('#/scan/' + i.id) }, icon('photo'), h('span', {}, t('todo.readDate')))
        : null);
  })));
}
