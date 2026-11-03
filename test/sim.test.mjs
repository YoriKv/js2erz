import { test } from "node:test";
import assert from "node:assert/strict";
import { createSim, emptyWorld, makeWorld, cellAt, frontCells } from "../src/sim.js";

// tiny IR builder: N(t, outs, p) -> node with id = position
function prog(name, specs, params = []) {
  const nodes = [{ id: 0, t: "start", x: 0, y: 0, outs: [specs.length ? 1 : null], p: { params } }];
  specs.forEach(([t, outs, p], i) => nodes.push({ id: i + 1, t, x: 0, y: 0, outs, p: p || {} }));
  return { name, params, nodes };
}
const progs = (...ps) => new Map(ps.map(p => [p.name, p]));
function world(W = 20, H = 15) { return emptyWorld(W, H); }   // open room, TectonicMass border
const v = name => ({ var: name }), n = x => ({ num: x }), c = x => ({ cell: x });

test("frontCells: 3 straight, 5 diagonal", () => {
  assert.equal(frontCells(0).length, 3);
  assert.equal(frontCells(1).length, 5);
  assert.deepEqual(frontCells(0).sort(), [[2, -1], [2, 0], [2, 1]].sort());
});

test("STEP into a wall takes the fail output", () => {
  // walk east until fail, then count steps into variable via fail -> assign
  const p = prog("m", [["move", [1, 2]], ["assign", [null, null], { varname: "hit", value: n(1) }]]);
  const w = world(12, 9); w.bot = { x: 3, y: 4 };
  const s = createSim({ programs: progs(p), main: "m", world: w, dir: 0 });
  s.run(1000);
  assert.equal(s.status, "done");
  assert.equal(s.bot.x, 9);            // body x 8..10, wall at x 11
  assert.equal(s.frames.length, 0);
  assert.equal(s.current().node, 2);   // last executed: the assign behind fail
});

test("MOVEDIG digs a 3-wide tunnel", () => {
  const w = world(20, 9); w.bot = { x: 3, y: 4 };
  for (let x = 6; x <= 12; x++) for (let y = 1; y < 8; y++) w.cells[y * w.W + x] = "Chondrite";
  // loop: moved -> itself, dug -> itself, fail -> stop; stop when x >= 11 via compare
  const p = prog("m", [
    ["movedig", [2, 1, null]],
    ["cmp", [null, null, 1, null], { left: v("x"), right: n(11) }],   // x < 11 -> continue, else end
  ]);
  const s = createSim({ programs: progs(p), main: "m", world: w });
  s.run(5000);
  assert.equal(s.status, "done");
  assert.equal(s.bot.x, 11);
  for (let x = 6; x <= 12; x++) for (const y of [3, 4, 5]) assert.equal(cellAt(s.world, x, y), "Back", `cell ${x},${y}`);
  assert.equal(cellAt(s.world, 6, 2), "Chondrite");
  assert.equal(cellAt(s.world, 6, 6), "Chondrite");
  assert.equal(s.cargo, 21);
  assert.equal(cellAt(w, 6, 4), "Chondrite", "input world untouched");
});

test("COMP/OPER counted loop runs N times", () => {
  const p = prog("m", [
    ["assign", [2, null], { varname: "i", value: n(0) }],                  // 1
    ["cmp", [null, null, 3, null], { left: v("i"), right: n(5) }],         // 2: i < 5 -> body
    ["oper", [4, null], { varname: "i", op: "Plus", left: v("i"), right: n(1) }], // 3
    ["rotR", [2], { dir: 2 }],                                             // 4
  ]);
  const s = createSim({ programs: progs(p), main: "m", world: world() });
  s.run(1000);
  assert.equal(s.status, "done");
  assert.deepEqual(s.frames, []);
  assert.equal(s.bot.dir, (5 * 2) % 8);
  assert.equal(s.actions, 5);
});

test("SCAN + AIM REL on a Road cell", () => {
  const w = world(); w.bot = { x: 5, y: 5 };
  w.cells[5 * w.W + 7] = "Road";        // two cells east
  const p = prog("m", [
    ["aimR", [2], { front: 2, right: 0 }],
    ["scan", [3, 4], { category: "Artificial" }],
    ["assign", [null, null], { varname: "r", value: n(1) }],
    ["assign", [null, null], { varname: "r", value: n(0) }],
  ]);
  let s = createSim({ programs: progs(p), main: "m", world: w, dir: 0 });
  s.run(10); assert.equal(s.last.node, 3);
  s = createSim({ programs: progs(p), main: "m", world: w, dir: 4 });   // facing west: aim hits Back
  s.run(10); assert.equal(s.last.node, 4);
});

