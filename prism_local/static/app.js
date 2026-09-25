/* prism-local — editor client. Talks only to prism_local/server.py.
   Loaded after common.js (helpers, theme) and pdfview.js (PV). */
"use strict";

/* ------------------------------------------------------------------ state */
const S = {
  files: [], order: [], tabs: [], active: null, symbols: { labels: [], bibkeys: [], outline: [], macros: [] },
  diagnostics: [], pdfMtime: null, building: false,
};

/* ------------------------------------------------------------------ theme */
$("#btn-theme").onclick = () => {
  const cur = store.get("theme", null);
  const next = cur === null ? "dark" : cur === "dark" ? "light" : null;
  store.set("theme", next); applyTheme(next);
};

/* ------------------------------------------------------------------ home */
// The Home page (hub.py) lists all projects. Its tab calls itself "prism-home", so this
// finds and reuses it when it opened us; the server starts the Home page if needed.
$("#btn-home").onclick = async () => {
  const w = window.open("", "prism-home");
  let fresh = true;
  try { fresh = !!w && w.location.href === "about:blank"; } catch { fresh = false; }
  if (w && fresh) w.document.body.innerHTML = '<p style="font:15px system-ui;color:#6f6a60;margin:40vh auto;text-align:center">Opening your projects…</p>';
  const r = await api("/api/home", {}).catch(() => ({ error: "server not reachable" }));
  if (r.url) {
    // An existing Home tab only needs to load again if its server had to be restarted.
    if (!w) location.href = r.url;
    else { if (fresh || r.started) w.location.href = r.url; w.focus(); }
  } else {
    if (w && fresh) w.close();
    alert("Could not open the Home page: " + (r.error || "unknown error") + (r.log ? "\n\n" + r.log : ""));
  }
};

