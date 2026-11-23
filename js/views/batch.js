// Registra tutta la spesa: foto del tavolo → elenco confezioni → date una alla volta.
// Lo stato è salvato a ogni passo: uscire non fa perdere nulla.
import { h, icon, clear, toast, vibrate, uid, sheet, confirmDialog } from '../util.js';
import { t } from '../i18n.js';
import * as db from '../db.js';
import * as resources from '../resources.js';
import * as barcode from '../barcode.js';
import * as ocr from '../ocr.js';
import * as camera from '../camera.js';
import { lookup, normalizeEan, isValidEan, remember } from '../products.js';
import { newItem, save, shelvesByLocation, LOCATIONS } from '../store.js';
import { sameExpiry } from '../dates.js';
import { needsChoice } from '../ocr-parse.js';
import { createScanner, liveBarcode, resourceStatus, readDate, readDateFromFile, dateTools, noDateMessage, chooseDate, confirmItem } from '../components/scanner.js';
import { locationPicker } from '../components/forms.js';
import { navigate } from '../router.js';

let photo = null; // {url, w, h} solo in memoria, mai salvata

export async function render(root) {
  const settings = await db.getSettings();
  let state = await db.kv.get('batch', null);
  let alive = true;
  let cleanupPhase = null;
  const persist = () => db.kv.set('batch', state);

  const go = async (phase) => {
    if (cleanupPhase) { await cleanupPhase(); cleanupPhase = null; }
    if (!alive) return;
    clear(root);
    if (phase === 'capture') cleanupPhase = await capture();
    else if (phase === 'review') cleanupPhase = review();
    else if (phase === 'queue') cleanupPhase = await queue();
    else if (phase === 'done') cleanupPhase = done();
  };

  function ensureState() {
    if (!state) state = { id: uid(), phase: 'review', startedAt: Date.now(), entries: [], index: 0, location: settings.defaultLocation };
    return state;
  }

  function addEntry(ean, extra = {}) {
    ensureState();
    const e = { key: uid(), ean: ean || null, name: '', brand: '', location: state.location || settings.defaultLocation, itemId: null, done: false, skipped: false, selected: true, ...extra };
    state.entries.push(e);
    if (ean) {
      lookup(ean).then((r) => {
        if (r.product) { e.name = e.name || r.product.name; e.brand = e.brand || r.product.brand || ''; }
        e.lookup = r.status;
        persist();
        refreshRow?.(e);
      });
    }
    return e;
  }
  let refreshRow = null;
  const fills = new Map(); // key → funzione di ridisegno (fuori dallo stato salvato)

  // ---------- 1. Foto del tavolo ----------
  async function capture() {
    const sc = createScanner({ hires: true, onClose: async () => { if (state?.entries.length) await go('review'); else navigate('#/', { replace: true }); } });
    root.append(sc.el);
    sc.setMode('photo');
    sc.setTitle(h('div', { class: 'steps' }, h('span', { class: 'step is-on' }, t('batch.titlePhoto'))));
    const cam = await sc.startCamera();
    const resNode = resourceStatus('barcode');
    sc.setResources(resNode);
    sc.setMessage(t(cam.ok ? 'batch.photoHint' : 'batch.photoNoCam'), cam.ok ? '' : 'is-warn');
    if (navigator.onLine) resources.ensure('barcode');

    const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try {
        const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(f));
        await analyse(bmp, bmp.width, bmp.height);
        bmp.close?.();
      } catch { sc.setMessage(t('batch.photoError'), 'is-warn'); }
    });
    const shutter = h('button', { type: 'button', class: 'shutter', 'aria-label': t('batch.shoot'), disabled: !cam.ok, onclick: async () => {
      const c = camera.grabFull(sc.video);
      await analyse(c, c.width, c.height);
    } }, h('span'));

    sc.setActions(
      h('button', { type: 'button', class: 'pill', onclick: () => fileIn.click() }, icon('photo'), t('batch.fromFile')),
      shutter,
      h('button', { type: 'button', class: 'pill', onclick: () => { ensureState(); persist(); go('review'); } }, t('batch.skipPhoto'), icon('skip')),
      fileIn);

    async function analyse(src, w, hgt) {
      shutter.disabled = true;
      const ok = await resources.ensure('barcode');
      if (!ok) { sc.setMessage(t('res.barcode.offline'), 'is-warn'); shutter.disabled = !cam.ok; return; }
      sc.setMessage(t('batch.analysing', { pct: 0 }), 'is-busy');
      let found = [];
      try {
        found = await barcode.readMany(src, { onProgress: (p) => sc.setMessage(t('batch.analysing', { pct: Math.round(p * 100) }), 'is-busy') });
      } catch (e) { console.warn(e); }
      if (!alive) return;
      shutter.disabled = !cam.ok;
      if (!found.length) { sc.setMessage(t('batch.noneFound'), 'is-warn'); return; }
      vibrate(40);
      // Miniatura per mostrare dove sono i codici letti; la foto originale viene scartata.
      const k = Math.min(1, 1200 / Math.max(w, hgt));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(hgt * k);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.7));
      c.width = c.height = 0;
      if (photo) URL.revokeObjectURL(photo.url);
      const photoId = uid();
      photo = { url: URL.createObjectURL(blob), id: photoId };
      ensureState();
      found.forEach((f) => addEntry(f.ean, { photoId, px: (f.x / w) * 100, py: (f.y / hgt) * 100 }));
      state.phase = 'review';
      await persist();
      go('review');
    }
    return async () => { resNode.dispose?.(); sc.destroy(); };
  }

  // ---------- 2. Elenco da controllare ----------
  function review() {
    ensureState();
    const list = h('ul', { class: 'rows rows-batch' });
    const countEl = h('p', { class: 'summary' });
    const photoWrap = h('div', { class: 'photo-wrap' });
    const selInfo = h('span', { class: 'sel-info' });
    const startBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: startQueue });

    const numberOf = (e) => state.entries.indexOf(e) + 1;
    const dupCount = (ean) => state.entries.filter((x) => x.ean && x.ean === ean).length;

    function rowFor(e) {
      const li = h('li', { class: 'row brow' + (e.selected ? ' is-sel' : ''), dataset: { key: e.key } });
      const fill = () => {
        clear(li);
        li.className = 'row brow' + (e.selected ? ' is-sel' : '');
        const nameIn = h('input', { class: 'in in-row', type: 'text', value: e.name, placeholder: e.ean ? (e.lookup === 'offline' ? t('batch.namePhOffline') : e.lookup ? t('batch.namePhNew') : t('batch.namePhWait')) : t('batch.namePh'), 'aria-label': t('form.name') });
        nameIn.addEventListener('change', () => { e.name = nameIn.value.trim(); persist(); });
        const sel = h('button', { type: 'button', class: 'sel', role: 'checkbox', 'aria-checked': String(!!e.selected), 'aria-label': t('batch.select', { n: numberOf(e) }),
          onclick: () => { e.selected = !e.selected; persist(); fill(); updateFooter(); } }, h('span', { class: 'sel-n' }, String(numberOf(e))));
        const dups = e.ean ? dupCount(e.ean) : 0;
        li.append(sel,
          h('div', { class: 'what' }, nameIn,
            h('span', { class: 'meta' }, [t('loc.' + e.location), e.ean || t('batch.noCode'), dups > 1 ? t('batch.sameCode', { n: dups }) : ''].filter(Boolean).join(', '))),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('batch.more'), onclick: () => more(e) }, icon('dots')));
      };
      fill();
      fills.set(e.key, fill);
      return li;
    }

    async function more(e) {
      const act = await sheet((close, panel) => {
        panel.append(h('h2', { class: 'sheet-title' }, e.name || e.ean || t('batch.noCode')),
          h('div', { class: 'sheet-actions' },
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close('dup') }, icon('copy'), t('batch.addSame')),
            h('button', { type: 'button', class: 'btn btn-ghost btn-danger-text', onclick: () => close('del') }, icon('trash'), t('batch.remove')),
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, t('common.cancel'))));
      });
      if (act === 'dup') { const i = state.entries.indexOf(e); const c = { ...e, key: uid(), itemId: null, px: null, py: null }; state.entries.splice(i + 1, 0, c); }
      if (act === 'del') state.entries = state.entries.filter((x) => x !== e);
      if (act) { await persist(); drawAll(); }
    }

    function drawPhoto() {
      clear(photoWrap);
      const marks = state.entries.filter((e) => photo && e.photoId === photo.id && e.px != null);
      photoWrap.hidden = !marks.length;
      if (!marks.length) return;
      photoWrap.append(h('img', { src: photo.url, alt: t('batch.photoAlt') }),
        ...marks.map((e) => h('span', { class: 'mark' + (e.selected ? ' is-sel' : ''), style: `left:${e.px}%;top:${e.py}%` }, String(numberOf(e)))));
    }

    function drawAll() {
      clear(list);
      state.entries.forEach((e) => list.append(rowFor(e)));
      countEl.textContent = state.entries.length ? t('batch.count', { n: state.entries.length }) : t('batch.countNone');
      drawPhoto();
      updateFooter();
    }
    refreshRow = (e) => { const f = fills.get(e.key); if (f && alive) f(); };

    function updateFooter() {
      const n = state.entries.filter((e) => e.selected).length;
      selInfo.textContent = t('batch.selected', { n });
      locSeg.el.classList.toggle('is-disabled', !n);
      startBtn.textContent = t('batch.start', { n: state.entries.length });
      startBtn.disabled = !state.entries.length;
      allBtn.textContent = n === state.entries.length ? t('batch.none') : t('batch.all');
    }

    // Assegna il luogo a tutti i selezionati con un tap, poi svuota la selezione.
    const locSeg = locationPicker(null, async (loc) => {
      const sel = state.entries.filter((e) => e.selected);
      if (!sel.length) return;
      sel.forEach((e) => { e.location = loc; e.selected = false; });
      state.location = loc;
      await persist();
      toast(t('batch.assigned', { n: sel.length, loc: t('loc.' + loc) }));
      locSeg.set(null);
      drawAll();
    });
    const allBtn = h('button', { type: 'button', class: 'chip chip-sm', onclick: () => {
      const all = state.entries.every((e) => e.selected);
      state.entries.forEach((e) => { e.selected = !all; });
      persist(); drawAll();
    } });

    async function scanMissing() {
      const host = h('div', { class: 'fs-host' });
      root.append(host);
      const sc = createScanner({ onClose: () => finish() });
      host.append(sc.el);
      let added = 0, last = null, lastAt = 0, stop = null;
      sc.setMode('barcode');
      sc.setTitle(h('div', { class: 'steps' }, h('span', { class: 'step is-on' }, t('batch.missingTitle'))));
      sc.setMessage(t('batch.missingHint'));
      sc.setActions(h('button', { type: 'button', class: 'pill pill-primary', onclick: () => finish() }, t('common.done')));
      const cam = await sc.startCamera();
      if (!cam.ok) sc.setMessage(t('scan.noCameraHint'), 'is-warn');
      const ok = cam.ok && await resources.ensure('barcode');
      const loop = () => {
        stop = liveBarcode(sc, (code) => {
          if (code === last && Date.now() - lastAt < 2500) { setTimeout(loop, 300); return; }
          last = code; lastAt = Date.now();
          vibrate(40); added++;
          const e = addEntry(code);
          persist();
          sc.setMessage(t('batch.missingAdded', { n: added, code }), 'is-ok');
          setTimeout(loop, 900);
          return e;
        });
      };
      if (ok) { try { await barcode.load(); loop(); } catch { sc.setMessage(t('res.barcode.error'), 'is-warn'); } }
      function finish() { stop?.(); sc.destroy(); host.remove(); drawAll(); }
    }

    async function typeOrNoCode() {
      const r = await sheet((close, panel) => {
        const name = h('input', { class: 'in', type: 'text', placeholder: t('form.namePh'), 'aria-label': t('form.name') });
        const code = h('input', { class: 'in', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '14', placeholder: t('batch.codeOptional'), 'aria-label': t('scan.typeCode') });
        const err = h('p', { class: 'form-err' });
        panel.append(h('h2', { class: 'sheet-title' }, t('batch.addManual')),
          h('label', { class: 'field' }, h('span', { class: 'flabel' }, t('form.name')), name),
          h('label', { class: 'field' }, h('span', { class: 'flabel' }, t('batch.codeLabel')), code), err,
          h('div', { class: 'sheet-actions' },
            h('button', { type: 'button', class: 'btn btn-primary', onclick: () => {
              const c = code.value ? normalizeEan(code.value) : null;
              if (c && !isValidEan(c)) { err.textContent = t('scan.badCode'); return; }
              if (!c && !name.value.trim()) { err.textContent = t('batch.needSomething'); return; }
              close({ ean: c, name: name.value.trim() });
            } }, t('common.add')),
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, t('common.cancel'))));
      });
      if (r) { addEntry(r.ean, { name: r.name }); await persist(); drawAll(); }
    }

    async function cancelBatch() {
      if (state.entries.length && !(await confirmDialog({ title: t('batch.discardTitle'), message: t('batch.discardText'), confirm: t('batch.discard'), danger: true }))) return;
      await db.kv.del('batch'); state = null;
      navigate('#/', { replace: true });
    }

    async function startQueue() {
      if (!state.entries.length) return;
      // Crea subito le confezioni: anche uscendo ora, restano in «Da completare».
      const toCreate = [];
      for (const e of state.entries) {
        if (!e.itemId) {
          const it = newItem({ ean: e.ean, name: e.name, brand: e.brand, location: e.location, batchId: state.id });
          e.itemId = it.id;
          toCreate.push(it);
        }
      }
      await db.items.putMany(toCreate.map((i) => ({ ...i, updatedAt: new Date().toISOString() })));
      for (const e of state.entries) if (e.name && e.ean) await remember(e.ean, e.name, e.brand);
      state.phase = 'queue';
      state.index = state.entries.findIndex((e) => !e.done);
      if (state.index < 0) state.index = 0;
      await persist();
      go('queue');
    }

    root.append(
      h('header', { class: 'top' },
        h('div', { class: 'top-row' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.close'), onclick: () => navigate('#/', { replace: true }) }, icon('close')),
          h('h1', {}, t('batch.title')),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost btn-danger-text', onclick: cancelBatch }, t('batch.discard'))),
        countEl),
      photoWrap,
      h('p', { class: 'hint' }, t('batch.reviewHint')),
      list,
      h('div', { class: 'add-row' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: scanMissing }, icon('scan'), t('batch.scanMissing')),
        h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: typeOrNoCode }, icon('plus'), t('batch.addManual')),
        h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => go('capture') }, icon('photo'), t('batch.anotherPhoto'))),
      h('div', { class: 'footer-bar' },
        h('div', { class: 'assign' }, h('div', { class: 'assign-head' }, selInfo, allBtn), h('div', { class: 'assign-label' }, t('batch.assignTo')), locSeg.el),
        startBtn));
    drawAll();
    return () => { refreshRow = null; };
  }

  // ---------- 3. Date una alla volta ----------
  async function queue() {
    const shelves = await shelvesByLocation();
    const sc = createScanner({ onClose: () => leave() });
    root.append(sc.el);
    sc.setMode('date');
    const cam = await sc.startCamera();
    const resNode = resourceStatus('ocr');
    sc.setResources(cam.ok ? resNode : null);
    if (cam.ok && navigator.onLine) resources.ensure('ocr').then((ok) => { if (ok && alive) ocr.getWorker().catch(() => {}); });

    function leave() {
      toast(t('batch.paused'));
      navigate('#/', { replace: true });
    }

    async function current() {
      const e = state.entries[state.index];
      if (!e) return null;
      const item = await db.items.get(e.itemId);
      if (!item) { e.done = true; e.skipped = true; return null; } // eliminata nel frattempo
      return { e, item };
    }

    async function show() {
      while (state.index < state.entries.length && state.entries[state.index].done) state.index++;
      if (state.index >= state.entries.length) { await persist(); return go('done'); }
      const cur = await current();
      if (!cur) { state.index++; await persist(); return show(); }
      const { e, item } = cur;
      const total = state.entries.length;
      const pos = state.index + 1;
      const locBtn = h('button', { type: 'button', class: 'pill pill-sm', 'aria-label': t('batch.changeLoc') }, t('loc.' + (item.location || settings.defaultLocation)));
      locBtn.addEventListener('click', async () => {
        const next = LOCATIONS[(LOCATIONS.indexOf(item.location) + 1) % LOCATIONS.length];
        item.location = next; e.location = next;
        await save(item); await persist();
        locBtn.textContent = t('loc.' + next);
      });
      sc.setTitle(h('div', { class: 'qhead' },
        h('div', { class: 'qbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(pos - 1) }, h('span', { style: `width:${((pos - 1) / total) * 100}%` })),
        h('div', { class: 'qline' }, h('span', { class: 'qpos' }, t('batch.pos', { pos, total })), h('span', { class: 'prod-name' }, item.name || e.ean || t('item.unnamed')), locBtn)));
      sc.freeze(null);
      sc.setMessage(cam.ok ? t('scan.dateHint') : t('scan.noCameraHint'), cam.ok ? '' : 'is-warn');
      sc.setTopRight(dateTools((f) => shoot(null, item, e, f)));
      const shutter = h('button', { type: 'button', class: 'shutter', 'aria-label': t('scan.shoot'), disabled: !cam.ok, onclick: () => shoot(shutter, item, e) }, h('span'));
      sc.setActions(
        h('button', { type: 'button', class: 'pill' + (cam.ok ? '' : ' pill-primary'), onclick: () => confirm(item, e, null) }, icon('keyboard'), t('scan.typeDate')),
        shutter,
        h('button', { type: 'button', class: 'pill', onclick: () => skip(e) }, t('batch.later'), icon('skip')));
    }

    async function shoot(btn, item, e, file) {
      const shutter = btn || sc.el.querySelector('.shutter');
      if (shutter) { shutter.disabled = true; shutter.classList.add('is-busy'); }
      const onStage = (s, p) => sc.setMessage(t('scan.stage.' + s, p), 'is-busy');
      const r = file ? await readDateFromFile(file, { onStage, host: sc.overlay }) : await readDate(sc, { onStage });
      if (file && cam.ok) await sc.resumeCamera();
      if (shutter) { shutter.disabled = !cam.ok; shutter.classList.remove('is-busy'); }
      if (!alive) return;
      if (r.status === 'cancel') { sc.freeze(null); sc.setMessage(t('scan.dateHint')); return; }
      if (r.status === 'ok') {
        await db.bumpStats({ ocrRead: 1 });
        sc.setMessage(t('scan.dateHint'));
        let pick = r.candidates[0];
        if (needsChoice(r.candidates)) {
          pick = await chooseDate(sc.overlay, r.candidates);
          if (pick === 'retake') { sc.freeze(null); sc.setMessage(t('scan.dateHint')); return; }
          if (pick === 'none') pick = null;
        }
        return confirm(item, e, pick);
      }
      sc.freeze(null);
      if (r.status === 'none') sc.setMessage(noDateMessage(r, 'batch.noDateFound'), 'is-warn');
      else if (r.status === 'unavailable') { sc.setMessage(t('res.ocr.offline'), 'is-warn'); confirm(item, e, null); }
      else sc.setMessage(t('scan.ocrError'), 'is-warn');
    }

    async function confirm(item, e, cand) {
      const d = { ...item, expiry: cand ? cand.exp : item.expiry, expiryKind: cand ? cand.kind : item.expiryKind };
      const res = await confirmItem(sc.overlay, d, {
        source: cand ? 'ocr' : null, yearInferred: !!cand?.yearInferred, shelves, title: d.name || t('confirm.title'),
        primary: t('batch.confirmNext'),
        extra: [[t('batch.later'), 'skip'], ...(cam.ok ? [[t('confirm.retake'), 'retake']] : [])],
      });
      if (!alive) return;
      if (res.action === 'skip') return skip(e);
      if (res.action === 'cancel' || res.action === 'retake') { sc.freeze(null); sc.setMessage(t('scan.dateHint')); return; }
      const saved = await save({ ...res.item, batchId: state.id });
      e.done = true; e.skipped = !saved.expiry && !saved.noDate; e.name = saved.name; e.location = saved.location;
      const stat = { saved: 1 };
      if (cand) { if (sameExpiry(cand.exp, saved.expiry)) stat.ocrAccepted = 1; else { stat.ocrCorrected = 1; e.corrected = true; } }
      await db.bumpStats(stat);
      state.index++;
      await persist();
      show();
    }

    async function skip(e) {
      e.done = true; e.skipped = true;
      state.index++;
      await persist();
      toast(t('batch.skipped'));
      show();
    }

    await show();
    return async () => { resNode.dispose?.(); sc.destroy(); ocr.release(); };
  }

  // ---------- 4. Riepilogo ----------
  function done() {
    const total = state.entries.length;
    const skipped = state.entries.filter((e) => e.skipped).length;
    const corrected = state.entries.filter((e) => e.corrected).length;
    const secs = Math.round((Date.now() - state.startedAt) / 1000);
    db.bumpStats({ lastBatch: { total, skipped, corrected, seconds: secs, at: new Date().toISOString() } });
    db.kv.del('batch');
    if (photo) { URL.revokeObjectURL(photo.url); photo = null; }
    const st = state; state = null;
    root.append(h('div', { class: 'done' },
      h('h1', {}, t('batch.doneTitle')),
      h('p', { class: 'summary' }, t('batch.doneText', { n: total - skipped, total })),
      skipped ? h('p', { class: 'summary' }, t('batch.doneSkipped', { n: skipped })) : null,
      h('p', { class: 'muted small' }, t('batch.doneTime', { m: Math.floor(secs / 60), s: secs % 60 })),
      h('div', { class: 'empty-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => navigate('#/', { replace: true }) }, t('batch.toList')),
        skipped ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => navigate('#/todo', { replace: true }) }, t('home.todoTitle')) : null)));
    void st;
    return null;
  }

  await go(state ? state.phase : 'capture');

  return async () => {
    alive = false;
    if (cleanupPhase) await cleanupPhase();
  };
}