test("EQ against a cell literal", () => {
  const w = world(); w.bot = { x: 5, y: 5 };
  w.cells[5 * w.W + 7] = "DenseOre";
  const p = prog("m", [
    ["eq", [2, 3], { value: v("scan_cell_front"), set: [c("Regolith"), c("DenseOre")] }],
    ["pass", [null]],
    ["exit", [], { fail: true }],
  ]);
  let s = createSim({ programs: progs(p), main: "m", world: w, dir: 0 });
  s.run(10); assert.equal(s.result, "success"); assert.equal(s.last.node, 2);
  s = createSim({ programs: progs(p), main: "m", world: w, dir: 2 });
  s.run(10); assert.equal(s.result, "fail");
});

test("CELL node with a scanned cell", () => {
  const w = world(); w.bot = { x: 5, y: 5 };
  w.cells[5 * w.W + 7] = "SinterCrust";
  const p = prog("m", [["cell", [2, null], { value: v("scan_cell_front"), category: "DiggableHard" }], ["exit", [], { fail: true }]]);
  const s = createSim({ programs: progs(p), main: "m", world: w });
  s.run(10); assert.equal(s.result, "fail");
});

test("CALL/EXIT returns into the caller's success/fail outputs", () => {
  const sub = prog("sub", [["cmp", [2, 3, 3, 3], { left: v("k"), right: n(0) }], ["exit", [], { fail: false }], ["exit", [], { fail: true }]], ["k"]);
  const main = prog("m", [
    ["call", [2, 3, null], { program: "sub", args: [v("arg")] }],
    ["assign", [null, null], { varname: "out", value: n(1) }],
    ["assign", [null, null], { varname: "out", value: n(2) }],
  ], ["arg"]);
  let s = createSim({ programs: progs(main, sub), main: "m", world: world(), params: { arg: 5 } });
  let seen = 0;
  while (s.status === "run") { s.step(); seen = Math.max(seen, s.frames.length); }
  assert.equal(seen, 2);
  assert.equal(s.last.node, 2); assert.equal(s.last.program, "m");
  s = createSim({ programs: progs(main, sub), main: "m", world: world(), params: { arg: -1 } });
  s.run(100); assert.equal(s.last.node, 3);
});

test("missing CALL target takes halt", () => {
  const p = prog("m", [["call", [null, null, 2], { program: "nope", args: [] }], ["exit", [], { fail: true }]]);
  const s = createSim({ programs: progs(p), main: "m", world: world() });
  s.run(10); assert.equal(s.result, "fail"); assert.equal(s.last.node, 2);
});

test("unconnected output ends with status done", () => {
  const p = prog("m", [["rotA", [null], { dir: 6 }]]);
  const s = createSim({ programs: progs(p), main: "m", world: world() });
  assert.equal(s.status, "run");
  assert.deepEqual(s.current(), { program: "m", node: 0 });
  s.step(); s.step();
  assert.equal(s.status, "done"); assert.equal(s.result, "success"); assert.equal(s.bot.dir, 6);
  s.step(); assert.equal(s.steps, 2);
});

test("read-only builtin assign fails; aim_x moves the aim", () => {
  const p = prog("m", [
    ["assign", [2, 3], { varname: "x", value: n(3) }],
    ["exit", [], { fail: true }],
    ["assign", [null, null], { varname: "aim_x", value: n(-2) }],
  ]);
  const s = createSim({ programs: progs(p), main: "m", world: world() });
  s.run(10);
  assert.equal(s.result, "success"); assert.equal(s.aim.rel, false); assert.equal(s.aim.right, -2);
});

test("makeWorld: one or two primary minerals in veins, impactite with a sinter rim in about a quarter", () => {
  let imp = 0;
  for (let seed = 0; seed < 80; seed++) {
    const w = makeWorld(96, 72, seed), n = w.cells.length, count = c => w.cells.filter(x => x === c).length;
    assert.ok(w.ores.length === 1 || w.ores.length === 2, `seed ${seed}`);
    const ore = w.ores.reduce((s, o) => s + count(o), 0) / n;
    assert.ok(ore > 0.05 && ore < 0.35, `seed ${seed}: ore share ${ore}`);
    const crust = count("MetallicCrust");
    if (crust) { imp++; assert.ok(count("SinterCrust") > crust * 0.2, `seed ${seed}: sinter rim`); }
    else assert.equal(count("SinterCrust"), 0, `seed ${seed}: no sinter without impactite`);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.equal(cellAt(w, w.bot.x + dx, w.bot.y + dy), "Back");
  }
  assert.ok(imp >= 10 && imp <= 30, `impactite in ${imp} of 80`);
});

