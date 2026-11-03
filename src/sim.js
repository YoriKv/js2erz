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
  ["DenseOre", "Dense ore"], ["WaterIce", "Water ice"], ["Breccia"], ["ConsolidatedRock"], ["SilicateRock"], ["MetallicRock"],
  ["PhosphateRock"], ["CarbonaceousRock"], ["CryoIce"], ["SinterCrust", "Sinter crust"], ["MetallicCrust", "Metallic crust"],
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

// ---------------------------------------------------------------- random worlds
// Modelled on the game's map: host rock (regolith, chondrite, breccia, some consolidated rock) in long streaky
// bands that follow one flow direction; one or two primary minerals in veins along that direction, packed into
// richer zones, with lacy edges and loose specks around them; in a quarter of the worlds an impactite vein (solid,
// thick, bending) wrapped in a rim of sinter crust; small caves. Sizes follow the real map at 1 cell = 1 cell.
const HOSTS = [["Regolith", 5], ["Chondrite", 4], ["Breccia", 4], ["ConsolidatedRock", 0.8]];
// minerals that occur together on one moon (the game's region lists)
const SUITES = [
  ["DenseOre", "SulfideRock", "MetallicRock"],            // Himalia
  ["SilicateRock"],                                       // Korda
  ["SilicateRock", "MetallicRock"],                       // Euporie
  ["WaterIce", "CryoIce", "PhosphateRock"],               // Harpalyke
  ["WaterIce", "CarbonaceousRock", "SilicateRock"],       // Dia
  ["CarbonaceousRock", "WaterIce"],                       // Carpo
  ["CarbonaceousRock", "WaterIce", "MetallicRock"],       // Valetudo
];
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
// warped, stretched noise: bands `along` cells long and `across` cells wide at angle `ang`, bent by `warp` cells
function bands(rnd, ang, along, across, warp) {
  const n = valueNoise(rnd), wx = valueNoise(rnd), wy = valueNoise(rnd), c = Math.cos(ang), s = Math.sin(ang);
  return (x, y) => {
    const X = x + warp * fractal(wx, x / 40, y / 40, 2), Y = y + warp * fractal(wy, x / 40, y / 40, 2);
    return fractal(n, (X * c + Y * s) / along, (Y * c - X * s) / across, 3);
  };
}
// the value that `share` of the scores reach
function cut(score, share) {
  const s = Float32Array.from(score).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((1 - share) * s.length)))];
}

// One impactite vein: a bending spine across the world, 5-14 cells thick (thicker in bigger worlds), with a side
// branch or two, ragged edges, and a 2-4 cell rim of sinter crust that frays into specks.
function crustVein(W, H, cells, rnd) {
  const N = W * H, f = new Float32Array(N).fill(1e9), edge = valueNoise(rnd), thick = valueNoise(rnd);
  const size = Math.sqrt(W * H) / 110, wide = (5 + rnd() * 5) * Math.max(0.7, size);
  function spine(x, y, ang, len, w0) {
    for (let t = 0; t < len; t++) {
      const w = w0 * (0.55 + 0.9 * (fractal(thick, t / 30 + w0, 0.5, 2) * 0.5 + 0.5)), R = Math.ceil(w + 5);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const X = Math.round(x) + dx, Y = Math.round(y) + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const d = Math.hypot(X - x, Y - y) - w, i = Y * W + X;
        if (d < f[i]) f[i] = d;
      }
      ang += (rnd() - 0.5) * 0.12;
      x += Math.cos(ang); y += Math.sin(ang);
    }
  }
  // start outside one side of the world, aim across it through a random inner point
  const tx = W * (0.2 + 0.6 * rnd()), ty = H * (0.2 + 0.6 * rnd()), a = rnd() * 2 * Math.PI, L = Math.hypot(W, H);
  const pts = [];
  { let x = tx - Math.cos(a) * L * 0.6, y = ty - Math.sin(a) * L * 0.6; pts.push([x, y]); spine(x, y, a, L * 1.2, wide); }
  for (let b = rnd() < 0.5 ? 1 : 2; b > 0; b--) {
    const s = 0.3 + 0.4 * rnd();
    spine(tx + Math.cos(a) * L * (s - 0.6) * 1.2, ty + Math.sin(a) * L * (s - 0.6) * 1.2, a + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.6),
      L * (0.15 + rnd() * 0.2), wide * (0.4 + rnd() * 0.3));
  }
  const rim = 2 + rnd() * 1.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, d = f[i] + 2.2 * fractal(edge, x / 6, y / 6, 2);
    if (d < 0) cells[i] = "MetallicCrust";
    else if (d < rim || (d < rim + 3 && rnd() < 0.2)) cells[i] = "SinterCrust";
  }
}

