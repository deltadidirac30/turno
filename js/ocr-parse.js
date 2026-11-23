// Estrae date di scadenza plausibili dal testo OCR di una confezione.
// Modulo puro (nessun DOM): testabile con Node.
import { isValidExpiry, expiryEnd, startOfDay, daysInMonth } from './dates.js';

const MONTHS = {
  GEN: 1, JAN: 1, FEB: 2, MAR: 3, APR: 4, MAG: 5, MAY: 5, GIU: 6, JUN: 6, LUG: 7, JUL: 7,
  AGO: 8, AUG: 8, SET: 9, SEP: 9, OTT: 10, OCT: 10, NOV: 11, DIC: 12, DEC: 12,
};
const MONTH_RE = 'GEN|FEB|MAR|APR|MAG|GIU|LUG|AGO|SET|OTT|NOV|DIC|JAN|MAY|JUN|JUL|AUG|SEP|OCT|DEC';

// Diciture, tolleranti agli errori tipici dell'OCR (CONSUMARSI → COMSUMARSI, TMC → TNC...).
// L'ordine conta: la più specifica vince.
const KEYWORDS = [
  { type: 'best_before', re: /PREF[EF]?R[IL1]B\w*|PREF\.?(?=\s)|\bT[.\s]?[MN][.\s]?C\b|BEST\s*BEFORE|\bBBE?\b|MIN\w*\s+(?:DI\s+)?CONSERV\w*|\bMHD\b|DE\s+PREFERENCE/g },
  { type: 'use_by', re: /C[O0][NM]?S[UV][MN]\w*\s+E[NH]TR[O0A]|\bCONS\b\.?\s*E[NH]TR[O0A]|USE\s*BY|\bEXP\w*\b|SCAD\w*|CONSUMIR|A\s+CONSOMMER\s+JUSQU/g },
  { type: 'use_by_weak', re: /DA\s+C[O0][NM]?S[UV][MN]\w*|C[O0][NM]S[UV]MAR\w*/g },
  { type: 'generic', re: /\bE[NH]TR[O0A]\b|\bFINE\b|\bVALID\w*/g },
  { type: 'production', re: /PROD\w*|CONFEZ\w*|\bCONF\b|PACK\w*|\bPKD\b|IMBOTT\w*|\bMFG\b|FABBRIC\w*|MACELL\w*|DATA\s+DI\s+PRODUZ\w*|SEZIONAT\w*|CONGELAT\w*\s+IL/g },
];