test("makeWorld is deterministic per seed", () => {
  const a = makeWorld(96, 72, 42), b = makeWorld(96, 72, 42);
  assert.deepEqual(a.cells, b.cells);
  assert.equal(a.cells.length, 96 * 72);
  assert.equal(cellAt(a, a.bot.x, a.bot.y), "Back");
  assert.ok(!a.cells.includes("Road"), "no roads in generated worlds");
});

// ---------------------------------------------------------------- seismic initiator
import { stampInitiator, initiatorAt, minedShare, SEISMIC_DEFAULTS } from "../src/sim.js";
// a 128x96 world with an initiator on the bot's start, no impactite inside the disc
function seismicWorld(seed) {
  const w = makeWorld(128, 96, seed);
  stampInitiator(w, w.bot.x, w.bot.y);
  for (let i = 0; i < w.cells.length; i++) if (w.cells[i] === "MetallicCrust") w.cells[i] = "SinterCrust";
  return w;
}

// a room of Regolith with an initiator centred on (30, 30); the break centres on it
function rockRoom(W = 90, H = 80) {
  const w = emptyWorld(W, H);
  for (let i = 0; i < w.cells.length; i++) if (w.cells[i] === "Back") w.cells[i] = "Regolith";
  stampInitiator(w, 30, 30);
  return w;
}
const idle = () => prog("m", [["pass", [1]]]);                // runs forever
// dig every rock cell of the disc whose distance from the break centre is >= rmin (and optionally < rmax)
function digDisc(w, share, { cx = 30, cy = 30, R = 40 } = {}) {
  const cells = [];
  for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    if (d2 <= R * R && w.cells[y * w.W + x] === "Regolith") cells.push([x, y, d2]);
  }
  cells.sort((a, b) => b[2] - a[2]);
  const n = Math.ceil(cells.length * share);
  for (const [x, y] of cells.slice(0, n)) w.cells[y * w.W + x] = "Back";
}

test("seismic: footprint is open ground, placement keeps a gap", () => {
  const w = rockRoom();
  assert.equal(cellAt(w, 28, 28), "Back"); assert.equal(cellAt(w, 32, 32), "Back"); assert.equal(cellAt(w, 33, 30), "Regolith");
  assert.equal(initiatorAt(w, 32, 28), 0); assert.equal(initiatorAt(w, 33, 28), -1);
  assert.equal(stampInitiator(w, 35, 30), false, "too close");
  assert.equal(stampInitiator(w, 36, 30), true);
  assert.equal(stampInitiator(w, 2, 2), false, "outside the border");
});

test("seismic: starts working at the threshold, breaks after workSec * nodesPerSec nodes", () => {
  const w = rockRoom(); w.bot = { x: 80, y: 74 };             // outside the radius (about 59 cells away)
  digDisc(w, 0.79);
  assert.ok(minedShare(w, w.initiators[0]) < 0.8);
  let s = createSim({ programs: progs(idle()), main: "m", world: w, seismic: { nodesPerSec: 2, workSec: 50, breakSec: 5 } });
  s.run(500);
  assert.equal(s.seismic.list[0].state, "idle", "below the threshold nothing happens");

  const w2 = rockRoom(); w2.bot = w.bot;
  digDisc(w2, 0.81);
  s = createSim({ programs: progs(idle()), main: "m", world: w2, seismic: { nodesPerSec: 2, workSec: 50, breakSec: 5 } });
  const o = s.seismic.list[0];
  assert.ok(o.share >= 0.8 && o.share < 0.82, `share ${o.share}`);
  assert.equal(s.seismic.workNodes, 100); assert.equal(s.seismic.breakNodes, 10);
  s.step();
  assert.equal(o.state, "working"); assert.equal(o.left, 100);
  s.run(99);
  assert.equal(o.state, "working"); assert.equal(o.left, 1);
  s.step();
  assert.equal(o.state, "breaking");
  assert.ok(s.log.some(l => l.startsWith("Seismic break at (30, 30), radius 40")));
  s.run(10);
  assert.equal(o.state, "idle"); assert.ok(o.refilled > 0);
  assert.ok(o.share < 0.2, `share after the break ${o.share}`);   // the rim ring refills only in part
  assert.equal(s.status, "run", "a bot outside the radius survives");
});