/* ------------------------------------------------------------------ editor */
const cm = CodeMirror($("#editor"), {
  lineNumbers: true, lineWrapping: true, matchBrackets: true, autoCloseBrackets: "()[]{}$$",
  styleActiveLine: true, indentUnit: 2, tabSize: 2, indentWithTabs: false,
  extraKeys: {
    "Cmd-S": () => saveActive(), "Ctrl-S": () => saveActive(),
    "Cmd-Enter": () => compile(), "Ctrl-Enter": () => compile(),
    "Cmd-J": () => forwardSync(), "Ctrl-J": () => forwardSync(),
    "Ctrl-Space": (ed) => showCompletions(ed, true),
    "Cmd-/": "toggleTexComment", "Ctrl-/": "toggleTexComment",
    Tab: (ed) => ed.somethingSelected() ? ed.indentSelection("add") : ed.replaceSelection("  "),
  },
});
CodeMirror.commands.toggleTexComment = (ed) => {
  const from = ed.getCursor("from").line, to = ed.getCursor("to").line;
  const lines = []; for (let l = from; l <= to; l++) lines.push(ed.getLine(l));
  const allC = lines.every((t) => /^\s*%/.test(t) || !t.trim());
  ed.operation(() => {
    for (let l = from; l <= to; l++) {
      const t = ed.getLine(l);
      if (allC) { const m = t.match(/^(\s*)% ?/); if (m) ed.replaceRange(m[1], { line: l, ch: 0 }, { line: l, ch: m[0].length }); }
      else if (t.trim()) ed.replaceRange("% ", { line: l, ch: t.match(/^\s*/)[0].length });
    }
  });
};
cm.getWrapperElement().style.display = "none";
cm.on("change", () => { const t = activeTab(); if (t) renderTabs(); });
cm.on("inputRead", (ed, ch) => { if (/[{,]/.test(ch.text.join("")) || /\\[A-Za-z]*$/.test(lineBefore(ed))) showCompletions(ed, false); });

function modeFor(path) { return path.endsWith(".md") ? "markdown" : "stex"; }
function activeTab() { return S.tabs.find((t) => t.path === S.active) || null; }
function isDirty(t) { return !t.doc.isClean(t.gen); }

async function openFile(path, line) {
  let t = S.tabs.find((x) => x.path === path);
  if (!t) {
    const r = await api("/api/file?path=" + encodeURIComponent(path));
    if (r._status !== 200) return toast(`Cannot open ${path}: ${r.error || r._status}`);
    const doc = CodeMirror.Doc(r.content, modeFor(path));
    t = { path, doc, mtime: r.mtime, gen: doc.changeGeneration(true) };
    S.tabs.push(t);
  }
  S.active = path;
  cm.swapDoc(t.doc);
  cm.getWrapperElement().style.display = "";
  $("#empty-editor").hidden = true;
  applyDiagnostics();
  renderTabs(); renderTree(); showBanner(t);
  persistSession(); if (typeof updateCtxLabel === "function") updateCtxLabel();
  if (line) jumpToLine(line);
  cm.focus();
  cm.refresh();
}

function jumpToLine(line) {
  const l = Math.max(0, Math.min(line - 1, cm.lineCount() - 1));
  cm.setCursor({ line: l, ch: 0 });
  const top = cm.charCoords({ line: l, ch: 0 }, "local").top;
  cm.scrollTo(null, top - cm.getScrollInfo().clientHeight / 3);
  const h = cm.addLineClass(l, "background", "cm-line-flash");
  setTimeout(() => cm.removeLineClass(h, "background", "cm-line-flash"), 1400);
}

function closeTab(path) {
  const t = S.tabs.find((x) => x.path === path);
  if (t && isDirty(t) && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
  S.tabs = S.tabs.filter((x) => x.path !== path);
  if (S.active === path) {
    const next = S.tabs[S.tabs.length - 1];
    if (next) return openFile(next.path);
    S.active = null; cm.getWrapperElement().style.display = "none"; $("#empty-editor").hidden = false;
  }
  renderTabs(); renderTree(); persistSession();
}

function renderTabs() {
  $("#tabs").innerHTML = S.tabs.map((t) => `
    <div class="tab ${t.path === S.active ? "active" : ""} ${isDirty(t) ? "dirty" : ""}" data-path="${esc(t.path)}" title="${esc(t.path)}">
      <span class="name">${esc(t.path.split("/").pop())}</span><span class="close" data-close="${esc(t.path)}">×</span>
    </div>`).join("");
}
$("#tabs").addEventListener("click", (e) => {
  const c = e.target.closest("[data-close]"); if (c) { e.stopPropagation(); return closeTab(c.dataset.close); }
  const t = e.target.closest(".tab"); if (t) openFile(t.dataset.path);
});
$("#tabs").addEventListener("auxclick", (e) => { const t = e.target.closest(".tab"); if (t && e.button === 1) closeTab(t.dataset.path); });

function persistSession() { store.set("session", { tabs: S.tabs.map((t) => t.path), active: S.active }); }

/* ------------------------------------------------------------------ save & external changes */
async function saveTab(t, force = false) {
  if (!isDirty(t) && !force) return true;
  const gen = t.doc.changeGeneration();
  const r = await api("/api/file", { path: t.path, content: t.doc.getValue(), base_mtime: t.mtime, force });
  if (r._status === 409 && r.conflict) {
    t.conflict = "disk"; showBanner(t);
    toast(`${t.path} changed on disk — not saved. Resolve in the banner.`);
    return false;
  }
  if (r._status !== 200) { toast(`Save failed: ${r.error || r._status}`); return false; }
  t.mtime = r.mtime; t.gen = gen; t.conflict = null;
  renderTabs(); showBanner(t);
  return true;
}
async function saveActive() {
  const t = activeTab(); if (!t) return;
  const ok = await saveTab(t);
  if (ok && $("#auto-compile").checked) compile();
}
async function saveAll() {
  let ok = true;
  for (const t of S.tabs) if (isDirty(t)) ok = (await saveTab(t)) && ok;
  return ok;
}

async function reloadFromDisk(t) {
  const r = await api("/api/file?path=" + encodeURIComponent(t.path));
  if (r._status !== 200) return;
  const cur = t.doc.getCursor(), scroll = t === activeTab() ? cm.getScrollInfo() : null;
  t.doc.setValue(r.content);
  t.doc.setCursor(cur);
  if (scroll) cm.scrollTo(scroll.left, scroll.top);
  t.mtime = r.mtime; t.gen = t.doc.changeGeneration(true); t.conflict = null;
  renderTabs(); showBanner(t);
}

function showBanner(t) {
  const b = $("#banner");
  if (!t || t !== activeTab() || !t.conflict) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<b>${esc(t.path)}</b> was changed on disk (e.g. by Claude Code) while you have unsaved edits.
    <button id="bn-reload">Load disk version (discard mine)</button>
    <button id="bn-keep">Keep mine (overwrite disk)</button>
    <button id="bn-diff">Show git diff</button>`;
  $("#bn-reload").onclick = () => reloadFromDisk(t);
  $("#bn-keep").onclick = () => saveTab(t, true);
  $("#bn-diff").onclick = () => showDiff(t.path);
}

/* ------------------------------------------------------------------ file tree & outline */
function renderTree() {
  const groups = new Map();
  const rank = (p) => { const i = S.order.indexOf(p); return i < 0 ? 999 : i; };
  const files = [...S.files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  for (const f of files) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const dirOrder = ["", "tex", "tex/sections", "bib", "notes"];
  const dirs = [...groups.keys()].sort((a, b) => {
    const ia = dirOrder.indexOf(a), ib = dirOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  let html = "";
  for (const d of dirs) {
    if (d) html += `<li class="folder">${esc(d)}/</li>`;
    for (const f of groups.get(d)) {
      html += `<li data-path="${esc(f.path)}" class="${f.path === S.active ? "active" : ""}" title="${esc(f.path)}">
        ${esc(f.path.split("/").pop())}${f.git ? `<span class="git" title="git status">${esc(f.git)}</span>` : ""}</li>`;
    }
  }
  $("#tree").innerHTML = html;
}
$("#tree").addEventListener("click", (e) => { const li = e.target.closest("li[data-path]"); if (li) openFile(li.dataset.path); });

const KIND_ABBR = { theorem: "Thm", proposition: "Prop", lemma: "Lem", corollary: "Cor", conjecture: "Conj", claim: "Claim",
  definition: "Def", assumption: "Ass", example: "Ex", problem: "Prob", remark: "Rem", notation: "Not", "theorem*": "Thm*" };
function renderOutline() {
  const labelAt = new Map(S.symbols.labels.map((l) => [l.file + ":" + l.line, l.label]));
  let html = "";
  for (const o of S.symbols.outline) {
    const lvl = KIND_ABBR[o.kind] ? "env" : o.kind;
    const label = labelAt.get(o.file + ":" + o.line) || labelAt.get(o.file + ":" + (o.line + 1)) || "";
    const text = KIND_ABBR[o.kind] ? `<span class="kind">${KIND_ABBR[o.kind]}</span>${esc(o.title || label)}` : esc(o.title);
    html += `<li class="lvl-${lvl}" data-file="${esc(o.file)}" data-line="${o.line}" title="${esc(o.file)}:${o.line}${label ? "  " + esc(label) : ""}">${text}</li>`;
  }
  $("#outline").innerHTML = html || `<li class="file-sep">No sections yet.</li>`;
}
$("#outline").addEventListener("click", (e) => { const li = e.target.closest("li[data-file]"); if (li) openFile(li.dataset.file, +li.dataset.line); });
$("#btn-refresh-outline").onclick = () => loadSymbols();
async function loadSymbols() {
  const r = await api("/api/symbols");
  if (r._status === 200) { S.symbols = r; renderOutline(); buildInsertMenu(); }
}

async function poll() {
  const r = await api("/api/tree").catch(() => null);
  if (!r || r._status !== 200) { $("#build-status").textContent = "server not reachable"; $("#build-status").className = "status err"; return; }
  $("#projname").textContent = r.root;
  document.title = r.root + " · prism-local";
  const changed = JSON.stringify(r.files.map((f) => [f.path, f.git])) !== JSON.stringify(S.files.map((f) => [f.path, f.git]));
  S.files = r.files; S.order = r.order || [];
  if (changed) renderTree();
  let anyChange = false;
  for (const t of S.tabs) {
    const f = r.files.find((x) => x.path === t.path);
    if (!f || Math.abs(f.mtime - t.mtime) < 1e-6) continue;
    anyChange = true;
    if (!isDirty(t)) await reloadFromDisk(t);
    else if (t.conflict !== "disk") { t.conflict = "disk"; showBanner(t); }
  }
  if (anyChange || changed) loadSymbols();
  if (r.pdf_mtime && r.pdf_mtime !== S.pdfMtime && !S.building) showPdf(r.pdf_mtime);
}

/* ------------------------------------------------------------------ completion */
function lineBefore(ed) { const c = ed.getCursor(); return ed.getLine(c.line).slice(0, c.ch); }
const REF_RE = /\\(?:[cC]ref|[cC]pageref|ref|eqref|autoref|pageref|labelcref|namecref|nameref)\*?\{([^}]*)$/;
const CITE_RE = /\\(?:cite[tp]?|nocite|citeauthor|citeyear)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const CMD_RE = /\\([A-Za-z]*)$/;
const COMMON_CMDS = ["begin", "end", "label", "cref", "Cref", "eqref", "cite", "section", "subsection", "emph", "textbf",
  "mathbb", "mathcal", "mathrm", "operatorname", "frac", "sum", "int", "lim", "sup", "inf", "left", "right", "langle", "rangle",
  "varepsilon", "alpha", "beta", "gamma", "delta", "lambda", "mu", "sigma", "omega", "Omega", "partial", "nabla", "infty",
  "subseteq", "coloneqq", "quad", "qquad", "text", "item", "input", "footnote", "ref", "includegraphics"];

function computeHints(ed, explicit) {
  const before = lineBefore(ed), cur = ed.getCursor();
  let m, items = [], word = "";
  if ((m = before.match(REF_RE))) {
    word = m[1].split(",").pop().trimStart();
    items = S.symbols.labels.map((l) => ({ text: l.label, kind: `${l.kind} · ${l.file.split("/").pop()}:${l.line}` }));
  } else if ((m = before.match(CITE_RE))) {
    word = m[1].split(",").pop().trimStart();
    items = S.symbols.bibkeys.map((k) => ({ text: k.key, kind: k.type }));
  } else if ((m = before.match(CMD_RE)) && (explicit || m[1].length >= 2)) {
    word = m[1];
    const mine = new Set((S.symbols.macros || []).map((x) => x.name));
    items = [...new Set([...mine, ...COMMON_CMDS])].map((n) => ({ text: n, kind: mine.has(n) ? "macros.tex" : "" }));
  } else return null;
  const w = word.toLowerCase();
  const list = items.filter((i) => i.text.toLowerCase().includes(w) && i.text !== word)
    .sort((a, b) => (a.text.toLowerCase().startsWith(w) ? 0 : 1) - (b.text.toLowerCase().startsWith(w) ? 0 : 1) || a.text.localeCompare(b.text))
    .slice(0, 60)
    .map((i) => ({ text: i.text, render: (el) => { el.innerHTML = `${esc(i.text)}<span class="hint-kind">${esc(i.kind)}</span>`; } }));
  if (!list.length) return null;
  return { list, from: { line: cur.line, ch: cur.ch - word.length }, to: cur };
}

function showCompletions(ed, explicit) {
  if (ed.state.completionActive) return;          // the open widget re-queries by itself
  if (!computeHints(ed, explicit)) {
    if (explicit && CITE_RE.test(lineBefore(ed)) && !S.symbols.bibkeys.length) toast("No BibTeX entries found in the project's .bib files.");
    return;
  }
  ed.showHint({ hint: (e) => computeHints(e, explicit), completeSingle: false });
}

/* ------------------------------------------------------------------ snippets */
// Insert menu: theorem-like environments found via \newtheorem, standard math
// environments, and project snippets from prism.json. Filled by loadConfig().
let LABEL_PREFIX = {};
let SNIPPETS = [];
function buildInsertMenu() {
  const envs = S.symbols.environments || [];
  const opt = (v, l) => `<option value="${esc(v)}">${esc(l || v)}</option>`;
  let h = `<option value="">Insert…</option>`;
  if (envs.length) h += `<optgroup label="Theorem-like">${envs.map((e) => opt("env:" + e, e)).join("")}</optgroup>`;
  h += `<optgroup label="Math & text">${["proof", "equation", "align", "itemize", "enumerate", "figure"].map((e) => opt("env:" + e, e)).join("")}</optgroup>`;
  if (SNIPPETS.length) h += `<optgroup label="Project snippets">${SNIPPETS.map((s, i) => opt("snip:" + i, s.name)).join("")}</optgroup>`;
  $("#insert").innerHTML = h;
}
async function loadConfig() {
  const r = await api("/api/config");
  if (r._status !== 200) return;
  LABEL_PREFIX = r.labelPrefixes || {}; SNIPPETS = r.snippets || [];
  const sel = $("#build-mode");
  const labels = { draft: "Draft (continue on errors)", strict: "Strict (stop at first error)", check: "Check" };
  sel.innerHTML = (r.modes || []).map((m) => `<option value="${m}" title="${esc((r.build[m] || []).join(" "))}">${labels[m] || m}</option>`).join("")
    || `<option value="">no build command</option>`;
  const want = store.get("buildmode", "draft");
  sel.value = (r.modes || []).includes(want) ? want : (r.modes || [])[0] || "";
  buildInsertMenu();
}
$("#insert").onchange = (e) => {
  const val = e.target.value; e.target.value = "";
  if (!val || !activeTab()) return;
  const cur = cm.getCursor(), ind = cm.getLine(cur.line).match(/^\s*/)[0];
  let text, caret;
  if (val.startsWith("snip:")) {
    const s = SNIPPETS[+val.slice(5)];
    text = s.text; caret = Number.isInteger(s.caret) ? s.caret : text.length;
  } else {
    const env = val.slice(4);
    const p = LABEL_PREFIX[env];
    const head = `\\begin{${env}}` + (p ? `\\label{${p}:}` : "");
    text = `${head}\n${ind}  \n${ind}\\end{${env}}`;
    caret = p ? head.length - 1 : null;
  }
  cm.replaceSelection(text);
  if (caret !== null) cm.setCursor({ line: cur.line, ch: cur.ch + caret });
  else cm.setCursor({ line: cur.line + 1, ch: ind.length + 2 });
  cm.focus();
};
$("#btn-save").onclick = () => saveActive();

/* ------------------------------------------------------------------ build */
async function compile() {
  if (S.building) return;
  if (!(await saveAll())) return;
  const mode = $("#build-mode").value;
  S.building = true;
  const st = $("#build-status");
  st.className = "status busy"; st.textContent = `compiling (${mode})…`;
  $("#btn-compile").disabled = true;
  try {
    const r = await api("/api/build", { mode });
    if (r.busy) { st.className = "status warn"; st.textContent = "a build is already running"; return; }
    S.diagnostics = r.diagnostics || [];
    $("#output").textContent = r.output || "";
    const errs = S.diagnostics.filter((d) => d.severity === "error").length;
    const warns = S.diagnostics.length - errs;
    const failed = r.exit !== 0;
    st.className = "status " + (failed || errs ? "err" : warns ? "warn" : "ok");
    st.textContent = (failed ? `FAILED (exit ${r.exit})` : errs ? `PDF built with ${errs} TeX error${errs > 1 ? "s" : ""}` : "OK")
      + (warns ? ` · ${warns} warning${warns > 1 ? "s" : ""}` : "") + ` · ${r.seconds}s`;
    renderProblems();
    applyDiagnostics();
    if (failed || errs) openPanel(errs || !r.output ? "problems" : "output");
    if (r.pdf_mtime) await showPdf(r.pdf_mtime);
  } catch (e) {
    st.className = "status err"; st.textContent = "build request failed: " + e;
  } finally {
    S.building = false; $("#btn-compile").disabled = false;
  }
}
$("#btn-compile").onclick = () => compile();
$("#auto-compile").checked = store.get("autocompile", false);
$("#auto-compile").onchange = (e) => store.set("autocompile", e.target.checked);
$("#build-mode").value = store.get("buildmode", "draft");
$("#build-mode").onchange = (e) => store.set("buildmode", e.target.value);

function renderProblems() {
  const d = S.diagnostics;
  const errs = d.filter((x) => x.severity === "error").length;
  const b = $("#problem-count");
  b.textContent = d.length ? String(d.length) : ""; b.className = "badge" + (errs ? "" : " warn");
  $("#problems").innerHTML = d.length ? d.map((x, i) => `
    <li data-i="${i}"><span class="sev ${x.severity}">${x.severity}</span><span class="loc">${esc(x.file || "?")}${x.line ? ":" + x.line : ""}</span>${esc(x.message)}</li>`).join("")
    : `<li class="none">No errors or warnings from the build.</li>`;
}
$("#problems").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]"); if (!li) return;
  const d = S.diagnostics[+li.dataset.i];
  if (d.file) openFile(d.file, d.line);
});

let diagMarks = [];
function applyDiagnostics() {
  for (const [doc, h, cls] of diagMarks) doc.removeLineClass(h, "background", cls);
  diagMarks = [];
  for (const d of S.diagnostics) {
    const t = S.tabs.find((x) => x.path === d.file);
    if (!t || !d.line || d.line > t.doc.lineCount()) continue;
    const cls = d.severity === "error" ? "cm-line-error" : "cm-line-warning";
    diagMarks.push([t.doc, t.doc.addLineClass(d.line - 1, "background", cls), cls]);
  }
}

/* ------------------------------------------------------------------ bottom panel & diff */
function openPanel(name) {
  $("#panel").classList.remove("collapsed"); $("#panel-toggle").textContent = "▾";
  document.querySelectorAll("#panel-tabs [data-panel]").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  document.querySelectorAll(".panel-view").forEach((v) => { v.hidden = v.id !== name; });
  cm.refresh();
}
$("#panel-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-panel]"); if (b) { openPanel(b.dataset.panel); if (b.dataset.panel === "diff") showDiff(); }
});
$("#panel-toggle").onclick = () => {
  const p = $("#panel"); p.classList.toggle("collapsed");
  $("#panel-toggle").textContent = p.classList.contains("collapsed") ? "▴" : "▾"; cm.refresh();
};
async function showDiff(path) {
  const r = await api("/api/diff" + (path ? "?path=" + encodeURIComponent(path) : ""));
  const text = r.diff || "(no uncommitted changes, or not a git repository)";
  $("#diff").innerHTML = text.split("\n").map((l) => {
    const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "";
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
  }).join("\n");
  openPanel("diff");
}
$("#btn-diff").onclick = () => showDiff();

/* ------------------------------------------------------------------ PDF */
PV.init({ scaleKey: "scale" });
PV.onInverse = (p) => inverseJump(p.page, p.x, p.y);

// Pop-out viewer: while a viewer tab is alive, the inline PDF pane is hidden.
const POP = { alive: false, last: 0 };
function setPopped(on) {
  if (POP.alive === on) return;
  POP.alive = on;
  $("#pdf-pane").hidden = on; document.querySelector('.gutter[data-resize="pdf"]').hidden = on;
  $("#btn-popout").classList.toggle("active", on);
  $("#btn-popout").title = on ? "PDF is open in another tab — click to focus it" : "Open the PDF in a separate tab (stays in sync)";
  cm.refresh();
  if (!on && S.pdfMtime && S.pdfMtime !== PV.mtime) PV.load(S.pdfMtime);
}
let popWin = null;
function popOut() {
  popWin = window.open("/viewer", "prism-pdf");
  if (popWin) popWin.focus();
}
$("#btn-popout").onclick = popOut;
$("#pdf-popout").onclick = (e) => { e.preventDefault(); popOut(); };
if (pdfChannel) pdfChannel.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === "alive") { POP.last = Date.now(); setPopped(true); }
  else if (m.type === "bye") setPopped(false);
  else if (m.type === "inverse") inverseJump(m.page, m.x, m.y);
};
setInterval(() => { if (POP.alive && Date.now() - POP.last > 5000) setPopped(false); }, 2000);

function showPdf(mtime) {
  S.pdfMtime = mtime;
  if (pdfChannel) pdfChannel.postMessage({ type: "pdf", mtime });
  if (!POP.alive) return PV.load(mtime);
}

/* ------------------------------------------------------------------ SyncTeX */
async function forwardSync() {
  const t = activeTab(); if (!t || !t.path.endsWith(".tex")) return;
  if (!S.pdfMtime) return toast("No PDF yet — compile first.");
  const line = cm.getCursor().line + 1;
  const r = await api(`/api/synctex/forward?file=${encodeURIComponent(t.path)}&line=${line}`);
  if (r._status !== 200) return toast("No PDF location for this line (compile, or the line produces no output).");
  if (POP.alive && pdfChannel) pdfChannel.postMessage({ type: "forward", r });
  else PV.highlight(r);
}
$("#btn-forward").onclick = () => forwardSync();

async function inverseJump(page, x, y) {
  const r = await api(`/api/synctex/inverse?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
  if (r._status !== 200 || !r.file) return toast("No source location found here.");
  if (!S.files.some((f) => f.path === r.file)) return toast(`Source is ${r.file}:${r.line} (not editable here).`);
  openFile(r.file, r.line);
}

/* ------------------------------------------------------------------ misc UI */
function sidebarHidden(h) {
  $("#sidebar").classList.toggle("hidden", h); $("#sidebar-gutter").classList.toggle("hidden", h);
  store.set("sidebar.hidden", h); cm.refresh();
}
sidebarHidden(store.get("sidebar.hidden", false));
$("#btn-sidebar").onclick = () => sidebarHidden(!$("#sidebar").classList.contains("hidden"));

let toastTimer = null;
function toast(msg) {
  const st = $("#build-status");
  const prev = [st.textContent, st.className];
  st.textContent = msg; st.className = "status warn";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (st.textContent === msg) [st.textContent, st.className] = prev; }, 4000);
}

