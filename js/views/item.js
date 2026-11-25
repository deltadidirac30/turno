// Scheda di una confezione (#/item/ID) con le azioni rapide, modifica (#/edit/ID) e nuovo inserimento (#/add).
import { h, icon, clear, toast, confirmDialog, downloadBlob, sheet } from '../util.js';
import { t, lang } from '../i18n.js';
import * as db from '../db.js';
import { itemForm, locationPicker } from '../components/forms.js';
import { newItem, save, consumeOne, remove, shelvesByLocation, missing, waste } from '../store.js';
import { buildICS, icsFilename } from '../ics.js';
import { deadline, urgency, formatExpiry, formatDate, parseYMD, ymd } from '../dates.js';
import { navigate, back } from '../router.js';
import { sticker, placeText } from './home.js';

// #/item/ID → scheda; #/edit/ID e #/add → modulo
export async function render(root, id, route) {
  if (route === 'item' && id) return renderDetail(root, id);
  return renderForm(root, id);
}

async function renderDetail(root, id) {
  const item = await db.items.get(id);
  clear(root);
  if (!item) return notFound(root);
  const settings = await db.getSettings();
  const u = urgency(item);
  const L = lang();

  root.append(h('div', { class: 'top-row' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.back'), onclick: () => back('#/') }, icon('back')),
    h('span', { style: 'flex:1' }),
    h('button', { type: 'button', class: 'link-btn', onclick: () => navigate('#/edit/' + item.id) }, icon('pencil'), t('item.edit'))));

  root.append(h('div', { class: 'detail-hero lv-' + u.level }, sticker(item),
    h('div', { style: 'min-width:0' },
      h('h1', { class: 'detail-name' }, item.name || t('item.unnamed')),
      item.brand ? h('p', { class: 'detail-brand' }, item.brand) : null)));
  root.append(h('p', { class: 'detail-status lv-' + u.level }, statusText(item, u)));

  // Dati principali
  const facts = [];
  if (item.expiry) facts.push([item.expiryKind !== 'unknown' ? t('kind.' + item.expiryKind) : t('item.f.expiry'), formatExpiry(item.expiry)]);
  else facts.push([t('item.f.expiry'), item.noDate ? t('row.noDate') : t('row.missingDate')]);
  facts.push([t('item.f.place'), placeText(item) || t('places.nowhere')]);
  if (item.qty > 1) facts.push([t('item.f.qty'), String(item.qty)]);
  if (item.openedAt) {
    const od = parseYMD(item.openedAt);
    if (od) facts.push([t('item.f.opened'), formatDate(od, L)]);
    const dl = deadline(item);
    if (item.openDays && dl && dl.source === 'opened') facts.push([t('item.f.openUntil'), formatDate(dl.date, L)]);
  }
  facts.push([t('item.f.added'), formatDate(new Date(item.createdAt), L)]);
  root.append(h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'fact' }, h('dt', {}, k), h('dd', {}, v)))));

  if (item.status !== 'active') {
    root.append(h('div', { class: 'actions-grid' },
      h('button', { type: 'button', class: 'act', onclick: async () => { await save({ ...item, status: 'active', consumedAt: null, wastedAt: null }); toast(t('item.restored')); renderDetail(root, id); } },
        icon('back'), t('item.restore'), h('span', { class: 'act-sub' }, t(item.status === 'wasted' ? 'item.wasWasted' : 'item.wasConsumed')))));
  } else {
    const name = item.name || t('item.unnamed');
    root.append(h('div', { class: 'actions-grid' },
      h('button', { type: 'button', class: 'act act-main', onclick: async () => {
        const { after, undo } = await consumeOne(item);
        toast(after.status === 'consumed' ? t('toast.consumed', { name }) : t('toast.consumedOne', { name, n: after.qty }), { action: t('common.undo'), onAction: undo });
        if (after.status === 'consumed') back('#/'); else renderDetail(root, id);
      } }, icon('check'), t('row.consume'), h('span', { class: 'act-sub' }, item.qty > 1 ? t('item.act.consumeOne', { n: item.qty - 1 }) : t('item.act.consumeAll'))),
      h('button', { type: 'button', class: 'act', onclick: () => openSheet(item, () => renderDetail(root, id)) },
        icon('open'), t('item.act.opened'), h('span', { class: 'act-sub' }, item.openedAt ? t('item.act.openedChange') : t('item.act.openedSub'))),
      h('button', { type: 'button', class: 'act', onclick: () => moveSheet(item, () => renderDetail(root, id)) },
        icon('move'), t('item.act.move'), h('span', { class: 'act-sub' }, placeText(item) || t('places.nowhere'))),
      h('button', { type: 'button', class: 'act act-waste', onclick: async () => {
        const undo = await waste(item);
        toast(t('toast.wasted', { name }), { action: t('common.undo'), onAction: undo });
        back('#/');
      } }, icon('bin'), t('item.act.waste'), h('span', { class: 'act-sub' }, t('item.act.wasteSub')))));
  }

  root.append(h('div', { class: 'more-list' },
    h('button', { type: 'button', class: 'btn', onclick: async () => {
      const copy = newItem({ ean: item.ean, name: item.name, brand: item.brand, location: item.location, shelf: item.shelf });
      await save(copy);
      toast(t('toast.duplicated'));
      navigate('#/edit/' + copy.id, { replace: true });
    } }, icon('copy'), t('item.duplicate')),
    deadline(item) ? h('button', { type: 'button', class: 'btn', onclick: () => exportIcs([item], settings) }, icon('cal'), t('item.calendar')) : null,
    h('button', { type: 'button', class: 'btn btn-danger-text', onclick: async () => {
      if (!(await confirmDialog({ title: t('item.deleteTitle'), message: t('item.deleteText'), confirm: t('item.delete'), danger: true }))) return;
      const undo = await remove(item);
      toast(t('toast.deleted'), { action: t('common.undo'), onAction: undo });
      back('#/');
    } }, icon('trash'), t('item.delete'))),
    deadline(item) ? h('p', { class: 'muted small', style: 'margin-top:6px' }, t('item.calendarHint')) : null);
}