test("seismic: mining in the disc raises the share and triggers the initiator", () => {
  const w = rockRoom(); w.bot = { x: 60, y: 31 };             // 29 cells east of the break centre
  digDisc(w, 0.799);
  // dig westwards towards the initiator
  const p = prog("m", [["movedig", [1, 1, null]]]);
  const s = createSim({ programs: progs(p), main: "m", world: w, dir: 4, seismic: { nodesPerSec: 1, workSec: 5000 } });
  const o = s.seismic.list[0], before = o.share;
  s.run(200);
  assert.ok(o.share > before);
  assert.equal(o.state, "working");
});

test("seismic: the break centres on the initiator; roads and the footprint count for nothing", () => {
  const w = rockRoom();
  digDisc(w, 0.5);
  const o = w.initiators[0], R = SEISMIC_DEFAULTS.radius;
  const share = () => minedShare(w, o);
  const before = share();
  // a road across the disc, half over rock, half over dug ground: removes cells from both counts
  let open = 0, rock = 0;
  for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
    if (Math.hypot(x - o.x, y - o.y) > R || initiatorAt(w, x, y) >= 0) continue;
    const c = w.cells[y * w.W + x];
    if (x === 40 || y === 40) { w.cells[y * w.W + x] = "Road"; continue; }
    if (c === "Back") open++; else if (c === "Regolith") rock++;
  }
  assert.ok(Math.abs(share() - open / (open + rock)) < 1e-9, `${share()} vs ${open / (open + rock)} (was ${before})`);
  const s = createSim({ programs: progs(idle()), main: "m", world: w, seismic: { nodesPerSec: 1 } });
  s.triggerBreak();
  assert.ok(s.log.some(l => l.startsWith("Seismic break at (30, 30)")), s.log.join("\n"));
});

test("seismic: regrowth stays inside the disc and spares footprint and roads", () => {
  const w = emptyWorld(120, 100);                             // all open
  stampInitiator(w, 50, 50);
  w.cells[50 * w.W + 75] = "Road";
  w.bot = { x: 110, y: 90 };
  const s = createSim({ programs: progs(idle()), main: "m", world: w, seismic: { nodesPerSec: 1, seed: 5 } });
  s.run(5);                                                   // all open: the share is 1, the initiator starts working
  assert.equal(s.seismic.list[0].state, "working");
  s.triggerBreak();
  s.run(20);
  const R = SEISMIC_DEFAULTS.radius, cx = 50, cy = 50;
  let inner = 0, innerRock = 0;
  for (let y = 1; y < w.H - 1; y++) for (let x = 1; x < w.W - 1; x++) {
    const c = cellAt(s.world, x, y), d = Math.hypot(x - cx, y - cy);
    if (d > R) assert.ok(c === "Back" || c === "Road", `outside ${x},${y} ${c}`);
    if (d <= R - SEISMIC_DEFAULTS.fade && initiatorAt(s.world, x, y) < 0 && !(x === 75 && y === 50)) { inner++; if (c !== "Back") innerRock++; }
  }
  assert.equal(innerRock, inner, "every open cell well inside the radius refills");
  for (let y = 48; y <= 52; y++) for (let x = 48; x <= 52; x++) assert.equal(cellAt(s.world, x, y), "Back", "footprint stays open");
  assert.equal(cellAt(s.world, 75, 50), "Road");
  // nothing was known about these cells: the rock comes from the mix, mostly plain rock with some ore
  const counts = {};
  for (const c of s.world.cells) counts[c] = (counts[c] || 0) + 1;
  assert.ok(counts.Regolith > counts.DenseOre && counts.DenseOre > 0, JSON.stringify(counts));
});

test("seismic: dug rock comes back as the rock it was", () => {
  const p = prog("m", [["use", [1, 1, 1], { item: "MiningCharge" }]]);
  const w = rockRoom(); w.bot = { x: 30, y: 8 };
  for (let y = 10; y <= 14; y++) for (let x = 20; x <= 40; x++) w.cells[y * w.W + x] = "DenseOre";
  const s = createSim({ programs: progs(p), main: "m", world: w, dir: 2, items: { MiningCharge: 1 }, seismic: { nodesPerSec: 1, seed: 3 } });
  s.aim = { rel: false, front: 3, right: 0 };                 // charge at (30, 11): clears 29..31 x 10..12
  s.run(2);
  assert.equal(cellAt(s.world, 30, 11), "Back");
  s.triggerBreak(); s.stop();                                 // the bot (23 cells out) is crushed; the break is applied
  // these cells have dense ore all round, so they come back as dense ore (the top row may take the Regolith above)
  for (let y = 11; y <= 12; y++) for (let x = 29; x <= 31; x++) assert.equal(cellAt(s.world, x, y), "DenseOre", `${x},${y}`);
});

