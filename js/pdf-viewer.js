/**
 * PDF.js 6.1.200 (legacy, self-hosted) — fit-width + scroll continuo
 * Hardening: allowlist path esatta, magic %PDF, isEvalSupported off
 */
import * as pdfjsLib from "../assets/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../assets/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

/** Solo i due planning previsti (niente path generici o sottocartelle) */
const PDF_ALLOW = Object.freeze({
  "./assets/PlanningSP.pdf": "Planning-Sporting.pdf",
  "./assets/PlanningHB.pdf": "Planning-HB.pdf",
});
const PDF_NAME_RE = /^[A-Za-z0-9._-]{1,80}\.pdf$/;

function readConfig() {
  const body = document.body;
  if (!body) return null;
  const pdf = (body.getAttribute("data-pdf") || "").trim();
  if (!Object.prototype.hasOwnProperty.call(PDF_ALLOW, pdf)) {
    console.error("Config PDF non valida (path non in allowlist).");
    return null;
  }
  let name = (body.getAttribute("data-pdf-name") || PDF_ALLOW[pdf]).trim();
  if (!PDF_NAME_RE.test(name)) name = PDF_ALLOW[pdf];
  return { pdf, name };
}

function showFail(msg) {
  const loading = document.getElementById("loading");
  const fallback = document.getElementById("fallback");
  const scrollEl = document.getElementById("pdf-scroll");
  if (loading) {
    loading.classList.add("is-off");
    loading.style.display = "none";
  }
  if (fallback) {
    fallback.classList.add("is-on");
    const p = fallback.querySelector("[data-fallback-msg]");
    if (p && msg) p.textContent = msg;
  }
  if (scrollEl) scrollEl.hidden = true;
}

const cfg = readConfig();
if (!cfg) {
  showFail("Impossibile aprire il planning. Riprova più tardi.");
} else {
  boot(cfg);
}