function statusText(item, u) {
  if (item.status === 'consumed') return t('item.st.consumed');
  if (item.status === 'wasted') return t('item.st.wasted');
  if (u.level === 'none') return missing(item).includes('date') ? t('item.st.missing') : t('item.st.noDate');
  const opened = u.dl.source === 'opened';
  if (u.dl.precision !== 'day') return t(u.level === 'expired' ? 'item.st.monthPast' : 'item.st.month', { m: formatExpiry(item.expiry) });
  if (u.level === 'expired') return t(opened ? 'item.st.openExpired' : 'item.st.expired', { n: -u.days });
  if (u.level === 'today') return t(opened ? 'item.st.openToday' : 'item.st.today');
  if (u.days === 1) return t(opened ? 'item.st.openTomorrow' : 'item.st.tomorrow');
  return t(opened ? 'item.st.openIn' : 'item.st.in', { n: u.days });
}

// Aperto: quanti giorni dopo l'apertura (scritti sulla confezione).
function openSheet(item, done) {
  return sheet((close, panel) => {
    let days = item.openDays || null;
    const custom = h('input', { class: 'in in-xs', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '3', value: days && ![1, 2, 3, 4, 5, 7, 10, 14].includes(days) ? String(days) : '', placeholder: '…', 'aria-label': t('form.openDays') });
    const chips = [1, 2, 3, 4, 5, 7, 10, 14].map((n) => {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(days === n) }, t('item.days', { n }));
      b.addEventListener('click', () => { days = n; custom.value = ''; chips.forEach((c) => c.setAttribute('aria-pressed', String(c === b))); });
      return b;
    });
    custom.addEventListener('input', () => { custom.value = custom.value.replace(/\D/g, ''); days = parseInt(custom.value, 10) || null; chips.forEach((c) => c.setAttribute('aria-pressed', 'false')); });
    panel.append(
      h('h2', { class: 'sheet-title' }, t('item.openTitle')),
      h('p', { class: 'sheet-text' }, t('item.openText')),
      h('div', { class: 'days-row' }, chips, h('label', { class: 'inline' }, custom, h('span', { class: 'muted' }, t('form.days')))),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
          await save({ ...item, openedAt: item.openedAt || ymd(new Date()), openDays: days });
          toast(t('toast.opened'));
          close(true); done();
        } }, t('item.openSave')),
        item.openedAt ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => { await save({ ...item, openedAt: null, openDays: null }); close(true); done(); } }, t('item.openUndo')) : null,
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(false) }, t('common.cancel'))));
  });
}

