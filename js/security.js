/**
 * Hardening lato client (GitHub Pages non espone header HTTP custom).
 * - Anti-clickjacking best-effort (frame busting)
 * - Blocca UI se non si può uscire dal frame
 */
(function () {
  "use strict";

  function lockUi() {
    try {
      document.documentElement.style.display = "none";
    } catch (e) {}
  }

  try {
    if (window.top !== window.self) {
      try {
        window.top.location.replace(window.self.location.href);
      } catch (e) {
        lockUi();
      }
      // Se dopo un attimo siamo ancora framed, nascondi tutto
      setTimeout(function () {
        try {
          if (window.top !== window.self) lockUi();
        } catch (e2) {
          lockUi();
        }
      }, 80);
    }
  } catch (e) {
    lockUi();
  }

  // Evita che la pagina resti usabile se aperta in contesto opaco/sandbox
  try {
    if (window.frameElement) {
      try {
        window.top.location.replace(window.self.location.href);
      } catch (e3) {
        lockUi();
      }
    }
  } catch (e4) {
    /* cross-origin frameElement access: ok */
  }
})();
