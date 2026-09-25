/* prism-local Home — project list. Talks only to prism_local/hub.py.
   Loaded after common.js (helpers, theme, presence) and pdf.js. */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.js";
window.name = "prism-home";        // lets the editor's ⌂ button find and reuse this tab

const H = { projects: [], defaultParent: "", git: {}, busy: new Set(), loaded: false };
const thumbs = new Map();          // `${id}:${pdf_mtime}` -> canvas (or null while rendering)

/* ------------------------------------------------------------------ helpers */
function ago(t) {
  if (!t) return "";
  const s = Date.now() / 1000 - t;
  if (s < 60) return "just now";
  const units = [[60, "min"], [3600, "h"], [86400, "d"], [86400 * 30, "mo"], [86400 * 365, "y"]];
  let out = "";
  for (let i = units.length - 1; i >= 0; i--) {
    if (s >= units[i][0]) { out = Math.floor(s / units[i][0]) + " " + units[i][1]; break; }
  }
  return out + " ago";
}
let toastTimer = null;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = err ? "err" : ""; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 7000 : 2600);
}
const byId = (id) => H.projects.find((p) => p.id === id);

$("#btn-theme").onclick = () => {
  const cur = store.get("theme", null);
  const next = cur === null ? "dark" : cur === "dark" ? "light" : null;
  store.set("theme", next); applyTheme(next);
};

/* ------------------------------------------------------------------ data */
async function load() {
  const r = await api("/api/projects").catch(() => null);
  if (!r || r._status !== 200) return;
  delete r._status;
  const sig = JSON.stringify(r);
  if (sig === H.sig) return;          // unchanged: keep the DOM (hover, focus) as it is
  H.sig = sig;
  H.projects = r.projects; H.defaultParent = r.default_parent; H.loaded = true;
  render();
}
async function loadGit(p) {
  if (!p.exists) return;
  const r = await api("/api/git?id=" + encodeURIComponent(p.id)).catch(() => null);
  if (r && r._status === 200) { H.git[p.id] = r.git; const el = document.querySelector(`.card-p[data-id="${p.id}"] .gitchip`); if (el) el.outerHTML = gitChip(p.id); }
}
function loadAllGit() { H.projects.forEach(loadGit); }

/* ------------------------------------------------------------------ render */
function sorted(list) {
  const mode = $("#sort").value;
  const key = {
    opened: (p) => -(p.opened || p.added || 0),
    edited: (p) => -(p.edited || 0),
    name: (p) => p.name.toLowerCase(),
  }[mode];
  return [...list].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
}
function matches(p, q) {
  if (!q) return true;
  const hay = [p.name, p.folder, p.title || "", p.path].join("\n").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}