document.querySelectorAll(".gutter").forEach((g) => {
  g.addEventListener("mousedown", (e) => {
    e.preventDefault(); g.classList.add("drag");
    const target = { sidebar: $("#sidebar"), pdf: $("#pdf-pane"), chat: $("#chat") }[g.dataset.resize];
    const startX = e.clientX, startW = target.getBoundingClientRect().width;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.max(160, startW + (g.dataset.resize === "sidebar" ? dx : -dx));
      target.style.width = w + "px"; cm.refresh();
    };
    const up = () => {
      g.classList.remove("drag"); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      store.set("w." + g.dataset.resize, target.style.width);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
});
for (const [k, sel] of [["sidebar", "#sidebar"], ["pdf", "#pdf-pane"], ["chat", "#chat"]]) { const w = store.get("w." + k, null); if (w) $(sel).style.width = w; }

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "s") { e.preventDefault(); saveActive(); }
  else if (mod && e.key === "Enter") { e.preventDefault(); compile(); }
  else if (mod && e.key === "b" && !e.shiftKey) { e.preventDefault(); sidebarHidden(!$("#sidebar").classList.contains("hidden")); }
});
window.addEventListener("beforeunload", (e) => { if (S.tabs.some(isDirty)) { e.preventDefault(); e.returnValue = ""; } });

