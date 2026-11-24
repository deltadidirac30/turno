// Preparazione delle foto per l'OCR delle date stampate (modulo puro, senza DOM).
//
// Le date vere sono sfocate, a punti, su cartone, plastica lucida o metallo, in mezzo ad altre
// scritte. Tesseract legge bene solo righe pulite, quindi qui:
//  1. si rende uniforme la luce (divisione per lo sfondo sfocato) e si stira il contrasto;
//  2. si provano più soglie (Otsu e percentuali di pixel più scuri);
//  3. si chiudono i buchi della stampa a getto d'inchiostro, con un raggio stimato dalla
//     distanza tra i punti;
//  4. si cercano le righe di caratteri (altezze simili, allineate, anche se inclinate);
//  5. ogni riga viene restituita da sola, pulita e alla dimensione adatta a Tesseract.
// Le scritte piccole accanto alla data (ore, lotti in apice) finiscono in righe separate.

export function grayFromRGBA(data, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  return { w, h, g };
}

function boxBlurF(src, w, h, r) {
  // tre passate di sfocatura a scatola separabile ≈ gaussiana
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { b[row + x] = s / win; s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = s / win; s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; }
    }
  }
  return a;
}

function percentile(arr, p) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[arr[i]]++;
  const target = arr.length * p / 100;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

function median3(g, w, h) {
  const out = new Uint8ClampedArray(g.length);
  const v = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
        for (let dx = -1; dx <= 1; dx++) v[k++] = g[yy + Math.min(w - 1, Math.max(0, x + dx))];
      }
      v.sort();
      out[y * w + x] = v[4];
    }
  }
  return out;
}

// Luce uniforme, contrasto stirato, testo scuro su fondo chiaro.
export function flatten({ w, h, g }) {
  const r = Math.max(4, Math.round(h / 26));
  const bg = boxBlurF(g, w, h, r);
  const f = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) f[i] = g[i] / (bg[i] + 1);
  // percentili 1–99 sul rapporto
  const sorted = Float32Array.from(f).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)];
  const span = Math.max(1e-6, hi - lo);
  const out = new Uint8ClampedArray(g.length);
  for (let i = 0; i < f.length; i++) out[i] = ((f[i] - lo) / span) * 255;
  if (percentile(out, 50) < 128) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
  return { w, h, g: median3(out, w, h) };
}

function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = g.length - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = v; }
  }
  return thr;
}

export function threshold(img, mode) {
  const t = mode === 'otsu' ? otsu(img.g) : percentile(img.g, mode);
  const ink = new Uint8Array(img.g.length);
  for (let i = 0; i < ink.length; i++) ink[i] = img.g[i] <= t ? 1 : 0;
  return ink;
}

// Componenti connesse (8-vicini) con statistiche; restituisce anche le etichette.
export function components(ink, w, h) {
  const lab = new Int32Array(w * h);
  const parent = [0];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      const n = [];
      if (x > 0 && lab[i - 1]) n.push(lab[i - 1]);
      if (y > 0) {
        const up = i - w;
        if (lab[up]) n.push(lab[up]);
        if (x > 0 && lab[up - 1]) n.push(lab[up - 1]);
        if (x < w - 1 && lab[up + 1]) n.push(lab[up + 1]);
      }
      if (!n.length) { lab[i] = next; parent.push(next); next++; continue; }
      let m = find(n[0]);
      for (let k = 1; k < n.length; k++) { const r = find(n[k]); if (r !== m) { if (r < m) { parent[m] = r; m = r; } else parent[r] = m; } }
      lab[i] = m;
    }
  }
  const stats = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lab[i]) continue;
      const r = find(lab[i]); lab[i] = r;
      let s = stats.get(r);
      if (!s) { s = { id: r, x0: x, y0: y, x1: x, y1: y, a: 0 }; stats.set(r, s); }
      if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y; s.a++;
    }
  }
  const comps = [...stats.values()].map((s) => ({ id: s.id, x: s.x0, y: s.y0, w: s.x1 - s.x0 + 1, h: s.y1 - s.y0 + 1, a: s.a }));
  return { comps, lab };
}

// Dilatazione/erosione con quadrato (2r+1) via immagine integrale: O(pixel).
function boxMorph(ink, w, h, r, erode) {
  const W = w + 1;
  const I = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += ink[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const s = I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
      out[y * w + x] = erode ? (s === (x1 - x0 + 1) * (y1 - y0 + 1) ? 1 : 0) : (s > 0 ? 1 : 0);
    }
  }
  return out;
}
export function closeInk(ink, w, h, r) {
  if (r <= 0) return ink;
  return boxMorph(boxMorph(ink, w, h, r, false), w, h, r, true);
}

