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

test("makeWorld is deterministic per seed", () => {
  const a = makeWorld(96, 72, 42), b = makeWorld(96, 72, 42);
  assert.deepEqual(a.cells, b.cells);
  assert.equal(a.cells.length, 96 * 72);
  assert.equal(cellAt(a, a.bot.x, a.bot.y), "Back");
  assert.ok(a.cells.includes("Road"));
});