function boot(cfg) {
  const scrollEl = document.getElementById("pdf-scroll");
  const loading = document.getElementById("loading");
  const pageLabel = document.getElementById("page-label");
  const loadText = loading ? loading.querySelector("p") : null;

  const state = {
    pdf: null,
    pages: [],
    width: 0,
    dpr: Math.min(window.devicePixelRatio || 1, 2.5),
    ready: false,
    /** ArrayBuffer già caricato: download senza secondo fetch (gesture ok) */
    pdfBytes: null,
    blobUrl: null,
  };

  function setStatus(msg) {
    if (loadText) loadText.textContent = msg;
  }

  function hideLoading() {
    if (!loading) return;
    loading.classList.add("is-off");
    loading.style.display = "none";
  }

  function fail(msg) {
    showFail(msg);
  }

  function storePdfBytes(data) {
    // Copia indipendente (PDF.js può transferire/svuotare il buffer originale)
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data));
    state.pdfBytes = copy.buffer;
    if (state.blobUrl) {
      try {
        URL.revokeObjectURL(state.blobUrl);
      } catch (e) {}
      state.blobUrl = null;
    }
    // Blob “file-like” — i browser rispettano meglio download=
    const file = new File([state.pdfBytes], cfg.name, {
      type: "application/pdf",
    });
    state.blobUrl = URL.createObjectURL(file);
    armNativeDownloadLinks();
  }

  function revokeBlobUrl() {
    if (!state.blobUrl) return;
    try {
      URL.revokeObjectURL(state.blobUrl);
    } catch (e) {}
    state.blobUrl = null;
  }

  window.addEventListener("pagehide", revokeBlobUrl);
  window.addEventListener("beforeunload", revokeBlobUrl);

  /**
   * Link nativi <a download href="blob:…"> senza preventDefault:
   * è il metodo più affidabile su Chrome/Edge/Firefox.
   */
  function armNativeDownloadLinks() {
    if (!state.blobUrl) return;
    ["hdr-dl", "fb-dl"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      // togli listener vecchi clonando il nodo
      const neu = el.cloneNode(true);
      el.parentNode.replaceChild(neu, el);
      neu.setAttribute("href", state.blobUrl);
      neu.setAttribute("download", cfg.name);
      neu.removeAttribute("target");
      neu.removeAttribute("role");
      // click extra: se il browser ignora download, forza via File API
      neu.addEventListener("click", (e) => {
        if (!state.pdfBytes) return;
        // Lascia pure il comportamento nativo; in più tenta msSaveBlob / picker
        if (window.navigator && typeof navigator.msSaveOrOpenBlob === "function") {
          e.preventDefault();
          const blob = new Blob([state.pdfBytes], {
            type: "application/pdf",
          });
          navigator.msSaveOrOpenBlob(blob, cfg.name);
        }
      });
    });
  }

  function wireFallback() {
    // finché i byte non sono pronti: link file diretto con download=
    ["hdr-dl", "fb-dl"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.setAttribute("href", cfg.pdf);
      el.setAttribute("download", cfg.name);
      el.removeAttribute("target");
    });
    const open = document.getElementById("fb-open");
    if (open && Object.prototype.hasOwnProperty.call(PDF_ALLOW, cfg.pdf)) {
      open.setAttribute("href", cfg.pdf);
      open.setAttribute("target", "_blank");
      open.setAttribute("rel", "noopener noreferrer");
    }
  }

  function containerWidth() {
    if (!scrollEl) return Math.min(window.innerWidth - 20, 980);
    const cs = getComputedStyle(scrollEl);
    const pad =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    let w = Math.floor(scrollEl.clientWidth - pad);
    if (w < 120) w = Math.min(window.innerWidth - 24, 980);
    return Math.max(260, w);
  }

  function buildPages(n) {
    const maxPages = 80;
    const total = Math.min(n, maxPages);
    scrollEl.innerHTML = "";
    state.pages = [];
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= total; i++) {
      const wrap = document.createElement("div");
      wrap.className = "pdf-page";
      wrap.setAttribute("data-page", String(i));
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      wrap.appendChild(canvas);
      frag.appendChild(wrap);
      state.pages.push({
        num: i,
        el: wrap,
        canvas,
        rendered: false,
        busy: false,
      });
    }
    scrollEl.appendChild(frag);
  }

  function renderPage(entry) {
    if (!entry || !state.pdf || entry.busy || entry.rendered) {
      return Promise.resolve();
    }
    entry.busy = true;
    return state.pdf
      .getPage(entry.num)
      .then((page) => {
        const unscaled = page.getViewport({ scale: 1 });
        const scale = state.width / unscaled.width;
        const viewport = page.getViewport({ scale });
        const canvas = entry.canvas;
        const ctx = canvas.getContext("2d", { alpha: false });
        let dpr = state.dpr;

        let w = Math.floor(viewport.width * dpr);
        let h = Math.floor(viewport.height * dpr);
        const maxEdge = 4096;
        if (w > maxEdge || h > maxEdge) {
          const f = maxEdge / Math.max(w, h);
          w = Math.floor(w * f);
          h = Math.floor(h * f);
          dpr = dpr * f;
        }

        canvas.width = w;
        canvas.height = h;
        canvas.style.width = state.width + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";
        entry.el.style.height = Math.floor(viewport.height) + "px";

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, viewport.width, viewport.height);

        // PDF.js 6.x: canvas + canvasContext + viewport
        return page
          .render({
            canvasContext: ctx,
            canvas,
            viewport,
          })
          .promise.then(() => {
            entry.rendered = true;
            try {
              page.cleanup();
            } catch (e) {}
          });
      })
      .catch(() => {})
      .then(() => {
        entry.busy = false;
      });
  }

  function sizePlaceholders() {
    return state.pdf.getPage(1).then((page) => {
      const unscaled = page.getViewport({ scale: 1 });
      const scale = state.width / unscaled.width;
      const vp = page.getViewport({ scale });
      const h = Math.floor(vp.height);
      state.pages.forEach((e) => {
        if (!e.rendered) {
          e.el.style.height = h + "px";
          e.canvas.style.width = state.width + "px";
          e.canvas.style.height = h + "px";
        }
      });
    });
  }

  function updateLabel() {
    if (!pageLabel || !state.pages.length) return;
    const mid = scrollEl.scrollTop + (scrollEl.clientHeight || 1) * 0.28;
    let cur = 1;
    for (let i = 0; i < state.pages.length; i++) {
      if (state.pages[i].el.offsetTop <= mid) cur = state.pages[i].num;
    }
    pageLabel.textContent = cur + " / " + state.pages.length;
    pageLabel.hidden = false;
  }

  function paintNear() {
    if (!state.pages.length) return Promise.resolve();
    const top = scrollEl.scrollTop;
    const vh = scrollEl.clientHeight || window.innerHeight;
    const margin = vh * 1.6;
    const jobs = [];
    for (let i = 0; i < state.pages.length; i++) {
      const e = state.pages[i];
      const et = e.el.offsetTop;
      const eh = e.el.offsetHeight || 1;
      const near = et + eh > top - margin && et < top + vh + margin;
      if ((near || e.num <= 2) && !e.rendered && !e.busy) {
        jobs.push(renderPage(e));
      }
    }
    return Promise.all(jobs).then(updateLabel);
  }

  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      paintNear();
    });
  }

  let resizeT = 0;
  function onResize() {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const w = containerWidth();
      if (Math.abs(w - state.width) < 12) return;
      state.width = w;
      state.pages.forEach((p) => {
        p.rendered = false;
      });
      sizePlaceholders().then(paintNear);
    }, 200);
  }

  function timeout(p, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("timeout"));
      }, ms);
      p.then(
        (v) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  wireFallback();

  if (!scrollEl) {
    fail("Impossibile aprire il planning. Riprova più tardi.");
    return;
  }

  if (location.protocol === "file:") {
    fail("Apri il sito tramite server o GitHub Pages. Puoi usare Scarica PDF.");
    return;
  }

  const safety = setTimeout(() => {
    if (!state.ready) {
      fail("Caricamento non riuscito. Usa Scarica PDF oppure riprova.");
    }
  }, 25000);

  setStatus("Caricamento planning…");

  timeout(
    fetch(cfg.pdf, { credentials: "same-origin", cache: "no-store" }),
    15000
  )
    .then((res) => {
      if (!res.ok) throw new Error("fetch");
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      // Rifiuta HTML mascherato (GH Pages a volte omette CT → decide magic %PDF)
      if (ct && ct.indexOf("text/html") !== -1) throw new Error("type");
      setStatus("Preparazione…");
      return res.arrayBuffer();
    })
    .then((data) => {
      if (!data || data.byteLength < 100) throw new Error("empty");
      const head = new Uint8Array(data.slice(0, 5));
      const magic = String.fromCharCode(
        head[0],
        head[1],
        head[2],
        head[3],
        head[4]
      );
      if (magic.indexOf("%PDF") !== 0) throw new Error("magic");

      storePdfBytes(data);

      const task = pdfjsLib.getDocument({
        // altra copia per il worker
        data: data.slice(0),
        verbosity: 0,
        isEvalSupported: false,
        useSystemFonts: true,
      });
      return timeout(task.promise, 20000);
    })
    .then((pdf) => {
      state.pdf = pdf;
      state.width = containerWidth();
      buildPages(pdf.numPages);
      return sizePlaceholders();
    })
    .then(() => renderPage(state.pages[0]))
    .then(() => {
      state.ready = true;
      clearTimeout(safety);
      hideLoading();
      updateLabel();
      return paintNear();
    })
    .then(() => {
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onResize, { passive: true });
      window.addEventListener("orientationchange", onResize, { passive: true });

      let i = 1;
      function next() {
        if (!state.pdf || i >= state.pages.length) return;
        const e = state.pages[i++];
        renderPage(e).then(() => setTimeout(next, 24));
      }
      setTimeout(next, 60);
    })
    .catch(() => {
      clearTimeout(safety);
      fail(
        "Impossibile aprire il planning. Prova Scarica PDF oppure riprova più tardi."
      );
    });
}
