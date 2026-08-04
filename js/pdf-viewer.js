/**
 * PDF.js 6.1.200 — continuous scroll + zoom
 *
 * Zoom architecture:
 * ──────────────────
 * • Idle: native scroll, pages at committed zoom
 * • Gesture (pinch / wheel): live CSS layout resize (no transform)
 *   → focal point locked under fingers, no GPU-layer tear-down
 * • Commit: layout already final → optional sharp re-render via
 *   double-buffer canvas swap (old bitmap stays until new is ready)
 *
 * Interactions: pinch, double-tap, Ctrl/Cmd+wheel
 * Hardening: PDF path allowlist, %PDF magic, isEvalSupported off
 */
import * as pdfjsLib from "../assets/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../assets/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

/* ─── config ─────────────────────────────────────────────── */
const PDF_ALLOW = Object.freeze({
  "./assets/PlanningSP.pdf": "Planning-Sporting.pdf",
  "./assets/PlanningHB.pdf": "Planning-HB.pdf",
});
const PDF_NAME_RE = /^[A-Za-z0-9._-]{1,80}\.pdf$/;

const MIN_ZOOM = 1;
const MAX_ZOOM = 3.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 32; // px
const DOUBLE_TAP_ZOOM = 2.25;
const PAGE_GAP = 12; // fixed gap (px) between pages — does NOT scale
const WHEEL_STEP = 0.12; // relative zoom per wheel tick
const WHEEL_SETTLE_MS = 120; // commit after wheel stops
const MAX_PAGES = 80;
const MAX_CANVAS_EDGE = 4096;