/* ------------------------------------------------------------------ Claude panel */
const C = { session: store.get("chat.session", null), job: null, cur: null };

function chatHidden(h) {
  $("#chat").classList.toggle("hidden", h); $("#chat-gutter").classList.toggle("hidden", h);
  store.set("chat.hidden", h); cm.refresh();
}
chatHidden(store.get("chat.hidden", false));
$("#btn-chat").onclick = () => chatHidden(!$("#chat").classList.contains("hidden"));
$("#chat-mode").value = store.get("chat.mode", "edit");
$("#chat-mode").onchange = (e) => store.set("chat.mode", e.target.value);

// Minimal, safe rendering: escape first, then code fences, inline code, bold, file:line links.
function renderMd(text) {
  const parts = String(text).split(/```[a-zA-Z]*\n?/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre>${esc(p.replace(/\n$/, ""))}</pre>`;
    let h = esc(p);
    h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    h = h.replace(/((?:[\w.-]+\/)*[\w.-]+\.(?:tex|bib|md))(?::(\d+))?/g, (m, f, ln) => {
      const hit = S.files.find((x) => x.path === f || x.path.endsWith("/" + f));
      return hit ? `<a class="src" data-file="${esc(hit.path)}" data-line="${ln || ""}">${m}</a>` : m;
    });
    return h;
  }).join("");
}

