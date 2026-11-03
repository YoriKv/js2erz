// js2erz application: code editor -> compiler -> layout -> interactive node canvas, plus simulator and exports.
import { compile, BUILTIN_DOCS } from "./compiler.js";
import { layout } from "./layout.js";
import { graphSvg, graphBounds, exportSvg } from "./render.js";
import { U, sizePx, portPos } from "./geom.js";
import { T, PALETTE, DEFAULTS, DIRS, DIR_ARROW, DIR_NAMES, REL_ROT, OPS, OP_SYM, CATEGORIES, CATEGORY_LABEL, CELLS, ITEMS, INV_TARGETS,
  BUILTIN_VARS, WRITABLE_BUILTINS, NODE_LIMIT, nodeSummary, fmtOperand, TITLE } from "./nodes.js";
import { toErzstat, importJson, buildList } from "./formats.js";
import { createEditor } from "./codeedit.js";
import { EXAMPLES } from "./examples.js";
import { mountWorldPanel } from "./worldpanel.js";

const $ = id => document.getElementById(id);
const LS = "js2erz.v1";
const store = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } })();
const save = () => { try { localStorage.setItem(LS, JSON.stringify(store)); } catch (e) { /* storage unavailable */ } };
store.opts = Object.assign({ live: true, idx: true, codeW: null, sideW: null }, store.opts);

// ---------------------------------------------------------------- state
let compiled = [];        // [{prog, routes, edited, view, undo, redo}] from the code
let imported = store.imported || [];   // plain Programs from JSON imports (kept across reloads)
let cur = 0;              // index into tabs()
let sel = new Set(), selEdge = null, activePort = null, hover = null, placing = null;
let simCur = null, codeHl = new Set(), lastErr = null;
const tabs = () => compiled.concat(imported.map(p => wrapImported(p)));
const wrapCache = new WeakMap();
function wrapImported(p) {
  if (!wrapCache.has(p)) wrapCache.set(p, { prog: p, routes: new Map(), edited: true, imported: true, view: null, undo: [], redo: [] });
  return wrapCache.get(p);
}
const view = () => tabs()[cur];
const prog = () => view() && view().prog;

