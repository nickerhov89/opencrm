// Applies the saved theme before the first paint (see src/theme.js), so a dark page never flashes white.
(function () {
  try {
    var saved = localStorage.getItem('opencrm.theme');
    var dark = saved === 'dark' || ((saved === 'auto' || !saved) && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (error) {}
})();