function chatAppend(html, cls) {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.innerHTML = html;
  $("#chat-log").appendChild(div);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return div;
}
function saveChatLog() { store.set("chat.log", $("#chat-log").innerHTML.slice(-400000)); }
function chatIntro() {
  chatAppend(`Claude Code runs in this repository with the project's CLAUDE.md rules.
<b>Edit</b> mode may change files — every turn ends with a diff and an Undo button.
<b>Ask</b> mode is read-only. Select text and press <code>⌘L</code> to ask about it.
Commits, pushes and non-allowlisted shell commands are not permitted from here.`, "msg intro");
}

function currentContext() {
  const t = activeTab();
  if (!t) return null;
  const ctx = { file: t.path, line: cm.getCursor().line + 1 };
  const sel = cm.getSelection();
  if (sel) { ctx.selection = sel.slice(0, 6000); ctx.from = cm.getCursor("from").line + 1; ctx.to = cm.getCursor("to").line + 1; }
  return ctx;
}
function editorContext() { return $("#chat-ctx").checked ? currentContext() : null; }
function describeCtx(ctx) {
  if (!ctx) return "no editor context";
  return ctx.selection ? `${ctx.file}:${ctx.from}–${ctx.to} (selection)` : `${ctx.file}, line ${ctx.line}`;
}
function updateCtxLabel() { $("#chat-ctx-text").textContent = "Attach: " + describeCtx(currentContext()); }
cm.on("cursorActivity", updateCtxLabel);