function terrain(W, H, rnd) {
  const N = W * H, cells = new Array(N), flow = rnd() * Math.PI;
  const each = fn => { const a = new Float32Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = fn(x, y); return a; };
  const r = () => rnd();

  // host rock: 2-3 kinds in bands of unequal width (consolidated rock stays a minor one), with specks of the others
  const hosts = [], pool = HOSTS.slice();
  for (let k = 2 + (r() < 0.5 ? 1 : 0); k > 0 && pool.length; k--) {
    let w = r() * pool.reduce((s, h) => s + h[1], 0), i = 0;
    while (w > pool[i][1]) w -= pool[i++][1];
    hosts.push(pool.splice(i, 1)[0][0]);
  }
  const hw = hosts.map(h => h === "ConsolidatedRock" ? 0.25 : 0.4 + r()), hsum = hw.reduce((a, b) => a + b, 0);
  const hs = each(bands(rnd, flow, 36, 11, 16)), cuts = [];
  for (let i = 1, acc = 0; i < hosts.length; i++) cuts.push(cut(hs, 1 - (acc += hw[i - 1] / hsum)));
  for (let i = 0; i < N; i++) {
    let k = 0;
    while (k < cuts.length && hs[i] < cuts[k]) k++;
    cells[i] = r() < 0.05 ? pick(rnd, hosts) : hosts[k];
  }
  const isHost = new Set(hosts);

  // primary minerals: one or two from one suite, the first takes more of the ground. Veins are the ridges (zero
  // lines) of band noise, gathered into richer zones; "net" deposits are a finer, less stretched mesh.
  const suite = pick(rnd, SUITES), ores = [pick(rnd, suite)];
  if (suite.length > 1 && r() < 0.5) ores.push(pick(rnd, suite.filter(o => o !== ores[0])));
  const shares = ores.length === 1 ? [0.16 + r() * 0.1] : [0.13 + r() * 0.07, 0.06 + r() * 0.05];
  ores.forEach((ore, m) => {
    const ang = flow + (r() - 0.5) * 0.7, net = r() < 0.35;
    const vein = net ? bands(rnd, ang, 14, 9, 6) : bands(rnd, ang, 34, 9, 12);
    const rich = valueNoise(rnd), speck = 0.04 + r() * 0.06;
    const sc = each((x, y) => 0.35 * fractal(rich, x / 48, y / 48, 2) - Math.abs(vein(x, y)) + (r() - 0.5) * 0.16);
    const at = cut(sc, shares[m]), loose = cut(sc, shares[m] * 2.2);
    for (let i = 0; i < N; i++) if (isHost.has(cells[i]) && (sc[i] >= at || (sc[i] >= loose && r() < speck))) cells[i] = ore;
  });

  // impactite vein with a sinter crust rim (1 world in 4)
  if (r() < 0.25) crustVein(W, H, cells, rnd);

  // caves, border
  const cave = valueNoise(rnd);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (fractal(cave, x / 16, y / 16) < -0.46) cells[i] = "Back";
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) cells[i] = "TectonicMass";
  }
  return { cells, ores, host: hosts[0] };
}
const toSeed = seed => (seed == null || !isFinite(seed) ? Math.floor(Math.random() * 1e6) : Math.floor(seed));
// open 3x3 for the bot body, no hard rock within 4 cells
function clearPocket(w, bx, by, host = "Regolith") {
  const { W, H, cells } = w;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const X = bx + dx, Y = by + dy;
    if (X <= 0 || Y <= 0 || X >= W - 1 || Y >= H - 1) continue;
    const i = Y * W + X;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) cells[i] = "Back";
    else if (cells[i] === "SinterCrust" || cells[i] === "MetallicCrust") cells[i] = host;
  }
}

