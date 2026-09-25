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