function buildPrompt(text, ctx) {
  if (!ctx) return text;
  let block = `[Editor context]\nFile: ${ctx.file}\nCursor: line ${ctx.line}\n`;
  if (ctx.selection) block += `Selection (lines ${ctx.from}–${ctx.to}):\n\`\`\`latex\n${ctx.selection}\n\`\`\`\n`;
  return block + "[/Editor context]\n\n" + text;
}

async function chatSend() {
  if (C.job) return;
  const text = $("#chat-input").value.trim();
  if (!text) return;
  if (!(await saveAll())) return toast("Resolve the save conflict before asking Claude.");
  const ctx = editorContext(), mode = $("#chat-mode").value;
  const r = await api("/api/agent", { prompt: buildPrompt(text, ctx), session_id: C.session, mode });
  if (r.error) return chatAppend(`<div class="err">${esc(r.error)}</div>`, "card");
  $("#chat-input").value = "";
  chatAppend(`${esc(text)}<span class="ctx">${esc(describeCtx(ctx))} · ${mode === "edit" ? "Edit" : "Ask"}</span>`, "msg user");
  C.job = r.job; C.cur = null;
  const tools = new Map();
  $("#chat-send").textContent = "Stop"; $("#chat-send").classList.remove("primary");
  $("#chat-status").className = "status busy"; $("#chat-status").textContent = "working…";
  let after = 0, done = false, buf = "", streamed = false;
  const flush = () => { if (C.cur) { C.cur.innerHTML = renderMd(buf); $("#chat-log").scrollTop = $("#chat-log").scrollHeight; } };
  while (!done) {
    let d;
    try { d = await api(`/api/agent/events?job=${r.job}&after=${after}`); }
    catch { await new Promise((res) => setTimeout(res, 1000)); continue; }
    if (d._status !== 200) break;
    for (const e of d.events) {
      if (e.t === "init") { C.session = e.session_id; store.set("chat.session", C.session); }
      else if (e.t === "message_start") { C.cur = null; buf = ""; streamed = false; }
      else if (e.t === "delta") {
        if (!C.cur) { C.cur = chatAppend("", "msg assistant"); buf = ""; }
        streamed = true; buf += e.text; flush();
      } else if (e.t === "text") {
        if (!streamed) { C.cur = chatAppend("", "msg assistant"); buf = e.text; flush(); C.cur = null; }
      } else if (e.t === "tool") {
        C.cur = null;
        tools.set(e.id, chatAppend(`<span class="st">▸</span>${esc(e.name)} ${esc(e.summary || "")}`, "tool"));
        tools.get(e.id).title = `${e.name} ${e.summary || ""}`;
      } else if (e.t === "tool_result") {
        const el = tools.get(e.id);
        if (el) { el.querySelector(".st").textContent = e.error ? "✗" : "✓"; if (e.error) { el.classList.add("err"); el.title += "\n" + e.preview; } }
      } else if (e.t === "error") chatAppend(`<div class="err">${esc(e.message)}</div>`, "card");
      else if (e.t === "done") renderTurnCard(e);
    }
    after += d.events.length; done = d.done;
  }
  C.job = null;
  $("#chat-send").textContent = "Send"; $("#chat-send").classList.add("primary");
  $("#chat-status").className = "status"; $("#chat-status").textContent = "";
  saveChatLog();
  await poll();
}

