/**
 * Easter egg: 7 tap sul logo → sparisce l'UI, resta solo l'onda XMB
 * Un altro tap (o Escape) ripristina l'interfaccia.
 */
(function () {
  "use strict";

  if (!document.body.classList.contains("page-home")) return;

  var logo = document.getElementById("logo-easter");
  if (!logo) return;

  var taps = 0;
  var lastTap = 0;
  var WINDOW_MS = 2800;
  var NEED = 7;
  var locked = false;

  function enterXmbOnly() {
    if (document.body.classList.contains("xmb-only")) return;
    document.body.classList.add("xmb-only");
    // accessibilità: niente focus su elementi nascosti
    var home = document.querySelector(".home");
    if (home) home.setAttribute("aria-hidden", "true");
    taps = 0;
  }

  function exitXmbOnly() {
    if (!document.body.classList.contains("xmb-only")) return;
    document.body.classList.remove("xmb-only");
    var home = document.querySelector(".home");
    if (home) home.removeAttribute("aria-hidden");
    taps = 0;
  }

  logo.addEventListener(
    "click",
    function (e) {
      e.preventDefault();
      e.stopPropagation();

      // Se già in modalità XMB, un tap in qualsiasi punto ripristina (gestito sotto)
      if (document.body.classList.contains("xmb-only")) return;

      var now = Date.now();
      if (now - lastTap > WINDOW_MS) taps = 0;
      lastTap = now;
      taps += 1;

      // micro feedback leggero
      logo.classList.remove("logo-tap-pop");
      // force reflow
      void logo.offsetWidth;
      logo.classList.add("logo-tap-pop");

      if (taps >= NEED) {
        taps = 0;
        enterXmbOnly();
      }
    },
    { passive: false }
  );

  // Ripristino: tap sullo sfondo / Escape
  document.addEventListener(
    "click",
    function (e) {
      if (!document.body.classList.contains("xmb-only")) return;
      // evita doppio trigger immediato dal 7° tap
      if (locked) return;
      exitXmbOnly();
    },
    true
  );

  // blocca per un attimo il click che attiva xmb-only
  var observer = new MutationObserver(function () {
    if (document.body.classList.contains("xmb-only")) {
      locked = true;
      setTimeout(function () {
        locked = false;
      }, 450);
    }
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") exitXmbOnly();
  });
})();