test("seismic: a bot in the disc dies at the break, a bot outside survives", () => {
  const p = idle();
  for (const [bx, by, dies] of [[50, 31, true], [65, 31, true], [74, 31, false]]) {   // 20, 35, 44 cells from (30, 30)
    const w = rockRoom(); w.bot = { x: bx, y: by };
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) w.cells[(by + dy) * w.W + bx + dx] = "Back";
    const s = createSim({ programs: progs(p), main: "m", world: w, seismic: { nodesPerSec: 1 } });
    s.step(); s.triggerBreak(); s.run(20);
    assert.equal(s.dead != null, dies, `bot at ${bx},${by}`);
    if (dies) {
      assert.equal(s.status, "done"); assert.equal(s.result, "fail");
      assert.match(s.log.join("\n"), /bot crushed by the seismic break at \(30, 30\)/);
    } else assert.equal(s.status, "run");
  }
});

test("seismic: wave mode kills when the front arrives", () => {
  const w = rockRoom(); w.bot = { x: 50, y: 30 };             // 20 cells out: the front gets there halfway through
  const s = createSim({ programs: progs(idle()), main: "m", world: w, seismic: { nodesPerSec: 10, deathMode: "wave" } });   // 100-node break
  s.triggerBreak();
  s.run(45); assert.equal(s.status, "run");
  s.run(10); assert.equal(s.status, "done"); assert.ok(s.dead.step >= 49 && s.dead.step <= 51, `died at ${s.dead.step}`);
});

test("seismic: a bot standing on the initiator survives the break", () => {
  const w = rockRoom(); w.bot = { x: 30, y: 30 };
  const s = createSim({ programs: progs(idle()), main: "m", world: w, seismic: { nodesPerSec: 1 } });
  s.step(); s.triggerBreak(); s.run(20);
  assert.equal(s.dead, null);
  assert.equal(s.seismic.list[0].state, "idle");
  // the cells around the body stay open where it stood
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.equal(cellAt(s.world, 30 + dx, 30 + dy), "Back");
});

test("seismic: Block / Road can't go on the footprint", () => {
  const w2 = rockRoom(); w2.bot = { x: 30, y: 26 };          // just north of the footprint
  for (let y = 25; y <= 27; y++) for (let x = 29; x <= 31; x++) w2.cells[y * w2.W + x] = "Back";
  const p = prog("m", [["aimR", [2], { front: 3, right: 0 }], ["use", [null, null, null], { item: "Block" }]]);
  const s2 = createSim({ programs: progs(p), main: "m", world: w2, dir: 2, seismic: { nodesPerSec: 1 } });
  s2.run(5);
  assert.equal(cellAt(s2.world, 30, 29), "Back"); assert.equal(s2.items.Block, 20);
});

test("seismic: worlds without an initiator behave as before", () => {
  const w = makeWorld(96, 72, 7);
  assert.equal(w.initiators, undefined);
  const p = prog("m", [["movedig", [1, 1, 2]], ["rotR", [1], { dir: 2 }]]);
  const a = createSim({ programs: progs(p), main: "m", world: w });
  const b = createSim({ programs: progs(p), main: "m", world: w, seismic: { nodesPerSec: 1, workSec: 1 } });
  a.run(3000); b.run(3000);
  assert.deepEqual(b.world.cells, a.world.cells); assert.deepEqual(b.log, a.log); assert.deepEqual(b.bot, a.bot);
  assert.equal(a.seismic, null); assert.equal(a.dead, null); assert.equal(a.triggerBreak, undefined);
});

test("seismic: an initiator placed on the bot's start", () => {
  const a = seismicWorld(9);
  assert.deepEqual(a.initiators, [{ x: 64, y: 48 }]);
  assert.equal(initiatorAt(a, a.bot.x, a.bot.y), 0, "bot on the footprint");
  assert.ok(minedShare(a, a.initiators[0]) < 0.3);
});

test("seismic: driving into the radius during the break is deadly too", () => {
  const w = rockRoom(); w.bot = { x: 72, y: 30 };             // 42 cells out, facing west along an open lane
  for (let y = 29; y <= 31; y++) for (let x = 59; x <= 73; x++) w.cells[y * w.W + x] = "Back";
  const p = prog("m", [["move", [1, null]]]);
  const s = createSim({ programs: progs(p), main: "m", world: w, dir: 4, seismic: { nodesPerSec: 10 } });
  s.triggerBreak();
  assert.equal(s.status, "run");
  s.run(10);
  assert.equal(s.status, "done"); assert.ok(s.dead && s.dead.dist <= 40, JSON.stringify(s.dead));
});

