// World panel: paint a sandbox world and run the compiled programs in it (RUN / STEP / Pause / Stop).
import { T, DIR_ARROW, CELLS } from "./nodes.js";
import { createSim, makeWorld, emptyWorld, cellAt, cellColor, BRUSHES, DV, fmtValue,
  SEISMIC_DEFAULTS, FOOT, stampInitiator, initiatorAt, minedShare, breakCentre } from "./sim.js";
import { t, tOr, onLangChange, getLang } from "./i18n.js";

const LS_KEY = "js2erz.world.v1";
const SIZES = [[64, 48], [96, 72], [128, 96], [192, 144]];
const SIM_ITEMS = ["RoadSector", "Block", "MiningCharge"];
const MAX_NPS = 2000;
const INIT_COLOR = "#3c6e80";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const isInt = v => Number.isInteger(v);
const BRUSH_NAMES = new Set([...BRUSHES.map(b => b.cell), "bot", "initiator"]);
// a stored world, checked: null when it can't be used (a fresh world is generated then)
export function loadWorld(w) {
  if (!w || typeof w !== "object" || !isInt(w.W) || !isInt(w.H) || w.W < 5 || w.H < 5) return null;
  if (!Array.isArray(w.cells) || w.cells.length !== w.W * w.H) return null;
  const b = w.bot;
  if (!b || !isInt(b.x) || !isInt(b.y) || b.x < 1 || b.y < 1 || b.x > w.W - 2 || b.y > w.H - 2) return null;
  // cell indices (index 0 "Unknown" and unknown indices load as Back); names from older saves stay
  const cells = w.cells.map(i => typeof i === "number" ? (i > 0 && CELLS[i]) || "Back" : typeof i === "string" ? i : "Back");
  const out = { W: w.W, H: w.H, seed: isInt(w.seed) ? w.seed : null, cells, bot: { x: b.x, y: b.y } };
  // initiators: integer centres whose footprint lies inside the border, no two overlapping
  const inits = [];
  for (const o of Array.isArray(w.initiators) ? w.initiators : []) {
    if (!o || !isInt(o.x) || !isInt(o.y)) continue;
    if (o.x - FOOT < 1 || o.y - FOOT < 1 || o.x + FOOT > w.W - 2 || o.y + FOOT > w.H - 2) continue;
    if (inits.some(q => Math.abs(q.x - o.x) <= 2 * FOOT && Math.abs(q.y - o.y) <= 2 * FOOT)) continue;
    inits.push({ x: o.x, y: o.y });
  }
  if (inits.length) out.initiators = inits;
  return out;
}
// stored settings, coerced to sane values (missing or bad ones take the defaults)
export function loadSettings(s, defaults) {
  const out = JSON.parse(JSON.stringify(defaults));
  if (!s || typeof s !== "object") return out;
  const num = (v, lo, hi, d) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);
  out.dir = num(s.dir, 0, 7, out.dir);
  out.speed = num(s.speed, 0, 100, out.speed);
  out.brush = BRUSH_NAMES.has(s.brush) ? s.brush : "Regolith";
  if (s.items && typeof s.items === "object") for (const it of SIM_ITEMS) out.items[it] = num(s.items[it], 0, 1e6, out.items[it]);
  if (s.seismic && typeof s.seismic === "object") out.seismic.nps = num(s.seismic.nps, 1, 1e7, out.seismic.nps);
  return out;
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? { world: loadWorld(o.world), settings: o.settings } : null;
  } catch (e) { return null; }
}
function save(state) {
  try {
    const w = state.world;
    localStorage.setItem(LS_KEY, JSON.stringify({
      world: { W: w.W, H: w.H, seed: w.seed, bot: w.bot, cells: w.cells.map(c => Math.max(0, CELLS.indexOf(c))),
        ...(w.initiators && w.initiators.length ? { initiators: w.initiators } : {}) },
      settings: state.settings,
    }));
  } catch (e) { /* storage unavailable */ }
}