export function makeWorld(W = 96, H = 72, seed) {
  seed = toSeed(seed);
  const { cells, ores, host } = terrain(W, H, mulberry32(seed));
  const bot = { x: W >> 1, y: H >> 1 };
  const set = (x, y, c) => { if (x > 0 && y > 0 && x < W - 1 && y < H - 1) cells[y * W + x] = c; };
  // a road ring west of the bot, so road-following programs work at once
  const R = 8, rcx = bot.x - 13, rcy = bot.y;
  for (let a = 0; a < 360; a++) {
    const x = Math.round(rcx + R * Math.cos(a * Math.PI / 180)), y = Math.round(rcy + R * Math.sin(a * Math.PI / 180));
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, "Road");
  }
  const w = { W, H, seed, cells, bot, ores };
  clearPocket(w, bot.x, bot.y, host);
  return w;
}
export function emptyWorld(W, H) {
  const cells = new Array(W * H).fill("Back");
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x === 0 || y === 0 || x === W - 1 || y === H - 1) cells[y * W + x] = "TectonicMass";
  return { W, H, seed: null, cells, bot: { x: W >> 1, y: H >> 1 } };
}
export const cellAt = (w, x, y) => (x < 0 || y < 0 || x >= w.W || y >= w.H) ? "TectonicMass" : w.cells[y * w.W + x];