// ---------------------------------------------------------------- interpreter details
import { digOrder, STACK_LIMIT } from "../src/sim.js";
import { CELLS } from "../src/nodes.js";
const exits = () => [["exit", [], {}], ["exit", [], { fail: true }]];

test("diagonal STEP needs the 5 corner cells; DIG strikes corner, then the sides (SE and NE)", () => {
  const cases = [
    [1, [[2, 2], [1, 2], [2, 1], [0, 2], [2, 0]]],          // SE
    [7, [[2, -2], [2, -1], [1, -2], [2, 0], [0, -2]]],      // NE
  ];
  for (const [dir, order] of cases) {
    assert.deepEqual(digOrder(dir).map(([x, y]) => [x + 0, y + 0]), order);   // rot90 can give -0
    // DIG: each strike removes the next cell of the order (Chondrite takes one hit)
    const w = world(20, 15); w.bot = { x: 9, y: 7 };
    for (const [dx, dy] of order) w.cells[(7 + dy) * w.W + 9 + dx] = "Chondrite";
    const p = prog("m", [["dig", [1, null, null]]]);
    const s = createSim({ programs: progs(p), main: "m", world: w, dir });
    s.step();                                                // START
    order.forEach(([dx, dy], k) => {
      s.step();
      assert.equal(cellAt(s.world, 9 + dx, 7 + dy), "Back", `dir ${dir} strike ${k}`);
      for (const [ex, ey] of order.slice(k + 1)) assert.equal(cellAt(s.world, 9 + ex, 7 + ey), "Chondrite");
    });
    s.step();
    assert.equal(s.status, "done"); assert.match(s.log.at(-1), /"nothing to dig"/);
    // STEP: any one of the 5 cells blocked -> fail; all open -> one diagonal step
    for (const [bx, by] of order) {
      const w2 = world(20, 15); w2.bot = { x: 9, y: 7 }; w2.cells[(7 + by) * w2.W + 9 + bx] = "Regolith";
      const s2 = createSim({ programs: progs(prog("m", [["move", [...exits().map((_, i) => 2 + i)]], ...exits()])), main: "m", world: w2, dir });
      s2.run(5); assert.equal(s2.result, "fail", `dir ${dir} blocked at ${bx},${by}`);
    }
    const s3 = createSim({ programs: progs(prog("m", [["move", [2, 3]], ...exits()])), main: "m", world: world(20, 15), dir });
    s3.run(5); assert.equal(s3.result, "success"); assert.deepEqual([s3.bot.x - 10, s3.bot.y - 7], [1, dir === 1 ? 1 : -1]);
  }
});

test("aim: aim_x / aim_y read the world offset of a relative aim; aim_front after AIM ABS resets to relative (0, 0)", () => {
  const p = prog("m", [
    ["aimR", [2], { front: 2, right: 1 }],
    ["assign", [3, null], { varname: "ax", value: v("aim_x") }],
    ["assign", [4, null], { varname: "ay", value: v("aim_y") }],
    ["aimA", [5], { front: 1, right: 2 }],
    ["assign", [null, null], { varname: "aim_front", value: n(3) }],
  ]);
  const s = createSim({ programs: progs(p), main: "m", world: world(), dir: 1 });   // facing SE: front (1, 1), right (-1, 1)
  s.run(10);
  assert.equal(s.vars.get("ax").v, 1); assert.equal(s.vars.get("ay").v, 3);
  assert.deepEqual(s.aim, { rel: true, front: 3, right: 0 });
});

test("CALL past STACK_LIMIT takes halt and unwinds", () => {
  const p = prog("m", [["call", [null, null, 2], { program: "m", args: [] }], ["assign", [null, null], { varname: "deep", value: n(1) }]]);
  const s = createSim({ programs: progs(p), main: "m", world: world() });
  let max = 0;
  while (s.status === "run") { s.step(); max = Math.max(max, s.frames.length); }
  assert.equal(max, STACK_LIMIT);
  assert.equal(s.log.filter(l => /stack overflow → halt/.test(l)).length, 1);
  assert.equal(s.frames.length, 0); assert.equal(s.result, "success");
});

test("OPER Div / Mod by zero and COMP on a cell take the fail outputs", () => {
  for (const op of ["Div", "Mod"]) {
    const s = createSim({ programs: progs(prog("m", [["oper", [2, 3], { varname: "z", op, left: n(1), right: n(0) }], ...exits()])), main: "m", world: world() });
    s.run(5); assert.equal(s.result, "fail", op); assert.equal(s.vars.get("z"), undefined);
  }
  const s = createSim({ programs: progs(prog("m", [["cmp", [2, 2, 2, 3], { left: v("scan_cell_front"), right: n(1) }], ...exits()])), main: "m", world: world() });
  s.run(5); assert.equal(s.result, "fail");
});

