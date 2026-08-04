/**
 * Sfondo stile XMB PS3 (riferimento MakeAGif Iw2TLH):
 * - un'unica onda a più veli
 * - particelle
 * - gioco blu / rosso brand
 */
(function () {
  "use strict";

  if (!document.body.classList.contains("page-home")) return;
  if (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  var canvas = document.getElementById("xmb-waves");
  if (!canvas) return;
  var ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = 0;
  var h = 0;
  var t = 0;
  var raf = 0;
  var running = true;
  var particles = [];
  var isMobile = false;
  /** Altezza "bloccata": non segue la barra URL durante lo scroll */
  var lockedH = 0;

  // Un'unica onda: lunga e bassa (come XMB), veli leggeri
  var veils = [
    { off: -0.028, phase: 0.0, thick: 0.048, a: 0.2 },
    { off: -0.012, phase: 0.4, thick: 0.058, a: 0.26 },
    { off: 0.0, phase: 0.8, thick: 0.065, a: 0.3 },
    { off: 0.012, phase: 1.2, thick: 0.055, a: 0.24 },
    { off: 0.026, phase: 1.6, thick: 0.045, a: 0.18 },
  ];

  function resize(force) {
    var newW = window.innerWidth;
    var newH = window.innerHeight;
    var mobile = newW < 520;

    // Larghezza invariata e non è un force (orientation):
    // tieni l'altezza bloccata così l'onda non salta con la barra URL.
    if (!force && w > 0 && Math.abs(newW - w) < 2) {
      return;
    }

    // In caso di rotazione / primo avvio: ricalcola e blocca l'altezza
    // al valore più grande tra innerHeight e screen.availHeight*0.9
    // così copre anche quando la chrome UI è nascosta.
    var tall = Math.max(
      newH,
      Math.round((window.screen && screen.availHeight) || newH)
    );

    w = newW;
    h = force || lockedH === 0 ? tall : Math.max(lockedH, tall);
    lockedH = h;
    isMobile = mobile;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuildParticles();
  }

  function rebuildParticles() {
    var n = isMobile ? 55 : 90;
    particles = [];
    for (var i = 0; i < n; i++) {
      particles.push(spawnParticle(true));
    }
  }

  function spawnParticle(anywhere) {
    var nearWave = Math.random() < 0.65;
    var y;
    if (anywhere) {
      y = nearWave
        ? h * (0.44 + Math.random() * 0.18)
        : Math.random() * h;
    } else {
      y = h * (0.4 + Math.random() * 0.25);
    }

    // blu / bianco / rosso
    var roll = Math.random();
    var col;
    if (roll < 0.45) col = [140, 190, 255];
    else if (roll < 0.75) col = [255, 255, 255];
    else col = [255, 150, 160];

    return {
      x: Math.random() * w,
      y: y,
      r: 0.5 + Math.random() * 1.7,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.25,
      tw: Math.random() * Math.PI * 2,
      tws: 0.02 + Math.random() * 0.04,
      a: 0.25 + Math.random() * 0.55,
      col: col,
      life: 0.5 + Math.random() * 0.5,
    };
  }

  /**
   * Onda lunga e bassa (XMB):
   * - frequenza bassa → curve più lunghe
   * - ampiezza ridotta → non alta / non a “montagne”
   */
  function waveY(x, time, phaseExtra) {
    var nx = x / w;
    var base = h * 0.52;
    // bassa: solo una leggera ondulazione
    var amp = h * (isMobile ? 0.045 : 0.055);
    // molto allungata in orizzontale (quasi 1 mezza-onda sullo schermo)
    return (
      base +
      Math.sin(nx * Math.PI * 2 * 0.38 + time * 0.38 + phaseExtra) * amp +
      Math.sin(nx * Math.PI * 2 * 0.72 + time * 0.55 + phaseExtra * 1.2) *
        amp *
        0.28 +
      Math.sin(nx * Math.PI * 2 * 0.18 + time * 0.18) * amp * 0.15
    );
  }

  function drawWave(time) {
    var steps = Math.max(60, Math.floor(w / 8));
    var list = isMobile ? veils.slice(1, 4) : veils;

    ctx.globalCompositeOperation = "lighter";

    for (var v = 0; v < list.length; v++) {
      var veil = list[v];
      var thick = veil.thick * h;

      ctx.beginPath();
      for (var i = 0; i <= steps; i++) {
        var x = (i / steps) * w;
        var y = waveY(x, time, veil.phase) + veil.off * h;
        if (i === 0) ctx.moveTo(x, y - thick * 0.5);
        else ctx.lineTo(x, y - thick * 0.5);
      }
      for (var j = steps; j >= 0; j--) {
        var x2 = (j / steps) * w;
        var y2 = waveY(x2, time, veil.phase) + veil.off * h;
        ctx.lineTo(x2, y2 + thick * 0.5);
      }
      ctx.closePath();

      // gradiente orizzontale blu → bianco → rosso (gioco brand)
      var g = ctx.createLinearGradient(0, 0, w, 0);
      var a = veil.a;
      g.addColorStop(0, "rgba(70, 140, 255," + a * 0.35 + ")");
      g.addColorStop(0.2, "rgba(130, 190, 255," + a + ")");
      g.addColorStop(0.45, "rgba(240, 248, 255," + a * 1.15 + ")");
      g.addColorStop(0.7, "rgba(255, 170, 180," + a + ")");
      g.addColorStop(1, "rgba(230, 80, 90," + a * 0.4 + ")");

      ctx.fillStyle = g;
      ctx.fill();
    }

    // bordo luminoso sottile sull'onda centrale
    ctx.beginPath();
    for (var k = 0; k <= steps; k++) {
      var xx = (k / steps) * w;
      var yy = waveY(xx, time, 0.7);
      if (k === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.globalCompositeOperation = "source-over";
  }

  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.tw += p.tws;

      // leggera attrazione verso l'onda
      var wy = waveY(p.x, t, 0.7);
      p.y += (wy - p.y) * 0.002;

      if (p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) {
        particles[i] = spawnParticle(false);
        p = particles[i];
      }

      var alpha = p.a * (0.45 + 0.55 * Math.abs(Math.sin(p.tw))) * p.life;
      var c = p.col;

      // glow soft
      if (!isMobile && p.r > 1.1) {
        var grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        grd.addColorStop(0, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha * 0.35 + ")");
        grd.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.fillStyle =
        "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")";
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame(now) {
    if (!running) return;
    t = now * 0.001;
    ctx.clearRect(0, 0, w, h);

    // alone centrale soft
    var glow = ctx.createRadialGradient(
      w * 0.5,
      h * 0.52,
      0,
      w * 0.5,
      h * 0.52,
      Math.max(w, h) * 0.55
    );
    glow.addColorStop(0, "rgba(100, 150, 255, 0.08)");
    glow.addColorStop(0.5, "rgba(180, 60, 80, 0.04)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    drawWave(t);
    drawParticles();

    raf = requestAnimationFrame(frame);
  }

  function onVis() {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      raf = requestAnimationFrame(frame);
    }
  }

  var rt = 0;
  window.addEventListener(
    "resize",
    function () {
      clearTimeout(rt);
      // resize "soft": solo se cambia la larghezza
      rt = setTimeout(function () {
        resize(false);
      }, 120);
    },
    { passive: true }
  );
  // Rotazione: force, ricalcola altezza bloccata
  window.addEventListener(
    "orientationchange",
    function () {
      lockedH = 0;
      setTimeout(function () {
        resize(true);
      }, 200);
    },
    { passive: true }
  );
  document.addEventListener("visibilitychange", onVis);

  resize(true);
  raf = requestAnimationFrame(frame);
})();
