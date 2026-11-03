// World panel: paint a sandbox world and run the compiled programs in it (RUN / DEBUG / Pause / Stop).
import { T, DIR_ARROW, CELLS } from "./nodes.js";
import { createSim, makeWorld, emptyWorld, cellAt, cellColor, BRUSHES, DV, fmtValue } from "./sim.js";
import { t, tOr, onLangChange } from "./i18n.js";

const LS_KEY = "js2erz.world.v1";
const SIZES = [[64, 48], [96, 72], [128, 96], [192, 144]];
const SIM_ITEMS = ["RoadSector", "Block", "MiningCharge"];
const MAX_NPS = 2000;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o.world && Array.isArray(o.world.cells)) o.world.cells = o.world.cells.map(i => typeof i === "number" ? CELLS[i] || "Back" : i);
    return o;
  } catch (e) { return null; }
}
function save(state) {
  try {
    const w = state.world;
    localStorage.setItem(LS_KEY, JSON.stringify({
      world: { W: w.W, H: w.H, seed: w.seed, bot: w.bot, cells: w.cells.map(c => Math.max(0, CELLS.indexOf(c))) },
      settings: state.settings,
    }));
  } catch (e) { /* storage unavailable */ }
}

// UI words in the panel language; `log` lines from sim.js are matched and rebuilt (sim.js itself stays English)
const nodeName = ty => (T[ty] ? tOr("node." + ty, T[ty].label) : ty);
const LABEL_TYPE = Object.fromEntries(Object.entries(T).map(([k, v]) => [v.label, k]));
const resultWord = r => (r === "success" ? t("sim.success") : r === "fail" ? t("sim.fail") : r);
const cellName = c => tOr("cell." + c, c);
const brushLabel = b => tOr("brush." + b.cell, b.label);
function trWhy(w) {
  let m;
  if ((m = w.match(/^no program "(.*)"$/))) return t("log.noProg", m[1]);
  if ((m = w.match(/^output "(.*)" of (.+) #(\d+) is not connected$/))) return t("log.notConn", m[1], LABEL_TYPE[m[2]] ? nodeName(LABEL_TYPE[m[2]]) : m[2], m[3]);
  if ((m = w.match(/^node (\S+) not found in "(.*)"$/))) return t("log.notFound", m[1], m[2]);
  if ((m = w.match(/^EXIT (SUCCESS|FAIL)$/))) return t("log.exit", nodeName("exit"), t(m[1] === "FAIL" ? "exit.fail" : "exit.success"));
  if (w === "stopped") return t("log.stopped");
  if ((m = w.match(/^unknown node type (.*)$/))) return t("log.unknown", m[1]);
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
  return line;
}

export function mountWorldPanel(root, { getPrograms, onCurrent = () => {} } = {}) {
  root.classList.add("wp");
  // data-k: textContent, data-kt: title, data-ka: aria-label (i18n keys)
  root.innerHTML = `
    <div class="wp-bar">
      <label class="wp-l"><span data-k="sim.start"></span> <select class="wp-dir" data-ka="sim.startAria"></select></label>
      <button type="button" class="wp-debug" data-k="sim.debug" data-kt="sim.debugTip"></button>
      <button type="button" class="wp-run" data-k="sim.run"></button>
      <button type="button" class="wp-pause" data-k="sim.pause"></button>
      <button type="button" class="wp-stop" data-k="sim.stop" data-kt="sim.stopTip"></button>
      <label class="wp-l"><span data-k="sim.speed"></span> <input class="wp-speed" type="range" min="0" max="100" data-ka="sim.speedAria"></label>
      <span class="wp-nps wp-m"></span>
    </div>
    <div class="wp-brushes" role="toolbar" data-ka="sim.brushes"></div>
    <div class="wp-cvbox"><canvas class="wp-cv"></canvas></div>
    <div class="wp-hint wp-m" aria-live="polite"></div>
    <div class="wp-row">
      <select class="wp-size" data-ka="sim.size">${SIZES.map(([w, h]) => `<option value="${w}x${h}">${w}×${h}</option>`).join("")}</select>
      <label class="wp-l"><span data-k="sim.seed"></span> <input class="wp-seed" type="number" style="width:84px"></label>
      <button type="button" class="wp-gen" data-k="sim.gen" data-kt="sim.genTip"></button>
      <button type="button" class="wp-rand" data-k="sim.rand"></button>
      <button type="button" class="wp-clear" data-k="sim.clear" data-kt="sim.clearTip"></button>
      <button type="button" class="wp-fit" data-k="sim.fit"></button>
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
  const state = {
    world: stored?.world && stored.world.cells?.length === stored.world.W * stored.world.H ? stored.world : makeWorld(96, 72),
    settings: Object.assign({ dir: 0, speed: 40, brush: "Regolith", items: { RoadSector: 20, Block: 20, MiningCharge: 5 } }, stored?.settings || {}),
  };
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

  const brushBar = $(".wp-brushes"), hint = $(".wp-hint");
  let pickNote = "";                 // eyedropper message that replaces the hint line until the next pick
  const renderHint = () => { hint.textContent = pickNote || t("sim.alt"); };
  function renderBrushes() {
    brushBar.innerHTML = BRUSHES.map(b => `<button type="button" class="wp-br${state.settings.brush === b.cell ? " on" : ""}" data-b="${b.cell}" title="Cell.${esc(b.cell)}"><span class="wp-sw" style="background:${b.color}"></span>${esc(brushLabel(b))}</button>`).join("")
      + `<button type="button" class="wp-br${state.settings.brush === "bot" ? " on" : ""}" data-b="bot" title="${esc(t("sim.botTip"))}"><span class="wp-sw" style="background:#414893"></span>${esc(t("sim.bot"))}</button>`;
  }
  const setBrush = b => { state.settings.brush = b; renderBrushes(); save(state); };
  brushBar.addEventListener("click", e => { const b = e.target.closest("[data-b]"); if (!b) return; pickNote = ""; setBrush(b.dataset.b); renderHint(); });
  renderBrushes();
  renderHint();

  function newWorld(w) { reset(); state.world = w; seedIn.value = w.seed ?? ""; save(state); fit(); }
  const curSize = () => sizeSel.value.split("x").map(Number);
  $(".wp-gen").addEventListener("click", () => { const [W, H] = curSize(); newWorld(makeWorld(W, H, seedIn.value === "" ? undefined : +seedIn.value)); });
  $(".wp-rand").addEventListener("click", () => { const [W, H] = curSize(); newWorld(makeWorld(W, H)); });
  $(".wp-clear").addEventListener("click", () => { const [W, H] = curSize(); newWorld(emptyWorld(W, H)); });
  $(".wp-fit").addEventListener("click", () => fit());
  sizeSel.addEventListener("change", () => { const [W, H] = curSize(); newWorld(makeWorld(W, H, state.world.seed ?? undefined)); });

  // ---------------------------------------------------------------- running
  function start() {
    const { programs, main } = getPrograms();
    sim = createSim({ programs, main, world: state.world, dir: +dirSel.value, items: { ...state.settings.items } });
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
  function debugStep() {
    if (!sim || sim.status !== "run") start();
    else { pause(); sim.step(); }
    update();
  }
  function pause() { paused = true; if (raf) cancelAnimationFrame(raf); raf = 0; update(); }
  function reset() { paused = true; if (raf) cancelAnimationFrame(raf); raf = 0; sim = null; }
  function stop() { reset(); update(); }
  $(".wp-run").addEventListener("click", run);
  $(".wp-debug").addEventListener("click", debugStep);
  $(".wp-pause").addEventListener("click", pause);
  $(".wp-stop").addEventListener("click", stop);

  function update() {
    draw(); renderInfo();
    onCurrent(sim ? sim.current() : null);
    root.querySelector(".wp-pause").disabled = !sim || paused || sim.status !== "run";
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
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    cv.style.width = r.width + "px"; cv.style.height = r.height + "px";
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
    const b = sim ? sim.bot : { ...state.world.bot, dir: +dirSel.value };
    ctx.fillStyle = "rgba(65,72,147,.92)";
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
    if (altDown && hoverCell && hoverCell[0] >= 0 && hoverCell[1] >= 0 && hoverCell[0] < w.W && hoverCell[1] < w.H) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
      ctx.strokeRect(px(hoverCell[0]) - 1, py(hoverCell[1]) - 1, cs - gap + 2, cs - gap + 2);
    }
  }

  // ---------------------------------------------------------------- info box
  function renderInfo() {
    if (!sim) { info.innerHTML = `<div class="wp-m">${esc(t("sim.hint", t("sim.run"), t("sim.debug"), state.world.bot.x, state.world.bot.y))}</div>`; return; }
    const cur = sim.current(), { programs } = getPrograms();
    const node = cur && programs.get(cur.program)?.nodes.find(n => n.id === cur.node);
    const top = sim.frames[sim.frames.length - 1];
    const vars = top ? [...top.vars] : [];
    const status = sim.status === "run" ? (paused ? t("sim.paused") : t("sim.running")) : t("sim.finished", resultWord(sim.result));
    const bi = [["x", sim.bot.x], ["y", sim.bot.y], ["dir", sim.bot.dir], ["aim", `${sim.aim.rel ? t("rel") : t("abs")} ${sim.aim.front},${sim.aim.right}`]];
    info.innerHTML = `
      <div><b class="wp-st ${sim.status === "run" ? "" : sim.result === "fail" ? "bad" : "ok"}">${esc(status)}</b>
        <span class="wp-m">· ${esc(t("sim.stats", sim.steps, sim.actions, sim.cargo))}</span></div>
      ${cur ? `<div>${esc(cur.program)} · ${esc(t("sim.node"))} <b>#${cur.node}</b>${node ? ` ${esc(nodeName(node.t))}` : ""}</div>` : ""}
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
    else {
      const c = w.cells[y * w.W + x];
      const br = BRUSHES.find(q => q.cell === c) || BRUSHES.find(q => q.cell === ALIAS[c]);
      const same = BRUSHES.filter(q => q.color === cellColor(c));   // drawn in exactly one brush's colour
      pick = br ? br.cell : same.length === 1 ? same[0].cell : null;
      if (!pick) { pickNote = t("sim.noBrush", `${cellName(c)} (Cell.${c})`); renderHint(); return; }
    }
    pickNote = "";
    setBrush(pick); renderHint();
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
  function paint(e) {
    const [x, y] = cellOf(e), w = state.world;
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return;
    if (sim) { if (sim.status === "run" && !paused) return; reset(); onCurrent(null); }
    if (state.settings.brush === "bot") {
      const bx = Math.min(w.W - 2, Math.max(1, x)), by = Math.min(w.H - 2, Math.max(1, y));
      w.bot = { x: bx, y: by };
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) w.cells[(by + dy) * w.W + bx + dx] = "Back";
    } else {
      const ab = w.bot;
      if (Math.abs(x - ab.x) <= 1 && Math.abs(y - ab.y) <= 1 && !["Back", "Road"].includes(state.settings.brush)) return;   // keep the body free
      w.cells[y * w.W + x] = state.settings.brush;
    }
    drag.dirty = true;
    draw(); renderInfo();
  }
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("pointerdown", e => {
    if (e.button === 0 && e.altKey) { e.preventDefault(); pickAt(cellOf(e)); return; }
    cv.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) { drag = { pan: true, x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (sim && sim.status === "run" && !paused) return;
    drag = { pan: false }; paint(e);
  });
  cv.addEventListener("pointermove", e => {
    const hc = cellOf(e), moved = !hoverCell || hc[0] !== hoverCell[0] || hc[1] !== hoverCell[1];
    hoverCell = hc;
    if (e.altKey !== altDown) setAlt(e.altKey); else if (altDown && moved) draw();
    if (!drag) return;
    if (drag.pan) { view.ox = drag.ox + e.clientX - drag.x; view.oy = drag.oy + e.clientY - drag.y; draw(); }
    else paint(e);
  });
  const endDrag = () => { if (drag && drag.dirty) save(state); drag = null; };
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
  onLangChange(() => { relabel(); updSpeed(); renderBrushes(); renderHint(); renderInfo(); });

  return {
    refresh() { draw(); renderInfo(); },
    stop,
    resize() { fitted = false; draw(); },
  };
}
