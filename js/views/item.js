// Scheda di una confezione: modifica, Consumato, apertura, calendario, duplicazione.
// Usata anche per l'inserimento manuale (#/add).
import { h, icon, clear, toast, confirmDialog, downloadBlob } from '../util.js';
import { t } from '../i18n.js';
import * as db from '../db.js';
import { itemForm } from '../components/forms.js';
import { newItem, save, consumeOne, remove, shelvesByLocation, missing } from '../store.js';
import { buildICS, icsFilename } from '../ics.js';
import { deadline } from '../dates.js';
import { navigate, back } from '../router.js';

export async function render(root, id) {
  const settings = await db.getSettings();
  const isNew = !id;
  let item = isNew ? newItem({ location: settings.defaultLocation }) : await db.items.get(id);
  clear(root);
  if (!item) {
    root.append(h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, t('item.notFound')),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => navigate('#/') }, t('todo.toList'))));
    return;
  }
  const shelves = await shelvesByLocation();
  const form = itemForm(item, { shelves });
  const err = h('p', { class: 'form-err', 'aria-live': 'assertive' });

  const doSave = async (andNew = false) => {
    const r = form.read();
    if (!r.ok) { err.textContent = t('date.err.fix'); form.dates.focus(); return; }
    const saved = await save(r.item);
    if (saved.expiry && r.dateSource === 'edited') await db.bumpStats({ ocrCorrected: 1 });
    await db.bumpStats({ saved: isNew ? 1 : 0 });
    const miss = missing(saved);
    toast(miss.length ? t('toast.savedTodo') : t('toast.saved'));
    if (andNew) { navigate(location.hash === '#/add' ? '#/add-again' : '#/add', { replace: true }); return; }
    back('#/');
  };

  root.append(
    h('header', { class: 'top' },
      h('div', { class: 'top-row' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.back'), onclick: () => back('#/') }, icon('back')),
        h('h1', {}, isNew ? t('item.newTitle') : t('item.title')))),
    h('div', { class: 'page' }, form.el, err));

  const actions = h('div', { class: 'page-actions' },
    h('button', { type: 'button', class: 'btn btn-primary', onclick: () => doSave(false) }, t('common.save')),
    isNew ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => doSave(true) }, t('item.saveAndNew')) : null);
  root.append(actions);

  if (!isNew) {
    const more = h('div', { class: 'page-more' },
      item.status === 'active' ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => {
        const { after, undo } = await consumeOne(item);
        toast(after.status === 'consumed' ? t('toast.consumed', { name: item.name || t('item.unnamed') }) : t('toast.consumedOne', { name: item.name, n: after.qty }),
          { action: t('common.undo'), onAction: async () => { await undo(); } });
        back('#/');
      } }, icon('check'), t('row.consume')) : null,
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => {
        const copy = newItem({ ean: item.ean, name: item.name, brand: item.brand, location: item.location, shelf: item.shelf });
        await save(copy);
        toast(t('toast.duplicated'));
        navigate('#/item/' + copy.id, { replace: true });
      } }, icon('copy'), t('item.duplicate')),
      h('button', { type: 'button', class: 'btn btn-ghost', disabled: !deadline(item), onclick: () => exportIcs([item], settings) }, icon('cal'), t('item.calendar')),
      h('button', { type: 'button', class: 'btn btn-ghost btn-danger-text', onclick: async () => {
        if (!(await confirmDialog({ title: t('item.deleteTitle'), message: t('item.deleteText'), confirm: t('item.delete'), danger: true }))) return;
        const undo = await remove(item);
        toast(t('toast.deleted'), { action: t('common.undo'), onAction: undo });
        back('#/');
      } }, icon('trash'), t('item.delete')),
      deadline(item) ? h('p', { class: 'muted small' }, t('item.calendarHint')) : null);
    root.append(more);
  }
}

export async function exportIcs(list, settings) {
  const s = settings || await db.getSettings();
  const text = buildICS(list, { daysBefore: s.icsDaysBefore, hour: s.icsHour, t });
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const name = icsFilename(list);
  // Su iPhone il foglio di condivisione permette di aprire il file con Calendario.
  try {
    const file = new File([blob], name, { type: 'text/calendar' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: name });
      toast(t('ics.done'));
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  downloadBlob(blob, name);
  toast(t('ics.done'));
}
