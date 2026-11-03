// Program simulator: a grid world with a 3x3 bot and an interpreter for the graph IR (see nodes.js).
// DOM-free so it runs in the browser and under `node --test`.
//
// Geometry follows the game as described by the erzstat.site Programmator wiki: the bot body is 3x3, a straight
// step needs the 3 cells of the next row free, a diagonal step the 5 cells of the next corner; DIG strikes the first
// non-empty cell of the front row in the order centre, right, left (diagonal: corner, then the sides).
// Cell names and category membership are the real game values.

import { T, CELLS, CATEGORY_CELLS, BUILTIN_VARS, WRITABLE_BUILTINS, fmtNum } from "./nodes.js";

// ---------------------------------------------------------------- cells
const WALKABLE = new Set(CATEGORY_CELLS.Walkable);
const DIGGABLE = new Set(CATEGORY_CELLS.Diggable);
const CELL_HP = { Regolith: 2, Chondrite: 1, Breccia: 2, SulfideRock: 2, SilicateRock: 3, MetallicRock: 5, ConsolidatedRock: 5,
  SinterCrust: 8, DenseOre: 10, MetallicCrust: 8 };
const cellHp = c => CELL_HP[c] ?? (c.startsWith("Block") ? 3 : 2);
export const isWalkable = c => WALKABLE.has(c);
export const isDiggable = c => DIGGABLE.has(c);

const COLORS = {
  Empty: "#1a1512", Back: "#241d18", BackWorn: "#2a221c", BackBurning: "#4a2414", Hole: "#0e0b09", Blank: "#1a1512",
  Road: "#6d6a66", FedRoad: "#8a8580",
  Regolith: "#7a5434", Chondrite: "#b8935a", Breccia: "#8a6d4e", SulfideRock: "#3aa39b", DenseOre: "#8c3b8f",
  WaterIce: "#9fd3e6", CryoIce: "#cfe9f2", PressurizedIce: "#7fb7d0", SilicateRock: "#c9c2a8", MetallicRock: "#8a8f99",
  PhosphateRock: "#c48a3a", ConsolidatedRock: "#5d4a3a", CarbonaceousRock: "#3b3431", ReactiveSulfide: "#c9b13a",
  SinterCrust: "#6e655c", MetallicCrust: "#4a5260", TectonicMass: "#1c1a30",
  BlockSimple: "#9aa0aa", BlockFed: "#b0b8c8", BlockMetal: "#7c8594",
};
export function cellColor(name) {
  if (COLORS[name]) return COLORS[name];
  if (name && name.startsWith("Block")) return "#8f96a3";
  return isWalkable(name) ? "#241d18" : "#5a4a3a";
}
export const BRUSHES = [
  ["Back", "Dug out"], ["Road", "Road"], ["Regolith", "Regolith"], ["Chondrite", "Chondrite"], ["SulfideRock", "Sulfide rock"],
  ["DenseOre", "Dense ore"], ["WaterIce", "Water ice"], ["SinterCrust", "Sinter crust"], ["MetallicCrust", "Metallic crust"],
  ["BlockSimple", "Block"], ["TectonicMass", "Wall (undiggable)"],
].map(([cell, label]) => ({ cell, label, color: cellColor(cell) }));

// ---------------------------------------------------------------- geometry
export const DV = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];   // 0 east, clockwise, y down
const rot90 = ([x, y], k) => { for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [-y, x]; return [x, y]; };
// cells the body enters on a step (relative to the bot centre)
export function frontCells(dir) {
  return dir % 2 === 0
    ? [[2, -1], [2, 0], [2, 1]].map(p => rot90(p, dir / 2))
    : [[0, -2], [1, -2], [2, -2], [2, -1], [2, 0]].map(p => rot90(p, (dir + 1) / 2));
}
// strike order of DIG / MOVEDIG
export function digOrder(dir) {
  return dir % 2 === 0
    ? [[2, 0], [2, 1], [2, -1]].map(p => rot90(p, dir / 2))
    : [[2, -2], [2, -1], [1, -2], [2, 0], [0, -2]].map(p => rot90(p, (dir + 1) / 2));
}

