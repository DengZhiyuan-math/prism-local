/* Pop-out PDF viewer: reloads on every build, SyncTeX both ways via pdfChannel. */
"use strict";

PV.init({ scaleKey: "scale.popout" });

let editorSeen = 0;
function note(msg, warn) {
  const n = $("#viewer-note");
  n.textContent = msg; n.className = warn ? "warn" : "";
}
const DEFAULT_NOTE = "Double-click to jump to the source in the editor tab";

PV.onInverse = (p) => {
  if (!pdfChannel) return note("This browser cannot talk to the editor tab (no BroadcastChannel).", true);
  pdfChannel.postMessage({ type: "inverse", ...p });
  if (Date.now() - editorSeen > 6000) note("No editor tab found — open the editor tab to jump to sources.", true);
};

async function checkPdf() {
  const r = await api("/api/pdfstat").catch(() => null);
  if (r && r.mtime && r.mtime !== PV.mtime) await PV.load(r.mtime);
}

if (pdfChannel) {
  pdfChannel.onmessage = async (ev) => {
    const m = ev.data || {};
    editorSeen = Date.now();
    if (m.type === "pdf" && m.mtime !== PV.mtime) await PV.load(m.mtime);
    else if (m.type === "forward") {
      await checkPdf();
      PV.highlight(m.r);
      window.focus();
    }
  };
  // Hold this lock while the tab lives: the browser drops it when the tab closes or
  // crashes, which is how the editor knows the viewer is gone (see app.js).
  if (navigator.locks && navigator.locks.request)
    navigator.locks.request("prism-pdf-viewer", () => new Promise(() => {}));
  const alive = () => pdfChannel.postMessage({ type: "alive" });
  alive(); setInterval(alive, 2000);
  window.addEventListener("pagehide", () => pdfChannel.postMessage({ type: "bye" }));
}
// Theme changes made in the editor tab apply here too.
window.addEventListener("storage", (e) => { if (e.key === "prism.theme") applyTheme(store.get("theme", null)); });

note(DEFAULT_NOTE);
checkPdf();
setInterval(checkPdf, 2000);