function gitChip(id) {
  const g = H.git[id];
  if (!g) return `<span class="gitchip"></span>`;
  const extra = [g.changes ? `${g.changes} changed` : "clean", g.ahead ? `↑${g.ahead}` : "", g.behind ? `↓${g.behind}` : ""].filter(Boolean).join(" ");
  return `<span class="gitchip chip ${g.changes ? "dirty" : ""}" title="git: branch ${esc(g.branch)}">⎇ ${esc(g.branch || "—")} · ${esc(extra)}</span>`;
}
function initials(name) {
  const w = name.replace(/[-_.]+/g, " ").trim().split(/\s+/);
  return esc(((w[0] || "?")[0] + (w[1] ? w[1][0] : "")).toUpperCase());
}
function cardHTML(p) {
  const busy = H.busy.has(p.id);
  if (!p.exists) {
    return `<div class="card-p missing" data-id="${p.id}">
      <div class="thumb"><div class="ph"><div class="ini">!</div><small>Folder not found</small></div></div>
      <div class="body"><div class="name" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="path" title="${esc(p.path)}"><bdi>${esc(p.path)}</bdi></div>
        <div class="meta"><span class="chip err">moved or deleted</span></div></div>
      <div class="foot"><button class="open" data-act="remove">Remove from list</button>
        <button class="more" data-act="menu" title="More">⋯</button></div></div>`;
  }
  const title = p.title && p.title.toLowerCase() !== p.name.toLowerCase() ? `<div class="title" title="${esc(p.title)}">${esc(p.title)}</div>` : "";
  const meta = [
    p.edited ? `<span title="Last change to a source file">Edited ${ago(p.edited)}</span>` : "",
    p.files ? `<span>${p.files} file${p.files === 1 ? "" : "s"}</span>` : `<span>no .tex files</span>`,
  ].join("");
  const run = p.running ? `<span class="badge-run" title="${p.running.pages} page(s) open at ${esc(p.running.url)}">Open</span>` : "";
  return `<div class="card-p" data-id="${p.id}">
    <div class="thumb" data-act="open" title="Open ${esc(p.name)}">
      <div class="ph"><div class="ini">${initials(p.name)}</div><small>${p.pdf_mtime ? "" : "No PDF yet"}</small></div>
      ${run}
      <button class="pin ${p.pinned ? "on" : ""}" data-act="pin" title="${p.pinned ? "Unpin" : "Pin to top"}">${p.pinned ? "★" : "☆"}</button>
    </div>
    <div class="body">
      <div class="name" data-act="open" title="${esc(p.name)}">${esc(p.name)}</div>
      ${title}
      <div class="path" title="${esc(p.path)}"><bdi>${esc(p.path)}</bdi></div>
      <div class="meta">${meta}${gitChip(p.id)}</div>
    </div>
    <div class="foot">
      <button class="open ${p.running ? "" : "primary"}" data-act="open" ${busy ? "disabled" : ""}>${busy ? "Starting…" : p.running ? "Show editor" : "Open"}</button>
      <button class="more" data-act="menu" title="More actions">⋯</button>
    </div>
  </div>`;
}
function render() {
  const q = $("#search").value.trim();
  const shown = sorted(H.projects.filter((p) => matches(p, q)));
  const pinned = shown.filter((p) => p.pinned), rest = shown.filter((p) => !p.pinned);
  $("#welcome").hidden = !H.loaded || H.projects.length > 0;
  $("#no-match").hidden = !H.projects.length || shown.length > 0;
  $("#sec-pinned").hidden = !pinned.length;
  $("#sec-all").hidden = !rest.length;
  $("#all-title").textContent = pinned.length ? "Other projects" : "All projects";
  $("#grid-pinned").innerHTML = pinned.map(cardHTML).join("");
  $("#grid-all").innerHTML = rest.map(cardHTML).join("");
  const running = H.projects.filter((p) => p.running).length;
  $("#summary").textContent = H.projects.length
    ? `${H.projects.length} project${H.projects.length === 1 ? "" : "s"}` + (running ? ` · ${running} open` : "")
    : "";
  document.querySelectorAll(".card-p[data-id]").forEach(attachThumb);
}