// ---------------------------------------------------------------- world generation
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// seeded value noise on a lattice, smoothly interpolated
function valueNoise(rnd) {
  const N = 256, tab = new Float32Array(N * N);
  for (let i = 0; i < tab.length; i++) tab[i] = rnd() * 2 - 1;
  const at = (x, y) => tab[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const s = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = s(x - x0), fy = s(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
}
function fractal(n, x, y, oct = 3) {
  let sum = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { sum += amp * n(x * f, y * f); norm += amp; amp /= 2; f *= 2; }
  return sum / norm;
}

export function makeWorld(W = 96, H = 72, seed) {
  seed = seed == null || !isFinite(seed) ? Math.floor(Math.random() * 1e6) : Math.floor(seed);
  const rnd = mulberry32(seed);
  const nBase = valueNoise(rnd), nLayer = valueNoise(rnd), nOre = valueNoise(rnd), nIce = valueNoise(rnd),
    nCave = valueNoise(rnd), nHard = valueNoise(rnd);
  const cells = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = "Regolith";
    const base = fractal(nBase, x / 18, y / 18);
    if (base > 0.12) c = "Chondrite";
    else if (base < -0.3) c = "Breccia";
    if (fractal(nLayer, x / 9, y / 9, 2) > 0.38) c = "SilicateRock";
    const hard = fractal(nHard, x / 14, y / 14);
    if (hard > 0.42) c = hard > 0.52 ? "MetallicCrust" : "SinterCrust";
    else {
      const ore = fractal(nOre, x / 5, y / 5, 2);
      if (ore > 0.5) c = "DenseOre"; else if (ore > 0.4) c = "SulfideRock";
      if (fractal(nIce, x / 7, y / 7, 2) > 0.46) c = "WaterIce";
      if (fractal(nCave, x / 11, y / 11) < -0.4) c = "Back";
    }
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) c = "TectonicMass";
    cells[y * W + x] = c;
  }
  const bot = { x: W >> 1, y: H >> 1 };
  const set = (x, y, c) => { if (x > 0 && y > 0 && x < W - 1 && y < H - 1) cells[y * W + x] = c; };
  // a road ring west of the bot, so road-following programs work at once
  const R = 8, rcx = bot.x - 13, rcy = bot.y;
  for (let a = 0; a < 360; a++) {
    const x = Math.round(rcx + R * Math.cos(a * Math.PI / 180)), y = Math.round(rcy + R * Math.sin(a * Math.PI / 180));
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, "Road");
  }
  // open pocket around the bot; no hard rock right next to it
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const X = bot.x + dx, Y = bot.y + dy;
    if (X <= 0 || Y <= 0 || X >= W - 1 || Y >= H - 1) continue;
    const i = Y * W + X;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) cells[i] = "Back";
    else if (cells[i] === "SinterCrust" || cells[i] === "MetallicCrust") cells[i] = "Regolith";
  }
  return { W, H, seed, cells, bot };
}
export function emptyWorld(W, H) {
  const cells = new Array(W * H).fill("Back");
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x === 0 || y === 0 || x === W - 1 || y === H - 1) cells[y * W + x] = "TectonicMass";
  return { W, H, seed: null, cells, bot: { x: W >> 1, y: H >> 1 } };
}
export const cellAt = (w, x, y) => (x < 0 || y < 0 || x >= w.W || y >= w.H) ? "TectonicMass" : w.cells[y * w.W + x];

// ---------------------------------------------------------------- interpreter
export const STACK_LIMIT = 32;
const num = v => ({ t: "n", v });
export function fmtValue(v) { return v == null ? "—" : v.t === "n" ? fmtNum(v.v) : v.v; }