// ---------------------------------------------------------------- editor + compile
const editor = createEditor($("editor"), {
  value: initialSource(),
  onChange: v => { store.source = v; save(); if (store.opts.live) scheduleCompile(); },
  onCursor: (line, endLine) => { highlightNodesForLines(line, endLine ?? line); },
});
function initialSource() {
  const m = location.hash.match(/code=([^&]+)/);
  if (m) { try { return decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")))); } catch (e) { /* bad link */ } }
  return store.source ?? EXAMPLES[0].code;
}
let compileTimer = null;
function scheduleCompile() { clearTimeout(compileTimer); compileTimer = setTimeout(() => runCompile(false), 350); }

// structure signature: same graph shape keeps the hand-tidied positions
const shape = p => p.name + "|" + p.nodes.map(n => n.t + JSON.stringify(n.p) + n.outs.join(",")).join(";");
function runCompile(force) {
  if (!force && compiled.some(c => c.edited)) { showBanner(); return; }
  const src = editor.value;
  let res;
  try { res = compile(src); }
  catch (e) {
    lastErr = e;
    renderDiag(null, e);
    editor.setMarks({ err: new Set(e.loc ? [e.loc.line] : []) });
    return;
  }
  lastErr = null;
  const old = new Map(compiled.map(c => [c.prog.name, c]));
  const curName = prog() && prog().name;
  compiled = res.programs.map(p => {
    const o = old.get(p.name);
    if (o && !o.edited && shape(o.prog) === shape(p)) {
      p.nodes.forEach((n, i) => { n.x = o.prog.nodes[i].x; n.y = o.prog.nodes[i].y; });
      return { prog: p, routes: o.routes, edited: false, view: o.view, undo: [], redo: [] };
    }
    return { prog: p, routes: layout(p), edited: false, view: o ? o.view : null, undo: [], redo: [], fresh: true };
  });
  const k = tabs().findIndex(t => t.prog.name === curName);
  cur = k >= 0 ? k : 0;
  sel.clear(); selEdge = null; activePort = null;
  renderDiag(res, null);
  editor.setMarks({ err: new Set(), warn: new Set(res.warnings.filter(w => w.loc).map(w => w.loc.line)) });
  hideBanner();
  renderTabs(); if (view() && (view().fresh || !view().view)) fit(); else render();
  renderSide();
  world && world.refresh();
}
function renderDiag(res, err) {
  const d = $("diag");
  d.innerHTML = "";
  const line = (cls, text, loc) => {
    const el = document.createElement("div");
    el.className = "msg " + cls; el.textContent = text;
    if (loc) el.addEventListener("click", () => editor.select(loc.line, loc.col || 1));
    d.append(el);
  };
  if (err) { line("err", `${err.loc ? `${err.loc.line}:${err.loc.col}  ` : ""}${err.message}`, err.loc); return; }
  const total = res.programs.reduce((a, p) => a + p.nodes.length, 0);
  line("ok", res.programs.map(p => `${p.name}: ${p.nodes.length} node${p.nodes.length === 1 ? "" : "s"}`).join(" · ") + (res.programs.length > 1 ? `  (total ${total})` : ""));
  if (res.tech.length) line("m", "Needs: " + res.tech.map(t => t === "Move-dig setting" ? "the “Show Move-dig node” setting" : `tech ${t}`).join(", "));
  for (const w of res.warnings) line("warn", `${w.loc ? `${w.loc.line}:${w.loc.col}  ` : ""}${w.msg}`, w.loc);
}
function showBanner() {
  const b = $("banner");
  b.hidden = false;
  b.innerHTML = "";
  b.append("The graph was edited by hand, so live compile is paused. ");
  const r = document.createElement("button"); r.textContent = "Recompile from code (drops the hand edits)";
  r.addEventListener("click", () => runCompile(true));
  b.append(r);
}
function hideBanner() { $("banner").hidden = true; }

// ---------------------------------------------------------------- program tabs
function renderTabs() {
  const box = $("progTabs");
  box.innerHTML = "";
  tabs().forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.setAttribute("role", "tab");
    b.className = i === cur ? "on" : "";
    b.innerHTML = `${esc(t.prog.name)}<small>${t.prog.nodes.length}${t.imported ? " · imported" : t.edited ? " · edited" : ""}</small>`;
    b.addEventListener("click", () => { cur = i; sel.clear(); selEdge = null; activePort = null; renderTabs(); if (!view().view) fit(); else render(); renderSide(); });
    if (t.imported) {
      b.title = "Imported program (double-click to remove)";
      b.addEventListener("dblclick", () => { if (confirm(`Remove imported program "${t.prog.name}"?`)) { imported = imported.filter(p => p !== t.prog); persistImported(); cur = 0; renderTabs(); fit(); renderSide(); } });
    }
    box.append(b);
  });
}
const persistImported = () => { store.imported = imported; save(); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- canvas
const svg = $("cv");
let vp = null, simMark = null;
function render() {
  const v = view();
  if (!v) { svg.innerHTML = ""; return; }
  const p = v.prog;
  const hl = new Set();
  if (codeHl.size) p.nodes.forEach(n => { if (n.src && [...codeHl].some(l => l >= n.src.line && l <= n.src.endLine)) hl.add(n.id); });
  const { defs, body } = graphSvg(p, { routes: v.routes, sel, selEdge, activePort, hl, showIndex: store.opts.idx, interactive: true });
  const z = v.view || { x: 40, y: 40, z: 1 };
  svg.innerHTML = `<defs>${defs}<pattern id="gp" width="${U}" height="${U}" patternUnits="userSpaceOnUse"><path d="M${U} 0H0V${U}" fill="none" stroke="#33281f" stroke-width="1"/></pattern></defs>` +
    `<g id="vp" transform="translate(${z.x},${z.y}) scale(${z.z})"><rect x="-200000" y="-200000" width="400000" height="400000" fill="url(#gp)"/>${body}` +
    `<rect id="simMark" fill="none" stroke="#3fbf5f" stroke-width="4" rx="4" visibility="hidden"/><g id="over"></g></g>`;
  vp = svg.querySelector("#vp"); simMark = svg.querySelector("#simMark");
  placeSimMark();
  const c = $("count");
  c.textContent = `${p.nodes.length} / ${NODE_LIMIT} nodes`;
  c.className = p.nodes.length > NODE_LIMIT ? "over" : "";
}
function setView(z) { view().view = z; if (vp) vp.setAttribute("transform", `translate(${z.x},${z.y}) scale(${z.z})`); }
function fit() {
  const v = view(); if (!v) { render(); return; }
  const b = graphBounds(v.prog, v.routes), r = svg.getBoundingClientRect();
  const W = r.width || 800, H = (r.height || 600) - 50;
  const z = Math.min(1.4, Math.max(0.08, Math.min((W - 60) / b.w, (H - 60) / b.h)));
  v.view = { x: (W - b.w * z) / 2 - b.x * z, y: 20 + (H - b.h * z) / 2 - b.y * z, z };
  render();
}
function zoomAt(f, cx, cy) {
  const z0 = view().view || { x: 0, y: 0, z: 1 };
  const z = Math.min(3, Math.max(0.05, z0.z * f));
  setView({ x: cx - (cx - z0.x) * z / z0.z, y: cy - (cy - z0.y) * z / z0.z, z });
}
const toWorld = e => { const r = svg.getBoundingClientRect(), z = view().view || { x: 0, y: 0, z: 1 }; return [(e.clientX - r.left - z.x) / z.z, (e.clientY - r.top - z.y) / z.z]; };
function nodeAt(wx, wy) {
  const p = prog();
  for (let k = p.nodes.length - 1; k >= 0; k--) {
    const n = p.nodes[k], [w, h] = sizePx(n);
    if (wx >= n.x * U - 8 && wx <= n.x * U + w && wy >= n.y * U && wy <= n.y * U + h) return n;
  }
  return null;
}

let drag = null;
svg.addEventListener("pointerdown", e => {
  if (!view()) return;
  svg.setPointerCapture(e.pointerId);
  const [wx, wy] = toWorld(e);
  const portEl = e.target.closest("[data-port]"), nodeEl = e.target.closest("[data-node]"), edgeEl = e.target.closest("[data-edge]");
  if (e.button === 1 || e.button === 2) { drag = { kind: "pan", sx: e.clientX, sy: e.clientY, v0: { ...view().view } }; svg.classList.add("panning"); return; }
  if (placing) { addNode(placing, wx, wy); return; }
  if (portEl) {
    const [id, i] = portEl.dataset.port.split(":").map(Number);
    drag = { kind: "link", id, i, x: wx, y: wy, moved: false };
    activePort = { id, i }; return;
  }
  if (nodeEl) {
    const id = +nodeEl.dataset.node;
    if (e.shiftKey || e.ctrlKey) { sel.has(id) ? sel.delete(id) : sel.add(id); }
    else if (!sel.has(id)) { sel = new Set([id]); }
    selEdge = null;
    const p = prog();
    drag = { kind: "move", sx: wx, sy: wy, start: [...sel].map(k => [k, p.nodes[k].x, p.nodes[k].y]), moved: false };
    revealNode(p.nodes[id]);
    render(); renderSide(); return;
  }
  if (edgeEl) {
    const [id, i] = edgeEl.dataset.edge.split(":").map(Number);
    selEdge = { id, i }; sel.clear(); render(); renderSide(); return;
  }
  if (e.shiftKey) { drag = { kind: "box", x0: wx, y0: wy, x1: wx, y1: wy, add: new Set(sel) }; return; }
  drag = { kind: "pan", sx: e.clientX, sy: e.clientY, v0: { ...(view().view || { x: 0, y: 0, z: 1 }) }, click: true };
  svg.classList.add("panning");
});
svg.addEventListener("pointermove", e => {
  if (!view()) return;
  const [wx, wy] = toWorld(e);
  if (!drag) {
    const n = nodeAt(wx, wy);
    if ((n && n.id) !== (hover && hover.id)) {
      hover = n;
      editor.setMarks({ hl: n && n.src ? new Set(range(n.src.line, n.src.endLine)) : new Set() });
      if (n && n.src) editor.reveal(n.src.line);
    }
    return;
  }
  if (drag.kind === "pan") {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.click = false;
    setView({ ...drag.v0, x: drag.v0.x + dx, y: drag.v0.y + dy });
  } else if (drag.kind === "move") {
    const dx = wx - drag.sx, dy = wy - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { snapshot(); drag.moved = true; }
    const p = prog();
    for (const [k, x0, y0] of drag.start) { p.nodes[k].x = Math.round((x0 + dx / U) * 4) / 4; p.nodes[k].y = Math.round((y0 + dy / U) * 4) / 4; }
    dropRoutes(drag.start.map(s => s[0]));
    render();
  } else if (drag.kind === "link") {
    drag.x = wx; drag.y = wy; drag.moved = true;
    const a = prog().nodes[drag.id], [x1, y1] = portPos(a, drag.i);
    const o = svg.querySelector("#over"), col = T[a.t].outs[drag.i][2];
    if (o) o.innerHTML = `<path d="M${x1},${y1} C${x1 + 60},${y1} ${wx - 60},${wy} ${wx},${wy}" fill="none" stroke="${col}" stroke-width="2.6" stroke-dasharray="5 4"/>`;
  } else if (drag.kind === "box") {
    drag.x1 = wx; drag.y1 = wy;
    const x0 = Math.min(drag.x0, wx), y0 = Math.min(drag.y0, wy), x1 = Math.max(drag.x0, wx), y1 = Math.max(drag.y0, wy);
    sel = new Set(drag.add);
    for (const n of prog().nodes) { const [w, h] = sizePx(n); if (n.x * U < x1 && n.x * U + w > x0 && n.y * U < y1 && n.y * U + h > y0) sel.add(n.id); }
    render();
    svg.querySelector("#over").innerHTML = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="rgba(255,228,163,.08)" stroke="${TITLE}" stroke-dasharray="4 3"/>`;
  }
});
svg.addEventListener("pointerup", e => {
  if (!drag) return;
  const d = drag; drag = null;
  svg.classList.remove("panning");
  if (d.kind === "link") {
    const [wx, wy] = toWorld(e);
    const target = nodeAt(wx, wy);
    if (d.moved) {
      if (target && target.t !== "start") setOut(d.id, d.i, target.id);
      else if (!target) setOut(d.id, d.i, null);
    }
    render(); renderSide();
  } else if (d.kind === "move" && d.moved) { markMoved(); renderSide(); }
  else if (d.kind === "box") { render(); renderSide(); }
  else if (d.kind === "pan" && d.click) { sel.clear(); selEdge = null; activePort = null; render(); renderSide(); }
});
svg.addEventListener("contextmenu", e => e.preventDefault());
svg.addEventListener("wheel", e => {
  if (!view()) return;
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
svg.addEventListener("dblclick", e => {
  const el = e.target.closest("[data-node]"); if (!el) return;
  const n = prog().nodes[+el.dataset.node];
  if (n.src) editor.select(n.src.line, n.src.col);
});
const range = (a, b) => Array.from({ length: (b ?? a) - a + 1 }, (_, k) => a + k);
function revealNode(n) {
  if (!n || !n.src) return;
  editor.setMarks({ hl: new Set(range(n.src.line, n.src.endLine)) });
  editor.reveal(n.src.line);
}
function highlightNodesForLines(a, b) {
  codeHl = new Set(range(Math.min(a, b), Math.max(a, b)));
  render();
}
function dropRoutes(ids) {
  const v = view(), set = new Set(ids);
  for (const n of v.prog.nodes) n.outs.forEach((t, i) => { if (set.has(n.id) || set.has(t)) v.routes.delete(`${n.id}:${i}`); });
}

// ---------------------------------------------------------------- editing
function snapshot() {
  const v = view();
  v.undo.push(JSON.stringify(v.prog.nodes)); if (v.undo.length > 200) v.undo.shift();
  v.redo = [];
}
function restore(from, to) {
  const v = view(); if (!v[from].length) return;
  v[to].push(JSON.stringify(v.prog.nodes));
  v.prog.nodes = JSON.parse(v[from].pop());
  v.routes = new Map(); sel = new Set([...sel].filter(k => k < v.prog.nodes.length)); selEdge = null;
  markEdited(); render(); renderSide();
}
function markEdited() {
  const v = view();
  if (!v.edited) { v.edited = true; renderTabs(); if (!v.imported) showBanner(); }
  if (v.imported) persistImported();
}
function markMoved() { if (view().imported) persistImported(); }
function setOut(id, i, target) {
  snapshot();
  prog().nodes[id].outs[i] = target;
  view().routes.delete(`${id}:${i}`);
  markEdited();
}
function addNode(t, wx, wy) {
  snapshot();
  const p = prog();
  const n = { id: p.nodes.length, t, x: Math.round((wx / U - T[t].size[0] / 2) * 4) / 4, y: Math.round((wy / U - T[t].size[1] / 2) * 4) / 4,
    outs: T[t].outs.map(() => null), p: DEFAULTS[t] ? DEFAULTS[t]() : {} };
  p.nodes.push(n);
  if (activePort && p.nodes[activePort.id] && p.nodes[activePort.id].outs[activePort.i] == null) p.nodes[activePort.id].outs[activePort.i] = n.id;
  activePort = T[t].outs.length ? { id: n.id, i: 0 } : null;
  sel = new Set([n.id]); selEdge = null;
  if (!placingSticky) setPlacing(null);
  markEdited(); render(); renderSide();
}
function deleteSelection() {
  const v = view(), p = v.prog;
  if (selEdge) { setOut(selEdge.id, selEdge.i, null); selEdge = null; render(); renderSide(); return; }
  const del = new Set([...sel].filter(id => p.nodes[id] && p.nodes[id].t !== "start"));
  if (!del.size) return;
  snapshot();
  const keep = p.nodes.filter(n => !del.has(n.id));
  const remap = new Map(keep.map((n, i) => [n.id, i]));
  p.nodes = keep.map((n, i) => ({ ...n, id: i, outs: n.outs.map(o => (o == null || del.has(o)) ? null : remap.get(o)) }));
  v.routes = new Map(); sel.clear(); activePort = null;
  markEdited(); render(); renderSide();
}
let clip = null;
function copySel() {
  const p = prog(), ids = [...sel].filter(id => p.nodes[id].t !== "start").sort((a, b) => a - b);
  if (!ids.length) return;
  const idx = new Map(ids.map((id, k) => [id, k]));
  clip = ids.map(id => { const n = p.nodes[id]; return { ...JSON.parse(JSON.stringify(n)), outs: n.outs.map(o => idx.has(o) ? idx.get(o) : null) }; });
  toast(`Copied ${ids.length} node${ids.length > 1 ? "s" : ""}`);
}
function paste() {
  if (!clip) return;
  snapshot();
  const p = prog(), base = p.nodes.length;
  const add = clip.map((n, k) => ({ ...JSON.parse(JSON.stringify(n)), id: base + k, x: n.x + 1, y: n.y + 1, outs: n.outs.map(o => o == null ? null : base + o) }));
  p.nodes.push(...add);
  sel = new Set(add.map(n => n.id));
  markEdited(); render(); renderSide();
}

// palette
let placingSticky = false;
function setPlacing(t, sticky = false) {
  placing = t; placingSticky = sticky;
  svg.classList.toggle("placing", !!t);
  renderPalette();
}
function renderPalette() {
  const box = $("palette"); box.innerHTML = "";
  for (const [g, types] of PALETTE) {
    const s = document.createElement("span"); s.className = "pg"; s.textContent = g; box.append(s);
    for (const t of types) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = T[t].label === "." ? "• PASS" : T[t].label;
      b.style.background = T[t].bg; b.className = (T[t].fg ? "light " : "") + (placing === t ? "on" : "");
      b.title = `Add ${T[t].label} (click the canvas to place it; Shift-click to place several)`;
      b.addEventListener("click", e => setPlacing(placing === t ? null : t, e.shiftKey));
      box.append(b);
    }
  }
}

document.addEventListener("keydown", e => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runCompile(true); return; }
  if (typing) return;
  if (!view()) return;
  if (e.key === "Escape") { setPlacing(null); sel.clear(); selEdge = null; activePort = null; render(); renderSide(); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? restore("redo", "undo") : restore("undo", "redo"); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); restore("redo", "undo"); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") copySel();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") paste();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); sel = new Set(prog().nodes.map(n => n.id)); render(); }
  else if (e.key === "f" || e.key === "Home") fit();
});

// ---------------------------------------------------------------- side panel
const sideTabs = ["node", "world", "steps", "ref"];
let sideTab = "node";
$("tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  sideTab = b.dataset.tab;
  for (const t of sideTabs) $("tab-" + t).hidden = t !== sideTab;
  $("tabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.tab === sideTab));
  if (sideTab === "world") world.resize();
  renderSide();
});
function renderSide() {
  if (sideTab === "node") renderInspector();
  else if (sideTab === "steps") renderSteps();
  else if (sideTab === "ref") renderRef();
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
function parseOperand(s) {
  s = s.trim();
  if (s === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return { num: +s };
  const c = s.replace(/^Cell\./, "");
  if (CELLS.includes(c) && (s.startsWith("Cell.") || !/^[a-z]/.test(c))) return { cell: c };
  return { var: s };
}
const operandText = o => o == null ? "" : o.cell != null ? "Cell." + o.cell : fmtOperand(o);
function edit(fn) { snapshot(); fn(); markEdited(); render(); renderInspector(); }
function selectBox(options, value, onchange) {
  const s = el("select", { onchange: () => onchange(s.value) });
  for (const [v, label] of options) s.append(el("option", { value: v, selected: String(v) === String(value) }, label));
  return s;
}
function operandInput(get, set, label) {
  const i = el("input", { value: operandText(get()), size: 16, placeholder: "var, number or Cell.Name", list: "varlist",
    onchange: () => edit(() => set(parseOperand(i.value))) });
  return el("div", { class: "row" }, el("span", { class: "lbl" }, label), i);
}
function renderInspector() {
  const box = $("tab-node"); box.innerHTML = "";
  const v = view();
  if (!v) { box.append(el("p", { class: "note" }, "Nothing compiled yet.")); return; }
  const p = v.prog;
  if (selEdge) {
    const a = p.nodes[selEdge.id], o = T[a.t].outs[selEdge.i];
    box.append(el("h2", {}, "Arrow"), el("p", {}, `#${a.id} ${T[a.t].label} — output “${o[1]}” → #${a.outs[selEdge.i]}`),
      el("div", { class: "row" }, el("button", { type: "button", onclick: () => deleteSelection() }, "Disconnect (Del)")));
    return;
  }
  if (sel.size !== 1) {
    box.append(el("h2", {}, p.name),
      el("p", {}, `${p.nodes.length} nodes${sel.size ? ` · ${sel.size} selected` : ""}.`),
      el("p", { class: "note" }, "Click a node to see and edit it. Hover a node to see the code it came from; put the cursor on a code line to highlight its nodes."),
      helpBlock());
    return;
  }
  const n = p.nodes[[...sel][0]], t = T[n.t];
  box.append(el("h2", {}, el("span", { class: "chip", style: `background:${t.bg};color:${t.fg || TITLE}` }, t.label), `#${n.id}`));
  if (n.src) box.append(el("div", { class: "row" }, el("span", { class: "lbl" }, "Source"),
    el("button", { type: "button", class: "link", onclick: () => editor.select(n.src.line, n.src.col) }, `line ${n.src.line}${n.src.endLine > n.src.line ? `–${n.src.endLine}` : ""}`)));
  const s = nodeSummary(n);
  if (s) box.append(el("p", {}, s));
  if (t.tech) box.append(el("p", { class: "note" }, `Needs ${t.tech === "Move-dig setting" ? "the “Show Move-dig node” setting" : `tech ${t.tech}`}.`));
  const sec = el("div", { class: "sec" }, el("h3", {}, "Settings"));
  const P = n.p;
  switch (n.t) {
    case "start": sec.append(el("div", { class: "row" }, el("span", { class: "lbl" }, "Params"),
      el("input", { value: (P.params || []).join(", "), onchange: e => edit(() => { P.params = e.target.value.split(",").map(x => x.trim()).filter(Boolean); }) }))); break;
    case "rotA": {
      const c = el("div", { class: "compass" });
      [5, 6, 7, 4, null, 0, 3, 2, 1].forEach(d => c.append(d == null ? el("span") :
        el("button", { type: "button", class: P.dir === d ? "on" : "", title: DIR_NAMES[d], onclick: () => edit(() => { P.dir = d; }) }, DIR_ARROW[d])));
      sec.append(c); break;
    }
    case "rotR": sec.append(selectBox(Object.entries(REL_ROT).sort((a, b) => a[0] - b[0]), P.dir, v2 => edit(() => { P.dir = +v2; }))); break;
    case "aimA": case "aimR": {
      const rel = n.t === "aimR", g = el("div", { class: "grid7" });
      for (let r = -3; r <= 3; r++) for (let c = -3; c <= 3; c++) {
        const hit = rel ? (P.right === c && P.front === -r) : (P.right === c && P.front === r);
        g.append(el("button", { type: "button", class: hit ? "on" : Math.abs(r) <= 1 && Math.abs(c) <= 1 ? "body" : "",
          title: rel ? `front ${-r}, right ${c}` : `X ${c}, Y ${r}`, onclick: () => edit(() => { P.right = c; P.front = rel ? -r : r; }) }, c === 0 && r === 0 ? "●" : ""));
      }
      sec.append(g, el("p", { class: "note" }, rel ? "Top of the grid = in front of the bot." : "Map axes: X right = east, Y down = south.")); break;
    }
    case "scan": case "cell":
      if (n.t === "cell") sec.append(operandInput(() => P.value, x => { P.value = x; }, "Value"));
      sec.append(el("div", { class: "row" }, el("span", { class: "lbl" }, "Category"), selectBox(CATEGORIES.map(c => [c, CATEGORY_LABEL[c]]), P.category, v2 => edit(() => { P.category = v2; })))); break;
    case "use": sec.append(selectBox(ITEMS.map(i => [i, i]), P.item, v2 => edit(() => { P.item = v2; }))); break;
    case "inv":
      sec.append(el("div", { class: "row" }, el("span", { class: "lbl" }, "Target"), selectBox(INV_TARGETS.map(i => [i, i]), P.target, v2 => edit(() => { P.target = v2; }))),
        el("div", { class: "row" }, el("span", { class: "lbl" }, "Direction"), selectBox([["true", "bot → target (unload)"], ["false", "target → bot (load)"]], String(P.positive), v2 => edit(() => { P.positive = v2 === "true"; })))); break;
    case "call":
      sec.append(el("div", { class: "row" }, el("span", { class: "lbl" }, "Program"), el("input", { value: P.program, onchange: e => edit(() => { P.program = e.target.value.trim(); }) })),
        el("div", { class: "row" }, el("span", { class: "lbl" }, "Arguments"), el("input", { value: (P.args || []).map(operandText).join(", "),
          onchange: e => edit(() => { P.args = e.target.value.split(",").map(parseOperand).filter(Boolean); }) }))); break;
    case "exit": sec.append(selectBox([["false", "SUCCESS"], ["true", "FAIL"]], String(!!P.fail), v2 => edit(() => { P.fail = v2 === "true"; }))); break;
    case "assign":
      sec.append(el("div", { class: "row" }, el("span", { class: "lbl" }, "Variable"), el("input", { value: P.varname, onchange: e => edit(() => { P.varname = e.target.value.trim(); }) })),
        operandInput(() => P.value, x => { P.value = x; }, "Value")); break;
    case "oper":
      sec.append(el("div", { class: "row" }, el("span", { class: "lbl" }, "Variable"), el("input", { value: P.varname, onchange: e => edit(() => { P.varname = e.target.value.trim(); }) })),
        operandInput(() => P.left, x => { P.left = x; }, "Left"),
        el("div", { class: "row" }, el("span", { class: "lbl" }, "Operation"), selectBox(OPS.map(o => [o, `${OP_SYM[o]}  ${o}`]), P.op, v2 => edit(() => { P.op = v2; }))),
        operandInput(() => P.right, x => { P.right = x; }, "Right")); break;
    case "cmp": sec.append(operandInput(() => P.left, x => { P.left = x; }, "Left"), operandInput(() => P.right, x => { P.right = x; }, "Right")); break;
    case "eq":
      sec.append(operandInput(() => P.value, x => { P.value = x; }, "Value"),
        el("div", { class: "row" }, el("span", { class: "lbl" }, "Any of"), el("input", { value: (P.set || []).map(operandText).join(", "), size: 28,
          onchange: e => edit(() => { P.set = e.target.value.split(",").map(parseOperand).filter(Boolean); }) }))); break;
    default: sec.append(el("p", { class: "note" }, "No settings."));
  }
  box.append(sec);
  if (t.outs.length) {
    const outs = el("div", { class: "outs" });
    n.outs.forEach((o, i) => {
      const [, label, col] = t.outs[i];
      outs.append(el("div", { class: "out" }, el("span", { class: "dot", style: `background:${col}` }), el("span", {}, label),
        o == null ? el("span", { class: "tgt" }, "END") : el("button", { type: "button", class: "link tgt", onclick: () => { sel = new Set([o]); render(); renderSide(); revealNode(p.nodes[o]); } }, `→ #${o} ${T[p.nodes[o].t].label}`),
        o == null ? el("span") : el("button", { type: "button", class: "x", title: "Disconnect", onclick: () => { setOut(n.id, i, null); render(); renderSide(); } }, "×")));
    });
    box.append(el("div", { class: "sec" }, el("h3", {}, "Outputs"), outs));
  }
  const preds = p.nodes.filter(a => a.outs.includes(n.id));
  if (preds.length) box.append(el("div", { class: "sec" }, el("h3", {}, "Comes from"),
    el("div", { class: "chips" }, ...preds.map(a => el("button", { type: "button", class: "link", onclick: () => { sel = new Set([a.id]); render(); renderSide(); } }, `#${a.id} ${T[a.t].label}`)))));
}
function helpBlock() {
  return el("div", { class: "sec" }, el("h3", {}, "Canvas"),
    el("p", { class: "note" }, "Drag the background to pan, wheel to zoom, Shift+drag to box-select. Drag nodes to tidy the picture before exporting. Drag from an output circle onto a node to connect it, or onto empty space to disconnect. Del deletes, Ctrl+Z / Ctrl+Y undo / redo, Ctrl+C / Ctrl+V copy / paste, F fits the view. Double-click a node to jump to its code."));
}
function renderSteps() {
  const box = $("tab-steps"); box.innerHTML = "";
  const v = view(); if (!v) return;
  const text = buildList(v.prog);
  box.append(el("p", { class: "note" }, "Every node with its settings and where each output goes. Build the nodes in this order; #0 is the START node the editor already has."),
    el("div", { class: "row" }, el("button", { type: "button", onclick: () => copyText(text) }, "Copy"), el("button", { type: "button", onclick: () => download(`${v.prog.name}.txt`, new Blob([text], { type: "text/plain" })) }, "Download .txt")));
  const pre = el("pre", { class: "steps" });
  text.split("\n").forEach(line => {
    const m = line.match(/^#(\d+) /);
    if (m) { const a = el("span", { class: "sn", onclick: () => { sel = new Set([+m[1]]); render(); revealNode(v.prog.nodes[+m[1]]); } }, `#${m[1]}`); pre.append(a, line.slice(m[0].length - 1) + "\n"); }
    else pre.append(line + "\n");
  });
  box.append(pre);
}
function renderRef() {
  const box = $("tab-ref"); if (box.dataset.done) return; box.dataset.done = "1";
  const tbl = el("table", {}, el("tr", {}, el("th", {}, "Call"), el("th", {}, "Node"), el("th", {}, "")));
  for (const [c, n, d] of BUILTIN_DOCS) tbl.append(el("tr", {}, el("td", {}, el("code", {}, c)), el("td", {}, n), el("td", {}, d)));
  const chips = list => el("div", { class: "chips" }, ...list.map(x => el("code", {}, x)));
  box.append(
    el("div", { class: "sec" }, el("h3", {}, "How it works"),
      el("p", {}, "Every call to a built-in becomes one node. A call's outcome steers if, while, do…while, for and switch: if (step()) takes the success output, dig() === \"cantDig\" picks a single output, switch (dig()) routes each case. A call used as a plain statement connects all its outputs to what follows."),
      el("p", {}, "let variables become VALUE / OPER nodes; const with a constant value is folded away. Functions are inlined at each call; a function whose body starts with \"use program\" is compiled as its own program and called with CALL. for (const d of [...]) is unrolled. halt() leaves an output unconnected; exit() / return in a program adds EXIT."),
      el("p", { class: "note" }, "Nodes run on the game server, about 1000 per second. A program may have up to 1000 nodes.")),
    el("div", { class: "sec" }, el("h3", {}, "Built-ins"), tbl),
    el("div", { class: "sec" }, el("h3", {}, "Constants"),
      el("p", {}, el("code", {}, "Dir."), " ", DIRS.map((d, i) => `${d}=${i}`).join(" ")),
      el("p", {}, el("code", {}, "Category.")), chips(CATEGORIES),
      el("p", {}, el("code", {}, "Item.")), chips(ITEMS),
      el("p", {}, el("code", {}, "Target.")), chips(INV_TARGETS),
      el("p", {}, el("code", {}, "Cell.")), chips(CELLS)),
    el("div", { class: "sec" }, el("h3", {}, "System variables"), chips(BUILTIN_VARS),
      el("p", { class: "note" }, `Writable: ${WRITABLE_BUILTINS.join(", ")}. scan_cell_front / scan_cell_back hold cells; compare them with ==, anyOf() or inCategory().`)));
}
// datalist of known variables for operand inputs
const varlist = el("datalist", { id: "varlist" }, ...BUILTIN_VARS.map(v => el("option", { value: v })));
document.body.append(varlist);

// ---------------------------------------------------------------- simulator
let world = null;
function placeSimMark() {
  if (!simMark) return;
  const v = view();
  if (!simCur || !v || simCur.program !== v.prog.name || !v.prog.nodes[simCur.node]) { simMark.setAttribute("visibility", "hidden"); return; }
  const n = v.prog.nodes[simCur.node], [w, h] = sizePx(n);
  simMark.setAttribute("x", n.x * U - 7); simMark.setAttribute("y", n.y * U - 7);
  simMark.setAttribute("width", w + 14); simMark.setAttribute("height", h + 14);
  simMark.setAttribute("visibility", "visible");
}
function onSimCurrent(c) {
  simCur = c;
  placeSimMark();
  let line = null;
  if (c) { const t = tabs().find(x => x.prog.name === c.program); const n = t && t.prog.nodes[c.node]; if (n && n.src && !t.imported) line = n.src.line; }
  editor.setMarks({ cur: line });
  if (line) editor.reveal(line);
}
world = mountWorldPanel($("tab-world"), {
  getPrograms: () => {
    const all = new Map();
    for (const t of tabs()) if (!all.has(t.prog.name)) all.set(t.prog.name, t.prog);
    return { programs: all, main: prog() ? prog().name : null };
  },
  onCurrent: onSimCurrent,
});

// ---------------------------------------------------------------- export / import / share
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name.replace(/[^\w.-]+/g, "_");
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function toast(msg) { const t = el("div", { class: "toast" }, msg); document.body.append(t); setTimeout(() => t.remove(), 1800); }
function copyText(s) {
  (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(() => toast("Copied"), () => {
    const ta = el("textarea", {}, s); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("Copied");
  });
}
const svgForExport = () => {
  const v = view(), p = v.prog;
  const tech = [...new Set(p.nodes.map(n => T[n.t].tech).filter(Boolean))];
  return exportSvg(p, { routes: v.routes, title: p.name, showIndex: store.opts.idx,
    subtitle: `${p.nodes.length} nodes${tech.length ? " · needs " + tech.join(", ") : ""} · js2erz` });
};
$("bSvg").addEventListener("click", () => { if (view()) download(`${prog().name}.svg`, new Blob([svgForExport()], { type: "image/svg+xml" })); });
$("bPng").addEventListener("click", () => {
  if (!view()) return;
  const s = svgForExport();
  const W = +s.match(/width="(\d+)"/)[1], H = +s.match(/height="(\d+)"/)[1];
  const k = Math.min(2, 16000 / Math.max(W, H), Math.sqrt(120e6 / (W * H)));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = Math.round(W * k); c.height = Math.round(H * k);
    const ctx = c.getContext("2d"); ctx.scale(k, k); ctx.drawImage(img, 0, 0, W, H);
    c.toBlob(b => b ? download(`${prog().name}.png`, b) : toast("The image is too large for a PNG; use SVG"), "image/png");
  };
  img.onerror = () => toast("Could not render the PNG; use SVG");
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
});
const modal = $("modal"), modalBox = $("modalBox");
const closeModal = () => { modal.hidden = true; modalBox.innerHTML = ""; };
modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
$("bJson").addEventListener("click", () => {
  if (!view()) return;
  const p = prog();
  const ta = el("textarea", { readonly: true });
  ta.value = JSON.stringify(toErzstat(p), null, 1);
  modalBox.append(el("h2", {}, `Export ${p.name}`),
    el("p", { class: "note" }, "Executable for the erzstat.site Programmator editor (Import JSON there). Coordinates in grid cells. Category and inventory numbers follow the game's enums, which differ from that editor's guesses for Rare and the inventory targets."),
    ta, el("div", { class: "row" }, el("button", { type: "button", onclick: () => copyText(ta.value) }, "Copy"),
      el("button", { type: "button", onclick: () => download(`${p.name}.json`, new Blob([ta.value], { type: "application/json" })) }, "Download"),
      el("button", { type: "button", onclick: closeModal }, "Close")));
  modal.hidden = false;
});
$("bImport").addEventListener("click", () => {
  const ta = el("textarea", { placeholder: '{"nodes":[{"x":0,"y":0,"outputs":[1],"start":{"params":[]}}, …]}  — an erzstat.site export, or any JSON that contains one' });
  const file = el("input", { type: "file", accept: ".json,.txt,application/json", onchange: () => { const f = file.files[0]; if (f) f.text().then(t => { ta.value = t; }); } });
  const name = el("input", { placeholder: "name (optional)" });
  const err = el("div", { class: "err" });
  const relayout = el("input", { type: "checkbox" });
  const go = () => {
    try {
      const p = importJson(ta.value, name.value.trim() || "Imported");
      if (name.value.trim()) p.name = name.value.trim();
      while (tabs().some(t => t.prog.name === p.name)) p.name += "'";
      const routes = relayout.checked ? layout(p) : new Map();
      imported.push(p); persistImported();
      wrapImported(p).routes = routes;
      cur = tabs().findIndex(t => t.prog === p);
      closeModal(); renderTabs(); fit(); renderSide();
    } catch (e) { err.textContent = e.message; }
  };
  modalBox.append(el("h2", {}, "Import a program"),
    el("p", { class: "note" }, "The program opens in its own tab. It is not linked to the code; it is there to view, tidy, simulate and export."),
    ta, el("div", { class: "row" }, file, name, el("label", {}, relayout, "lay out again")), err,
    el("div", { class: "row" }, el("button", { type: "button", class: "primary", onclick: go }, "Import"), el("button", { type: "button", onclick: closeModal }, "Cancel")));
  modal.hidden = false; ta.focus();
});
$("bShare").addEventListener("click", () => {
  const b64 = btoa(unescape(encodeURIComponent(editor.value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const url = location.href.replace(/#.*$/, "") + "#code=" + b64;
  history.replaceState(null, "", url);
  copyText(url);
});

// ---------------------------------------------------------------- top bar
for (const ex of EXAMPLES) $("exSel").append(el("option", { value: ex.id }, ex.title));
$("exSel").addEventListener("change", e => {
  const ex = EXAMPLES.find(x => x.id === e.target.value); e.target.value = "";
  if (!ex) return;
  if (editor.value.trim() && editor.value !== ex.code && !EXAMPLES.some(x => x.code === editor.value) && !confirm("Replace the current code with the example?")) return;
  editor.setValue(ex.code); store.source = ex.code; save();
  compiled.forEach(c => { c.edited = false; });
  runCompile(true);
});
$("bCompile").addEventListener("click", () => runCompile(true));
$("optLive").checked = store.opts.live;
$("optLive").addEventListener("change", e => { store.opts.live = e.target.checked; save(); if (e.target.checked) runCompile(false); });
$("optIdx").checked = store.opts.idx;
$("optIdx").addEventListener("change", e => { store.opts.idx = e.target.checked; save(); render(); });
$("bLayout").addEventListener("click", () => { const v = view(); if (!v) return; snapshot(); v.routes = layout(v.prog); if (v.imported) persistImported(); fit(); });
$("bFit").addEventListener("click", fit);
$("bUndo").addEventListener("click", () => restore("undo", "redo"));
$("bRedo").addEventListener("click", () => restore("redo", "undo"));
$("bZoomIn").addEventListener("click", () => { const r = svg.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); });
$("bZoomOut").addEventListener("click", () => { const r = svg.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); });

// resizable panes
function splitter(id, target, key, sign) {
  const s = $(id), t = $(target);
  if (store.opts[key]) t.style.width = store.opts[key] + "px";
  s.addEventListener("pointerdown", e => {
    s.setPointerCapture(e.pointerId); s.classList.add("drag");
    const x0 = e.clientX, w0 = t.getBoundingClientRect().width;
    const move = ev => { t.style.width = Math.max(200, w0 + sign * (ev.clientX - x0)) + "px"; world.resize(); };
    const up = () => { s.classList.remove("drag"); s.removeEventListener("pointermove", move); s.removeEventListener("pointerup", up); store.opts[key] = t.getBoundingClientRect().width; save(); };
    s.addEventListener("pointermove", move); s.addEventListener("pointerup", up);
  });
}
splitter("split1", "codePane", "codeW", 1);
splitter("split2", "side", "sideW", -1);

// ---------------------------------------------------------------- boot
renderPalette();
{ const m = location.hash.match(/tab=(\w+)/); if (m && sideTabs.includes(m[1])) setTimeout(() => $("tabs").querySelector(`[data-tab=${m[1]}]`).click()); }
runCompile(true);
if (!compiled.length && imported.length) { cur = 0; renderTabs(); fit(); renderSide(); }
window.addEventListener("resize", () => { if (view() && view().view) render(); });
