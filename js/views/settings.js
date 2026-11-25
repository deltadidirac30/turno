// Impostazioni: risorse offline, promemoria, backup, lingua, statistiche.
import { h, clear, toast, confirmDialog, downloadBlob, formatBytes } from '../util.js';
import { t, LANGUAGES, setLang, lang } from '../i18n.js';
import * as db from '../db.js';
import * as resources from '../resources.js';
import { exportData, validate, restore } from '../backup.js';
import { locationPicker, seg } from '../components/forms.js';
import { applyTheme } from '../theme.js';
import { exportIcs } from './item.js';
import { urgency } from '../dates.js';
import { APP_VERSION } from '../version.js';

export async function render(root) {
  const s = await db.getSettings();
  const stats = await db.kv.get('stats', null);
  const all = await db.items.all();
  const nConsumed = all.filter((i) => i.status === 'consumed').length;
  const nWasted = all.filter((i) => i.status === 'wasted').length;
  const disposers = [];
  clear(root);

  const section = (title, ...body) => h('section', { class: 'card' }, h('h2', { class: 'card-title' }, title), ...body);

  // --- Risorse offline ---
  const resRow = (name) => {
    const status = h('span', { class: 'res-status' });
    const btn = h('button', { type: 'button', class: 'btn btn-small btn-ghost' }, t('settings.download'));
    btn.addEventListener('click', () => resources.download(name));
    const draw = () => {
      const st = resources.getState(name);
      status.className = 'res-status st-' + st.status;
      status.textContent = st.status === 'downloading' ? t('settings.res.downloading', { pct: Math.round(st.progress * 100) }) : t('settings.res.' + st.status);
      btn.hidden = st.status === 'ready' || st.status === 'downloading' || st.status === 'nocache';
      btn.disabled = !navigator.onLine;
    };
    disposers.push(resources.onChange(draw));
    resources.check(name).then(draw);
    draw();
    return h('div', { class: 'set-row' },
      h('div', {}, h('div', { class: 'set-name' }, t('settings.res.' + name)), h('div', { class: 'muted small' }, formatBytes(resources.groupSize(name)) + ', ' + t('settings.res.' + name + 'Desc'))),
      h('div', { class: 'set-side' }, status, btn));
  };
  const auto = h('input', { type: 'checkbox', class: 'switch', checked: s.autoDownload });
  auto.addEventListener('change', () => db.saveSettings({ autoDownload: auto.checked }));

  // --- Promemoria ---
  const daysSel = h('select', { class: 'in in-sm', 'aria-label': t('settings.icsDays') },
    [0, 1, 2, 3, 7].map((n) => h('option', { value: String(n), selected: n === s.icsDaysBefore }, t('settings.daysBefore', { n }))));
  daysSel.addEventListener('change', () => db.saveSettings({ icsDaysBefore: +daysSel.value }));
  const hourSel = h('select', { class: 'in in-sm', 'aria-label': t('settings.icsHour') },
    [7, 8, 9, 10, 12, 18, 20].map((n) => h('option', { value: String(n), selected: n === s.icsHour }, `${String(n).padStart(2, '0')}:00`)));
  hourSel.addEventListener('change', () => db.saveSettings({ icsHour: +hourSel.value }));
  const icsAll = h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => {
    const list = (await db.items.active()).filter((i) => { const u = urgency(i); return u.days != null && u.days >= 0 && u.days <= 14; });
    if (!list.length) { toast(t('settings.icsNone')); return; }
    exportIcs(list, await db.getSettings());
  } }, t('settings.icsExport'));

  // --- Backup ---
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    const text = await f.text();
    const r = validate(text);
    if (!r.ok) {
      toast(t('backup.invalid', { why: t('backup.err.' + (r.errors[0]?.split(' ')[0] || 'structure'), { detail: r.errors.slice(0, 3).join('; ') }) }), { duration: 8000 });
      return;
    }
    const current = (await db.items.active()).length;
    const ok = await confirmDialog({
      title: t('backup.confirmTitle'),
      message: t('backup.confirmText', { n: r.summary.active, p: r.summary.products, current }),
      confirm: t('backup.replace'), danger: true,
    });
    if (!ok) return;
    await restore(r.data);
    toast(t('backup.restored', { n: r.summary.active }));
    location.hash = '#/';
  });

  const langSel = h('select', { class: 'in in-sm', 'aria-label': t('settings.lang') },
    Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code, selected: code === lang() }, name)));
  langSel.addEventListener('change', async () => { await db.saveSettings({ lang: langSel.value }); setLang(langSel.value); location.reload(); });

  let persisted = null;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch {}

  root.append(
    h('header', { class: 'top' }, h('div', { class: 'top-row' }, h('h1', {}, t('settings.title')))),
    section(t('settings.theme'),
      seg(['light', 'dark', 'auto'].map((v) => [v, t('settings.theme.' + v)]), s.theme || 'light', (v) => { applyTheme(v); db.saveSettings({ theme: v }); }, { label: t('settings.theme') }).el),
    section(t('settings.offline'),
      h('p', { class: 'muted small' }, t('settings.offlineText')),
      resRow('barcode'), resRow('ocr'),
      h('label', { class: 'set-row' }, h('span', {}, t('settings.autoDownload')), auto)),
    section(t('settings.reminders'),
      h('p', { class: 'small' }, t('settings.remindersText')),
      h('div', { class: 'set-row' }, h('span', {}, t('settings.icsDays')), daysSel),
      h('div', { class: 'set-row' }, h('span', {}, t('settings.icsHour')), hourSel),
      icsAll,
      h('p', { class: 'muted small' }, t('settings.icsHelp'))),
    section(t('settings.defaultLoc'),
      locationPicker(s.defaultLocation, (v) => db.saveSettings({ defaultLocation: v })).el),
    section(t('settings.backup'),
      h('p', { class: 'muted small' }, t('settings.backupText')),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => {
          const data = await exportData();
          downloadBlob(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `turno-backup-${new Date().toISOString().slice(0, 10)}.json`);
          toast(t('backup.exported', { n: data.items.filter((i) => i.status === 'active').length }));
        } }, t('backup.export')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => fileIn.click() }, t('backup.import')), fileIn)),
    section(t('settings.stats'),
      h('p', { class: 'muted small' }, t('settings.statsText')),
      h('dl', { class: 'stats' },
        h('dt', {}, t('stats.saved')), h('dd', {}, String(stats?.saved || 0)),
        h('dt', {}, t('stats.consumed')), h('dd', {}, String(nConsumed)),
        h('dt', {}, t('stats.wasted')), h('dd', {}, String(nWasted)),
        h('dt', {}, t('stats.ocrAccepted')), h('dd', {}, String(stats?.ocrAccepted || 0)),
        h('dt', {}, t('stats.ocrCorrected')), h('dd', {}, String(stats?.ocrCorrected || 0)),
        stats?.lastBatch ? [h('dt', {}, t('stats.lastBatch')), h('dd', {}, t('stats.lastBatchVal', { n: stats.lastBatch.total, m: Math.floor(stats.lastBatch.seconds / 60), s: stats.lastBatch.seconds % 60, c: stats.lastBatch.corrected, k: stats.lastBatch.skipped }))] : null)),
    section(t('settings.lang'), langSel),
    section(t('settings.about'),
      h('p', { class: 'small' }, t('settings.privacy')),
      persisted === false ? h('p', { class: 'muted small' }, t('settings.notPersisted')) : null,
      h('p', { class: 'muted small' }, t('settings.version', { v: APP_VERSION }))));

  return () => disposers.forEach((d) => d());
}