export function createSim({ programs, main, world, dir = 0, items = { RoadSector: 20, Block: 20, MiningCharge: 5 }, params = {} }) {
  const index = new Map();   // program name -> Map(node id -> node)
  for (const [name, p] of programs) index.set(name, new Map(p.nodes.map(n => [n.id, n])));
  const w = { W: world.W, H: world.H, seed: world.seed, cells: world.cells.slice(), bot: { ...world.bot } };
  const S = {
    world: w, bot: { x: w.bot.x, y: w.bot.y, dir: ((dir % 8) + 8) % 8 }, aim: { rel: true, front: 2, right: 0 },
    frames: [], status: "run", result: null, steps: 0, actions: 0, cargo: 0, log: [], trail: new Set(), dmg: new Map(),
    items: { ...items }, autos: { auto_attack_miners: 1, auto_attack_mobs: 1, auto_war: 1 }, last: null,
  };
  S.trail.add(S.bot.x + "," + S.bot.y);
  const log = s => { S.log.push(s); if (S.log.length > 200) S.log.shift(); };
  const done = (result, why) => { S.status = "done"; S.result = result; log(`Program finished (${result}): ${why}`); };

  const startOf = prog => prog.nodes.find(n => n.t === "start") || prog.nodes[0];
  function pushFrame(name, vars) {
    const prog = programs.get(name);
    S.frames.push({ program: name, node: startOf(prog).id, vars, waiting: null });
  }
  {
    const prog = programs.get(main);
    if (!prog) { done("fail", `no program "${main}"`); }
    else {
      const vars = new Map();
      for (const name of startOf(prog).p?.params || []) {
        const raw = params[name];
        if (raw !== undefined && raw !== "" && isFinite(+raw)) vars.set(name, num(+raw));
      }
      pushFrame(main, vars);
      log(`Start "${main}", facing ${["E", "SE", "S", "SW", "W", "NW", "N", "NE"][S.bot.dir]}`);
    }
  }

  // --- world access
  const inside = (x, y) => x >= 0 && y >= 0 && x < w.W && y < w.H;
  const setCell = (x, y, c) => { w.cells[y * w.W + x] = c; S.dmg.delete(y * w.W + x); };
  const botCovers = (x, y) => Math.abs(x - S.bot.x) <= 1 && Math.abs(y - S.bot.y) <= 1;
  function aimWorld() {
    const a = S.aim, b = S.bot;
    if (!a.rel) return [b.x + a.right, b.y + a.front];
    const fw = DV[b.dir], rt = DV[(b.dir + 2) % 8];
    return [b.x + a.front * fw[0] + a.right * rt[0], b.y + a.front * fw[1] + a.right * rt[1]];
  }
  S.aimWorld = aimWorld;
  function tryMove() {
    const b = S.bot;
    if (!frontCells(b.dir).every(([dx, dy]) => isWalkable(cellAt(w, b.x + dx, b.y + dy)))) return false;
    b.x += DV[b.dir][0]; b.y += DV[b.dir][1];
    S.trail.add(b.x + "," + b.y); S.actions++;
    return true;
  }
  // one strike: 0 success, 1 can't dig, 2 nothing to dig
  function digAt(x, y) {
    const c = cellAt(w, x, y);
    if (isWalkable(c)) return 2;
    if (!inside(x, y) || !isDiggable(c)) return 1;
    const i = y * w.W + x, left = (S.dmg.get(i) ?? cellHp(c)) - 1;
    S.actions++;
    if (left > 0) S.dmg.set(i, left);
    else { setCell(x, y, "Back"); S.cargo++; }
    return 0;
  }
  function strike() {
    const b = S.bot;
    for (const [dx, dy] of digOrder(b.dir)) { const r = digAt(b.x + dx, b.y + dy); if (r !== 2) return r; }
    return 2;
  }
  const ITEM_FX = {
    RoadSector(x, y) { const c = cellAt(w, x, y); if (!inside(x, y) || !isWalkable(c) || c === "Road" || c === "FedRoad") return false; setCell(x, y, "Road"); return true; },
    Block(x, y) { if (!inside(x, y) || !isWalkable(cellAt(w, x, y)) || botCovers(x, y)) return false; setCell(x, y, "BlockSimple"); return true; },
    MiningCharge(x, y) {
      const bombable = new Set(CATEGORY_CELLS.Bombable);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (inside(X, Y) && bombable.has(cellAt(w, X, Y))) { setCell(X, Y, "Back"); S.cargo++; }
      }
      return true;
    },
  };

  // --- variables
  function builtin(name) {
    const b = S.bot, a = S.aim, fw = DV[b.dir];
    switch (name) {
      case "rnd": return num(Math.random());
      case "x": return num(b.x); case "y": return num(b.y); case "dir": return num(b.dir);
      case "hp": case "energy": case "hp_max": case "energy_max": case "hp_p": case "energy_p": return num(100);
      case "cargo": return num(S.cargo); case "cargo_max": return num(1000); case "cargo_p": return num(Math.min(100, S.cargo / 10));
      case "aim_rel": return num(a.rel ? 1 : 0);
      case "aim_x": { const [x] = aimWorld(); return num(x - b.x); }
      case "aim_y": { const [, y] = aimWorld(); return num(y - b.y); }
      case "aim_right": return num(a.rel ? a.right : 0);
      case "aim_front": return num(a.rel ? a.front : 0);
      case "auto_attack_miners": case "auto_attack_mobs": case "auto_war": return num(S.autos[name]);
      // SCAN stores the aimed cell (as in the game); before the first SCAN, the cell 2 ahead
      case "scan_cell_front": return { t: "c", v: S.scanFront ?? cellAt(w, b.x + 2 * fw[0], b.y + 2 * fw[1]) };
      case "scan_cell_back": return { t: "c", v: cellAt(w, b.x - 2 * fw[0], b.y - 2 * fw[1]) };
      default: return BUILTIN_VARS.includes(name) ? num(0) : undefined;
    }
  }
  function writeBuiltin(name, v) {
    if (v.t !== "n") return false;
    const a = S.aim;
    if (name === "aim_x" || name === "aim_y") {
      if (a.rel) { const [x, y] = aimWorld(); a.rel = false; a.right = x - S.bot.x; a.front = y - S.bot.y; }
      if (name === "aim_x") a.right = Math.round(v.v); else a.front = Math.round(v.v);
      return true;
    }
    if (name === "aim_right" || name === "aim_front") {
      if (!a.rel) { a.rel = true; a.right = 0; a.front = 0; }
      if (name === "aim_right") a.right = Math.round(v.v); else a.front = Math.round(v.v);
      return true;
    }
    S.autos[name] = v.v ? 1 : 0;
    return true;
  }
  const getVar = (fr, name) => { const b = builtin(name); return b !== undefined ? b : fr.vars.get(name); };
  function evalOp(fr, o) {
    if (o == null) return undefined;
    if (o.var != null) return getVar(fr, o.var);
    if (o.num != null) return num(+o.num);
    if (o.cell != null) return { t: "c", v: o.cell };
    return undefined;
  }
  function setVar(fr, name, v) {
    if (!name || v === undefined || (v.t === "n" && !isFinite(v.v))) return false;
    if (BUILTIN_VARS.includes(name)) return WRITABLE_BUILTINS.includes(name) && writeBuiltin(name, v);
    fr.vars.set(name, v);
    return true;
  }
  const asCell = v => v && v.t === "c" ? v.v : v && v.t === "n" && Number.isInteger(v.v) && CELLS[v.v] ? CELLS[v.v] : null;

  // one node -> output index, or {exit}, or {call}
  function exec(fr, n) {
    const p = n.p || {};
    switch (n.t) {
      case "start": case "pass": return 0;
      case "rotA": S.bot.dir = ((p.dir % 8) + 8) % 8; S.actions++; return 0;
      case "rotR": S.bot.dir = (((S.bot.dir + p.dir) % 8) + 8) % 8; S.actions++; return 0;
      case "move": return tryMove() ? 0 : 1;
      case "dig": return strike();
      case "movedig": return tryMove() ? 0 : strike() === 0 ? 1 : 2;
      case "aimA": S.aim = { rel: false, front: p.front, right: p.right }; return 0;
      case "aimR": S.aim = { rel: true, front: p.front, right: p.right }; return 0;
      case "scan": { const [x, y] = aimWorld(), c = cellAt(w, x, y); S.scanFront = c; return (CATEGORY_CELLS[p.category] || []).includes(c) ? 0 : 1; }
      case "use": {
        const it = p.item;
        if (!(it in ITEM_FX)) { log(`USE ${it}: not simulated`); return 2; }
        if (!(S.items[it] > 0)) return 2;
        const [x, y] = aimWorld();
        if (!ITEM_FX[it](x, y)) return 1;
        S.items[it]--; S.actions++;
        return 0;
      }
      case "inv": case "cargo": return 1;   // no base in the sandbox
      case "exit": return { exit: p.fail ? "fail" : "success" };
      case "call": return { call: p };
      case "assign": return setVar(fr, p.varname, evalOp(fr, p.value)) ? 0 : 1;
      case "oper": {
        const a = evalOp(fr, p.left), b = evalOp(fr, p.right);
        if (!a || !b || a.t !== "n" || b.t !== "n") return 1;
        const r = { Plus: a.v + b.v, Minus: a.v - b.v, Mult: a.v * b.v, Div: a.v / b.v, Mod: a.v % b.v }[p.op];
        return r !== undefined && isFinite(r) && setVar(fr, p.varname, num(r)) ? 0 : 1;
      }
      case "cmp": {
        const a = evalOp(fr, p.left), b = evalOp(fr, p.right);
        if (!a || !b || a.t !== "n" || b.t !== "n") return 3;
        return a.v > b.v ? 0 : a.v === b.v ? 1 : 2;
      }
      case "eq": {
        const v = evalOp(fr, p.value);
        if (!v) return 1;
        return (p.set || []).some(o => { const s = evalOp(fr, o); return s && s.t === v.t && s.v === v.v; }) ? 0 : 1;
      }
      case "cell": {
        const c = asCell(evalOp(fr, p.value));
        return c && (CATEGORY_CELLS[p.category] || []).includes(c) ? 0 : 1;
      }
      default: return { exit: "fail", why: `unknown node type ${n.t}` };
    }
  }
  function follow(fr, n, out) {
    const next = n.outs[out];
    if (next == null) {
      const lab = (T[n.t]?.outs[out] || ["?", "?"])[1];
      return finishFrame("success", `output "${lab}" of ${T[n.t]?.label || n.t} #${n.id} is not connected`);
    }
    fr.node = next;
  }
  function finishFrame(result, why) {
    const fin = S.frames.pop();
    if (!S.frames.length) { S.vars = fin.vars; return done(result, why); }   // keep the main frame's variables
    log(`"${fin.program}" returned ${result}`);
    const caller = S.frames[S.frames.length - 1], cn = index.get(caller.program).get(caller.waiting);
    caller.waiting = null;
    follow(caller, cn, result === "fail" ? 1 : 0);
  }

  S.current = () => {
    if (S.status === "run" && S.frames.length) { const f = S.frames[S.frames.length - 1]; return { program: f.program, node: f.node }; }
    return S.last;
  };
  S.step = () => {
    if (S.status !== "run") return;
    const fr = S.frames[S.frames.length - 1];
    const n = index.get(fr.program).get(fr.node);
    if (!n) return finishFrame("fail", `node ${fr.node} not found in "${fr.program}"`);
    S.steps++;
    S.last = { program: fr.program, node: n.id };
    const r = exec(fr, n);
    if (typeof r === "number") return follow(fr, n, r);
    if (r.exit) return finishFrame(r.exit, r.why || `EXIT ${r.exit.toUpperCase()}`);
    if (r.call) {
      const name = r.call.program;
      if (!programs.has(name) || S.frames.length >= STACK_LIMIT) {
        log(!programs.has(name) ? `CALL "${name}": no such program → halt` : `CALL "${name}": stack overflow → halt`);
        return follow(fr, n, 2);
      }
      const target = programs.get(name), vars = new Map();
      (startOf(target).p?.params || []).forEach((pn, i) => { const v = evalOp(fr, (r.call.args || [])[i]); if (v) vars.set(pn, v); });
      fr.waiting = n.id;
      pushFrame(name, vars);
      log(`CALL "${name}"`);
    }
  };
  S.run = (k) => { while (k-- > 0 && S.status === "run") S.step(); };
  S.stop = () => { if (S.status === "run") done("success", "stopped"); };
  return S;
}
