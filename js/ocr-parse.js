// Estrae date di scadenza plausibili dal testo OCR di una confezione.
// Modulo puro (nessun DOM): testabile con Node.
import { isValidExpiry, expiryEnd, startOfDay } from './dates.js';

const MONTHS = {
  GEN: 1, JAN: 1, FEB: 2, MAR: 3, APR: 4, MAG: 5, MAY: 5, GIU: 6, JUN: 6, LUG: 7, JUL: 7,
  AGO: 8, AUG: 8, SET: 9, SEP: 9, OTT: 10, OCT: 10, NOV: 11, DIC: 12, DEC: 12,
};
const MONTH_RE = 'GEN|FEB|MAR|APR|MAG|GIU|LUG|AGO|SET|OTT|NOV|DIC|JAN|MAY|JUN|JUL|AUG|SEP|OCT|DEC';

// Diciture: l'ordine conta (la più specifica vince).
const KEYWORDS = [
  { type: 'best_before', re: /PREFERIB\w*|PREF\.?(?=\s)|\bT\.?M\.?C\b|BEST\s*BEFORE|\bBBE?\b|MIN\w*\s+(?:DI\s+)?CONSERV\w*|\bMHD\b|DE\s+PREFERENCE/g },
  { type: 'use_by', re: /CONSUM\w*\s+ENTRO|USE\s*BY|\bEXP\w*\b|SCAD\w*|CONSUMIR|A\s+CONSOMMER\s+JUSQU/g },
  { type: 'use_by_weak', re: /DA\s+CONSUM\w*|CONSUMAR\w*/g },
  { type: 'generic', re: /\bENTRO\b|\bENTR0\b|\bFINE\b|\bVALID\w*/g },
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
    while ((m = k.re.exec(line))) {
      // Le parole dei produttori non contano se fanno parte di una dicitura di scadenza più lunga.
      out.push({ type: k.type, index: m.index, end: m.index + m[0].length });
    }
  }
  // Rimuove le sovrapposizioni lasciando la dicitura più specifica (ordine di KEYWORDS).
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
  // Riduce le diciture di una riga (o di un tratto di riga) a un solo significato.
  const types = kws.map((k) => k.type);
  if (types.includes('best_before')) return 'best_before';
  if (types.includes('use_by')) return 'use_by';
  if (types.includes('use_by_weak')) return 'use_by';
  if (types.includes('production')) return 'production';
  if (types.includes('generic')) return 'generic';
  return null;
}

function year(ys) { return ys.length === 2 ? 2000 + +ys : +ys; }

const PATTERNS = [
  { name: 'full', re: /(^|[^\d])(\d{1,2})\s?[.\/\-]\s?(\d{1,2})\s?[.\/\-]\s?(\d{4}|\d{2})(?!\d)/g,
    build: (m) => ({ d: +m[2], m: +m[3], y: year(m[4]) }), base: 30 },
  { name: 'monthname', re: new RegExp(`(^|[^\\dA-Z])(?:(\\d{1,2})\\s?[.\\/\\-]?\\s?)?(${MONTH_RE})[A-Z]{0,7}\\.?\\s?[.\\/\\-]?\\s?(\\d{4}|\\d{2})(?!\\d)`, 'g'),
    build: (m) => ({ d: m[2] ? +m[2] : null, m: MONTHS[m[3]], y: year(m[4]) }), base: 28 },
  { name: 'monthyear', re: /(^|[^\d.\/\-])(\d{1,2})\s?[.\/\-]\s?(\d{4}|\d{2})(?![\d.\/\-])/g,
    build: (m) => ({ d: null, m: +m[2], y: year(m[3]) }), base: 16 },
  { name: 'spaced', re: /(^|[^\d])(\d{2}) (\d{2}) (\d{4}|\d{2})(?!\d)/g,
    build: (m) => ({ d: +m[2], m: +m[3], y: year(m[4]) }), base: 12, needsKeyword: true },
  { name: 'compact', re: /(^|[^\d])(\d{2})(\d{2})(\d{4}|\d{2})(?!\d)/g,
    build: (m) => ({ d: +m[2], m: +m[3], y: year(m[4]) }), base: 8, needsKeyword: true },
];

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
    const taken = []; // intervalli già usati da pattern più forti
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        const start = m.index + m[1].length;
        const end = m.index + m[0].length;
        p.re.lastIndex = Math.max(end - 1, m.index + 1);
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        if (lots.some(([a, b]) => start < b && end > a)) continue; // numero di lotto: mai come scadenza
        const exp = p.build(m);
        if (!isValidExpiry(exp)) continue;
        if (exp.y < nowY - 2 || exp.y > nowY + 12) continue;

        // Dicitura più vicina prima della data sulla stessa riga, altrimenti righe sopra.
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

        let score = p.base;
        if (isExpiryKw) score += kwType === 'generic' ? [25, 18, 8][kwDist] : [45, 35, 12][kwDist];
        if (kwType === 'production') score -= [60, 25, 10][kwDist];
        const daysLeft = Math.round((expiryEnd(exp) - today) / 86400000);
        if (daysLeft < -1) score -= 20;
        else if (daysLeft <= 900) score += 5;

        const kind = kwType === 'best_before' ? 'best_before' : (kwType === 'use_by' ? 'use_by' : 'unknown');
        const ctxLines = [];
        if (kwDist && kwDist > 0) ctxLines.push(rawLines[i - kwDist]);
        ctxLines.push(rawLines[i]);
        found.push({
          exp, kind, score, pattern: p.name,
          raw: rawLines[i].slice(start, end).trim() || m[0].trim(),
          context: ctxLines.join(' · ').slice(0, 90),
          line: i,
          production: kwType === 'production',
        });
        taken.push([start, end]);
      }
    }
  });

  // Una sola voce per data: tiene il punteggio migliore e la dicitura riconosciuta.
  const byKey = new Map();
  for (const c of found) {
    const key = `${c.exp.y}-${c.exp.m}-${c.exp.d}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, c); continue; }
    const best = c.score > prev.score ? c : prev;
    if (best.kind === 'unknown') best.kind = c.kind !== 'unknown' ? c.kind : prev.kind;
    byKey.set(key, best);
  }
  // Una data solo mese/anno coperta da una data completa dello stesso mese è ridondante.
  const all = [...byKey.values()].filter((c) => !(c.exp.d == null && [...byKey.values()].some((o) => o !== c && o.exp.d != null && o.exp.y === c.exp.y && o.exp.m === c.exp.m && o.line === c.line)));
  all.sort((a, b) => b.score - a.score);
  const plausible = all.filter((c) => c.score >= 15 && !c.production);
  return { candidates: plausible, all, lines: rawLines };
}

// Decide se mostrare la scelta: più di una data plausibile senza un chiaro vincitore.
export function needsChoice(candidates) {
  if (candidates.length <= 1) return false;
  const [a, b] = candidates;
  // Anche con un vincitore netto mostriamo la scelta se le diciture sono diverse e leggibili
  // (es. una "entro" e una "preferibilmente"): l'utente decide quale registrare.
  if (a.kind !== 'unknown' && b.kind !== 'unknown' && a.kind !== b.kind) return true;
  return a.score - b.score < 30;
}