// UI words in the panel language; `log` lines from sim.js are matched and rebuilt (sim.js itself stays English)
const nodeName = ty => (T[ty] ? tOr("node." + ty, T[ty].label) : ty);
const LABEL_TYPE = Object.fromEntries(Object.entries(T).map(([k, v]) => [v.label, k]));
const resultWord = r => (r === "success" ? t("sim.success") : r === "fail" ? t("sim.fail") : r);
const cellName = c => tOr("cell." + c, c);
// brushes without a label of their own use the game's name of the cell
const brushLabel = b => { const l = tOr("brush." + b.cell, b.label || cellName(b.cell)); return l.charAt(0).toUpperCase() + l.slice(1); };
function trWhy(w) {
  let m;
  if ((m = w.match(/^no program "(.*)"$/))) return t("log.noProg", m[1]);
  if ((m = w.match(/^output "(.*)" of (.+) #(\d+) is not connected$/))) return t("log.notConn", m[1], LABEL_TYPE[m[2]] ? nodeName(LABEL_TYPE[m[2]]) : m[2], m[3]);
  if ((m = w.match(/^node (\S+) not found in "(.*)"$/))) return t("log.notFound", m[1], m[2]);
  if ((m = w.match(/^EXIT (SUCCESS|FAIL)$/))) return t("log.exit", nodeName("exit"), t(m[1] === "FAIL" ? "exit.fail" : "exit.success"));
  if (w === "stopped") return t("log.stopped");
  if ((m = w.match(/^unknown node type (.*)$/))) return t("log.unknown", m[1]);
  if ((m = w.match(/^bot crushed by the seismic break at \((\d+), (\d+)\), ([\d.]+) cells from the centre$/))) return t("log.crushed", m[1], m[2], m[3]);
  return w;
}
function trLog(line) {
  let m;
  if ((m = line.match(/^Program finished \((\w+)\): ([\s\S]*)$/))) return t("log.done", resultWord(m[1]), trWhy(m[2]));
  if ((m = line.match(/^Start "(.*)", facing (\w+)$/))) { const d = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"].indexOf(m[2]); return t("log.start", m[1], d >= 0 ? t("dirs." + d) : m[2]); }
  if ((m = line.match(/^USE (\w+): not simulated$/))) return t("log.useNotSim", nodeName("use"), tOr("item." + m[1], m[1]));
  if ((m = line.match(/^"(.*)" returned (\w+)$/))) return t("log.returned", m[1], resultWord(m[2]));
  if ((m = line.match(/^CALL "(.*)": no such program → halt$/))) return t("log.callNo", nodeName("call"), m[1]);
  if ((m = line.match(/^CALL "(.*)": stack overflow → halt$/))) return t("log.callOver", nodeName("call"), m[1]);
  if ((m = line.match(/^CALL "(.*)"$/))) return t("log.call", nodeName("call"), m[1]);
  if ((m = line.match(/^Seismic initiator at \((\d+), (\d+)\) started working: break in (\d+) nodes$/))) return t("log.seisWork", m[1], m[2], m[3]);
  if ((m = line.match(/^Seismic break at \((\d+), (\d+)\), radius (\d+)( \(by hand\))?$/))) return t(m[4] ? "log.seisHand" : "log.seisBreak", m[1], m[2], m[3]);
  if ((m = line.match(/^Seismic break at \((\d+), (\d+)\) over: (\d+) cells refilled$/))) return t("log.seisOver", m[1], m[2], m[3]);
  return line;
}

export function mountWorldPanel(root, { getPrograms, onCurrent = () => {} } = {}) {
  root.classList.add("wp");
  // data-k: textContent, data-kt: title, data-ka: aria-label (i18n keys)
  root.innerHTML = `
    <div class="wp-bar">
      <label class="wp-l"><span data-k="sim.start"></span> <select class="wp-dir" data-ka="sim.startAria"></select></label>
      <button type="button" class="wp-step" data-k="sim.step" data-kt="sim.stepTip"></button>
      <button type="button" class="wp-run" data-k="sim.run"></button>
      <button type="button" class="wp-pause" data-k="sim.pause"></button>
      <button type="button" class="wp-stop" data-k="sim.stop" data-kt="sim.stopTip"></button>
      <label class="wp-l"><span data-k="sim.speed"></span> <input class="wp-speed" type="range" min="0" max="100" data-ka="sim.speedAria"></label>
      <span class="wp-nps wp-m"></span>
      <span class="wp-help" tabindex="0" data-ka="sim.help">?<span class="wp-helpbox" role="tooltip"></span></span>
    </div>
    <div class="wp-brushes" role="toolbar" data-ka="sim.brushes"></div>
    <div class="wp-cvbox"><canvas class="wp-cv"></canvas><div class="wp-note" aria-live="polite" hidden></div>
      <div class="wp-hud">
        <button type="button" class="wp-undo" data-kt="hud.undo" data-ka="hud.undo" disabled>↶</button>
        <button type="button" class="wp-redo" data-kt="hud.redo" data-ka="hud.redo" disabled>↷</button>
      </div>
    </div>
    <div class="wp-row">
      <select class="wp-size" data-ka="sim.size">${SIZES.map(([w, h]) => `<option value="${w}x${h}">${w}×${h}</option>`).join("")}</select>
      <label class="wp-l"><span data-k="sim.seed"></span> <input class="wp-seed" type="number" style="width:84px"></label>
      <button type="button" class="wp-gen" data-k="sim.gen" data-kt="sim.genTip"></button>
      <button type="button" class="wp-rand" data-k="sim.rand"></button>
      <button type="button" class="wp-clear" data-k="sim.clear" data-kt="sim.clearTip"></button>
      <button type="button" class="wp-fit" data-k="sim.fit"></button>
    </div>
    <div class="wp-row wp-seis" hidden>
      <button type="button" class="wp-trig" data-k="seis.trigger" data-kt="seis.triggerTip"></button>
      <label class="wp-l" data-kt="seis.npsTip"><input class="wp-snps" type="number" min="1" step="1" style="width:72px"> <span data-k="seis.nps"></span></label>
    </div>
    <div class="wp-row wp-items">${SIM_ITEMS.map(it => `<label class="wp-l"><span data-item-label="${it}"></span> <input type="number" min="0" step="1" data-item="${it}" style="width:56px"></label>`).join("")}</div>
    <div class="wp-info" aria-live="polite"></div>`;
  const $ = s => root.querySelector(s);
  function relabel() {
    root.querySelectorAll("[data-k]").forEach(e => { e.textContent = t(e.dataset.k); });
    root.querySelectorAll("[data-kt]").forEach(e => { e.title = t(e.dataset.kt); });
    root.querySelectorAll("[data-ka]").forEach(e => { e.setAttribute("aria-label", t(e.dataset.ka)); });
    root.querySelectorAll("[data-item-label]").forEach(e => { const it = e.dataset.itemLabel; e.textContent = tOr("item." + it, it); });
    const ds = $(".wp-dir"), v = ds.value;
    ds.innerHTML = DIR_ARROW.map((a, i) => `<option value="${i}">${a} ${esc(t("dir." + i))}</option>`).join("");
    if (v !== "") ds.value = v;
  }
  relabel();
  const cv = $(".wp-cv"), ctx = cv.getContext("2d"), box = $(".wp-cvbox"), info = $(".wp-info");

  const stored = load();
  // stale keys of older versions (scenario, seismic.drills) are dropped by loadSettings
  const state = {
    world: stored?.world || makeWorld(96, 72),
    settings: loadSettings(stored?.settings, { dir: 0, speed: 40, brush: "Regolith", items: { RoadSector: 20, Block: 20, MiningCharge: 5 },
      seismic: { nps: SEISMIC_DEFAULTS.nodesPerSec } }),
  };
  // seismic initiators run with SEISMIC_DEFAULTS and the chosen node rate (drills are not modelled)
  const seisCfg = () => ({ ...SEISMIC_DEFAULTS, nodesPerSec: Math.max(1, +state.settings.seismic.nps || SEISMIC_DEFAULTS.nodesPerSec) });
  let sim = null, paused = true, raf = 0, last = 0, acc = 0;
  const view = { cs: 8, ox: 0, oy: 0 };
  let fitted = false;

  // ---------------------------------------------------------------- controls
  const dirSel = $(".wp-dir"), speed = $(".wp-speed"), nps = $(".wp-nps"), sizeSel = $(".wp-size"), seedIn = $(".wp-seed");
  dirSel.value = String(state.settings.dir);
  speed.value = String(state.settings.speed);
  const speedNps = () => Math.max(1, Math.round(Math.pow(MAX_NPS, +speed.value / 100)));
  const updSpeed = () => { nps.textContent = t("sim.nps", speedNps()); };
  updSpeed();
  sizeSel.value = `${state.world.W}x${state.world.H}`;
  if (!sizeSel.value) sizeSel.value = "96x72";
  seedIn.value = state.world.seed ?? "";
  root.querySelectorAll("[data-item]").forEach(inp => {
    inp.value = state.settings.items[inp.dataset.item] ?? 0;
    inp.addEventListener("change", () => { state.settings.items[inp.dataset.item] = Math.max(0, Math.floor(+inp.value || 0)); save(state); });
  });
  dirSel.addEventListener("change", () => { state.settings.dir = +dirSel.value; save(state); draw(); });
  speed.addEventListener("input", () => { state.settings.speed = +speed.value; updSpeed(); save(state); });

  const brushBar = $(".wp-brushes"), note = $(".wp-note"), helpBox = $(".wp-helpbox");
  const renderHelp = () => {
    helpBox.innerHTML = [t("sim.hint", t("sim.run"), t("sim.step")), t("sim.ctrl"), t("sim.alt"), t("sim.helpView"), t("sim.helpUndo"), t("sim.helpCalls", nodeName("call"))]
      .map(l => `<span>${esc(l)}</span>`).join("");
  };
  renderHelp();
  // a short message over the bottom of the map (eyedropper / initiator placement), gone after a few seconds
  let noteTimer = 0;
  const showNote = msg => {
    clearTimeout(noteTimer);
    note.textContent = msg; note.hidden = !msg;
    if (msg) noteTimer = setTimeout(() => { note.hidden = true; }, 4000);
  };
  function renderBrushes() {
    brushBar.innerHTML = BRUSHES.map(b => `<button type="button" class="wp-br${state.settings.brush === b.cell ? " on" : ""}" data-b="${b.cell}" title="Cell.${esc(b.cell)}"><span class="wp-sw" style="background:${b.color}"></span>${esc(brushLabel(b))}</button>`).join("")
      + `<button type="button" class="wp-br${state.settings.brush === "bot" ? " on" : ""}" data-b="bot" title="${esc(t("sim.botTip"))}"><span class="wp-sw" style="background:#414893"></span>${esc(t("sim.bot"))}</button>`
      + `<button type="button" class="wp-br${state.settings.brush === "initiator" ? " on" : ""}" data-b="initiator" title="${esc(t("sim.initTip"))}"><span class="wp-sw wp-sw-init" style="background:${INIT_COLOR}"></span>${esc(t("sim.init"))}</button>`;
  }
  const setBrush = b => { state.settings.brush = b; renderBrushes(); save(state); };
  brushBar.addEventListener("click", e => { const b = e.target.closest("[data-b]"); if (!b) return; showNote(""); setBrush(b.dataset.b); });
  renderBrushes();

  // ---------------------------------------------------------------- drawing history (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z)
  const hist = { undo: [], redo: [] }, HIST_MAX = 60;
  const cloneWorld = w => JSON.parse(JSON.stringify(w));
  function updHist() { $(".wp-undo").disabled = !hist.undo.length; $(".wp-redo").disabled = !hist.redo.length; }
  function pushUndo(before) {
    hist.undo.push(before); if (hist.undo.length > HIST_MAX) hist.undo.shift();
    hist.redo = []; updHist();
  }
  function stepHist(from, to) {
    if (!hist[from].length) return;
    if (sim) { if (sim.status === "run" && !paused) return; reset(); onCurrent(null); }
    const cur = state.world, next = hist[from].pop();
    hist[to].push(cloneWorld(cur));
    state.world = next; seedIn.value = next.seed ?? "";
    sizeSel.value = `${next.W}x${next.H}`;
    save(state);
    if (next.W !== cur.W || next.H !== cur.H) fit();
    update(); updHist();
  }
  const undo = () => stepHist("undo", "redo"), redo = () => stepHist("redo", "undo");
  function newWorld(w) { pushUndo(cloneWorld(state.world)); reset(); state.world = w; seedIn.value = w.seed ?? ""; save(state); fit(); update(); }
  const curSize = () => sizeSel.value.split("x").map(Number);
  const generate = seed => { const [W, H] = curSize(); newWorld(makeWorld(W, H, seed)); };
  $(".wp-gen").addEventListener("click", () => generate(seedIn.value === "" ? undefined : +seedIn.value));
  $(".wp-rand").addEventListener("click", () => generate());
  $(".wp-clear").addEventListener("click", () => { const [W, H] = curSize(); newWorld(emptyWorld(W, H)); });
  $(".wp-fit").addEventListener("click", () => fit());
  $(".wp-undo").addEventListener("click", undo);
  $(".wp-redo").addEventListener("click", redo);
  // the keys act on the drawing when the last click was in this panel (the graph has its own undo)
  let panelFocus = false;
  document.addEventListener("pointerdown", e => { panelFocus = root.contains(e.target); }, true);
  document.addEventListener("focusin", e => { panelFocus = root.contains(e.target); }, true);
  window.addEventListener("keydown", e => {
    if (!panelFocus || !root.offsetParent || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) undo();
    else if (k === "y" || (k === "z" && e.shiftKey)) redo();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  sizeSel.addEventListener("change", () => generate(state.world.seed ?? undefined));

  // seismic row: trigger a break by hand (shown when the world has an initiator)
  const seisRow = $(".wp-seis"), snps = $(".wp-snps");
  snps.value = seisCfg().nodesPerSec;
  snps.addEventListener("change", () => {
    state.settings.seismic.nps = Math.max(1, Math.floor(+snps.value || SEISMIC_DEFAULTS.nodesPerSec));
    snps.value = state.settings.seismic.nps; save(state);
    if (sim && (sim.status !== "run" || paused)) { reset(); onCurrent(null); }   // takes effect from the next run
    update();
  });
  $(".wp-trig").addEventListener("click", () => {
    if (!sim) start();
    if (sim.triggerBreak) sim.triggerBreak();
    update();
  });

  // ---------------------------------------------------------------- running
  function start() {
    const { programs, main } = getPrograms();
    sim = createSim({ programs, main, world: state.world, dir: +dirSel.value, items: { ...state.settings.items }, seismic: seisCfg() });
  }
  function tick(now) {
    raf = 0;
    if (!sim || paused || sim.status !== "run") { paused = true; update(); return; }
    acc += Math.min(0.25, (now - last) / 1000) * speedNps(); last = now;
    const k = Math.min(Math.floor(acc), 50000);
    acc -= k;
    sim.run(k);
    update();
    if (sim.status === "run") raf = requestAnimationFrame(tick); else paused = true;
  }
  function run() {
    if (!sim || sim.status !== "run") start();
    paused = false; last = performance.now(); acc = 0;
    if (!raf) raf = requestAnimationFrame(tick);
    update();
  }
  function step() {
    if (!sim || sim.status !== "run") start();
    else { pause(); sim.step(); }
    update();
  }
  function pause() { paused = true; if (raf) cancelAnimationFrame(raf); raf = 0; update(); }
  function reset() { paused = true; if (raf) cancelAnimationFrame(raf); raf = 0; sim = null; }
  function stop() { reset(); update(); }
  $(".wp-run").addEventListener("click", run);
  $(".wp-step").addEventListener("click", step);
  $(".wp-pause").addEventListener("click", pause);
  $(".wp-stop").addEventListener("click", stop);

  function update() {
    draw(); renderInfo();
    onCurrent(sim ? sim.current() : null, sim ? sim.calls() : []);
    root.querySelector(".wp-pause").disabled = !sim || paused || sim.status !== "run";
    updSeis();
  }
  function updSeis() {
    const inits = state.world.initiators || [];
    seisRow.hidden = !inits.length;
    if (inits.length) {
      snps.disabled = !!(sim && sim.status === "run" && !paused);
      $(".wp-trig").disabled = !!(sim && sim.seismic && sim.seismic.list.every(o => o.state === "breaking"));
    }
  }

  // ---------------------------------------------------------------- drawing
  function fit() {
    const r = box.getBoundingClientRect(), w = state.world;
    if (!r.width || !r.height) return;
    view.cs = Math.max(1, Math.min(r.width / w.W, r.height / w.H));
    view.ox = (r.width - w.W * view.cs) / 2; view.oy = (r.height - w.H * view.cs) / 2;
    fitted = true;
    draw();
  }
  function draw() {
    const r = box.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    if (!fitted) { fitted = true; fit(); return; }
    const cw = Math.round(r.width * dpr), ch = Math.round(r.height * dpr);
    if (cv.width !== cw || cv.height !== ch) {           // resizing the canvas reallocates and clears it
      cv.width = cw; cv.height = ch;
      cv.style.width = r.width + "px"; cv.style.height = r.height + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#15110e"; ctx.fillRect(0, 0, r.width, r.height);
    const w = sim ? sim.world : state.world, cs = view.cs;
    const x0 = Math.max(0, Math.floor(-view.ox / cs)), y0 = Math.max(0, Math.floor(-view.oy / cs));
    const x1 = Math.min(w.W - 1, Math.ceil((r.width - view.ox) / cs)), y1 = Math.min(w.H - 1, Math.ceil((r.height - view.oy) / cs));
    const px = x => view.ox + x * cs, py = y => view.oy + y * cs, gap = cs >= 6 ? 1 : 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      ctx.fillStyle = cellColor(w.cells[y * w.W + x]);
      ctx.fillRect(px(x), py(y), cs - gap, cs - gap);
    }
    if (sim) {
      ctx.fillStyle = "rgba(255,110,50,.4)";
      for (const i of sim.dmg.keys()) { const x = i % w.W, y = (i / w.W) | 0; ctx.fillRect(px(x), py(y), cs - gap, cs - gap); }
      ctx.fillStyle = "rgba(255,228,163,.22)";
      for (const k of sim.trail) { const [x, y] = k.split(",").map(Number); ctx.fillRect(px(x) + cs * .3, py(y) + cs * .3, cs * .4, cs * .4); }
    }
    drawInitiators(w, px, py, cs, gap);
    const b = sim ? sim.bot : { ...state.world.bot, dir: +dirSel.value };
    ctx.fillStyle = sim && sim.dead ? "rgba(120,60,60,.85)" : "rgba(65,72,147,.92)";
    ctx.fillRect(px(b.x - 1), py(b.y - 1), cs * 3 - gap, cs * 3 - gap);
    ctx.strokeStyle = "#8f97e6"; ctx.lineWidth = 1;
    ctx.strokeRect(px(b.x - 1) + .5, py(b.y - 1) + .5, cs * 3 - gap - 1, cs * 3 - gap - 1);
    ctx.fillStyle = "#ffe4a3";
    ctx.fillRect(px(b.x + DV[b.dir][0]), py(b.y + DV[b.dir][1]), cs - gap, cs - gap);
    if (sim) {
      const [ax, ay] = sim.aimWorld();
      ctx.strokeStyle = "#3fbf5f"; ctx.lineWidth = Math.max(1.5, cs / 6);
      ctx.strokeRect(px(ax) + ctx.lineWidth / 2, py(ay) + ctx.lineWidth / 2, cs - ctx.lineWidth, cs - ctx.lineWidth);
    }
    if (drag && drag.rect) {
      const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
      const x1 = Math.max(drag.x0, drag.x1), y1 = Math.max(drag.y0, drag.y1);
      ctx.fillStyle = cellColor(state.settings.brush); ctx.globalAlpha = 0.45;
      ctx.fillRect(px(x0), py(y0), (x1 - x0 + 1) * cs, (y1 - y0 + 1) * cs);
      ctx.globalAlpha = 1; ctx.strokeStyle = "#ffe4a3"; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
      ctx.strokeRect(px(x0) - 1, py(y0) - 1, (x1 - x0 + 1) * cs + 2, (y1 - y0 + 1) * cs + 2);
      ctx.setLineDash([]);
    }
    if (altDown && hoverCell && hoverCell[0] >= 0 && hoverCell[1] >= 0 && hoverCell[0] < w.W && hoverCell[1] < w.H) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
      ctx.strokeRect(px(hoverCell[0]) - 1, py(hoverCell[1]) - 1, cs - gap + 2, cs - gap + 2);
    }
  }

  // initiators: the 5x5 footprint and the break radius (dashed when idle, amber while working, red while breaking with
  // the regrowth front)
  const initList = () => (sim && sim.seismic ? sim.seismic.list : (state.world.initiators || []).map(o => ({ ...o, state: "idle" })));
  function drawInitiators(w, px, py, cs, gap) {
    const cfg = sim && sim.seismic ? sim.seismic.cfg : seisCfg(), R = cfg.radius;
    for (const o of initList()) {
      const fx = px(o.x - FOOT), fy = py(o.y - FOOT), fs = cs * (2 * FOOT + 1) - gap;
      ctx.fillStyle = "rgba(60,110,128,.85)"; ctx.fillRect(fx, fy, fs, fs);
      ctx.strokeStyle = "#8fd3e6"; ctx.lineWidth = 1; ctx.strokeRect(fx + .5, fy + .5, fs - 1, fs - 1);
      ctx.fillStyle = "#cdeef7";                              // centre cell
      ctx.fillRect(px(o.x) + cs * .2, py(o.y) + cs * .2, cs * .6 - gap, cs * .6 - gap);
      const [cx, cy] = breakCentre(o, cfg), X = px(cx) + cs / 2, Y = py(cy) + cs / 2;
      ctx.beginPath(); ctx.arc(X, Y, R * cs, 0, Math.PI * 2);
      if (o.state === "breaking") {
        ctx.fillStyle = "rgba(229,72,77,.13)"; ctx.fill();
        ctx.strokeStyle = "#e5484d"; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke();
        const front = R * Math.max(0, o.left / sim.seismic.breakNodes);
        ctx.beginPath(); ctx.arc(X, Y, front * cs, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,160,120,.9)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.stroke();
      } else if (o.state === "working") {
        ctx.fillStyle = "rgba(227,181,60,.07)"; ctx.fill();
        ctx.strokeStyle = "#e3b53c"; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(143,211,230,.9)"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // ---------------------------------------------------------------- info box
  const fmtInt = n => Math.round(n).toLocaleString(getLang());
  const fmtSec = (nodes, nps) => (nodes / nps).toLocaleString(getLang(), { maximumFractionDigits: nodes / nps < 10 ? 1 : 0 });
  function seismicInfo() {
    const cfg = sim && sim.seismic ? sim.seismic.cfg : seisCfg(), nps = cfg.nodesPerSec;
    return initList().map(o => {
      const share = sim && sim.seismic ? o.share : minedShare(state.world, o, cfg);
      const parts = [t("seis." + o.state)];
      if (o.state === "working") parts.push(t("seis.countdown", fmtInt(o.left), fmtSec(o.left, nps)));
      if (o.state === "breaking") parts.push(t("seis.breakLeft", fmtInt(o.left), fmtSec(o.left, nps)));
      parts.push(t("seis.mined", Math.floor(share * 100), Math.round(cfg.threshold * 100)));
      return `<div class="wp-seisl ${o.state}"><b>${esc(t("seis.name", o.x, o.y))}</b>: ${parts.map(esc).join(" · ")}</div>`;
    }).join("");
  }
  function renderInfo() {
    if (!sim) { info.innerHTML = `<div class="wp-m">${esc(t("sim.botAt", state.world.bot.x, state.world.bot.y))}</div>${seismicInfo()}`; return; }
    const cur = sim.current(), { programs } = getPrograms();
    const node = cur && programs.get(cur.program)?.nodes.find(n => n.id === cur.node);
    const top = sim.frames[sim.frames.length - 1];
    const vars = top ? [...top.vars] : sim.vars ? [...sim.vars] : [];   // after a normal finish: the main frame's
    const status = sim.status === "run" ? (paused ? t("sim.paused") : t("sim.running")) : sim.dead ? t("sim.dead") : t("sim.finished", resultWord(sim.result));
    const bi = [["x", sim.bot.x], ["y", sim.bot.y], ["dir", sim.bot.dir], ["aim", sim.aim.rel ? `${t("rel")} ${sim.aim.front},${sim.aim.right}` : `${t("abs")} ${sim.aim.right},${sim.aim.front}`]];
    info.innerHTML = `
      <div><b class="wp-st ${sim.status === "run" ? "" : sim.result === "fail" ? "bad" : "ok"}">${esc(status)}</b>
        <span class="wp-m">· ${esc(t("sim.stats", sim.steps, sim.actions, sim.cargo))}</span></div>
      ${cur ? `<div>${esc(cur.program)} · ${esc(t("sim.node"))} <b>#${cur.node}</b>${node ? ` ${esc(nodeName(node.t))}` : ""}</div>` : ""}
      ${seismicInfo()}
      ${sim.frames.length > 1 ? `<div class="wp-m">${esc(t("sim.stack"))} ${sim.frames.map(f => esc(f.program)).join(" › ")}</div>` : ""}
      <div class="wp-vars">${bi.map(([k, v]) => `<span class="wp-m">${k}=${esc(v)}</span>`).join("")}${vars.map(([k, v]) => `<span><i>${esc(k)}</i>=${esc(fmtValue(v))}</span>`).join("")}</div>
      <div class="wp-log">${sim.log.slice(-12).map(l => esc(trLog(l))).join("<br>")}</div>`;
  }

  // ---------------------------------------------------------------- painting, panning, zooming
  const cellOf = e => { const r = cv.getBoundingClientRect(); return [Math.floor((e.clientX - r.left - view.ox) / view.cs), Math.floor((e.clientY - r.top - view.oy) / view.cs)]; };

  // ---------------------------------------------------------------- eyedropper: Alt+click picks the brush for a cell
  let altDown = false, hoverCell = null, overCanvas = false;
  const ALIAS = { BackWorn: "Back", FedRoad: "Road" };     // look-alikes with no brush of their own
  function setAlt(on) {
    if (on === altDown) return;
    altDown = on; cv.classList.toggle("alt", on); draw();
  }
  function pickAt([x, y]) {
    const w = sim ? sim.world : state.world, b = sim ? sim.bot : state.world.bot;
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return;
    let pick = null;
    if (Math.abs(x - b.x) <= 1 && Math.abs(y - b.y) <= 1) pick = "bot";
    else if (initiatorAt(w, x, y) >= 0) pick = "initiator";
    else {
      const c = w.cells[y * w.W + x];
      const br = BRUSHES.find(q => q.cell === c) || BRUSHES.find(q => q.cell === ALIAS[c]);
      const same = BRUSHES.filter(q => q.color === cellColor(c));   // drawn in exactly one brush's colour
      pick = br ? br.cell : same.length === 1 ? same[0].cell : null;
      if (!pick) { showNote(t("sim.noBrush", `${cellName(c)} (Cell.${c})`)); return; }
    }
    showNote("");
    setBrush(pick);
  }
  cv.addEventListener("mousedown", e => { if (e.altKey) e.preventDefault(); });
  cv.addEventListener("pointerenter", e => { overCanvas = true; setAlt(e.altKey); });
  cv.addEventListener("pointerleave", () => { overCanvas = false; hoverCell = null; setAlt(false); });
  const onKey = e => {
    if (!overCanvas || e.key !== "Alt") return;
    e.preventDefault();             // keep the browser from moving focus to its menu bar
    setAlt(e.type === "keydown");
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", () => setAlt(false));
  let drag = null;
  // one cell with a cell brush; the bot's body and initiator footprints only take Back or Road
  function setCell(w, x, y, brush) {
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return false;
    const ab = w.bot;
    if ((initiatorAt(w, x, y) >= 0 || (Math.abs(x - ab.x) <= 1 && Math.abs(y - ab.y) <= 1)) && !["Back", "Road"].includes(brush)) return false;
    w.cells[y * w.W + x] = brush;
    return true;
  }
  const isCellBrush = () => !["bot", "initiator"].includes(state.settings.brush);
  // Ctrl+drag: fill the rectangle between the press and the release
  function fillRect(r) {
    const w = state.world;
    if (sim) { if (sim.status === "run" && !paused) return; reset(); onCurrent(null); }
    const x0 = Math.max(0, Math.min(r.x0, r.x1)), x1 = Math.min(w.W - 1, Math.max(r.x0, r.x1));
    const y0 = Math.max(0, Math.min(r.y0, r.y1)), y1 = Math.min(w.H - 1, Math.max(r.y0, r.y1));
    let n = 0;
    const before = cloneWorld(w);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (setCell(w, x, y, state.settings.brush)) n++;
    if (n) { pushUndo(before); save(state); }
    draw(); renderInfo(); updSeis();
  }
  function paint(e) {
    const [x, y] = cellOf(e), w = state.world;
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return;
    if (sim) { if (sim.status === "run" && !paused) return; reset(); onCurrent(null); }
    const onInit = initiatorAt(w, x, y);
    if (state.settings.brush === "initiator") {
      // one stamp per click: on an initiator it removes it, elsewhere it places one centred on the cell
      if (drag.stamped) return;
      drag.stamped = true;
      if (onInit >= 0) { w.initiators.splice(onInit, 1); if (!w.initiators.length) delete w.initiators; }
      else if (!stampInitiator(w, x, y)) { showNote(t("sim.initBad")); return; }
      showNote("");
    } else if (state.settings.brush === "bot") {
      // the body stays off the border; a drag moves the bot without carving a trail: the cells go back to how they
      // were before the stroke, and only the body at the final spot is cleared
      const bx = Math.min(w.W - 3, Math.max(2, x)), by = Math.min(w.H - 3, Math.max(2, y));
      if (drag.before && drag.before.cells.length === w.cells.length) w.cells = drag.before.cells.slice();
      w.bot = { x: bx, y: by };
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) w.cells[(by + dy) * w.W + bx + dx] = "Back";
    } else if (!setCell(w, x, y, state.settings.brush)) return;
    if (!drag.dirty && drag.before) pushUndo(drag.before);
    drag.dirty = true;
    draw(); renderInfo(); updSeis();
  }
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("pointerdown", e => {
    if (e.button === 0 && e.altKey) { e.preventDefault(); pickAt(cellOf(e)); return; }
    cv.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) { drag = { pan: true, x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (sim && sim.status === "run" && !paused) return;
    if ((e.ctrlKey || e.metaKey) && isCellBrush()) {
      e.preventDefault();
      const [x, y] = cellOf(e);
      drag = { rect: true, x0: x, y0: y, x1: x, y1: y };
      draw(); return;
    }
    drag = { pan: false, before: cloneWorld(state.world) }; paint(e);
  });
  cv.addEventListener("pointermove", e => {
    const hc = cellOf(e), moved = !hoverCell || hc[0] !== hoverCell[0] || hc[1] !== hoverCell[1];
    hoverCell = hc;
    if (e.altKey !== altDown) setAlt(e.altKey); else if (altDown && moved) draw();
    if (!drag) return;
    if (drag.pan) { view.ox = drag.ox + e.clientX - drag.x; view.oy = drag.oy + e.clientY - drag.y; draw(); }
    else if (drag.rect) { if (moved) { drag.x1 = hc[0]; drag.y1 = hc[1]; draw(); } }
    else paint(e);
  });
  const endDrag = e => {
    if (drag && drag.rect && e && e.type === "pointerup") { const r = drag; drag = null; fillRect(r); return; }
    if (drag && drag.dirty) save(state);
    const wasRect = drag && drag.rect;
    drag = null;
    if (wasRect) draw();
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015), cs = Math.min(64, Math.max(1, view.cs * k));
    view.ox = mx - (mx - view.ox) * cs / view.cs; view.oy = my - (my - view.oy) * cs / view.cs; view.cs = cs;
    draw();
  }, { passive: false });

  const ro = new ResizeObserver(() => draw());
  ro.observe(box);
  update();
  onLangChange(() => { relabel(); updSpeed(); renderBrushes(); renderHelp(); renderInfo(); });

  return {
    refresh() { draw(); renderInfo(); },
    stop,
    // another program tab was opened: reset, unless that program is on the running simulation's call stack
    programSwitched(name) { if (sim && !(sim.status === "run" && sim.frames.some(f => f.program === name))) stop(); },
    resize() { fitted = false; draw(); },
  };
}
