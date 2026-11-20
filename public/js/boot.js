// Boot loader for the live 3D view (runs before the page body is parsed).
// Matches the loader to the night view chosen before on this device; live-app.js applies the same choice.
try {
  const night = new URLSearchParams(location.search).get('night');
  if (night ? night !== '0' : localStorage.getItem('av_live_theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch {
  // Storage blocked: keep the light loader.
}

// If the app has not started after a while (slow network or a script error), say so instead of spinning forever.
setTimeout(() => {
  const text = document.getElementById('boot-text');
  if (text && document.body?.dataset.ready !== 'true') text.textContent = 'Still loading the 3D view. On a slow connection this can take a little longer. If nothing happens, reload the page.';
}, 20000);