// ---------------------------------------------------------------- seismic initiator
// In the game a seismic initiator is a 5x5 building that regrows the rock around it. When the ground within its
// break radius is about 80% mined out it starts working (one drill used), and about ten minutes later it breaks the
// layer: open cells in the radius fill up with rock again, from the rim inwards, over about ten seconds, and bots in
// the radius are crushed.
//
// Model used here (the values marked unverified are guesses and can be changed through createSim's `seismic`):
// - World: `world.initiators = [{ x, y, drills }]`, (x, y) = centre cell of the 5x5 footprint. The footprint cells are
//   open ground: a bot can stand and drive on them, there is nothing to dig, and SCAN sees the ground, not the
//   building (programs cannot see buildings in the game). Blocks and roads cannot be placed on a footprint.
// - Break centre: the footprint centre + `offset` (the game reports it one cell right of and below the centre).
// - Mined share over the disc (distance <= radius, footprints left out): open cells / (open cells + diggable rock).
//   Open = Back or Empty. Roads, blocks and walls count as neither; undiggable rock (MetallicCrust) counts as rock
//   only with `countUndiggable` (unverified either way).
// - Time: the simulator counts nodes. One game second = `nodesPerSec` nodes (default 1000, a rough node rate), so the
//   working period of `workSec` 603 s and the break of `breakSec` 10 s become node counts.
// - Regrowth: every open cell in the disc refills up to `radius - fade` from the centre, fewer and fewer towards the
//   rim (none at the radius). Footprints, roads and cells under a living bot do not refill. A cell takes the rock of a
//   random cell of its 3x3 neighbourhood as it was before it was dug (so dug ore tends to come back as ore). Where no
//   rock is known (cells that were open from the start), the rock comes from `mix` (about 15% ore; unverified).
// - Death: with `deathMode` "break" a bot dies when it is within the radius at any node of the break, its start
//   included (the cautious reading); with "wave" it dies when the regrowth front reaches it (unverified; one bot died
//   about 2 s after a break, 34 cells from the centre). A bot whose centre is on a footprint always survives,
//   as in the game. Distances are from the bot's centre cell.
export const SEISMIC_DEFAULTS = {
  nodesPerSec: 1000, workSec: 603, breakSec: 10, radius: 40, fade: 6, threshold: 0.8, offset: [1, 1],
  deathMode: "break", countUndiggable: false, seed: undefined,
  mix: [["Regolith", 45], ["Chondrite", 25], ["Breccia", 15], ["SilicateRock", 5], ["SulfideRock", 5], ["DenseOre", 3], ["PhosphateRock", 2]],
};
export const FOOT = 2;   // footprint half size (5x5)
const NATURAL = new Set(CATEGORY_CELLS.Bombable.filter(c => c !== "Road"));   // natural rock
const OPEN = new Set(["Back", "Empty"]);
const onFootOf = (o, x, y) => Math.abs(x - o.x) <= FOOT && Math.abs(y - o.y) <= FOOT;
// index of the initiator whose footprint covers (x, y), or -1
export const initiatorAt = (w, x, y) => (w.initiators || []).findIndex(o => onFootOf(o, x, y));
// place an initiator centred on (x, y): the footprint must lie inside the border and keep a 1-cell gap to other
// buildings (as the game's placement rule). Clears the footprint to open ground (roads stay). Returns success.
export function stampInitiator(w, x, y, drills = 3) {
  if (x - FOOT < 1 || y - FOOT < 1 || x + FOOT > w.W - 2 || y + FOOT > w.H - 2) return false;
  const list = w.initiators || (w.initiators = []);
  if (list.some(o => Math.abs(o.x - x) <= 2 * FOOT + 1 && Math.abs(o.y - y) <= 2 * FOOT + 1)) return false;
  for (let dy = -FOOT; dy <= FOOT; dy++) for (let dx = -FOOT; dx <= FOOT; dx++) {
    const i = (y + dy) * w.W + x + dx;
    if (w.cells[i] !== "Road") w.cells[i] = "Back";
  }
  list.push({ x, y, drills });
  return true;
}
export const breakCentre = (o, cfg = SEISMIC_DEFAULTS) => [o.x + cfg.offset[0], o.y + cfg.offset[1]];
// classify a cell for the mined share: 1 open, 2 rock, 0 neither
const shareClass = (c, cfg) => OPEN.has(c) ? 1 : NATURAL.has(c) && (cfg.countUndiggable || isDiggable(c)) ? 2 : 0;
function discCells(w, o, cfg, fn) {
  const [cx, cy] = breakCentre(o, cfg), R = cfg.radius, R2 = R * R, list = w.initiators || [];
  for (let y = Math.max(0, Math.ceil(cy - R)); y <= Math.min(w.H - 1, Math.floor(cy + R)); y++)
    for (let x = Math.max(0, Math.ceil(cx - R)); x <= Math.min(w.W - 1, Math.floor(cx + R)); x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 <= R2 && !list.some(q => onFootOf(q, x, y))) fn(x, y, d2);
    }
}
// mined share of an initiator's disc in a world (for display outside a run)
export function minedShare(w, o, cfg = SEISMIC_DEFAULTS) {
  cfg = { ...SEISMIC_DEFAULTS, ...cfg };
  let open = 0, rock = 0;
  discCells(w, o, cfg, (x, y) => { const k = shareClass(w.cells[y * w.W + x], cfg); if (k === 1) open++; else if (k === 2) rock++; });
  return open + rock ? open / (open + rock) : 0;
}

// ---------------------------------------------------------------- interpreter
export const STACK_LIMIT = 32;
const num = v => ({ t: "n", v });
export function fmtValue(v) { return v == null ? "—" : v.t === "n" ? fmtNum(v.v) : v.v; }