// Sposta: luogo e ripiano in un tocco (es. dal frigo al freezer).
async function moveSheet(item, done) {
  const shelves = await shelvesByLocation();
  return sheet((close, panel) => {
    let loc = item.location;
    const list = h('datalist', { id: 'mv-shelves' });
    const fill = () => list.replaceChildren(...(shelves[loc] || []).map((s) => h('option', { value: s })));
    const shelf = h('input', { class: 'in', type: 'text', value: item.shelf || '', placeholder: t('form.shelfPh'), list: 'mv-shelves', 'aria-label': t('form.shelf') });
    const picker = locationPicker(loc, (v) => { loc = v; shelf.value = ''; fill(); });
    fill();
    panel.append(
      h('h2', { class: 'sheet-title' }, t('item.moveTitle')),
      picker.el,
      h('label', { class: 'field' }, h('span', { class: 'flabel' }, t('form.shelf')), shelf, list),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
          await save({ ...item, location: loc, shelf: shelf.value.trim() });
          toast(t('toast.moved', { place: (loc ? t('loc.' + loc) : t('places.nowhere')).toLowerCase() }));
          close(true); done();
        } }, t('common.save')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(false) }, t('common.cancel'))));
  });
}

function notFound(root) {
  root.append(h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, t('item.notFound')),
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => navigate('#/') }, t('todo.toList'))));
}

async function renderForm(root, id) {
  const settings = await db.getSettings();
  const isNew = !id;
  const item = isNew ? newItem({ location: settings.defaultLocation }) : await db.items.get(id);
  clear(root);
  if (!item) return notFound(root);
  const shelves = await shelvesByLocation();
  const form = itemForm(item, { shelves });
  const err = h('p', { class: 'form-err', 'aria-live': 'assertive' });

  const doSave = async (andNew = false) => {
    const r = form.read();
    if (!r.ok) { err.textContent = t('date.err.fix'); form.dates.focus(); return; }
    const saved = await save(r.item);
    if (saved.expiry && r.dateSource === 'edited') await db.bumpStats({ ocrCorrected: 1 });
    await db.bumpStats({ saved: isNew ? 1 : 0 });
    toast(missing(saved).length ? t('toast.savedTodo') : t('toast.saved'));
    if (andNew) { navigate(location.hash === '#/add' ? '#/add-again' : '#/add', { replace: true }); return; }
    if (isNew) back('#/'); else navigate('#/item/' + saved.id, { replace: true });
  };

  root.append(
    h('div', { class: 'top-row' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.back'), onclick: () => back('#/') }, icon('back')),
      h('h1', { style: 'font-size:24px;font-weight:800;font-stretch:108%;margin:0;flex:1' }, isNew ? t('item.newTitle') : t('item.editTitle'))),
    h('div', { class: 'page' }, form.el, err),
    h('div', { class: 'page-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => doSave(false) }, t('common.save')),
      isNew ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => doSave(true) }, t('item.saveAndNew')) : null));
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
