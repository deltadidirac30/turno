// Tema: chiaro (predefinito), scuro o come il telefono.
const THEME_BG = { light: '#eef3ec', dark: '#141a17' };

export function applyTheme(theme) {
  const th = ['light', 'dark', 'auto'].includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = th;
  const dark = th === 'dark' || (th === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_BG[dark ? 'dark' : 'light']);
}
