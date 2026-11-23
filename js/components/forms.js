// Campi riutilizzati: data in tre parti, tipo di dicitura, luogo, quantità, scheda prodotto.
import { h, icon } from '../util.js';
import { t } from '../i18n.js';
import { fieldsToExpiry, expiryToFields, sameExpiry, addDays, parseYMD, formatDate, ymd } from '../dates.js';
import { LOCATIONS } from '../store.js';

function seg(options, value, onPick, { cls = '', label } = {}) {
  const wrap = h('div', { class: 'seg ' + cls, role: 'radiogroup', 'aria-label': label });
  const btns = options.map(([v, text]) => {
    const b = h('button', { type: 'button', role: 'radio', class: 'seg-btn', 'aria-checked': String(v === value), dataset: { v: v ?? '' } }, text);
    b.addEventListener('click', () => { set(v); onPick?.(v); });
    return b;
  });
  wrap.append(...btns);
  function set(v) { value = v; btns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === String(v ?? '')))); }
  return { el: wrap, get: () => value, set };
}

export function locationPicker(value, onPick, { allowNone = false } = {}) {
  const opts = LOCATIONS.map((l) => [l, t('loc.' + l)]);
  if (allowNone) opts.unshift([null, t('loc.none')]);
  return seg(opts, value, onPick, { cls: 'seg-loc', label: t('form.location') });
}

export function kindPicker(value, onPick) {
  return seg([['use_by', t('kind.use_by_short')], ['best_before', t('kind.best_before_short')], ['unknown', t('kind.unknown_short')]], value, onPick, { cls: 'seg-kind', label: t('form.kind') });
}

export function qtyStepper(value, onChange) {
  const out = h('output', { class: 'qty-val', 'aria-live': 'polite' }, String(value));
  const set = (v) => { value = Math.max(1, Math.min(99, v)); out.textContent = String(value); onChange?.(value); };
  const el = h('div', { class: 'qty', role: 'group', 'aria-label': t('form.qty') },
    h('button', { type: 'button', class: 'qty-btn', 'aria-label': t('form.qtyLess'), onclick: () => set(value - 1) }, icon('minus')),
    out,
    h('button', { type: 'button', class: 'qty-btn', 'aria-label': t('form.qtyMore'), onclick: () => set(value + 1) }, icon('plus')));
  return { el, get: () => value, set };
}

