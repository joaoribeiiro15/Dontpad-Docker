// Applies the saved theme and editor font before the first paint (loaded as a blocking script).
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem('openpad:theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    if (localStorage.getItem('openpad:mono') === '1') root.setAttribute('data-mono', '1');
  } catch (e) {
    // Storage blocked: the system theme is used.
  }
})();
