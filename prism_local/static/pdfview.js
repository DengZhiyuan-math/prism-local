/* PDF.js viewer shared by the editor's inline pane and the pop-out tab.
   Expects #pdf-scroll > #pdf-pages, #pdf-empty, #zoom-in/-out/-fit, #zoom-label, #page-label. */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.js";

const PV = {
  pdf: null, mtime: null, scale: 0, eff: 1, views: [], scaleKey: "scale",
  onInverse: null,              // ({page, x, y}) in PDF points from the top-left
  observer: null, seq: 0,

  init(opts) {
    Object.assign(this, opts);
    this.scale = store.get(this.scaleKey, 0);
    const sc = $("#pdf-scroll");
    sc.addEventListener("scroll", () => this.updatePageLabel());
    $("#zoom-in").onclick = () => this.setZoom(Math.min(4, this.eff * 1.15));
    $("#zoom-out").onclick = () => this.setZoom(Math.max(0.3, this.eff / 1.15));
    $("#zoom-fit").onclick = () => this.setZoom(0);
    let t = null;
    new ResizeObserver(() => { if (!this.scale) { clearTimeout(t); t = setTimeout(() => this.layout(true), 150); } }).observe(sc);
    sc.addEventListener("dblclick", (e) => {
      const div = e.target.closest(".pdf-page"); if (!div || !this.onInverse) return;
      const rect = div.getBoundingClientRect();
      this.onInverse({ page: +div.dataset.page, x: (e.clientX - rect.left) / this.eff, y: (e.clientY - rect.top) / this.eff });
    });
  },

  async load(mtime) {
    const seq = ++this.seq;
    let data;
    try {
      const res = await fetch("/pdf?t=" + mtime);
      if (!res.ok) return;
      data = new Uint8Array(await res.arrayBuffer());
    } catch { return; }
    const doc = await pdfjsLib.getDocument({ data }).promise.catch(() => null);
    if (!doc || seq !== this.seq) return;
    const old = this.pdf;
    this.pdf = doc; this.mtime = mtime;
    await this.layout(true);
    if (old) old.destroy();
  },

  async layout(keepScroll) {
    if (!this.pdf) return;
    const sc = $("#pdf-scroll");
    if (!sc.clientWidth) return;                 // hidden (e.g. popped out)
    const ratio = keepScroll && sc.scrollHeight > 0 ? sc.scrollTop / sc.scrollHeight : 0;
    const pages = [];
    for (let i = 1; i <= this.pdf.numPages; i++) pages.push(await this.pdf.getPage(i));
    const fit = Math.max(0.3, Math.min(4, (sc.clientWidth - 28) / pages[0].getViewport({ scale: 1 }).width));
    const scale = this.scale || fit;
    this.eff = scale;
    $("#zoom-label").textContent = Math.round(scale * 100) + "%";
    const wrap = document.createElement("div");
    wrap.id = "pdf-pages";
    this.views = pages.map((page, idx) => {
      const vp = page.getViewport({ scale });
      const div = document.createElement("div");
      div.className = "pdf-page"; div.style.width = vp.width + "px"; div.style.height = vp.height + "px";
      div.dataset.page = idx + 1;
      wrap.appendChild(div);
      return { page, vp, div, rendered: false };
    });
    $("#pdf-pages").replaceWith(wrap);
    $("#pdf-empty").hidden = true;
    sc.scrollTop = ratio * sc.scrollHeight;
    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.render(this.views[+e.target.dataset.page - 1]);
    }, { root: sc, rootMargin: "600px 0px" });
    this.views.forEach((pv) => this.observer.observe(pv.div));
    this.updatePageLabel();
  },

  async render(pv) {
    if (!pv || pv.rendered) return;
    pv.rendered = true;
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(pv.vp.width * dpr); canvas.height = Math.floor(pv.vp.height * dpr);
    canvas.style.width = pv.vp.width + "px"; canvas.style.height = pv.vp.height + "px";
    await pv.page.render({ canvasContext: canvas.getContext("2d"), viewport: pv.vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise.catch(() => {});
    pv.div.prepend(canvas);
  },

  updatePageLabel() {
    if (!this.views.length) return;
    const sc = $("#pdf-scroll"), mid = sc.scrollTop + sc.clientHeight / 3;
    let cur = 1;
    for (const pv of this.views) if (pv.div.offsetTop <= mid) cur = +pv.div.dataset.page;
    $("#page-label").textContent = `${cur} / ${this.views.length}`;
  },

  setZoom(s) { this.scale = s; store.set(this.scaleKey, s); this.layout(true); },

  // Scroll to and flash a SyncTeX box {page, x, y, w, h} (PDF points, top-left origin).
  highlight(r) {
    const pv = this.views[r.page - 1]; if (!pv) return;
    const s = this.eff, sc = $("#pdf-scroll");
    sc.scrollTop = pv.div.offsetTop + r.y * s - sc.clientHeight / 3;
    const hl = document.createElement("div");
    hl.className = "sync-hl";
    Object.assign(hl.style, { left: (r.x - 2) * s + "px", top: (r.y - 2) * s + "px", width: (r.w + 4) * s + "px", height: (r.h + 4) * s + "px" });
    pv.div.appendChild(hl);
    setTimeout(() => hl.remove(), 2400);
  },
};
