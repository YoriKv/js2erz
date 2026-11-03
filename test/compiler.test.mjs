import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compiler.js";
import { layout } from "../src/layout.js";
import { exportSvg } from "../src/render.js";
import { toErzstat, importJson } from "../src/formats.js";
import { createSim, emptyWorld } from "../src/sim.js";
import { T } from "../src/nodes.js";
import { EXAMPLES } from "../src/examples.js";

const types = p => p.nodes.map(n => n.t);
// compile and run on an open room; returns the finished sim
function run(src, { W = 30, H = 15, bot = { x: 4, y: 7 }, dir = 0, paint, steps = 20000 } = {}) {
  const r = compile(src);
  const w = emptyWorld(W, H); w.bot = bot;
  if (paint) paint(w);
  const programs = new Map(r.programs.map(p => [p.name, p]));
  const s = createSim({ programs, main: r.programs[0].name, world: w, dir });
  s.run(steps);
  return { r, s, vars: name => { const v = s.vars && s.vars.get(name); return v && v.v; } };
}
const fill = (w, x0, x1, y0, y1, cell) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.cells[y * w.W + x] = cell; };

test("a plain call statement connects every output to the next node", () => {
  const { programs: [p] } = compile("step(); turnLeft();");
  assert.deepEqual(types(p), ["start", "move", "rotR"]);
  assert.deepEqual(p.nodes[1].outs, [2, 2]);
});

test("while (moveDig() !== 'fail') is one self-looping MOVEDIG", () => {
  const { programs: [p] } = compile(`while (moveDig() !== "fail");`);
  assert.deepEqual(types(p), ["start", "movedig"]);
  assert.deepEqual(p.nodes[1].outs, [1, 1, null]);
});

test("const folds away; let becomes VALUE; counted loop runs N times", () => {
  const { r, s, vars } = run(`const N = 4; let n = 0; for (let i = 0; i < N; i++) n += 2;`);
  assert.equal(r.programs[0].nodes.filter(n => n.t === "assign").length, 2);
  assert.equal(s.status, "done");
  assert.equal(vars("n"), 8);
  assert.equal(vars("i"), 4);
});

test("arithmetic writes straight into the target, temporaries for nesting", () => {
  const { r, vars } = run(`let a = 3; let b = (a + 1) * 2 - a % 2;`);
  assert.equal(vars("b"), 7);
  assert.ok(r.programs[0].nodes.some(n => n.t === "oper" && n.p.varname === "b"));
});

test("if / else on STEP outcome; walking into a wall", () => {
  const { vars, s } = run(`let hits = 0; while (true) { if (!step()) { hits++; if (hits >= 1) break; } } let px = x;`, { W: 16 });
  assert.equal(s.status, "done");
  assert.equal(vars("hits"), 1);
  assert.equal(vars("px"), 13);   // body 12..14, wall at 15
});

test("outcome comparison and switch route single outputs", () => {
  const { programs: [p] } = compile(`switch (dig()) { case "success": turnLeft(); break; case "cantDig": turnRight(); break; default: turnAround(); }`);
  const dig = p.nodes[1];
  assert.equal(dig.t, "dig");
  assert.deepEqual(dig.outs.map(o => o != null && p.nodes[o].p.dir), [-2, 2, 4]);
  assert.throws(() => compile(`if (dig() === "nope") pass();`), /not an outcome of DIG/);
});

test("stored outcome compares by output index", () => {
  const { vars } = run(`let r = step(); let ok = 0; if (r === "success") ok = 1;`);
  assert.equal(vars("ok"), 1);
  assert.equal(vars("r"), 0);
});

test("inlined condition function steers the caller", () => {
  const src = `function roadAhead() { aim(2, 0); return scan(Category.Artificial); }
    let n = 0; while (roadAhead() && n < 100) { step(); n++; }`;
  const { vars } = run(src, { paint: w => fill(w, 1, 12, 5, 9, "Road") });
  assert.equal(vars("n"), 7);   // front cell x+2 is road up to x = 12, bot starts at 4
});

test("inlined value function and parameters", () => {
  const { vars } = run(`function sq(v) { return v * v; } let a = 3; let b = sq(a) + sq(2);`);
  assert.equal(vars("b"), 13);
});

