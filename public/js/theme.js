// Runs before first paint so a forced light or dark theme never flashes the wrong colours.
(function () {
  try {
    var theme = localStorage.getItem('plate.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {}
})();