// Stima dimensione e distanza dei punti della stampa a getto: due raggi di chiusura da provare.
export function dotRadii(ink, w, h) {
  const { comps } = components(ink, w, h);
  const dots = comps.filter((c) => c.a > 2 && c.a < 250 && c.w < 3 * c.h && c.h < 3 * c.w);
  if (dots.length < 25) return [0];
  const sizes = dots.map((c) => Math.sqrt(c.a)).sort((a, b) => a - b);
  const size = sizes[sizes.length >> 1];
  const sample = dots.length > 1200 ? dots.filter((_, i) => i % Math.ceil(dots.length / 1200) === 0) : dots;
  const pts = sample.map((c) => [c.x + c.w / 2, c.y + c.h / 2]);
  const nn = pts.map(([x, y], i) => {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) { if (j === i) continue; const d = (pts[j][0] - x) ** 2 + (pts[j][1] - y) ** 2; if (d < best) best = d; }
    return Math.sqrt(best);
  }).sort((a, b) => a - b);
  const sp = nn[nn.length >> 1];
  // la chiusura quadrata è più "forte" del disco: raggi un po' più piccoli
  const r1 = Math.max(1, Math.round(size * 0.6));
  const r2 = Math.max(1, Math.round(Math.min(sp * 0.5, sp * 0.75)));
  if (r2 <= r1 + 1) return [r1];
  const mid = Math.round((r1 + r2) / 2);
  return mid > r1 && mid < r2 ? [r1, mid, r2] : [r1, r2];
}

// Righe di caratteri. minH: altezza minima dei caratteri in pixel.
export function findLines(ink, w, h, { minH = h * 0.07, maxH = h * 0.75 } = {}) {
  const { comps, lab } = components(ink, w, h);
  const big = comps.filter((c) => c.h >= minH && c.h <= maxH && c.w < w * 0.6 && c.a >= 15 && c.w < c.h * 3.5 && c.a / (c.w * c.h) > 0.12)
    .sort((a, b) => a.x - b.x);
  const lines = [];
  for (const c of big) {
    const cy = c.y + c.h / 2;
    let best = null, bd = Infinity;
    for (const L of lines) {
      const last = L.c[L.c.length - 1];
      const ly = last.y + last.h / 2;
      const mh = L.mh;
      const gap = c.x - (last.x + last.w);
      const dy = Math.abs(cy - ly);
      if (dy < 0.45 * mh && c.h / mh > 1 / 1.6 && c.h / mh < 1.6 && gap < 4.2 * mh && gap > -0.3 * mh && dy < bd) { bd = dy; best = L; }
    }
    if (best) { best.c.push(c); const hs = best.c.map((d) => d.h).sort((a, b) => a - b); best.mh = hs[hs.length >> 1]; }
    else lines.push({ c: [c], mh: c.h });
  }
  const areaOf = new Map(comps.map((c) => [c.id, c.a]));
  const out = [];
  for (const L of lines) {
    const n = L.c.length;
    if (n < 2) continue;
    const mh = L.mh;
    const hs = L.c.map((d) => d.h);
    const mean = hs.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(hs.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    const cons = 1 - Math.min(1, sd / mh);
    const fillok = L.c.filter((d) => { const f = d.a / (d.w * d.h); return f > 0.2 && f < 0.85; }).length / n;
    const aspect = L.c.filter((d) => d.h / Math.max(1, d.w) > 0.9 && d.h / Math.max(1, d.w) < 4.5).length / n;
    const score = Math.min(n, 10) * cons * fillok * aspect;
    const x0 = Math.min(...L.c.map((d) => d.x)), x1 = Math.max(...L.c.map((d) => d.x + d.w));
    const y0 = Math.min(...L.c.map((d) => d.y)), y1 = Math.max(...L.c.map((d) => d.y + d.h));
    const members = new Set(L.c.map((d) => d.id));
    // punteggiatura (punti, due punti) solo negli spazi tra un carattere e l'altro, al massimo due
    // per spazio e ben formata: così la grana di plastica e cartone non sporca la riga
    const chars = [...L.c].sort((a, b) => a.x - b.x);
    for (let k = 0; k < chars.length; k++) {
      const left = chars[k], right = chars[k + 1];
      const gx0 = left.x + left.w, gx1 = right ? right.x : left.x + left.w + mh;
      const inGap = comps.filter((t) => !members.has(t.id) && t.x >= gx0 - 1 && t.x + t.w <= gx1 + 1
        && t.h >= 0.08 * mh && t.h < 0.45 * mh && t.w < 0.45 * mh && t.a >= 0.35 * t.w * t.h
        && t.y + t.h / 2 >= Math.min(left.y, right ? right.y : left.y) - 0.05 * mh
        && t.y + t.h / 2 <= Math.max(left.y + left.h, right ? right.y + right.h : 0) + 0.1 * mh)
        .sort((a, b) => b.a - a.a).slice(0, 2);
      inGap.forEach((t) => members.add(t.id));
    }
    // pezzi di caratteri spezzati (stampa a punti, inchiostro mancante): abbastanza grandi e dentro la riga
    for (const t of comps) {
      if (members.has(t.id) || t.x + t.w < x0 - 0.5 * mh || t.x > x1 + 0.5 * mh) continue;
      if (Math.max(t.w, t.h) < 0.25 * mh || t.h > 1.2 * mh || t.a < 0.2 * t.w * t.h) continue;
      let near = chars[0], nd = Infinity;
      for (const d of chars) { const dd = Math.abs(d.x + d.w / 2 - (t.x + t.w / 2)); if (dd < nd) { nd = dd; near = d; } }
      if (t.y >= near.y - 0.15 * mh && t.y + t.h <= near.y + near.h + 0.15 * mh) members.add(t.id);
    }
    const cxs = chars.map((d) => d.x + d.w / 2), cys = chars.map((d) => d.y + d.h / 2);
    const mx = cxs.reduce((a, b) => a + b, 0) / n, my = cys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) { sxy += (cxs[k] - mx) * (cys[k] - my); sxx += (cxs[k] - mx) ** 2; }
    const angle = n >= 3 && sxx > 0 ? Math.atan(sxy / sxx) : 0;
    out.push({ score, n, mh, box: [x0, y0, x1, y1], members, lab, w, h, angle, ink, areaOf, cx: mx, cy: my });
  }
  return out;
}