test("anyOf / inCategory / cell equality", () => {
  const src = `aim(2, 0); scan(Category.Diggable);
    let a = 0, b = 0, c = 0;
    if (anyOf(scan_cell_front, Cell.Regolith, Cell.DenseOre)) a = 1;
    if (inCategory(scan_cell_front, Category.Rare)) b = 1;
    if (scan_cell_front == Cell.DenseOre) c = 1;`;
  const { vars } = run(src, { paint: w => fill(w, 6, 6, 7, 7, "DenseOre") });
  assert.deepEqual([vars("a"), vars("b"), vars("c")], [1, 1, 1]);
});

test("for…of over a constant array is unrolled", () => {
  const { programs: [p] } = compile(`for (const d of [Dir.N, Dir.E, Dir.S]) rotateTo(d);`);
  assert.deepEqual(p.nodes.slice(1).map(n => n.p.dir), [6, 0, 2]);
});

test("variable direction becomes an EQ dispatch", () => {
  const { s } = run(`let d = 3; rotateTo(d);`);
  assert.equal(s.bot.dir, 3);
});

test("ternary argument becomes a branch with fixed nodes", () => {
  const { programs: [p] } = compile(`let k = 1; turn(k > 0 ? 90 : -90);`);
  assert.deepEqual(p.nodes.filter(n => n.t === "rotR").map(n => n.p.dir).sort(), [-2, 2]);
});

test("Math.abs / min / max", () => {
  const { vars } = run(`let a = -5; let b = Math.abs(a); let c = Math.max(a, 2); let d = Math.min(b, 3);`);
  assert.deepEqual([vars("b"), vars("c"), vars("d")], [5, 2, 3]);
});

test('"use program" functions become CALL + EXIT', () => {
  const src = `function Twice(n) { "use program"; let k = n * 2; return k > 5; }
    let ok = 0; if (Twice(4)) ok = 1; let bad = 0; if (!Twice(1)) bad = 1;`;
  const { r, vars } = run(src);
  assert.deepEqual(r.programs.map(p => p.name), ["Main", "Twice"]);
  assert.ok(r.programs[0].nodes.some(n => n.t === "call" && n.p.program === "Twice"));
  assert.ok(r.programs[1].nodes.some(n => n.t === "exit"));
  assert.deepEqual([vars("ok"), vars("bad")], [1, 1]);
});

test("break / continue in nested loops", () => {
  const { vars } = run(`let s = 0;
    outer: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j === 2) continue; if (j === 4) continue outer; if (i === 3) break outer; s++; } }`);
  assert.equal(vars("s"), 9);
});

test("do…while and switch on a number", () => {
  const { vars } = run(`let i = 0, t = 0; do { switch (i) { case 0: case 1: t += 1; break; case 2: t += 10; break; default: t += 100; } i++; } while (i < 4);`);
  assert.equal(vars("t"), 112);
});

test("shadowed locals get their own game variable", () => {
  const { vars } = run(`let i = 7; { let i = 1; i++; } let k = i;`);
  assert.equal(vars("k"), 7);
});

test("halt() leaves the output unconnected; exit(false) adds EXIT FAIL", () => {
  const a = compile(`if (step()) halt(); turnLeft();`).programs[0];
  assert.equal(a.nodes[1].outs[0], null);
  const b = run(`exit(false);`);
  assert.equal(b.s.result, "fail");
});

test("errors carry a source location", () => {
  try { compile(`let a = 1;\nrotateTo(Dir.Up);`); assert.fail(); }
  catch (e) { assert.match(e.message, /Dir.Up/); assert.equal(e.loc.line, 2); }
  assert.throws(() => compile(`x = 3;`), /read-only/);
  assert.throws(() => compile(`function f() { f(); } f();`), /recursive/);
  assert.throws(() => compile(`let a = ;`), /Unexpected/);
});