// Data in tre campi: il giorno (e il mese) si possono lasciare vuoti, l'anno è obbligatorio.
export function dateFields({ expiry = null, kind = 'unknown', noDate = false, source = null, yearInferred = false } = {}, { onChange } = {}) {
  const [d0, m0, y0] = expiryToFields(expiry);
  const mk = (cls, ph, max, aria, val) => h('input', {
    class: 'dp-in ' + cls, inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', enterkeyhint: 'next',
    maxlength: String(max), placeholder: ph, 'aria-label': aria, value: val,
  });
  const dIn = mk('dp-d', t('date.dd'), 2, t('date.day'), d0);
  const mIn = mk('dp-m', t('date.mm'), 2, t('date.month'), m0);
  const yIn = mk('dp-y', t('date.yyyy'), 4, t('date.year'), y0);
  const note = h('p', { class: 'dnote', 'aria-live': 'polite' });
  const original = expiry;
  let state = { noDate, source };

  const kindSeg = kindPicker(kind, () => onChange?.());
  const noDateBtn = h('button', { type: 'button', class: 'chip chip-toggle', 'aria-pressed': String(noDate) }, t('date.noDate'));

  const fields = h('div', { class: 'dparts' },
    h('label', { class: 'dp' }, h('span', { class: 'dp-lab' }, t('date.day')), dIn),
    h('span', { class: 'dp-sep', 'aria-hidden': 'true' }, '/'),
    h('label', { class: 'dp' }, h('span', { class: 'dp-lab' }, t('date.month')), mIn),
    h('span', { class: 'dp-sep', 'aria-hidden': 'true' }, '/'),
    h('label', { class: 'dp dp-wide' }, h('span', { class: 'dp-lab' }, t('date.year')), yIn));

  const el = h('fieldset', { class: 'datef' + (source === 'ocr' ? ' from-ocr' : '') },
    h('legend', { class: 'flabel' }, t('form.expiry')),
    fields, note, kindSeg.el, h('div', { class: 'row-end' }, noDateBtn));

  // Avanzamento automatico tra i campi e incolla di una data intera.
  const order = [dIn, mIn, yIn];
  order.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      const v = inp.value;
      if (/[^\d]/.test(v) || v.length > (i === 2 ? 4 : 2)) {
        const parts = v.split(/[^\d]+/).filter(Boolean);
        if (i === 0 && parts.length >= 2) {
          if (parts.length === 3) { dIn.value = parts[0].slice(0, 2); mIn.value = parts[1].slice(0, 2); yIn.value = parts[2].slice(0, 4); }
          else { dIn.value = ''; mIn.value = parts[0].slice(0, 2); yIn.value = parts[1].slice(0, 4); }
        } else inp.value = v.replace(/\D/g, '').slice(0, i === 2 ? 4 : 2);
      }
      if (i < 2 && inp.value.length === 2) order[i + 1].focus();
      if (state.noDate) setNoDate(false);
      if (state.source === 'ocr') state.source = 'edited';
      refresh();
      onChange?.();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) order[i - 1].focus();
    });
    inp.addEventListener('focus', () => inp.select());
  });

  function setNoDate(v) {
    state.noDate = v;
    noDateBtn.setAttribute('aria-pressed', String(v));
    el.classList.toggle('is-nodate', v);
    if (v) { order.forEach((i) => { i.value = ''; }); }
    refresh();
  }
  noDateBtn.addEventListener('click', () => { setNoDate(!state.noDate); onChange?.(); });

  function read() {
    if (state.noDate) return { value: null, noDate: true, kind: kindSeg.get() };
    const r = fieldsToExpiry(dIn.value, mIn.value, yIn.value);
    return { ...r, noDate: false, kind: kindSeg.get() };
  }

  function refresh() {
    const r = read();
    note.className = 'dnote';
    el.classList.remove('has-error');
    if (state.noDate) { note.textContent = t('date.noteNoDate'); return; }
    if (r.error) {
      // Mostra l'errore solo se l'utente ha iniziato a scrivere l'anno o ha finito.
      if (yIn.value.length >= 2 || r.error === 'invalid') { note.textContent = t('date.err.' + r.error); note.classList.add('is-error'); el.classList.add('has-error'); }
      else note.textContent = t('date.hint');
      return;
    }
    if (!r.value) { note.textContent = t('date.hint'); return; }
    const parts = [];
    if (state.source === 'ocr') parts.push(yearInferred ? t('date.yearInferred', { y: r.value.y }) : t('date.fromOcr'));
    if (state.source === 'edited' && original && !sameExpiry(original, r.value)) parts.push(t('date.corrected'));
    if (r.value.d == null) parts.push(r.value.m == null ? t('date.yearOnly') : t('date.monthOnly'));
    if (r.warn?.includes('past')) { parts.push(t('date.warnPast')); note.classList.add('is-warn'); }
    if (r.warn?.includes('far')) { parts.push(t('date.warnFar')); note.classList.add('is-warn'); }
    note.textContent = parts.join('. ') || t('date.hint');
  }
  refresh();

  return {
    el, read,
    get source() { return state.source; },
    set(exp, k, source = null) {
      const [d, m, y] = expiryToFields(exp);
      dIn.value = d; mIn.value = m; yIn.value = y;
      if (k) kindSeg.set(k);
      state.source = source;
      el.classList.toggle('from-ocr', source === 'ocr');
      setNoDate(false);
      refresh();
    },
    focus() { (dIn.value ? yIn : dIn).focus(); },
    setNoDate,
  };
}

