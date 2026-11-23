// Esportazione .ics: un evento per giorno intero con un avviso (VALARM).
// L'utente importa il file nel proprio calendario; l'app non programma notifiche.
import { deadline, pad, ymd } from './dates.js';

function esc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
function fold(line) {
  // Righe max 75 ottetti (RFC 5545); spezzatura semplice per caratteri.
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
const d8 = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

// Restituisce {date, note} o null. Con sola indicazione di mese/anno usa l'ultimo giorno
// del periodo come promemoria, dichiarandolo nella descrizione (la data non viene inventata).
export function reminderDate(item) {
  const dl = deadline(item);
  if (!dl) return null;
  return { date: dl.date, precision: dl.precision, source: dl.source };
}

export function buildICS(entries, { daysBefore = 1, hour = 9, t }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Turno//Scadenze//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const item of entries) {
    const r = reminderDate(item);
    if (!r) continue;
    const start = r.date;
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const minutesBefore = daysBefore * 1440 - hour * 60;
    const trigger = minutesBefore > 0 ? `-PT${minutesBefore}M` : `PT${-minutesBefore}M`;
    const title = t('ics.title', { name: item.name || t('item.unnamed') });
    const desc = [
      r.source === 'opened' ? t('ics.descOpened') : t('ics.descExpiry', { date: r.precision === 'day' ? `${pad(start.getDate())}/${pad(start.getMonth() + 1)}/${start.getFullYear()}` : '' }),
      r.precision === 'month' ? t('ics.descMonth') : '',
      r.precision === 'year' ? t('ics.descYear') : '',
      t('ics.descCheck'),
    ].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT',
      `UID:${item.id}-${d8(start)}@turno.local`,
      `DTSTAMP:${stamp()}`,
      `DTSTART;VALUE=DATE:${d8(start)}`,
      `DTEND;VALUE=DATE:${d8(end)}`,
      fold(`SUMMARY:${esc(title)}`),
      fold(`DESCRIPTION:${esc(desc)}`),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(title)}`), `TRIGGER:${trigger}`, 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export function icsFilename(items) {
  if (items.length === 1) {
    const slug = (items[0].name || 'alimento').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    return `turno-${slug || 'alimento'}.ics`;
  }
  return `turno-scadenze-${ymd(new Date())}.ics`;
}