/* ------------------------------------------------------------------ PDF thumbnails */
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); drawThumb(e.target); }
}, { rootMargin: "200px" });
function attachThumb(card) {
  const p = byId(card.dataset.id);
  if (!p || !p.pdf_mtime) return;
  const c = thumbs.get(`${p.id}:${p.pdf_mtime}`);
  if (c) { placeThumb(card, c); return; }
  io.observe(card);
}
function placeThumb(card, canvas) {
  const box = card.querySelector(".thumb");
  const ph = box && box.querySelector(".ph");
  if (!box) return;
  if (ph) ph.remove();
  if (canvas.parentNode !== box) box.prepend(canvas);
}
async function drawThumb(card) {
  const p = byId(card.dataset.id);
  const key = p && `${p.id}:${p.pdf_mtime}`;
  if (!p || thumbs.has(key)) return;
  thumbs.set(key, null);
  try {
    const data = await fetch(`/api/pdf?id=${encodeURIComponent(p.id)}&t=${p.pdf_mtime}`).then((r) => r.ok ? r.arrayBuffer() : Promise.reject());
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const page = await doc.getPage(1);
    // clientWidth is 0 while the tab is not laid out; fall back to the grid's minimum.
    const cssW = Math.max(120, Math.min((card.querySelector(".thumb").clientWidth || 236) - 36, 210));
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: (cssW / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = cssW + "px"; canvas.style.height = vp.height / dpr + "px";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    doc.destroy();
    for (const k of thumbs.keys()) if (k.startsWith(p.id + ":") && k !== key) thumbs.delete(k);
    thumbs.set(key, canvas);
    const live = document.querySelector(`.card-p[data-id="${p.id}"]`);
    if (live) placeThumb(live, canvas);
  } catch {
    thumbs.delete(key);
  }
}

/* ------------------------------------------------------------------ actions */
async function openProject(id) {
  const p = byId(id);
  if (!p || !p.exists || H.busy.has(id)) return;
  // Open the tab synchronously (inside the click) so the popup blocker allows it, then
  // point it at the editor once its server answers. The tab is named per project, so a
  // second click focuses the editor that is already open instead of opening another.
  const w = window.open("", "prism-" + id);
  let fresh = true;
  try { fresh = w && w.location.href === "about:blank"; } catch { fresh = false; }
  if (w && !fresh && p.running) { w.focus(); return; }
  if (w && fresh) {
    w.document.title = p.name + " · starting…";
    w.document.body.innerHTML = `<p style="font:15px system-ui;color:#6f6a60;margin:40vh auto;text-align:center">Starting prism-local for <b>${esc(p.name)}</b>…</p>`;
  }
  H.busy.add(id); render();
  const r = await api("/api/projects/open", { id }).catch(() => ({ error: "Home server not reachable" }));
  H.busy.delete(id);
  if (r.url) {
    if (w) { w.location.href = r.url; w.focus(); } else { location.href = r.url; }
    p.running = { url: r.url, pages: 0 }; p.opened = Date.now() / 1000;
  } else {
    if (w && fresh) w.close();
    toast(`Could not open ${p.name}: ${r.error || "unknown error"}` + (r.log ? "\n\n" + r.log : ""), true);
  }
  render();
  setTimeout(load, 1500);
}

async function setPinned(id, on) {
  const p = byId(id); if (!p) return;
  p.pinned = on; render();
  const r = await api("/api/projects/update", { id, pinned: on });
  if (r._status !== 200) { toast(r.error || "Could not save", true); load(); }
}
async function removeProject(id) {
  const p = byId(id); if (!p) return;
  if (!confirm(`Remove "${p.name}" from the list?\n\nThe folder and its files are not touched:\n${p.path}`)) return;
  const r = await api("/api/projects/remove", { id });
  if (r._status !== 200) return toast(r.error || "Could not remove", true);
  H.projects = H.projects.filter((x) => x.id !== id); render();
  toast(`Removed ${p.name} from the list`);
}
async function reveal(id) {
  const r = await api("/api/projects/reveal", { id });
  if (r._status !== 200) toast(r.error || "Could not open the folder", true);
}
async function copyPath(id) {
  const p = byId(id); if (!p) return;
  try { await navigator.clipboard.writeText(p.path); toast("Path copied"); } catch { toast(p.path); }
}

/* card clicks */
document.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (!e.target.closest("#menu")) closeMenu();
  if (!act) return;
  const card = act.closest(".card-p");
  const id = card && card.dataset.id;
  switch (act.dataset.act) {
    case "open": return openProject(id);
    case "pin": e.stopPropagation(); return setPinned(id, !byId(id).pinned);
    case "remove": return removeProject(id);
    case "menu": e.stopPropagation(); return showMenu(id, act);
    case "new": return openNew();
    case "add": return openAdd();
  }
});

/* ------------------------------------------------------------------ menu */
function showMenu(id, anchor) {
  const p = byId(id); const m = $("#menu");
  const items = p.exists ? [
    ["open", p.running ? "Show editor" : "Open"],
    ["pin", p.pinned ? "Unpin" : "Pin to top"],
    ["rename", "Rename in list…"],
    "-",
    ["reveal", "Show in folder"],
    ["copy", "Copy path"],
    "-",
    ["remove", "Remove from list…", "danger"],
  ] : [["copy", "Copy path"], "-", ["remove", "Remove from list…", "danger"]];
  m.innerHTML = items.map((it) => it === "-" ? "<hr>" : `<button data-m="${it[0]}" class="${it[2] || ""}" role="menuitem">${esc(it[1])}</button>`).join("");
  m.dataset.id = id; m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + "px";
  m.style.top = (r.bottom + mh + 6 > innerHeight ? r.top - mh - 4 : r.bottom + 4) + "px";
  m.querySelector("button").focus();
}
function closeMenu() { $("#menu").hidden = true; }
$("#menu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-m]"); if (!b) return;
  const id = $("#menu").dataset.id; closeMenu();
  ({
    open: () => openProject(id), pin: () => setPinned(id, !byId(id).pinned), rename: () => openRename(id),
    reveal: () => reveal(id), copy: () => copyPath(id), remove: () => removeProject(id),
  })[b.dataset.m]();
});
window.addEventListener("scroll", closeMenu, { passive: true });
window.addEventListener("resize", closeMenu);

