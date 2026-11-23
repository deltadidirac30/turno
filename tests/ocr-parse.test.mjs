// Test del parser delle date: node tests/ocr-parse.test.mjs
import { extractDates, needsChoice } from '../js/ocr-parse.js';
const now = new Date(2026, 10, 23);
let fail = 0;
function check(name, text, expect) {
  const r = extractDates(text, { now });
  const got = r.candidates.map((c) => `${c.exp.d ?? '-'}/${c.exp.m ?? '-'}/${c.exp.y}:${c.kind}`);
  const ok = JSON.stringify(got) === JSON.stringify(expect.list) && (expect.choice === undefined || needsChoice(r.candidates) === expect.choice);
  if (!ok) fail++;
  console.log(ok ? 'ok  ' : 'FAIL', name, JSON.stringify(got), 'choice=' + needsChoice(r.candidates));
}
check('use by stessa riga', 'DA CONSUMARSI ENTRO 12/03/2027', { list: ['12/3/2027:use_by'], choice: false });
check('preferibilmente riga sopra', 'Da consumarsi preferibilmente entro:\n05.06.27', { list: ['5/6/2027:best_before'], choice: false });
check('solo mese', 'Da consumarsi preferibilmente entro fine: 03/2028', { list: ['-/3/2028:best_before'], choice: false });
check('lotto ignorato', 'L 120327\nTMC 30/09/2027', { list: ['30/9/2027:best_before'], choice: false });
check('lotto con separatori', 'LOTTO 12.03.27', { list: [] });
check('produzione vs scadenza', 'PROD 01/11/2026 SCAD 12/03/2027', { list: ['12/3/2027:use_by'], choice: false });
check('ocr confuso O e I', 'DA CONSUMARSI ENTRO I2/O3/2O27', { list: ['12/3/2027:use_by'] });
check('due diciture', 'Da consumarsi entro 28/11/2026\nDa consumarsi preferibilmente entro 15/01/2027', { list: ['28/11/2026:use_by', '15/1/2027:best_before'], choice: true });
check('due date senza dicitura', '12/03/2027\n15/04/2027', { list: ['12/3/2027:unknown', '15/4/2027:unknown'], choice: true });
check('mese in lettere', 'Consumare preferibilmente entro 12 MAG 2027', { list: ['12/5/2027:best_before'] });
check('compatta solo con dicitura', 'SCAD 120327', { list: ['12/3/2027:use_by'] });
check('compatta senza dicitura ignorata', '120327 8001234', { list: [] });
check('data impossibile', 'SCAD 31/02/2027', { list: [] });
check('testo vuoto', '', { list: [] });
check('prezzo non e data', 'EUR 1.99 PESO 0.500 KG', { list: [] });
check('lotto L. data dopo', 'L.24310 A\nEXP 11/2027', { list: ['-/11/2027:use_by'] });
process.exit(fail ? 1 : 0);