/* ─── helpers ────────────────────────────────────────────── */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function readConfig() {
  const body = document.body;
  if (!body) return null;
  const pdf = (body.getAttribute("data-pdf") || "").trim();
  if (!Object.prototype.hasOwnProperty.call(PDF_ALLOW, pdf)) {
    console.error("PDF path not in allowlist.");
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

/* ─── boot ───────────────────────────────────────────────── */
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

  if (!scrollEl) {
    showFail("Impossibile aprire il planning. Riprova più tardi.");
    return;
  }
  if (location.protocol === "file:") {
    showFail(
      "Apri il sito tramite server o GitHub Pages. Puoi usare Scarica PDF."
    );
    return;
  }

  /* ── state ─────────────────────────────────────────────── */
  const state = {
    pdf: null,
    pages: [], // { num, el, canvas, nativeW, nativeH, rendered, busy, gen }
    layer: null,
    baseWidth: 0, // fit-width of container at zoom 1
    width: 0, // current page CSS width = baseWidth * zoom
    zoom: 1, // committed zoom
    dpr: Math.min(window.devicePixelRatio || 1, 2.5),
    ready: false,
    gen: 0, // increments on every commit → invalidates in-flight renders
    committing: false, // true while layout+render of a commit is running
    pdfBytes: null,
    blobUrl: null,
  };

  /* gesture (null when idle) */
  let gesture = null;
  /*
    gesture = {
      kind: 'pinch' | 'wheel',
      scale: 1,
      // Anchor relative to a page — survives height rounding / gap changes
      pageIdx, relX, relY,
      viewX, viewY,     // viewport target for the anchor
      startDist: 0,     // pinch only
      settleTimer: 0,   // wheel only
    }
  */

  /* double-tap tracking */
  let lastTapTs = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  /* rAF handles */
  let scrollRaf = 0;
  let gestureRaf = 0;
  let pendingGestureFrame = false;

  /* ── UI helpers ────────────────────────────────────────── */
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

  /* ── download / fallback ───────────────────────────────── */
  function storePdfBytes(data) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data));
    state.pdfBytes = copy.buffer;
    if (state.blobUrl) {
      try {
        URL.revokeObjectURL(state.blobUrl);
      } catch (_) {}
      state.blobUrl = null;
    }
    const file = new File([state.pdfBytes], cfg.name, {
      type: "application/pdf",
    });
    state.blobUrl = URL.createObjectURL(file);
    armDownloads();
  }

  function revokeBlob() {
    if (!state.blobUrl) return;
    try {
      URL.revokeObjectURL(state.blobUrl);
    } catch (_) {}
    state.blobUrl = null;
  }
  window.addEventListener("pagehide", revokeBlob);
  window.addEventListener("beforeunload", revokeBlob);

  function armDownloads() {
    if (!state.blobUrl) return;
    ["hdr-dl", "fb-dl"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const neu = el.cloneNode(true);
      el.parentNode.replaceChild(neu, el);
      neu.setAttribute("href", state.blobUrl);
      neu.setAttribute("download", cfg.name);
      neu.removeAttribute("target");
      neu.removeAttribute("role");
      neu.addEventListener("click", (e) => {
        if (!state.pdfBytes) return;
        if (
          window.navigator &&
          typeof navigator.msSaveOrOpenBlob === "function"
        ) {
          e.preventDefault();
          navigator.msSaveOrOpenBlob(
            new Blob([state.pdfBytes], { type: "application/pdf" }),
            cfg.name
          );
        }
      });
    });
  }

  function wireFallback() {
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

  /* ── geometry ──────────────────────────────────────────── */
  function containerWidth() {
    const cs = getComputedStyle(scrollEl);
    const pad =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    let w = Math.floor(scrollEl.clientWidth - pad);
    if (w < 120) w = Math.min(window.innerWidth - 24, 980);
    return Math.max(260, w);
  }

  function pageHeight(entry) {
    if (!entry.nativeW || !entry.nativeH) {
      return Math.round(state.width * (842 / 595));
    }
    return Math.max(
      1,
      Math.round((entry.nativeH * state.width) / entry.nativeW)
    );
  }

  /* ── build DOM ─────────────────────────────────────────── */
  function buildPages(n) {
    const total = Math.min(n, MAX_PAGES);
    scrollEl.innerHTML = "";
    state.pages = [];
    const layer = document.createElement("div");
    layer.className = "pdf-zoom-layer";
    state.layer = layer;

    const frag = document.createDocumentFragment();
    for (let i = 1; i <= total; i++) {
      const wrap = document.createElement("div");
      wrap.className = "pdf-page";
      wrap.dataset.page = String(i);
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      wrap.appendChild(canvas);
      frag.appendChild(wrap);
      state.pages.push({
        num: i,
        el: wrap,
        canvas,
        nativeW: 0,
        nativeH: 0,
        rendered: false,
        busy: false,
        gen: -1,
      });
    }
    layer.appendChild(frag);
    scrollEl.appendChild(layer);
  }

  function loadNativeSizes() {
    return Promise.all(
      state.pages.map((entry) =>
        state.pdf.getPage(entry.num).then((page) => {
          const vp = page.getViewport({ scale: 1 });
          entry.nativeW = vp.width;
          entry.nativeH = vp.height;
          try {
            page.cleanup();
          } catch (_) {}
        })
      )
    );
  }

  /* ── layout (sync, no render) ──────────────────────────── */
  function currentGap() {
    return Math.max(4, Math.round(PAGE_GAP * state.zoom));
  }

  function layoutPages() {
    if (!state.layer) return;
    state.layer.style.width = state.width + "px";
    state.layer.style.transform = "";
    state.layer.style.transformOrigin = "";
    state.layer.style.willChange = "";

    const gap = currentGap();
    const last = state.pages.length - 1;
    for (let i = 0; i < state.pages.length; i++) {
      const e = state.pages[i];
      const h = pageHeight(e);
      e.el.style.width = state.width + "px";
      e.el.style.height = h + "px";
      e.el.style.marginBottom = i === last ? "0" : gap + "px";
      // Always stretch current bitmap to the new CSS size.
      // Old pixels stay visible (slightly soft) until a sharp re-render swaps in.
      if (e.canvas) {
        e.canvas.style.width = state.width + "px";
        e.canvas.style.height = h + "px";
      }
    }
  }

  /* ── render one page (double-buffer swap → no white flash) ─ */
  function renderPage(entry) {
    if (!entry || !state.pdf || entry.busy) return Promise.resolve();
    if (entry.rendered && entry.gen === state.gen) return Promise.resolve();

    entry.busy = true;
    const myGen = state.gen;

    return state.pdf
      .getPage(entry.num)
      .then((page) => {
        if (myGen !== state.gen) return;

        const unscaled = page.getViewport({ scale: 1 });
        if (!entry.nativeW) {
          entry.nativeW = unscaled.width;
          entry.nativeH = unscaled.height;
        }

        const scale = state.width / unscaled.width;
        const viewport = page.getViewport({ scale });

        // DPR: lower at high zoom to stay under GPU limits
        let dpr = state.dpr;
        if (state.zoom > 1.8) dpr = Math.min(dpr, 2);
        if (state.zoom > 2.6) dpr = Math.min(dpr, 1.5);

        let bw = Math.floor(viewport.width * dpr);
        let bh = Math.floor(viewport.height * dpr);
        if (bw > MAX_CANVAS_EDGE || bh > MAX_CANVAS_EDGE) {
          const f = MAX_CANVAS_EDGE / Math.max(bw, bh);
          bw = Math.floor(bw * f);
          bh = Math.floor(bh * f);
          dpr *= f;
        }

        const cssH = Math.round(viewport.height);

        // Draw into a NEW canvas so the old one stays visible until swap
        const fresh = document.createElement("canvas");
        fresh.className = "pdf-canvas";
        fresh.width = bw;
        fresh.height = bh;
        fresh.style.width = state.width + "px";
        fresh.style.height = cssH + "px";

        const ctx = fresh.getContext("2d", { alpha: false });
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, viewport.width, viewport.height);

        return page
          .render({ canvasContext: ctx, canvas: fresh, viewport })
          .promise.then(() => {
            if (myGen !== state.gen) return;
            // Atomic swap — browser never shows a blank frame
            entry.el.style.width = state.width + "px";
            entry.el.style.height = cssH + "px";
            const prev = entry.canvas;
            if (prev && prev.parentNode) {
              prev.parentNode.replaceChild(fresh, prev);
            } else {
              entry.el.appendChild(fresh);
            }
            entry.canvas = fresh;
            entry.rendered = true;
            entry.gen = myGen;
            try {
              page.cleanup();
            } catch (_) {}
          });
      })
      .catch(() => {})
      .then(() => {
        entry.busy = false;
        // If a newer commit landed while we were busy, redo
        if (entry.gen !== state.gen && !entry.busy) {
          entry.rendered = false;
          return renderPage(entry);
        }
      });
  }

  /**
   * Paint pages near the viewport.
   * @param {boolean} [force] — allow while committing (used by commitZoom)
   */
  function paintVisible(force) {
    if (!state.pages.length || gesture) return Promise.resolve();
    if (state.committing && !force) return Promise.resolve();

    const top = scrollEl.scrollTop;
    const vh = scrollEl.clientHeight || window.innerHeight;
    const margin = vh * 1.5;
    const jobs = [];

    for (let i = 0; i < state.pages.length; i++) {
      const e = state.pages[i];
      const et = e.el.offsetTop;
      const eh = e.el.offsetHeight || 1;
      const near = et + eh > top - margin && et < top + vh + margin;
      const needs = !e.rendered || e.gen !== state.gen;
      if ((near || e.num <= 2) && needs && !e.busy) {
        jobs.push(renderPage(e));
      }
    }
    return Promise.all(jobs).then(updateLabel);
  }

  /* ── background spiral render ──────────────────────────── */
  function warmCache() {
    if (!state.pdf || !state.pages.length || gesture || state.committing)
      return;

    const n = state.pages.length;
    const center = currentPageIndex();
    const order = [center];
    const seen = new Set([center]);
    for (let d = 1; order.length < n; d++) {
      if (center + d < n && !seen.has(center + d)) {
        order.push(center + d);
        seen.add(center + d);
      }
      if (center - d >= 0 && !seen.has(center - d)) {
        order.push(center - d);
        seen.add(center - d);
      }
    }

    let i = 0;
    function step() {
      if (!state.pdf || gesture || state.committing || i >= order.length)
        return;
      const e = state.pages[order[i++]];
      if (e && (!e.rendered || e.gen !== state.gen) && !e.busy) {
        renderPage(e).then(() => setTimeout(step, 18));
      } else {
        setTimeout(step, 0);
      }
    }
    setTimeout(step, 30);
  }

  /* ── page label ────────────────────────────────────────── */
  function currentPageIndex() {
    if (!state.pages.length) return 0;
    const mid = scrollEl.scrollTop + (scrollEl.clientHeight || 1) * 0.3;
    let cur = 0;
    for (let i = 0; i < state.pages.length; i++) {
      if (state.pages[i].el.offsetTop <= mid) cur = i;
    }
    return cur;
  }

  function updateLabel() {
    if (!pageLabel || !state.pages.length) return;
    const cur = currentPageIndex() + 1;
    pageLabel.textContent = cur + " / " + state.pages.length;
    pageLabel.hidden = false;
  }

  /* ── focal-point helpers ───────────────────────────────── */

  /**
   * Convert a point in scrollEl viewport coords → layer local coords.
   * During a live gesture the layout is already scaled, so the result
   * is in live-layout coords; at gesture start (scale≈1) that equals
   * committed coords, which is what we store as the focal point.
   */
  function viewportToLayer(vx, vy) {
    if (!state.layer) return { x: 0, y: 0 };
    const layerLeft = state.layer.offsetLeft || 0;
    const layerTop = state.layer.offsetTop || 0;
    return {
      x: scrollEl.scrollLeft + vx - layerLeft,
      y: scrollEl.scrollTop + vy - layerTop,
    };
  }

  /**
   * Find which page contains a layer-Y coordinate and the relative offset.
   */
  function anchorAtLayerPoint(lx, ly) {
    const gap = currentGap();
    let pageIdx = 0;
    for (let i = 0; i < state.pages.length; i++) {
      const el = state.pages[i].el;
      const top = el.offsetTop;
      const h = el.offsetHeight || 1;
      if (ly >= top && ly < top + h + gap) {
        pageIdx = i;
        return {
          pageIdx,
          relY: clamp((ly - top) / h, 0, 1),
          relX:
            state.width > 0
              ? clamp((lx - (el.offsetLeft || 0)) / state.width, 0, 1)
              : 0.5,
        };
      }
      if (ly >= top) pageIdx = i;
    }
    return {
      pageIdx: Math.max(0, state.pages.length - 1),
      relY: 1,
      relX: 0.5,
    };
  }

  function restoreAnchor(anchor, viewX, viewY) {
    if (!anchor || !state.pages.length || !state.layer) return;
    const entry = state.pages[anchor.pageIdx];
    if (!entry) return;
    void state.layer.offsetHeight; // force layout
    const top = entry.el.offsetTop;
    const h = entry.el.offsetHeight || pageHeight(entry);
    const targetY = top + anchor.relY * h - viewY;
    const targetX =
      (entry.el.offsetLeft || 0) + anchor.relX * state.width - viewX;
    scrollEl.scrollTop = Math.max(0, targetY);
    scrollEl.scrollLeft = Math.max(0, targetX);
  }

  /* ── live layout zoom (no CSS transform → no GPU flash) ── */

  /**
   * Resize page boxes for the current gesture scale, then pin the
   * anchored page-relative point under the fingers / cursor.
   *
   * Using pageIdx + relY (instead of absolute Y * scale) avoids
   * vertical jitter from per-page height rounding and fixed gaps.
   */
  function applyLiveLayout() {
    if (!gesture || !state.layer) return;

    const s = gesture.scale;
    const liveWidth = Math.max(
      260,
      Math.round(state.baseWidth * state.zoom * s)
    );
    // Gap scales with zoom so the document grows uniformly
    const liveGap = Math.max(4, Math.round(PAGE_GAP * s));

    state.layer.style.width = liveWidth + "px";

    const last = state.pages.length - 1;
    for (let i = 0; i < state.pages.length; i++) {
      const e = state.pages[i];
      const h =
        e.nativeW && e.nativeH
          ? Math.max(1, Math.round((e.nativeH * liveWidth) / e.nativeW))
          : Math.round(liveWidth * (842 / 595));
      e.el.style.width = liveWidth + "px";
      e.el.style.height = h + "px";
      e.el.style.marginBottom = i === last ? "0" : liveGap + "px";
      if (e.canvas) {
        e.canvas.style.width = liveWidth + "px";
        e.canvas.style.height = h + "px";
      }
    }

    // Force layout so offsetTop is current, then pin anchor
    void state.layer.offsetHeight;
    pinAnchor(gesture.pageIdx, gesture.relX, gesture.relY, gesture.viewX, gesture.viewY, liveWidth);
  }

  /** Place (pageIdx, relX, relY) under viewport point (viewX, viewY). */
  function pinAnchor(pageIdx, relX, relY, viewX, viewY, width) {
    const entry = state.pages[pageIdx];
    if (!entry) return;
    const top = entry.el.offsetTop;
    const h = entry.el.offsetHeight || 1;
    const left = entry.el.offsetLeft || 0;
    const w = width || state.width || 1;
    scrollEl.scrollTop = Math.max(0, top + relY * h - viewY);
    scrollEl.scrollLeft = Math.max(0, left + relX * w - viewX);
  }

  /** Restore committed layout after a cancelled / tiny gesture */
  function revertLiveLayout() {
    layoutPages();
  }

  /* ── commit zoom ───────────────────────────────────────── */

  /**
   * Bake the live layout into committed state.
   * Layout is already at the right size (applyLiveLayout did it),
   * so we only update state and optionally re-rasterize pages.
   */
  function commitZoom() {
    if (!gesture) return Promise.resolve();

    const prevZoom = state.zoom;
    const s = gesture.scale;
    const finalZoom = clamp(prevZoom * s, MIN_ZOOM, MAX_ZOOM);
    const viewX = gesture.viewX;
    const viewY = gesture.viewY;
    const pageIdx = gesture.pageIdx;
    const relX = gesture.relX;
    const relY = gesture.relY;

    if (gesture.settleTimer) clearTimeout(gesture.settleTimer);
    gesture = null;

    // Tiny movement → snap back to committed layout
    if (Math.abs(finalZoom - prevZoom) < 0.02) {
      revertLiveLayout();
      void state.layer.offsetHeight;
      pinAnchor(pageIdx, relX, relY, viewX, viewY, state.width);
      return Promise.resolve();
    }

    const ratio = finalZoom / prevZoom;
    const needsResample = ratio < 0.88 || ratio > 1.12;

    state.committing = true;
    state.zoom = finalZoom;
    state.baseWidth = containerWidth();
    state.width = Math.max(260, Math.round(state.baseWidth * state.zoom));

    // Sync layout exactly (PAGE_GAP back to constant, widths exact)
    layoutPages();
    void state.layer.offsetHeight;
    pinAnchor(pageIdx, relX, relY, viewX, viewY, state.width);
    updateLabel();

    if (!needsResample) {
      state.committing = false;
      return Promise.resolve();
    }

    // Re-rasterize AFTER the stretched frame has been painted
    state.gen += 1;
    for (let i = 0; i < state.pages.length; i++) {
      state.pages[i].rendered = false;
    }

    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve(
            paintVisible(true)
              .then(() => {
                pinAnchor(pageIdx, relX, relY, viewX, viewY, state.width);
                updateLabel();
              })
              .then(() => {
                state.committing = false;
                warmCache();
              })
              .catch(() => {
                state.committing = false;
              })
          );
        });
      });
    });
  }

  /**
   * Programmatic zoom (double-tap). Same path: layout first, optional resample.
   */
  function zoomTo(targetZoom, viewX, viewY) {
    targetZoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(targetZoom - state.zoom) < 0.02) return Promise.resolve();
    if (state.committing || gesture) return Promise.resolve();

    const pt = viewportToLayer(viewX, viewY);
    const anchor = anchorAtLayerPoint(pt.x, pt.y);
    const ratio = targetZoom / state.zoom;
    const needsResample = ratio < 0.88 || ratio > 1.12;

    state.committing = true;
    state.zoom = targetZoom;
    state.baseWidth = containerWidth();
    state.width = Math.max(260, Math.round(state.baseWidth * state.zoom));

    layoutPages();
    void state.layer.offsetHeight;
    pinAnchor(anchor.pageIdx, anchor.relX, anchor.relY, viewX, viewY, state.width);
    updateLabel();

    if (!needsResample) {
      state.committing = false;
      return Promise.resolve();
    }

    state.gen += 1;
    for (let i = 0; i < state.pages.length; i++) {
      state.pages[i].rendered = false;
    }

    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve(
            paintVisible(true)
              .then(() => {
                pinAnchor(
                  anchor.pageIdx,
                  anchor.relX,
                  anchor.relY,
                  viewX,
                  viewY,
                  state.width
                );
                updateLabel();
              })
              .then(() => {
                state.committing = false;
                warmCache();
              })
              .catch(() => {
                state.committing = false;
              })
          );
        });
      });
    });
  }

  /* ── gesture: pinch ────────────────────────────────────── */
  function onTouchStart(e) {
    if (!state.ready || state.committing) return;

    if (e.touches.length === 2) {
      if (gesture && gesture.kind === "wheel") {
        clearTimeout(gesture.settleTimer);
        commitZoom();
      }

      const rect = scrollEl.getBoundingClientRect();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const viewX = (t0.clientX + t1.clientX) / 2 - rect.left;
      const viewY = (t0.clientY + t1.clientY) / 2 - rect.top;
      const dist = Math.hypot(
        t0.clientX - t1.clientX,
        t0.clientY - t1.clientY
      );
      const focal = viewportToLayer(viewX, viewY);
      const anchor = anchorAtLayerPoint(focal.x, focal.y);

      gesture = {
        kind: "pinch",
        scale: 1,
        pageIdx: anchor.pageIdx,
        relX: anchor.relX,
        relY: anchor.relY,
        viewX,
        viewY,
        startDist: dist,
        settleTimer: 0,
      };
      lastTapTs = 0;
    }
  }

  function onTouchMove(e) {
    if (!gesture || gesture.kind !== "pinch" || e.touches.length !== 2) return;
    e.preventDefault();

    const t0 = e.touches[0];
    const t1 = e.touches[1];
    const dist = Math.hypot(
      t0.clientX - t1.clientX,
      t0.clientY - t1.clientY
    );
    if (gesture.startDist < 10) return;

    const rect = scrollEl.getBoundingClientRect();
    gesture.viewX = (t0.clientX + t1.clientX) / 2 - rect.left;
    gesture.viewY = (t0.clientY + t1.clientY) / 2 - rect.top;

    const raw = dist / gesture.startDist;
    const desiredZoom = clamp(state.zoom * raw, MIN_ZOOM, MAX_ZOOM);
    gesture.scale = desiredZoom / state.zoom;

    if (!pendingGestureFrame) {
      pendingGestureFrame = true;
      gestureRaf = requestAnimationFrame(() => {
        pendingGestureFrame = false;
        if (gesture) applyLiveLayout();
      });
    }
  }

  function onTouchEnd(e) {
    if (gesture && gesture.kind === "pinch" && e.touches.length < 2) {
      cancelAnimationFrame(gestureRaf);
      pendingGestureFrame = false;
      if (gesture) applyLiveLayout();
      commitZoom();
      return;
    }

    // Double-tap
    if (
      e.touches.length === 0 &&
      e.changedTouches.length === 1 &&
      !gesture &&
      !state.committing
    ) {
      const t = e.changedTouches[0];
      const now = Date.now();
      const rect = scrollEl.getBoundingClientRect();
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;
      const dt = now - lastTapTs;
      const dist = Math.hypot(x - lastTapX, y - lastTapY);

      if (dt > 0 && dt < DOUBLE_TAP_MS && dist < DOUBLE_TAP_DIST) {
        lastTapTs = 0;
        const target =
          state.zoom < (MIN_ZOOM + DOUBLE_TAP_ZOOM) / 2
            ? DOUBLE_TAP_ZOOM
            : MIN_ZOOM;
        zoomTo(target, x, y);
      } else {
        lastTapTs = now;
        lastTapX = x;
        lastTapY = y;
      }
    }
  }

  /* ── gesture: wheel ────────────────────────────────────── */
  function onWheel(e) {
    if (!state.ready || state.committing) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();

    const rect = scrollEl.getBoundingClientRect();
    const viewX = e.clientX - rect.left;
    const viewY = e.clientY - rect.top;

    if (!gesture || gesture.kind !== "wheel") {
      if (gesture) commitZoom();

      const focal = viewportToLayer(viewX, viewY);
      const anchor = anchorAtLayerPoint(focal.x, focal.y);
      gesture = {
        kind: "wheel",
        scale: 1,
        pageIdx: anchor.pageIdx,
        relX: anchor.relX,
        relY: anchor.relY,
        viewX,
        viewY,
        startDist: 0,
        settleTimer: 0,
      };
    } else {
      gesture.viewX = viewX;
      gesture.viewY = viewY;
    }

    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = 1 + WHEEL_STEP * direction;
    const desiredZoom = clamp(
      state.zoom * gesture.scale * factor,
      MIN_ZOOM,
      MAX_ZOOM
    );
    gesture.scale = desiredZoom / state.zoom;

    if (!pendingGestureFrame) {
      pendingGestureFrame = true;
      gestureRaf = requestAnimationFrame(() => {
        pendingGestureFrame = false;
        if (gesture) applyLiveLayout();
      });
    }

    clearTimeout(gesture.settleTimer);
    gesture.settleTimer = setTimeout(() => {
      cancelAnimationFrame(gestureRaf);
      pendingGestureFrame = false;
      if (gesture) applyLiveLayout();
      commitZoom();
    }, WHEEL_SETTLE_MS);
  }

  /* ── scroll / resize ───────────────────────────────────── */
  function onScroll() {
    if (scrollRaf || gesture || state.committing) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      paintVisible();
    });
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (gesture || state.committing || !state.ready) return;
      const base = containerWidth();
      if (Math.abs(base - state.baseWidth) < 6) return;

      const ax = (scrollEl.clientWidth || 0) / 2;
      const ay = (scrollEl.clientHeight || 0) / 2;
      const pt = viewportToLayer(ax, ay);
      const anchor = anchorAtLayerPoint(pt.x, pt.y);

      state.baseWidth = base;
      state.width = Math.max(260, Math.round(base * state.zoom));
      state.gen += 1;
      for (let i = 0; i < state.pages.length; i++) {
        state.pages[i].rendered = false;
      }
      layoutPages();
      void state.layer.offsetHeight;
      restoreAnchor(anchor, ax, ay);
      paintVisible().then(() => warmCache());
    }, 180);
  }

  /* ── load PDF ──────────────────────────────────────────── */
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error("timeout"));
        }
      }, ms);
      promise.then(
        (v) => {
          if (!done) {
            done = true;
            clearTimeout(t);
            resolve(v);
          }
        },
        (e) => {
          if (!done) {
            done = true;
            clearTimeout(t);
            reject(e);
          }
        }
      );
    });
  }

  wireFallback();
  setStatus("Caricamento planning…");

  const safety = setTimeout(() => {
    if (!state.ready) {
      fail("Caricamento non riuscito. Usa Scarica PDF oppure riprova.");
    }
  }, 25000);

  withTimeout(
    fetch(cfg.pdf, { credentials: "same-origin", cache: "no-store" }),
    15000
  )
    .then((res) => {
      if (!res.ok) throw new Error("fetch");
      const ct = (res.headers.get("content-type") || "").toLowerCase();
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

      return withTimeout(
        pdfjsLib.getDocument({
          data: data.slice(0),
          verbosity: 0,
          isEvalSupported: false,
          useSystemFonts: true,
        }).promise,
        20000
      );
    })
    .then((pdf) => {
      state.pdf = pdf;
      state.baseWidth = containerWidth();
      state.zoom = 1;
      state.width = state.baseWidth;
      buildPages(pdf.numPages);
      setStatus("Misura pagine…");
      return loadNativeSizes();
    })
    .then(() => {
      layoutPages();
      return renderPage(state.pages[0]);
    })
    .then(() => {
      state.ready = true;
      clearTimeout(safety);
      hideLoading();
      updateLabel();
      return paintVisible();
    })
    .then(() => {
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
      scrollEl.addEventListener("touchstart", onTouchStart, { passive: true });
      scrollEl.addEventListener("touchmove", onTouchMove, { passive: false });
      scrollEl.addEventListener("touchend", onTouchEnd, { passive: true });
      scrollEl.addEventListener("touchcancel", onTouchEnd, { passive: true });
      scrollEl.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener("resize", onResize, { passive: true });
      window.addEventListener("orientationchange", onResize, {
        passive: true,
      });
      warmCache();
    })
    .catch(() => {
      clearTimeout(safety);
      fail(
        "Impossibile aprire il planning. Prova Scarica PDF oppure riprova più tardi."
      );
    });
}