/* ------------------------------------------------------------------ dialogs */
function dlgError(dlg, msg) { const el = dlg.querySelector(".dlg-error"); el.textContent = msg || ""; el.hidden = !msg; }
document.querySelectorAll("dialog [data-close]").forEach((b) => { b.onclick = () => b.closest("dialog").close(); });
document.querySelectorAll("dialog [data-browse]").forEach((b) => {
  b.onclick = async () => {
    const input = b.closest("form").elements[b.dataset.browse];
    b.disabled = true; b.textContent = "Choosing…";
    const r = await api("/api/pick-folder", { start: input.value || H.defaultParent, title: b.closest("dialog").querySelector("h3").textContent });
    b.disabled = false; b.textContent = "Browse…";
    if (r.path) { input.value = r.path; input.dispatchEvent(new Event("input")); }
    else if (r.error) dlgError(b.closest("dialog"), r.error + ". Type the path instead.");
  };
});

const sep = () => (H.defaultParent.includes("\\") ? "\\" : "/");
function updateTarget() {
  const f = $("#form-new");
  const parent = f.elements.parent.value.replace(/[\\/]+$/, "");
  const name = f.elements.name.value.trim();
  $("#new-target").textContent = name && parent ? "Creates " + parent + sep() + name : "";
}
function openNew() {
  const f = $("#form-new"), dlg = $("#dlg-new");
  f.reset();
  f.elements.parent.value = H.defaultParent;
  f.elements.author.value = store.get("home.author", "");
  f.elements.template.value = store.get("home.template", "amsart");
  dlgError(dlg, ""); updateTarget();
  dlg.showModal(); f.elements.name.focus();
}
$("#form-new").addEventListener("input", updateTarget);
$("#form-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, dlg = $("#dlg-new"), btn = f.querySelector("button[type=submit]");
  const body = {
    name: f.elements.name.value.trim(), parent: f.elements.parent.value.trim(),
    title: f.elements.title.value.trim(), author: f.elements.author.value.trim(),
    template: f.elements.template.value, git: f.elements.git.checked,
  };
  store.set("home.author", body.author); store.set("home.template", body.template);
  btn.disabled = true; dlgError(dlg, "");
  const r = await api("/api/projects/create", body);
  btn.disabled = false;
  if (r._status !== 200) return dlgError(dlg, r.error || "Could not create the project");
  dlg.close();
  toast(`Created ${r.path}` + (r.git_note ? `\n${r.git_note}` : ""));
  await load();
  if (f.elements.open.checked) openProject(r.id);
});

function openAdd() {
  const f = $("#form-add"), dlg = $("#dlg-add");
  f.reset(); dlgError(dlg, ""); dlg.showModal(); f.elements.path.focus();
}
$("#form-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const dlg = $("#dlg-add");
  const r = await api("/api/projects/add", { path: e.target.elements.path.value });
  if (r._status !== 200) return dlgError(dlg, r.error || "Could not add the folder");
  dlg.close();
  toast(r.has_tex ? `Added ${r.path}` : `Added ${r.path}\n(no .tex file at its top level yet)`);
  await load(); loadAllGit();
});

function openRename(id) {
  const p = byId(id), f = $("#form-rename");
  f.elements.name.value = p.custom_name ? p.name : "";
  f.elements.name.placeholder = p.folder;
  f.dataset.id = id;
  $("#dlg-rename").showModal(); f.elements.name.select();
}
$("#form-rename").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await api("/api/projects/update", { id: f.dataset.id, name: f.elements.name.value });
  $("#dlg-rename").close();
  if (r._status !== 200) toast(r.error || "Could not rename", true);
  load();
});

$("#btn-new").onclick = openNew;
$("#btn-add").onclick = openAdd;

/* ------------------------------------------------------------------ search, sort, keys */
$("#sort").value = store.get("home.sort", "opened");
$("#sort").onchange = () => { store.set("home.sort", $("#sort").value); render(); };
$("#search").addEventListener("input", render);
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const first = document.querySelector(".card-p:not(.missing)"); if (first) openProject(first.dataset.id); }
  if (e.key === "Escape") { e.target.value = ""; render(); e.target.blur(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
  if (document.querySelector("dialog[open]") || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  if (e.key === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openNew(); }
});

/* ------------------------------------------------------------------ start */
load().then(loadAllGit);
setInterval(() => { if (document.visibilityState === "visible" && !document.querySelector("dialog[open]")) load(); }, 10000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { load(); loadAllGit(); } });