// `seismic`: overrides of SEISMIC_DEFAULTS; used only when the world has initiators
export function createSim({ programs, main, world, dir = 0, items = { RoadSector: 20, Block: 20, MiningCharge: 5 }, params = {}, seismic = {} }) {
  const index = new Map();   // program name -> Map(node id -> node)
  for (const [name, p] of programs) index.set(name, new Map(p.nodes.map(n => [n.id, n])));
  const w = { W: world.W, H: world.H, seed: world.seed, cells: world.cells.slice(), bot: { ...world.bot } };
  const S = {
    world: w, bot: { x: w.bot.x, y: w.bot.y, dir: ((dir % 8) + 8) % 8 }, aim: { rel: true, front: 2, right: 0 },
    frames: [], status: "run", result: null, steps: 0, actions: 0, cargo: 0, log: [], trail: new Set(), dmg: new Map(),
    items: { ...items }, autos: { auto_attack_miners: 1, auto_attack_mobs: 1, auto_war: 1 }, last: null,
  };
  S.trail.add(S.bot.x + "," + S.bot.y);
  let seis = null;   // seismic initiators (see below); null when the world has none
  const log = s => { S.log.push(s); if (S.log.length > 200) S.log.shift(); };
  const done = (result, why) => {
    S.status = "done"; S.result = result; log(`Program finished (${result}): ${why}`);
    if (seis) seis.settle();
  };

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
  const setCell = (x, y, c) => {
    const i = y * w.W + x;
    if (seis) seis.change(x, y, w.cells[i], c);
    w.cells[i] = c; S.dmg.delete(i);
  };
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
    RoadSector(x, y) { const c = cellAt(w, x, y); if (!inside(x, y) || (seis && seis.onFoot(x, y)) || !isWalkable(c) || c === "Road" || c === "FedRoad") return false; setCell(x, y, "Road"); return true; },
    Block(x, y) { if (!inside(x, y) || !isWalkable(cellAt(w, x, y)) || botCovers(x, y) || (seis && seis.onFoot(x, y))) return false; setCell(x, y, "BlockSimple"); return true; },
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
    runNode();
    if (seis && S.status === "run") seis.tick();
  };
  function runNode() {
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
  }
  S.run = (k) => { while (k-- > 0 && S.status === "run") S.step(); };
  S.stop = () => { if (S.status === "run") done("success", "stopped"); };

  // --- seismic initiators (model: see SEISMIC_DEFAULTS above)
  S.seismic = null;
  S.dead = null;
  if (world.initiators && world.initiators.length) {
    const cfg = { ...SEISMIC_DEFAULTS, ...seismic }, R = cfg.radius;
    const workNodes = Math.max(1, Math.round(cfg.workSec * cfg.nodesPerSec));
    const breakNodes = Math.max(1, Math.round(cfg.breakSec * cfg.nodesPerSec));
    const rand = mulberry32(cfg.seed ?? ((w.seed ?? 0) * 7919 + 17));
    w.initiators = world.initiators.map(o => ({ x: o.x, y: o.y, drills: o.drills ?? 0 }));
    const list = w.initiators.map(o => {
      const [cx, cy] = breakCentre(o, cfg);
      const it = { x: o.x, y: o.y, cx, cy, drills: o.drills, state: "idle", left: 0, open: 0, rock: 0, refilled: 0, plan: null, k: 0, elapsed: 0 };
      Object.defineProperty(it, "share", { enumerable: true, get() { return it.open + it.rock ? it.open / (it.open + it.rock) : 0; } });
      discCells(w, o, cfg, (x, y) => { const k = shareClass(w.cells[y * w.W + x], cfg); if (k === 1) it.open++; else if (k === 2) it.rock++; });
      return it;
    });
    // rock layer under open cells: what each cell was before it was dug ("Back" = not known)
    const back = w.cells.map(c => NATURAL.has(c) ? c : "Back");
    const onFoot = (x, y) => list.some(o => onFootOf(o, x, y));
    const inDisc = (o, x, y) => (x - o.cx) * (x - o.cx) + (y - o.cy) * (y - o.cy) <= R * R;
    const dist = (o, x, y) => Math.hypot(x - o.cx, y - o.cy);
    const fromMix = () => {
      const total = cfg.mix.reduce((a, [, p]) => a + p, 0);
      let r = rand() * total;
      for (const [c, p] of cfg.mix) if ((r -= p) < 0) return c;
      return cfg.mix[cfg.mix.length - 1][0];
    };
    function regrowRock(x, y) {
      const pick = (X, Y) => (X >= 0 && Y >= 0 && X < w.W && Y < w.H && !onFoot(X, Y) ? back[Y * w.W + X] : "Back");
      const k = Math.floor(rand() * 9), first = pick(x + (k % 3) - 1, y + Math.floor(k / 3) - 1);
      if (NATURAL.has(first)) return first;
      const known = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = pick(x + dx, y + dy); if (NATURAL.has(b)) known.push(b); }
      return known.length ? known[Math.floor(rand() * known.length)] : fromMix();
    }
    function die(o) {
      const d = dist(o, S.bot.x, S.bot.y);
      S.dead = { x: S.bot.x, y: S.bot.y, dist: d, step: S.steps };
      done("fail", `bot crushed by the seismic break at (${o.cx}, ${o.cy}), ${fmtNum(Math.round(d * 10) / 10)} cells from the centre`);
    }
    // the bot dies within the radius while the layer breaks (in "wave" mode: once the front has passed it)
    function checkDeath(o, front) {
      if (S.dead || S.status !== "run") return;
      const d = dist(o, S.bot.x, S.bot.y);
      if (d > R || d < front) return;
      if (onFoot(S.bot.x, S.bot.y)) return;     // standing on the initiator is safe
      die(o);
    }
    function refill(o, upTo) {
      while (o.k < o.plan.length && o.plan[o.k].d >= upTo) {
        const { x, y } = o.plan[o.k++];
        if (!OPEN.has(w.cells[y * w.W + x]) || (!S.dead && botCovers(x, y))) continue;
        setCell(x, y, regrowRock(x, y));
        o.refilled++;
      }
    }
    function startBreak(o, manual) {
      o.state = "breaking"; o.left = breakNodes; o.elapsed = 0; o.refilled = 0; o.k = 0;
      // the cells that will refill, from the rim inwards
      const plan = [], edge = R - cfg.fade;
      discCells(w, o, cfg, (x, y, d2) => {
        const i = y * w.W + x;
        if (!OPEN.has(w.cells[i])) return;
        const d = Math.sqrt(d2);
        if (d > edge && rand() >= (R - d) / cfg.fade) return;
        plan.push({ x, y, d });
      });
      plan.sort((a, b) => b.d - a.d);
      o.plan = plan;
      log(`Seismic break at (${o.cx}, ${o.cy}), radius ${R}${manual ? " (by hand)" : ""}`);
      checkDeath(o, cfg.deathMode === "wave" ? R : 0);
    }
    function settleOne(o) {
      refill(o, -1);
      o.state = "idle"; o.left = 0; o.plan = null;
      log(`Seismic break at (${o.cx}, ${o.cy}) over: ${o.refilled} cells refilled`);
    }
    seis = {
      onFoot,
      change(x, y, old, c) {
        const i = y * w.W + x;
        if (NATURAL.has(old) && !NATURAL.has(c)) back[i] = old;
        if (onFoot(x, y)) return;
        for (const o of list) if (inDisc(o, x, y)) {
          const a = shareClass(old, cfg), b = shareClass(c, cfg);
          if (a === 1) o.open--; else if (a === 2) o.rock--;
          if (b === 1) o.open++; else if (b === 2) o.rock++;
        }
      },
      tick() {
        for (const o of list) {
          if (S.status !== "run") return;
          if (o.state === "idle") {
            if (o.drills > 0 && o.share >= cfg.threshold) {
              o.state = "working"; o.drills--; o.left = workNodes;
              log(`Seismic initiator at (${o.x}, ${o.y}) started working: break in ${workNodes} nodes, ${o.drills} drills left`);
            }
          } else if (o.state === "working") {
            if (--o.left <= 0) startBreak(o, false);
          } else if (o.state === "breaking") {
            o.elapsed++; o.left = breakNodes - o.elapsed;
            const front = R * (1 - o.elapsed / breakNodes);
            refill(o, front);
            checkDeath(o, cfg.deathMode === "wave" ? front : 0);
            if (S.status === "run" && o.elapsed >= breakNodes) settleOne(o);
          }
        }
      },
      // the run is over: finish running breaks at once so the world shows their result
      settle() { for (const o of list) if (o.state === "breaking") settleOne(o); },
    };
    S.seismic = { cfg, workNodes, breakNodes, list };
    // start a break now (the initiator nearest to the bot by default), without using a drill. Outside a run the
    // break is applied at once.
    S.triggerBreak = (n) => {
      const o = n != null ? list[n] : list.reduce((a, b) => (dist(b, S.bot.x, S.bot.y) < dist(a, S.bot.x, S.bot.y) ? b : a));
      if (!o || o.state === "breaking") return false;
      startBreak(o, true);
      if (S.status !== "run" && o.state === "breaking") settleOne(o);
      return true;
    };
  }
  return S;
}
