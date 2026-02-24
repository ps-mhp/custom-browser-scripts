(function() {
  function loadScript(src, config) {
    if (config) Object.assign(window, config);
    let s = document.createElement('script');
    s.src = src + '?t=' + Date.now();
    document.head.appendChild(s);
  }

  loadScript('https://cdn.jsdelivr.net/gh/ps-mhp/custom-browser-scripts@main/dist/sap/keepalive.js');
  loadScript('https://cdn.jsdelivr.net/gh/ps-mhp/custom-browser-scripts@main/dist/sap/stundenrechner.js');
})();
