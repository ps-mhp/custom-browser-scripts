let keepAlive = setInterval(function() {
  (function findAndClick(root) {
    Array.from(root.querySelectorAll('*')).forEach(function(el) {
      Array.from(el.childNodes).forEach(function(node) {
        if (node.nodeType === 3 && node.textContent.trim() === 'Weiterarbeiten') {
          console.log(new Date().toLocaleTimeString(), '- Session verlängert!');
          el.click();
        }
      });
      if (el.shadowRoot) findAndClick(el.shadowRoot);
    });
  })(document);
}, 10000);

console.log('Keepalive aktiv! Stop mit: clearInterval(' + keepAlive + ')');