// Scheda completa di una confezione. compact = versione nello scanner (meno campi).
export function itemForm(item, { compact = false, shelves = {}, source = null, yearInferred = false } = {}) {
  const name = h('input', { class: 'in', type: 'text', value: item.name || '', placeholder: t('form.namePh'), autocomplete: 'off', enterkeyhint: 'done', 'aria-label': t('form.name') });
  const brand = h('input', { class: 'in in-sm', type: 'text', value: item.brand || '', placeholder: t('form.brandPh'), autocomplete: 'off', 'aria-label': t('form.brand') });
  const dates = dateFields({ expiry: item.expiry, kind: item.expiryKind, noDate: item.noDate, source, yearInferred });
  let location = item.location;
  const shelfList = h('datalist', { id: 'shelves-' + item.id });
  const shelf = h('input', { class: 'in in-sm', type: 'text', value: item.shelf || '', placeholder: t('form.shelfPh'), list: shelfList.id, 'aria-label': t('form.shelf'), autocomplete: 'off' });
  const fillShelves = () => { shelfList.replaceChildren(...(shelves[location] || []).map((s) => h('option', { value: s }))); };
  fillShelves();
  const loc = locationPicker(location, (v) => { location = v; fillShelves(); });
  const qty = qtyStepper(item.qty || 1);

  // Apertura
  let opened = !!item.openedAt;
  const openedDate = h('input', { class: 'in in-sm', type: 'date', value: item.openedAt || ymd(new Date()), 'aria-label': t('form.openedOn') });
  const openDays = h('input', { class: 'in in-xs', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '3', value: item.openDays ? String(item.openDays) : '', placeholder: '3', 'aria-label': t('form.openDays') });
  const openInfo = h('p', { class: 'dnote' });
  const openBox = h('div', { class: 'openbox' },
    h('label', { class: 'inline' }, h('span', {}, t('form.openedOn')), openedDate),
    h('label', { class: 'inline' }, h('span', {}, t('form.openDaysLabel')), openDays, h('span', {}, t('form.days'))),
    openInfo);
  const openToggle = h('button', { type: 'button', class: 'chip chip-toggle', 'aria-pressed': String(opened) }, t('form.opened'));
  const updOpen = () => {
    openToggle.setAttribute('aria-pressed', String(opened));
    openBox.hidden = !opened;
    const days = parseInt(openDays.value, 10);
    const od = parseYMD(openedDate.value);
    openInfo.textContent = opened && days > 0 && od ? t('form.openUntil', { date: formatDate(addDays(od, days)) }) : t('form.openHint');
  };
  openToggle.addEventListener('click', () => { opened = !opened; updOpen(); });
  openDays.addEventListener('input', () => { openDays.value = openDays.value.replace(/\D/g, '').slice(0, 3); updOpen(); });
  openedDate.addEventListener('change', updOpen);
  updOpen();

  const el = h('div', { class: 'form' + (compact ? ' form-compact' : '') },
    h('label', { class: 'field' }, h('span', { class: 'flabel' }, t('form.name')), name),
    compact ? null : h('label', { class: 'field' }, h('span', { class: 'flabel' }, t('form.brand')), brand),
    dates.el,
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, t('form.location')), loc.el),
    h('div', { class: 'field field-row' },
      h('label', { class: 'grow' }, h('span', { class: 'flabel' }, t('form.shelf')), shelf, shelfList),
      h('div', {}, h('span', { class: 'flabel' }, t('form.qty')), qty.el)),
    compact ? null : h('div', { class: 'field' }, h('div', { class: 'row-start' }, openToggle), openBox),
    item.ean ? h('p', { class: 'muted small' }, t('form.ean', { ean: item.ean })) : null);

  function read() {
    const d = dates.read();
    if (d.error) return { ok: false, error: 'date' };
    let openedAt = null, openD = null;
    if (!compact && opened) {
      openedAt = openedDate.value || ymd(new Date());
      const n = parseInt(openDays.value, 10);
      openD = n > 0 ? Math.min(n, 365) : null;
    } else if (compact) { openedAt = item.openedAt; openD = item.openDays; }
    return {
      ok: true,
      item: {
        ...item,
        name: name.value.trim(), brand: compact ? item.brand : brand.value.trim(),
        expiry: d.value, expiryKind: d.kind, noDate: d.noDate,
        location, shelf: shelf.value.trim(), qty: qty.get(),
        openedAt, openDays: openD,
      },
      dateSource: dates.source,
    };
  }
  return { el, read, dates, name, setLocation: (v) => { location = v; loc.set(v); fillShelves(); } };
}