// Immagine binaria (0 = inchiostro, 255 = fondo) della sola riga, ritagliata con margine.
// Si prende tutto l'inchiostro dentro una fascia che segue l'inclinazione della riga (così i
// pezzi staccati delle cifre a punti non si perdono), scartando solo la grana minuscola.
export function lineBitmap(L, targetH = 44) {
  const { lab, w, ink, areaOf, mh } = L;
  const [x0, y0, x1, y1] = L.box;
  const slope = Math.tan(L.angle || 0);
  const half = 0.62 * mh;
  const minA = Math.max(5, 0.006 * mh * mh);
  const pad = Math.round(mh * 0.4);
  const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(w, x1 + pad), Y1 = Math.min(L.h, y1 + pad);
  const bw = X1 - X0, bh = Y1 - Y0;
  const px = new Uint8ClampedArray(bw * bh).fill(255);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const gx = x + X0, gy = y + Y0, i = gy * w + gx;
      if (!ink[i]) continue;
      if (Math.abs(gy - (L.cy + slope * (gx - L.cx))) > half) continue;
      if (gx < x0 - 0.3 * mh || gx > x1 + 0.3 * mh) continue;
      if ((areaOf.get(lab[i]) || 0) < minA && !L.members.has(lab[i])) continue;
      px[y * bw + x] = 0;
    }
  }
  return { w: bw, h: bh, g: px, scale: targetH / mh, angle: L.angle || 0 };
}

export function overlaps(a, b) {
  const [ax0, ay0, ax1, ay1] = a.box, [bx0, by0, bx1, by1] = b.box;
  const oy = Math.min(ay1, by1) - Math.max(ay0, by0);
  const ox = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  return oy > 0.5 * (ay1 - ay0) && ox > 0.5 * (ax1 - ax0);
}

// Tutte le righe candidate da un'immagine in scala di grigi, senza doppioni, dalla più promettente.
export function candidateLines(gray, { whole = false } = {}) {
  const flat = flatten(gray);
  const { w, h } = flat;
  const opts = whole ? { minH: 12, maxH: h * 0.25 } : {};
  const all = [];
  for (const mode of ['otsu', 6, 10, 15]) {
    const ink0 = threshold(flat, mode);
    for (const r of dotRadii(ink0, w, h)) {
      const ink = closeInk(ink0, w, h, r);
      for (const L of findLines(ink, w, h, opts)) { L.mode = `${mode}/r${r}`; all.push(L); }
    }
  }
  all.sort((a, b) => b.score - a.score);
  // per ogni zona tieni le due versioni migliori (soglie o chiusure diverse leggono cose diverse)
  const keep = [];
  for (const L of all) if (keep.filter((k) => overlaps(L, k)).length < 2) keep.push(L);
  return { lines: keep, flat };
}