test("USE: Road / Block refusals, MiningCharge 3x3, noItem", () => {
  const use = (item, w, { aim = [2, 0], items, dir = 0 } = {}) => {
    const p = prog("m", [["aimR", [2], { front: aim[0], right: aim[1] }], ["use", [3, 4, 5], { item }], ["pass", [null]], ["pass", [null]], ["pass", [null]]]);
    const s = createSim({ programs: progs(p), main: "m", world: w, dir, ...(items ? { items } : {}) });
    s.run(5);
    return { s, out: s.last.node - 3 };                       // 0 success, 1 fail, 2 noItem
  };
  const room = () => { const w = world(20, 15); w.bot = { x: 5, y: 7 }; return w; };
  // Road: on open ground yes, on a road or rock no
  let r = use("RoadSector", room()); assert.equal(r.out, 0); assert.equal(cellAt(r.s.world, 7, 7), "Road"); assert.equal(r.s.items.RoadSector, 19);
  let w = room(); w.cells[7 * 20 + 7] = "Road"; r = use("RoadSector", w); assert.equal(r.out, 1); assert.equal(r.s.items.RoadSector, 20);
  w = room(); w.cells[7 * 20 + 7] = "Regolith"; r = use("RoadSector", w); assert.equal(r.out, 1);
  // Block: not under the bot's body, not on rock
  r = use("Block", room(), { aim: [1, 0] }); assert.equal(r.out, 1); assert.equal(cellAt(r.s.world, 6, 7), "Back");
  w = room(); w.cells[7 * 20 + 7] = "Regolith"; r = use("Block", w); assert.equal(r.out, 1);
  r = use("Block", room()); assert.equal(r.out, 0); assert.equal(cellAt(r.s.world, 7, 7), "BlockSimple");
  // MiningCharge: the 3x3 around the aimed cell, one cargo per cell
  w = room(); for (let y = 6; y <= 8; y++) for (let x = 7; x <= 9; x++) w.cells[y * 20 + x] = "Regolith";
  w.cells[7 * 20 + 9] = "MetallicCrust";
  r = use("MiningCharge", w, { aim: [3, 0] });
  assert.equal(r.out, 0); assert.equal(r.s.cargo, 9); assert.equal(r.s.items.MiningCharge, 4);
  for (let y = 6; y <= 8; y++) for (let x = 7; x <= 9; x++) assert.equal(cellAt(r.s.world, x, y), "Back");
  // none left, and items the sandbox doesn't model: noItem (logged once)
  r = use("Block", room(), { items: { Block: 0 } }); assert.equal(r.out, 2);
  const p = prog("m", [["use", [1, 1, 1], { item: "GeoRadar" }]]);
  const s = createSim({ programs: progs(p), main: "m", world: room() });
  s.run(50);
  assert.equal(s.last.node, 1); assert.equal(s.log.filter(l => l === "USE GeoRadar: not simulated").length, 1);
});

test("MOVEDIG: undiggable centre -> fail; a two-hit cell -> dug without moving", () => {
  const w = world(20, 15); w.bot = { x: 5, y: 7 }; w.cells[7 * 20 + 7] = "MetallicCrust"; w.cells[6 * 20 + 7] = "Regolith";
  let s = createSim({ programs: progs(prog("m", [["movedig", [2, 3, 4]], ["pass", [null]], ["pass", [null]], ["pass", [null]]])), main: "m", world: w });
  s.run(5); assert.equal(s.last.node, 4); assert.equal(s.dmg.size, 0, "the side cell is not struck");
  const w2 = world(20, 15); w2.bot = { x: 5, y: 7 }; w2.cells[7 * 20 + 7] = "Regolith";   // 2 hits
  s = createSim({ programs: progs(prog("m", [["movedig", [2, 3, 4]], ["pass", [null]], ["pass", [null]], ["pass", [null]]])), main: "m", world: w2 });
  s.run(5); assert.equal(s.last.node, 3); assert.deepEqual([s.bot.x, s.bot.y], [5, 7]);
  assert.equal(cellAt(s.world, 7, 7), "Regolith"); assert.equal(s.dmg.get(7 * 20 + 7), 1);
});

