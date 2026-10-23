// Apply before the body is parsed to avoid flashing the wrong theme on startup.
(() => {
  const key = 'flow-sentinel-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (['light', 'dark', 'system'].includes(saved)) preference = saved;
  } catch { /* Storage may be unavailable; the current session still works. */ }
  function apply() {
    document.documentElement.dataset.theme = preference === 'system'
      ? (system.matches ? 'dark' : 'light') : preference;
  }
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('themeSelect');
    select.value = preference;
    select.addEventListener('change', () => {
      preference = select.value;
      apply();
      try { localStorage.setItem(key, preference); } catch { /* Session-only fallback. */ }
    });
  });
})();
