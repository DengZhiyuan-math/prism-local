/* Shared by the editor (app.js) and the pop-out PDF viewer (viewer.js). */
"use strict";

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem("prism." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("prism." + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "X-Prism-Local": "1" },
    body: JSON.stringify(body),
  };
  const r = await fetch(path, opts);
  let data = {};
  try { data = await r.json(); } catch { /* non-JSON */ }
  data._status = r.status;
  return data;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* theme */
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) document.documentElement.dataset.dark = ""; else delete document.documentElement.dataset.dark;
}
applyTheme(store.get("theme", null));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(store.get("theme", null)));

// Editor tab <-> pop-out PDF tab. Messages:
//   viewer -> editor: {type:"alive"} (heartbeat), {type:"bye"}, {type:"inverse", page, x, y}
//   editor -> viewer: {type:"forward", r} (SyncTeX box), {type:"pdf", mtime}
const pdfChannel = "BroadcastChannel" in window ? new BroadcastChannel("prism-pdf") : null;

/* Page presence. Every page (editor, pop-out PDF) sends a heartbeat so a server started
   with --exit-when-idle knows it is in use, and says goodbye when it closes. The goodbye
   goes through sendBeacon, which survives page unload but cannot set X-Prism-Local; the
   server accepts it only for a page id that has sent a heartbeat. */
(function presence() {
  const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  let fails = 0, banner = null;

  function showGone(on) {
    if (on && !banner) {
      banner = document.createElement("div");
      banner.id = "server-gone";
      banner.setAttribute("role", "alert");
      banner.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" +
        "justify-content:center;background:rgba(0,0,0,.45)";
      banner.innerHTML = '<div style="background:var(--panel,#fff);color:var(--text,#111);' +
        'border:1px solid var(--border,#ccc);border-radius:8px;padding:18px 22px;max-width:420px;' +
        'font:14px/1.5 var(--sans,system-ui)"><b>prism-local is not running.</b><br>' +
        "The server stopped, probably because every Prism page was closed. " +
        "Start it again from its shortcut; this page reconnects by itself.</div>";
      document.body.appendChild(banner);
    } else if (!on && banner) {
      banner.remove(); banner = null;
    }
  }

  async function beat() {
    try {
      const r = await api("/api/presence", { client: id });
      fails = r._status === 200 ? 0 : fails + 1;
    } catch { fails += 1; }
    showGone(fails >= 3);
  }

  // The open stream is what keeps the server alive: when this page, its tab or the
  // whole browser closes, the connection drops and the server notices at once, even
  // if the goodbye below never gets out. EventSource reconnects by itself.
  let stream = null;
  function hold() {
    if (!("EventSource" in window) || stream) return;
    stream = new EventSource("/api/presence/stream?client=" + encodeURIComponent(id));
  }

  window.addEventListener("pagehide", () => {
    if (stream) { stream.close(); stream = null; }
    navigator.sendBeacon("/api/bye", id);
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) { hold(); beat(); } });   // back/forward cache
  hold();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") beat(); });
  beat();
  setInterval(beat, 5000);
})();