const LOT_RE = /\b(?:LOTTO|LOT|LT|L)\s*[.:#]?\s*([A-Z0-9][A-Z0-9\/.\-]*)/g;

export function normalizeLine(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

// Corregge le confusioni tipiche dell'OCR (O→0, I→1, S→5...) solo nei gruppi soprattutto numerici.
// Sostituzione carattere per carattere: gli indici restano allineati.
export function fixDigits(s) {
  return s.replace(/[0-9OILSBZ|][0-9OILSBZ|.\/\-]*[0-9OILSBZ|]/g, (tok) => {
    const digits = (tok.match(/\d/g) || []).length;
    const letters = (tok.match(/[OILSBZ|]/g) || []).length;
    if (!letters || digits < 2 || digits < letters + 2) return tok;
    return tok.replace(/O/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
  });
}

function findKeywords(line) {
  const out = [];
  for (const k of KEYWORDS) {
    k.re.lastIndex = 0;
    let m;
    while ((m = k.re.exec(line))) out.push({ type: k.type, index: m.index, end: m.index + m[0].length });
  }
  const order = KEYWORDS.map((k) => k.type);
  out.sort((a, b) => a.index - b.index || order.indexOf(a.type) - order.indexOf(b.type));
  return out;
}

function lotSpans(line) {
  const spans = [];
  LOT_RE.lastIndex = 0;
  let m;
  while ((m = LOT_RE.exec(line))) {
    // "L" isolato vale solo se seguito subito da cifre (es. "L 2403", "L.120327").
    const marker = m[0].slice(0, m[0].length - m[1].length).trim().replace(/[.:#]/g, '').trim();
    if (marker === 'L' || marker === 'LT') { if (!/\d/.test(m[1][0])) continue; }
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function classify(kws) {
  const types = kws.map((k) => k.type);
  if (types.includes('best_before')) return 'best_before';
  if (types.includes('use_by')) return 'use_by';
  if (types.includes('use_by_weak')) return 'use_by';
  if (types.includes('production')) return 'production';
  if (types.includes('generic')) return 'generic';
  return null;
}

// Anno a 4 cifre letto male (2026 → 2826, 2626): la seconda cifra di un anno di questo secolo è 0.
function year(ys, nowY) {
  if (ys.length === 2) return { y: 2000 + +ys, fixed: false };
  let y = +ys;
  if ((y < nowY - 2 || y > nowY + 12) && ys[0] === '2' && /[35689]/.test(ys[1])) {
    const alt = +('20' + ys.slice(2));
    if (alt >= nowY - 2 && alt <= nowY + 12) return { y: alt, fixed: true };
  }
  return { y, fixed: false };
}

// Prima cifra di giorno/mese letta come 9, 8 o 6 al posto di 0 (stampa a punti).
function part(s, max) {
  const n = +s;
  if (n >= 1 && n <= max) return { n, fixed: false };
  if (s.length === 2 && /[689]/.test(s[0])) {
    const alt = +s[1];
    if (alt >= 1 && alt <= max) return { n: alt, fixed: true };
  }
  return { n, fixed: false };
}

const PATTERNS = [
  // 28/11/2026, 28.11.26, 28-11-26, anche con spazio prima dell'anno (28/11 2026)
  { name: 'full', re: /(^|[^\d,])(\d{1,2})\s?[.\/\-,*]\s?(\d{1,2})(?:\s?[.\/\-,*]\s?|\s)(\d{4}|\d{2})(?!\d)/g,
    build: (m, Y) => { const d = part(m[2], 31), mo = part(m[3], 12), y = year(m[4], Y); return { exp: { d: d.n, m: mo.n, y: y.y }, fixes: [d, mo, y].filter((x) => x.fixed).length }; }, base: 30 },
  { name: 'monthname', re: new RegExp(`(^|[^\\dA-Z])(?:(\\d{1,2})\\s?[.\\/\\-]?\\s?)?(${MONTH_RE})[A-Z]{0,7}\\.?\\s?[.\\/\\-]?\\s?(\\d{4}|\\d{2})(?!\\d)`, 'g'),
    build: (m, Y) => { const y = year(m[4], Y); return { exp: { d: m[2] ? +m[2] : null, m: MONTHS[m[3]], y: y.y }, fixes: y.fixed ? 1 : 0 }; }, base: 28 },
  // 03/2027, 03/27 (mese e anno)
  { name: 'monthyear', re: /(^|[^\d.\/\-])(\d{1,2})\s?[.\/\-]\s?(\d{4}|\d{2})(?![\d.\/\-])/g,
    build: (m, Y) => { const y = year(m[3], Y); return { exp: { d: null, m: +m[2], y: y.y }, fixes: y.fixed ? 1 : 0 }; }, base: 16 },
  // 28/11 senza anno: ammesso dalla legge per i prodotti freschi. L'anno viene dedotto e segnalato.
  { name: 'daymonth', re: /(^|[^\d.\/\-])(\d{1,2})\s?[.\/\-]\s?(\d{1,2})(?![\d]|\s?[.\/\-:]\s?\d)/g,
    build: (m, Y, now) => {
      const d = part(m[2], 31), mo = part(m[3], 12);
      if (mo.n < 1 || mo.n > 12 || d.n < 1 || d.n > daysInMonth(now.getFullYear(), mo.n)) return null;
      let y = now.getFullYear();
      const cand = new Date(y, mo.n - 1, d.n);
      if ((cand - startOfDay(now)) / 86400000 < -45) y += 1; // già passata da tempo: è dell'anno prossimo
      return { exp: { d: d.n, m: mo.n, y }, fixes: [d, mo].filter((x) => x.fixed).length, yearInferred: true, short: m[2].length < 2 || m[3].length < 2 };
    }, base: 14 },
  // 01 11 2026: con l'anno a quattro cifre gli spazi bastano (un lotto non ha questa forma)
  { name: 'spaced4', re: /(^|[^\d])(\d{2}) {1,2}(\d{2}) {1,2}(20\d{2})(?!\d)/g,
    build: (m, Y) => { const d = part(m[2], 31), mo = part(m[3], 12), y = year(m[4], Y); return { exp: { d: d.n, m: mo.n, y: y.y }, fixes: [d, mo, y].filter((x) => x.fixed).length }; }, base: 22 },
  // 01 11 202? con l'anno illeggibile (stampa difettosa): giorno e mese, anno dedotto e segnalato
  { name: 'spacedPartial', re: /(^|[^\d])(\d{2}) {1,2}(\d{2}) {1,2}20(?:\d(?!\d)|(?!\d))/g,
    build: (m, Y, now) => {
      const d = +m[2], mo = +m[3];
      if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(now.getFullYear(), mo)) return null;
      let y = now.getFullYear();
      if ((new Date(y, mo - 1, d) - startOfDay(now)) / 86400000 < -45) y += 1;
      return { exp: { d, m: mo, y }, fixes: 0, yearInferred: true };
    }, base: 16 },
  { name: 'spaced', re: /(^|[^\d])(\d{2}) (\d{2}) (\d{4}|\d{2})(?!\d)/g,
    build: (m, Y) => { const y = year(m[4], Y); return { exp: { d: +m[2], m: +m[3], y: y.y }, fixes: y.fixed ? 1 : 0 }; }, base: 12, needsKeyword: true },
  { name: 'compact', re: /(^|[^\d])(\d{2})(\d{2})(\d{4}|\d{2})(?!\d)/g,
    build: (m, Y) => { const y = year(m[4], Y); return { exp: { d: +m[2], m: +m[3], y: y.y }, fixes: y.fixed ? 1 : 0 }; }, base: 8, needsKeyword: true },
];

// Prezzi, pesi e orari non sono date.
function looksLikeAmount(line, start, end) {
  const before = line.slice(Math.max(0, start - 4), start);
  const after = line.slice(end, end + 4);
  return /€|EUR|\$/.test(before) || /^\s?(€|EUR|KG|G\b|GR|ML|CL|L\b|%)/.test(after) || /^\s?:\s?\d/.test(after);
}

export function extractDates(text, { now = new Date() } = {}) {
  const rawLines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lines = rawLines.map(normalizeLine);
  const fixed = lines.map(fixDigits);
  const kwPerLine = lines.map(findKeywords);
  const today = startOfDay(now);
  const nowY = now.getFullYear();
  const found = [];

  fixed.forEach((line, i) => {
    const lots = lotSpans(lines[i]);
    const taken = [];
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        const start = m.index + m[1].length;
        const end = m.index + m[0].length;
        p.re.lastIndex = Math.max(end - 1, m.index + 1);
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        if (lots.some(([a, b]) => start < b && end > a)) continue; // numero di lotto: mai come scadenza
        if ((p.name === 'daymonth' || p.name === 'monthyear') && looksLikeAmount(line, start, end)) continue;
        const built = p.build(m, nowY, now);
        if (!built) continue;
        const { exp } = built;
        if (!isValidExpiry(exp)) continue;
        if (exp.y < nowY - 2 || exp.y > nowY + 12) continue;

        const before = kwPerLine[i].filter((k) => k.end <= start + 1);
        const after = kwPerLine[i].filter((k) => k.index >= end && k.index - end < 6);
        let kwType = null; let kwDist = null;
        if (before.length) {
          const last = before[before.length - 1].index;
          kwType = classify(before.filter((k) => last - k.index < 45));
          kwDist = 0;
        } else if (after.length) { kwType = classify(after); kwDist = 0; }
        if (!kwType) {
          for (let back = 1; back <= 2 && i - back >= 0; back++) {
            const kws = kwPerLine[i - back];
            if (kws.length) { kwType = classify(kws); kwDist = back; break; }
          }
        }
        const isExpiryKw = kwType && kwType !== 'production';
        if (p.needsKeyword && !(isExpiryKw && kwDist !== null && kwDist <= 1)) continue;
        // Giorno/mese senza anno: senza dicitura servono due cifre per parte (28/11, non 2/1).
        if (p.name === 'daymonth' && built.short && !isExpiryKw) continue;

        let score = p.base + (p.name === 'daymonth' && isExpiryKw ? 10 : 0);
        if (isExpiryKw) score += kwType === 'generic' ? [25, 18, 8][kwDist] : [45, 35, 12][kwDist];
        if (kwType === 'production') score -= [60, 25, 10][kwDist];
        score -= built.fixes * 7;
        const daysLeft = Math.round((expiryEnd(exp) - today) / 86400000);
        if (daysLeft < -1 && !built.yearInferred) score -= daysLeft < -60 ? 20 : 6; // già scaduta: possibile, meno probabile
        else if (daysLeft <= 900) score += 5;

        const kind = kwType === 'best_before' ? 'best_before' : (kwType === 'use_by' ? 'use_by' : 'unknown');
        const ctxLines = [];
        if (kwDist && kwDist > 0) ctxLines.push(rawLines[i - kwDist]);
        ctxLines.push(rawLines[i]);
        found.push({
          exp, kind, score, pattern: p.name,
          yearInferred: !!built.yearInferred,
          raw: rawLines[i].slice(start, end).trim() || m[0].trim(),
          context: ctxLines.join(' / ').slice(0, 90),
          line: i,
          production: kwType === 'production',
        });
        taken.push([start, end]);
      }
    }
  });

  const all = dedupe(found);
  const plausible = all.filter((c) => c.score >= 15 && !c.production);
  return { candidates: plausible, all, lines: rawLines };
}

const keyOf = (e) => `${e.y}-${e.m}-${e.d}`;

function dedupe(found) {
  const byKey = new Map();
  for (const c of found) {
    const key = keyOf(c.exp);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...c }); continue; }
    const best = c.score > prev.score ? { ...c } : prev;
    if (best.kind === 'unknown') best.kind = c.kind !== 'unknown' ? c.kind : prev.kind;
    best.yearInferred = prev.yearInferred && c.yearInferred;
    byKey.set(key, best);
  }
  const vals = [...byKey.values()];
  // Una data solo mese/anno coperta da una data completa dello stesso mese è ridondante.
  const all = vals.filter((c) => !(c.exp.d == null && vals.some((o) => o !== c && o.exp.d != null && o.exp.y === c.exp.y && o.exp.m === c.exp.m && o.line === c.line)));
  all.sort((a, b) => b.score - a.score);
  return all;
}

// Unisce i risultati di più letture della stessa foto: una data trovata più volte guadagna fiducia.
export function mergeResults(results) {
  // results: [{all, src}] — src identifica la zona letta (più letture della stessa riga contano una volta)
  const byKey = new Map();
  for (const r of results) {
    for (const c of r.all) {
      const key = keyOf(c.exp);
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, { ...c, srcs: new Set([r.src ?? Math.random()]) }); continue; }
      const best = c.score > prev.score ? { ...c, srcs: prev.srcs } : prev;
      best.srcs.add(r.src ?? Math.random());
      if (best.kind === 'unknown') best.kind = c.kind !== 'unknown' ? c.kind : prev.kind;
      best.yearInferred = prev.yearInferred && c.yearInferred;
      if (prev.context.length > best.context.length && /[A-Z]{3}/i.test(prev.context)) best.context = prev.context;
      byKey.set(key, best);
    }
  }
  const all = [...byKey.values()].map((c) => { const hits = c.srcs.size; const { srcs, ...rest } = c; return { ...rest, hits, score: c.score + Math.min(3, hits - 1) * 8 }; });
  all.sort((a, b) => b.score - a.score);
  return { candidates: all.filter((c) => c.score >= 15 && !c.production), all };
}

// Decide se mostrare la scelta: più di una data plausibile senza un chiaro vincitore.
export function needsChoice(candidates) {
  if (candidates.length <= 1) return false;
  const [a, b] = candidates;
  // Diciture diverse e leggibili (es. «entro» e «preferibilmente»): decide l'utente.
  if (a.kind !== 'unknown' && b.kind !== 'unknown' && a.kind !== b.kind) return true;
  return a.score - b.score < 30;
}

// Lettura «sicura»: dicitura riconosciuta e data completa, oppure confermata da più letture.
export function isConfident(result) {
  const top = result.candidates[0];
  if (!top) return false;
  if (top.score >= 60 && !top.yearInferred) return true;
  return (top.hits || 1) >= 2 && top.score >= 30;
}
