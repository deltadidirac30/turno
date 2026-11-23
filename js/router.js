// Navigazione con hash (#/...): funziona su qualsiasi hosting statico, anche in sottocartella.
let depth = 0; // passaggi fatti dentro l'app in questa sessione

export function noteNavigation() { depth++; }

export function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function back(fallback = '#/') {
  if (depth > 0) { depth -= 2; history.back(); } // -2: il ritorno genera a sua volta un hashchange
  else navigate(fallback, { replace: true });
}
