// Aggiunta di un alimento: codice a barre → foto della data → conferma.
// La fotocamera resta accesa tra i passaggi (niente riavvii) e si spegne all'uscita.
import { h, icon, toast, vibrate, sheet } from '../util.js';
import { t } from '../i18n.js';
import * as db from '../db.js';
import * as resources from '../resources.js';
import * as barcode from '../barcode.js';
import * as ocr from '../ocr.js';
import { lookup, isValidEan, normalizeEan } from '../products.js';
import { newItem, save, shelvesByLocation, remove } from '../store.js';
import { sameExpiry } from '../dates.js';
import { needsChoice } from '../ocr-parse.js';
import { createScanner, liveBarcode, resourceStatus, readDate, readDateFromFile, dateTools, noDateMessage, chooseDate, confirmItem } from '../components/scanner.js';
import { back, navigate } from '../router.js';

let lastLocation = null;
let lastSaved = { ean: null, at: 0 }; // evita di rileggere subito la confezione appena salvata

export async function render(root, itemId) {
  const settings = await db.getSettings();
  const shelves = await shelvesByLocation();
  const existing = itemId ? await db.items.get(itemId) : null;
  let alive = true;
  let stopLive = null;
  let draft = null;
  let pendingLookup = null;
  let savedCount = 0;
  const disposers = [];

  const sc = createScanner({ onClose: () => back(existing ? '#/todo' : '#/') });
  root.append(sc.el);

  const steps = (n) => h('div', { class: 'steps' },
    h('span', { class: 'step' + (n === 1 ? ' is-on' : ''), 'aria-current': n === 1 ? 'step' : null }, t('scan.step1')),
    h('span', { class: 'step-sep', 'aria-hidden': 'true' }, '›'),
    h('span', { class: 'step' + (n === 2 ? ' is-on' : ''), 'aria-current': n === 2 ? 'step' : null }, t('scan.step2')),
    savedCount ? h('span', { class: 'step-count' }, t('scan.savedCount', { n: savedCount })) : null);

  const resNode = (name) => { const n = resourceStatus(name); disposers.push(n.dispose); return n; };

  const cam = await sc.startCamera();
  if (settings.autoDownload && navigator.onLine) { resources.ensure('barcode'); }

  const onVis = async () => {
    if (!alive) return;
    if (document.hidden) { stopLive?.(); sc.stopCamera(); }
    else { await sc.startCamera(); if (sc.frame.dataset.mode === 'barcode' && draft && !draft.ean) startLive(); }
  };
  document.addEventListener('visibilitychange', onVis);

  async function startLive() {
    stopLive?.();
    if (!sc.cameraOk) return;
    const ok = await resources.ensure('barcode');
    if (!ok || !alive) return;
    try { await barcode.load(); } catch { sc.setMessage(t('res.barcode.error'), 'is-warn'); return; }
    if (!alive || sc.frame.dataset.mode !== 'barcode') return;
    stopLive = liveBarcode(sc, onCode, (code) => {
      const fresh = code === lastSaved.ean && Date.now() - lastSaved.at < 3000;
      if (fresh) sc.setMessage(t('scan.sameAgain'));
      return !fresh;
    });
  }

  // ---------- Passo 1: codice ----------
  function stepBarcode() {
    draft = newItem({ location: lastLocation || settings.defaultLocation });
    pendingLookup = null;
    sc.freeze(null);
    sc.setMode('barcode');
    sc.setTitle(steps(1));
    sc.setMessage(cam.ok ? t('scan.barcodeHint') : t('scan.noCameraHint'), cam.ok ? '' : 'is-warn');
    sc.setResources(resNode('barcode'));
    sc.setTopRight(h('button', { type: 'button', class: 'pill pill-sm', onclick: () => navigate('#/batch', { replace: true }) }, t('scan.toBatch')));
    sc.setActions(
      h('button', { type: 'button', class: 'pill', onclick: typeCode }, icon('keyboard'), t('scan.typeCode')),
      h('button', { type: 'button', class: 'pill' + (cam.ok ? '' : ' pill-primary'), onclick: () => { stopLive?.(); stepDate(); } },
        t(cam.ok ? 'scan.noCode' : 'scan.manual'), icon('skip')));
    startLive();
  }

  function onCode(ean) {
    if (!alive) return;
    vibrate(40);
    draft.ean = normalizeEan(ean);
    pendingLookup = lookup(draft.ean).then((r) => {
      if (r.product && draft && draft.ean === r.product.ean) {
        if (!draft.name) draft.name = r.product.name;
        if (!draft.brand) draft.brand = r.product.brand || '';
      }
      if (alive && sc.frame.dataset.mode === 'date') sc.setTitle(productChip(r.status));
      return r;
    });
    stepDate();
  }

  async function typeCode() {
    stopLive?.();
    const code = await sheet((close, panel) => {
      const inp = h('input', { class: 'in in-big', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '14', placeholder: '8001234567890', 'aria-label': t('scan.typeCode'), autocomplete: 'off' });
      const err = h('p', { class: 'form-err' });
      const go = () => {
        const v = normalizeEan(inp.value);
        if (!isValidEan(v)) { err.textContent = t('scan.badCode'); return; }
        close(v);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      panel.append(h('h2', { class: 'sheet-title' }, t('scan.typeCode')), inp, err,
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: go }, t('common.continue')),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, t('common.cancel'))));
      setTimeout(() => inp.focus(), 50);
    }, { host: sc.overlay });
    if (code) onCode(code); else startLive();
  }

  function productChip(status) {
    const name = draft.name || (draft.ean ? t('scan.codeOnly', { ean: draft.ean }) : t('scan.noCodeChip'));
    let note = '';
    if (draft.ean && !draft.name) {
      note = status === 'offline' ? t('scan.lookupOffline') : status === 'notfound' ? t('scan.lookupNew') : status ? t('scan.lookupFail') : t('scan.lookupWait');
    }
    return h('div', { class: 'prod-chip' }, h('span', { class: 'prod-name' }, name), note ? h('span', { class: 'prod-note' }, note) : null);
  }

  // ---------- Passo 2: data ----------
  function stepDate() {
    stopLive?.();
    sc.freeze(null);
    sc.setMode('date');
    sc.setTopRight(dateTools((f) => shoot(null, f)));
    sc.setTitle(draft.ean || existing ? productChip(null) : steps(2));
    if (pendingLookup) pendingLookup.then((r) => { if (alive && sc.frame.dataset.mode === 'date') sc.setTitle(productChip(r.status)); });
    sc.setMessage(cam.ok ? t('scan.dateHint') : t('scan.noCameraHint'), cam.ok ? '' : 'is-warn');
    sc.setResources(cam.ok ? resNode('ocr') : null);
    if (cam.ok && settings.autoDownload && navigator.onLine) resources.ensure('ocr').then((ok) => { if (ok && alive) ocr.getWorker().catch(() => {}); });
    const shutter = h('button', { type: 'button', class: 'shutter', 'aria-label': t('scan.shoot'), disabled: !cam.ok, onclick: () => shoot(shutter) }, h('span'));
    sc.setActions(
      h('button', { type: 'button', class: 'pill', onclick: () => confirm(null) }, icon('keyboard'), t('scan.typeDate')),
      shutter,
      h('button', { type: 'button', class: 'pill', onclick: skipDate }, t('scan.skip'), icon('skip')));
  }

  async function shoot(btn, file) {
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
      return confirm(pick);
    }
    sc.freeze(null);
    if (r.status === 'none') sc.setMessage(noDateMessage(r, 'scan.noDateFound'), 'is-warn');
    else if (r.status === 'unavailable') { sc.setMessage(t('res.ocr.offline'), 'is-warn'); confirm(null); }
    else sc.setMessage(t('scan.ocrError'), 'is-warn');
  }

  async function withLookup() {
    if (!pendingLookup) return;
    await Promise.race([pendingLookup, new Promise((r) => setTimeout(r, 1500))]);
  }

  async function confirm(candidate) {
    await withLookup();
    const base = existing || draft;
    const d = { ...base, expiry: candidate ? candidate.exp : base.expiry, expiryKind: candidate ? candidate.kind : base.expiryKind };
    const res = await confirmItem(sc.overlay, d, {
      source: candidate ? 'ocr' : null, yearInferred: !!candidate?.yearInferred, shelves,
      title: d.name || t('confirm.title'),
      primary: existing ? t('common.save') : t('confirm.saveNext'),
      secondary: existing ? null : t('confirm.saveClose'),
      extra: cam.ok ? [[t('confirm.retake'), 'retake']] : [],
    });
    if (!alive) return;
    if (res.action === 'cancel' || res.action === 'retake') { sc.freeze(null); sc.setMessage(t('scan.dateHint')); return; }
    const saved = await save(res.item);
    lastLocation = saved.location;
    lastSaved = { ean: saved.ean, at: Date.now() };
    savedCount++;
    const stat = { saved: existing ? 0 : 1 };
    if (candidate) {
      if (sameExpiry(candidate.exp, saved.expiry)) stat.ocrAccepted = 1; else stat.ocrCorrected = 1;
    }
    await db.bumpStats(stat);
    const undo = existing ? null : async () => { await remove(saved); savedCount--; };
    toast(saved.expiry || saved.noDate ? t('toast.savedName', { name: saved.name || t('item.unnamed') }) : t('toast.savedTodo'),
      undo ? { action: t('common.undo'), onAction: undo } : {});
    if (existing) { back('#/todo'); return; }
    if (res.action === 'done') { back('#/'); return; }
    stepBarcode();
  }

  async function skipDate() {
    await withLookup();
    const saved = await save(existing ? existing : draft);
    savedCount += existing ? 0 : 1;
    if (!existing) await db.bumpStats({ saved: 1 });
    toast(t('toast.savedTodo'), { action: t('common.undo'), onAction: async () => { if (!existing) await remove(saved); } });
    if (existing) { back('#/todo'); return; }
    stepBarcode();
  }

  if (existing) { draft = { ...existing }; stepDate(); } else stepBarcode();

  return async () => {
    alive = false;
    stopLive?.();
    disposers.forEach((d) => d?.());
    document.removeEventListener('visibilitychange', onVis);
    sc.destroy(); // rilascia la fotocamera
    ocr.release();
  };
}