// Usage limits as reported by Claude Code's rate_limit_event (utilization 0–1 per window).
function renderQuota(rate) {
  const q = $("#quota");
  const refresh = `<button class="tiny" id="quota-refresh" title="Check usage now (a tiny Haiku call, ≈ $0.001)">↻</button>`;
  if (!rate || !rate.unifiedWindows) {
    q.innerHTML = `<span class="note">Usage limits: not checked yet ${refresh}</span>`;
    return;
  }
  const prev = store.get("chat.rate", null);
  if (!prev || !prev.at || (rate.at || 0) >= prev.at) store.set("chat.rate", rate);
  const fmtReset = (ts) => {
    if (!ts) return "";
    const d = new Date(ts * 1000), now = new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? time : d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  };
  const names = { five_hour: "5h", seven_day: "7d", seven_day_opus: "7d Opus", seven_day_sonnet: "7d Sonnet" };
  let h = "";
  for (const [k, w] of Object.entries(rate.unifiedWindows)) {
    const used = Math.max(0, Math.min(1, w.utilization || 0)), pct = Math.round(used * 100);
    const cls = used >= 0.9 ? "err" : used >= 0.7 ? "warn" : "";
    h += `<span>${esc(names[k] || k)}</span><div class="bar" title="${pct}% used"><i class="${cls}" style="width:${Math.max(pct, 1)}%"></i></div>
      <span class="num">${100 - pct}% left · resets ${esc(fmtReset(w.resetsAt))}</span>`;
  }
  const age = rate.at ? new Date(rate.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
  if (rate.status && rate.status !== "allowed")
    h += `<span class="note err">Rate limited (${esc(rate.rateLimitType || "")}) until ${esc(fmtReset(rate.resetsAt))}</span>`;
  else
    h += `<span class="note">as of ${esc(age)} · updated by each message and ↻ ${refresh}</span>`;
  q.innerHTML = h;
  q.title = "Claude usage limits reported by Claude Code. Usage from other sessions (e.g. the terminal) shows up after the next message sent from this panel.";
}

async function checkUsage() {
  const b = $("#quota-refresh");
  if (b) { b.disabled = true; b.textContent = "…"; }
  const r = await api("/api/agent/usage", {}).catch(() => ({}));
  renderQuota(r.rate || store.get("chat.rate", null));
  if (r.error) toast(r.error);
}
$("#quota").addEventListener("click", (e) => { if (e.target.id === "quota-refresh") checkUsage(); });

function diffHtml(diff) {
  return diff.split("\n").map((l) => {
    const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "";
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
  }).join("\n");
}

function renderTurnCard(e) {
  let h = "";
  if (e.changed && e.changed.length) {
    h += `<div class="row"><b>Changed ${e.changed.length} file${e.changed.length > 1 ? "s" : ""}</b>
      <button class="tiny sp" data-undo="${e.turn}">Undo this turn</button>
      <button class="tiny" data-compile="1">Compile</button></div>`;
    for (const c of e.changed) {
      const add = (c.diff.match(/^\+(?!\+\+)/gm) || []).length, del = (c.diff.match(/^-(?!--)/gm) || []).length;
      h += `<div class="row"><a data-file="${esc(c.path)}" data-line="${(c.diff.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m) || [])[1] || ""}">${esc(c.path)}</a>
        <span class="add">+${add}</span> <span class="del">−${del}</span>${c.created ? " (new)" : c.deleted ? " (deleted)" : ""}
        <button class="tiny sp" data-toggle="1">diff</button></div><pre hidden>${diffHtml(c.diff)}</pre>`;
    }
  } else if (!e.is_error && e.exit === 0) {
    h += `<div class="meta">No files changed.</div>`;
  }
  if (e.denials && e.denials.length)
    h += `<div class="warn">Not permitted here: ${esc([...new Set(e.denials)].join(", "))}. Run that step from the terminal session if it is needed.</div>`;
  if (e.exit !== 0 || e.is_error)
    h += `<div class="err">Claude exited with ${esc(e.subtype || "exit " + e.exit)}.${e.stderr ? "\n" + esc(e.stderr) : ""}</div>`;
  const meta = [e.duration ? (e.duration / 1000).toFixed(1) + "s" : "", e.cost ? "$" + e.cost.toFixed(3) : ""].filter(Boolean).join(" · ");
  if (meta) h += `<div class="meta">${meta}</div>`;
  chatAppend(h, "card");
}

$("#chat-log").addEventListener("click", async (ev) => {
  const a = ev.target.closest("a[data-file]");
  if (a) return openFile(a.dataset.file, a.dataset.line ? +a.dataset.line : undefined);
  const tg = ev.target.closest("[data-toggle]");
  if (tg) { const pre = tg.closest(".row").nextElementSibling; pre.hidden = !pre.hidden; return; }
  if (ev.target.closest("[data-compile]")) return compile();
  const u = ev.target.closest("[data-undo]");
  if (u) {
    if (S.tabs.some(isDirty) && !(await saveAll())) return;
    const r = await api("/api/agent/undo", { turn: +u.dataset.undo });
    if (r.error) { u.textContent = r.error === "unknown turn" ? "undo unavailable (server restarted)" : r.error; u.disabled = true; return; }
    u.textContent = `undone (${r.restored.length})` + (r.skipped.length ? `; kept ${r.skipped.length} edited since` : "");
    u.disabled = true; saveChatLog(); await poll();
  }
});

$("#chat-send").onclick = () => { if (C.job) api("/api/agent/stop", { job: C.job }); else chatSend(); };
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(); }
});
$("#chat-new").onclick = () => {
  if (C.job) return;
  C.session = null; store.set("chat.session", null);
  $("#chat-log").innerHTML = ""; chatIntro(); saveChatLog();
};
function askAboutSelection() {
  chatHidden(false); $("#chat-ctx").checked = true; updateCtxLabel(); $("#chat-input").focus();
}
cm.setOption("extraKeys", { ...cm.getOption("extraKeys"), "Cmd-L": askAboutSelection, "Ctrl-L": askAboutSelection });
{
  const saved = store.get("chat.log", "");
  if (saved) $("#chat-log").innerHTML = saved;
  else chatIntro();
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  renderQuota(store.get("chat.rate", null));
  api("/api/agent/info").then((r) => {
    if (r.rate) renderQuota(r.rate);
    const known = r.rate || store.get("chat.rate", null);
    if (r.available && (!known || !known.at || Date.now() / 1000 - known.at > 600)) checkUsage();
    if (!r.available) chatAppend(`<div class="err">Claude Code CLI not found. Start the editor with CLAUDE_BIN=/path/to/claude.</div>`, "card"); });
}

/* ------------------------------------------------------------------ start */
(async function init() {
  await loadConfig();
  await poll();
  await loadSymbols();
  const sess = store.get("session", null);
  const exists = (p) => S.files.some((f) => f.path === p);
  if (sess && sess.tabs) {
    for (const p of sess.tabs.filter(exists)) if (p !== sess.active) await openFile(p);
    if (sess.active && exists(sess.active)) await openFile(sess.active);
  }
  if (!S.active && exists("main.tex")) await openFile("main.tex");
  renderProblems();
  setInterval(poll, 2000);
})();
