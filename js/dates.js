// Date di scadenza con precisione esplicita: {y, m, d} dove d (e m) possono essere null.
// Le parti mancanti non vengono mai inventate: servono solo per ordinare (fine mese / fine anno).

export function pad(n) { return String(n).padStart(2, '0'); }
export function ymd(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
export function parseYMD(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
export function startOfDay(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }
export function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

export function precision(exp) {
  if (!exp || !exp.y) return 'none';
  if (exp.m == null) return 'year';
  if (exp.d == null) return 'month';
  return 'day';
}

export function isValidExpiry(exp) {
  if (!exp) return true;
  const { y, m, d } = exp;
  if (!Number.isInteger(y) || y < 1990 || y > 2100) return false;
  if (m == null) return d == null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return false;
  if (d == null) return true;
  return Number.isInteger(d) && d >= 1 && d <= daysInMonth(y, m);
}

// Ultimo giorno coperto dalla scadenza (solo per ordinare e calcolare l'urgenza).
export function expiryEnd(exp) {
  switch (precision(exp)) {
    case 'day': return new Date(exp.y, exp.m - 1, exp.d);
    case 'month': return new Date(exp.y, exp.m, 0);
    case 'year': return new Date(exp.y, 11, 31);
    default: return null;
  }
}

export function openedDeadline(item) {
  if (!item.openedAt || !item.openDays) return null;
  const o = parseYMD(item.openedAt);
  return o ? addDays(o, item.openDays) : null;
}

// Termine effettivo: il più vicino tra scadenza stampata e termine dopo l'apertura.
export function deadline(item) {
  const e = expiryEnd(item.expiry);
  const o = openedDeadline(item);
  if (o && (!e || o < e)) return { date: o, source: 'opened', precision: 'day' };
  if (e) return { date: e, source: 'expiry', precision: precision(item.expiry) };
  return null;
}

// Urgenza con significato fisso: expired, today, soon (1-3 giorni), week (4-7), later, none.
export function urgency(item, today = startOfDay()) {
  const dl = deadline(item);
  if (!dl) return { level: 'none', days: null, dl };
  const days = daysBetween(today, dl.date);
  let level = 'later';
  if (days < 0) level = 'expired';
  else if (days === 0) level = 'today';
  else if (days <= 3) level = 'soon';
  else if (days <= 7) level = 'week';
  // Con solo mese/anno non diciamo "scade oggi" a fine mese: resta un termine approssimato.
  return { level, days, dl };
}

export function sortKey(item) {
  const dl = deadline(item);
  return dl ? dl.date.getTime() : Number.MAX_SAFE_INTEGER;
}

export function formatExpiry(exp, lang = 'it') {
  switch (precision(exp)) {
    case 'day': return `${pad(exp.d)}/${pad(exp.m)}/${exp.y}`;
    case 'month': return `${pad(exp.m)}/${exp.y}`;
    case 'year': return String(exp.y);
    default: return '';
  }
}

export function formatDate(date, lang = 'it', opts = { day: '2-digit', month: '2-digit', year: 'numeric' }) {
  return new Intl.DateTimeFormat(lang, opts).format(date);
}

export function formatShort(date, lang = 'it') {
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(date);
}

export function formatMonth(exp, lang = 'it') {
  return new Intl.DateTimeFormat(lang, { month: 'short', year: 'numeric' }).format(new Date(exp.y, exp.m - 1, 1));
}

// Converte i tre campi GG / MM / AAAA in una scadenza. Restituisce {value} oppure {error}.
export function fieldsToExpiry(dStr, mStr, yStr, now = new Date()) {
  const ds = (dStr || '').trim(), ms = (mStr || '').trim(), ys = (yStr || '').trim();
  if (!ds && !ms && !ys) return { value: null };
  if (!/^\d*$/.test(ds) || !/^\d*$/.test(ms) || !/^\d*$/.test(ys)) return { error: 'digits' };
  if (!ys) return { error: 'year' };
  let y = +ys;
  if (ys.length === 2) y = 2000 + y;
  else if (ys.length !== 4) return { error: 'year' };
  if (ds && !ms) return { error: 'month' };
  const exp = { y, m: ms ? +ms : null, d: ds ? +ds : null };
  if (!isValidExpiry(exp)) return { error: 'invalid' };
  const warn = [];
  const end = expiryEnd(exp);
  if (end < startOfDay(now)) warn.push('past');
  if (y > now.getFullYear() + 10) warn.push('far');
  return { value: exp, warn };
}

export function expiryToFields(exp) {
  if (!exp) return ['', '', ''];
  return [exp.d != null ? pad(exp.d) : '', exp.m != null ? pad(exp.m) : '', String(exp.y)];
}

export function sameExpiry(a, b) {
  if (!a || !b) return !a && !b;
  return a.y === b.y && (a.m ?? null) === (b.m ?? null) && (a.d ?? null) === (b.d ?? null);
}