test("every node output index is valid and every example compiles, lays out and exports", () => {
  for (const ex of EXAMPLES) {
    const r = compile(ex.code);
    for (const p of r.programs) {
      assert.equal(p.nodes[0].t, "start");
      p.nodes.forEach((n, i) => {
        assert.equal(n.id, i);
        assert.equal(n.outs.length, T[n.t].outs.length, `${ex.id} #${i}`);
        for (const o of n.outs) assert.ok(o === null || (o >= 0 && o < p.nodes.length));
      });
      const routes = layout(p);
      assert.ok(p.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), ex.id);
      const svg = exportSvg(p, { routes, title: p.name });
      assert.ok(svg.startsWith("<svg") && !svg.includes("NaN"), ex.id);
      // formats round-trip
      for (const json of [toErzstat(p)]) {
        const back = importJson(JSON.stringify(json));
        assert.deepEqual(back.nodes.map(n => [n.t, n.outs]), p.nodes.map(n => [n.t, n.outs]), ex.id);
        assert.deepEqual(back.nodes.map(n => n.p), p.nodes.map(n => n.p), ex.id);
      }
    }
  }
});

test("nodes that lie in no reachable path are dropped", () => {
  const r = compile(`while (true) step();\nturnLeft();`);
  assert.deepEqual(types(r.programs[0]), ["start", "move"]);
  assert.match(r.warnings[0].msg, /unreachable/);
});

// ---------------------------------------------------------------- regressions from the generator comparison
test("variable arguments are copied when the call can change them", () => {
  assert.equal(run(`let n = 1; function bump() { n = n + 1; } function f(a) { bump(); return a; } let r = f(n);`).vars("r"), 1);
  assert.equal(run(`function movedFrom(x0) { step(); return x != x0; } let moved = 0; if (movedFrom(x)) moved = 1;`).vars("moved"), 1);
  // rnd changes on every read: it is copied once, so the comparison is v == v, not rnd == rnd
  const src = `function same(v) { return v == v; } let s = 0; if (same(rnd)) s = 1;`;
  const eq = compile(src).programs[0].nodes.find(n => n.t === "eq");
  assert.notEqual(eq.p.value.var, "rnd");
  assert.equal(run(src).vars("s"), 1);
});

test("a let without an initialiser starts at 0 on every entry", () => {
  assert.equal(run(`let n = 0; for (let i = 0; i < 2; i++) { let f; if (i == 0) f = 1; if (f) n++; }`).vars("n"), 1);
  assert.equal(run(`let g; let k = 0; if (g) k = 1;`).vars("k"), 0);
});

test("switch on a compile-time constant is folded", () => {
  const p = compile(`for (const d of [0, 1]) { switch (d) { case 0: turnLeft(); break; case 1: turnRight(); break; } }`).programs[0];
  assert.deepEqual(types(p), ["start", "rotR", "rotR"]);
  assert.deepEqual(p.nodes.slice(1).map(n => n.p.dir), [-2, 2]);
  const q = compile(`const K = 2; switch (K) { case 1: turnLeft(); case 2: turnRight(); case 3: turnAround(); break; default: step(); }`).programs[0];
  assert.deepEqual(q.nodes.slice(1).map(n => n.p.dir), [2, 4]);   // fallthrough from case 2 into case 3
});

test("constant-folded branches leave no unreachable-code warnings", () => {
  for (const src of [
    `for (const d of [0, 1]) { if (d == 0) turnLeft(); else turnRight(); }`,
    `function f(k) { if (k) turnLeft(); else turnRight(); }\nf(1);\nf(0);`,
    `const A = 1; let v = A ? x : y; A > 2 && step(); while (false) step();`,
  ]) assert.deepEqual(compile(src).warnings, [], src);
  assert.match(compile(`halt(); step();`).warnings[0].msg, /unreachable/);   // real dead code still warns
});

test("a program can't return a value", () => {
  assert.throws(() => compile(`function F() { "use program"; return 5; } let v = F();`), /can't return a value/);
  assert.doesNotThrow(() => compile(`function F() { "use program"; return true; } function G() { "use program"; return step(); } F(); G();`));
});

test("SCAN stores the aimed cell in scan_cell_front", () => {
  const { vars } = run(`aim(0, 3); scan(Category.Diggable); let ore = 0; if (scan_cell_front == Cell.DenseOre) ore = 1;`,
    { paint: w => fill(w, 4, 4, 10, 10, "DenseOre") });   // bot (4,7) facing east: right 3 = (4,10)
  assert.equal(vars("ore"), 1);
});