test("seismic: triggerBreak outside a run settles at once without a death; bad index -> false", () => {
  const w = rockRoom(); w.bot = { x: 50, y: 31 };            // 20 cells out: inside the radius
  digDisc(w, 0.5);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) w.cells[(31 + dy) * w.W + 50 + dx] = "Back";
  const s = createSim({ programs: progs(prog("m", [["exit", [], {}]])), main: "m", world: w });
  s.run(5); assert.equal(s.status, "done");
  assert.equal(s.triggerBreak(5), false);
  assert.equal(s.triggerBreak(0), true);
  const o = s.seismic.list[0];
  assert.equal(o.state, "idle"); assert.ok(o.refilled > 0); assert.equal(s.dead, null); assert.equal(s.result, "success");
});

test("seismic: wave mode refills the cells under the crushed bot", () => {
  const w = rockRoom(); w.bot = { x: 50, y: 30 };
  for (let y = 1; y < w.H - 1; y++) for (let x = 1; x < w.W - 1; x++) if (Math.hypot(x - 30, y - 30) <= 40) w.cells[y * w.W + x] = "Back";
  const s = createSim({ programs: progs(idle()), main: "m", world: w, seismic: { nodesPerSec: 10, deathMode: "wave" } });
  s.triggerBreak(); s.run(200);
  assert.ok(s.dead);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.notEqual(cellAt(s.world, 50 + dx, 30 + dy), "Back", `${50 + dx},${30 + dy}`);
});

// ---------------------------------------------------------------- stored world (worldpanel.js)
import { loadWorld, loadSettings } from "../src/worldpanel.js";

test("loadWorld / loadSettings check stored data", () => {
  const base = () => ({ W: 10, H: 8, seed: 3, bot: { x: 4, y: 4 }, cells: new Array(80).fill(CELLS.indexOf("Regolith")) });
  const ok = loadWorld({ ...base(), initiators: [{ x: 4, y: 3 }, { x: 5, y: 3 }, { x: 1, y: 1 }, { x: "a" }, null] });
  assert.equal(ok.cells[0], "Regolith"); assert.deepEqual(ok.initiators, [{ x: 4, y: 3 }]);
  const z = base(); z.cells[0] = 0; z.cells[1] = 999; z.cells[2] = "Chondrite";
  assert.deepEqual(loadWorld(z).cells.slice(0, 3), ["Back", "Back", "Chondrite"]);
  assert.equal(loadWorld({ ...base(), bot: undefined }), null);
  assert.equal(loadWorld({ ...base(), bot: { x: 0, y: 4 } }), null);
  assert.equal(loadWorld({ ...base(), bot: { x: 4.5, y: 4 } }), null);
  assert.equal(loadWorld({ ...base(), cells: [1, 2] }), null);
  assert.equal(loadWorld(undefined), null);
  const d = { dir: 0, speed: 40, brush: "Regolith", items: { RoadSector: 20, Block: 20, MiningCharge: 5 }, seismic: { nps: 1000 } };
  const s = loadSettings({ dir: 12, speed: "x", brush: "Lava", items: { Block: -3, RoadSector: 7.9 }, seismic: { nps: 0, drills: 2 }, scenario: "old" }, d);
  assert.deepEqual(s, { dir: 7, speed: 40, brush: "Regolith", items: { RoadSector: 7, Block: 0, MiningCharge: 5 }, seismic: { nps: 1 } });
  assert.equal(loadSettings({ brush: "initiator" }, d).brush, "initiator");
  assert.deepEqual(d.items, { RoadSector: 20, Block: 20, MiningCharge: 5 }, "defaults untouched");
});

test("calls(): the CALL nodes waiting on the stack, outermost first; empty once finished", () => {
  const m = prog("m", [["call", [2, 2, 2], { program: "a", args: [] }], ["exit", [], { fail: false }]]);
  const a = prog("a", [["pass", [2]], ["call", [3, 3, 3], { program: "b", args: [] }], ["exit", [], { fail: false }]]);
  const b = prog("b", [["pass", [2]], ["exit", [], { fail: false }]]);
  const s = createSim({ programs: progs(m, a, b), main: "m", world: world() });
  assert.deepEqual(s.calls(), []);
  s.step(); s.step();                       // START, CALL a
  assert.deepEqual(s.calls(), [{ program: "m", node: 1 }]);
  s.step(); s.step(); s.step(); s.step();   // START, PASS, CALL b, START
  assert.deepEqual(s.calls(), [{ program: "m", node: 1 }, { program: "a", node: 2 }]);
  assert.deepEqual(s.current(), { program: "b", node: 1 });
  s.run(20);
  assert.equal(s.status, "done"); assert.deepEqual(s.calls(), []);
});
