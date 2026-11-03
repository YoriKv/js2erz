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

// ---------------------------------------------------------------- shared functions (compiled once)
const nodesOf = r => r.programs.reduce((a, p) => a + p.nodes.length, 0);
// run with and without sharing; the variables must agree
function both(src, names, opts) {
  const on = run(src, opts), off = (() => {
    const r = compile(src, { share: false });
    const w = emptyWorld(opts?.W || 30, opts?.H || 15); w.bot = opts?.bot || { x: 4, y: 7 };
    if (opts?.paint) opts.paint(w);
    const s = createSim({ programs: new Map(r.programs.map(p => [p.name, p])), main: r.programs[0].name, world: w, dir: 0 });
    s.run(opts?.steps || 20000);
    return { r, s, vars: n => s.vars && s.vars.get(n) && s.vars.get(n).v };
  })();
  for (const n of names) assert.equal(on.vars(n), off.vars(n), `variable ${n}`);
  return { on, off };
}
const BIG = `function probe(f, r) { aim(f, r); scan(Category.Walkable); hits = hits + 1; t1 = t1 + f; t2 = t2 + r; t3 = t3 + f * r; }`;

test("a function called often is compiled once and called through a dispatch", () => {
  const src = `let hits = 0, t1 = 0, t2 = 0, t3 = 0, a = 1, b = 2, c = 3; ${BIG}
    probe(a, b); probe(b, c); probe(c, a); probe(a, a); probe(b, b);`;
  const { on, off } = both(src, ["hits", "t1", "t2", "t3"]);
  assert.ok(nodesOf(on.r) < nodesOf(off.r), `${nodesOf(on.r)} < ${nodesOf(off.r)}`);
  assert.deepEqual(on.r.shared.map(s => [s.name, s.calls]), [["probe", 5]]);
  assert.equal(on.vars("hits"), 5);
  assert.equal(on.vars("t3"), 1 * 2 + 2 * 3 + 3 * 1 + 1 + 4);
});

test("shared functions return conditions and values to the right call site", () => {
  // variable arguments (each constant argument set would be its own specialised copy)
  const cond = `let n = 0, m = 0, a = 1, b = 9, c = 4, z = 0, w = -5;
    function far(v) { let d = v - 3; d = d * d; d = d + 1; d = d - 1; return d > 4; }
    if (far(a)) n++; if (far(b)) n += 10; if (far(c)) n += 100; if (!far(z)) m = 1; if (far(w)) m += 10;`;
  const a = both(cond, ["n", "m"]);
  assert.ok(a.on.r.shared.length === 1, "far() is shared");
  assert.deepEqual([a.on.vars("n"), a.on.vars("m")], [10, 10]);
  const val = `let two = 2, three = 3, four = 4, one = 1;
    function sq(v) { let r = v * v; r = r + 0.5; r = r - 0.5; r = r * 1; return r; }
    let a = sq(two) + sq(three); let b = sq(sq(two)); let c = 2 * sq(four) - sq(one);`;
  const v = both(val, ["a", "b", "c"]);
  assert.ok(v.on.r.shared.length === 1, "sq() is shared");
  assert.deepEqual([v.on.vars("a"), v.on.vars("b"), v.on.vars("c")], [13, 16, 31]);
});

test("constant arguments keep one specialised copy per constant set", () => {
  const src = `let hits = 0, t1 = 0, t2 = 0, t3 = 0; ${BIG}
    probe(2, 0); probe(2, 0); probe(2, 0); probe(0, 2); probe(0, 2); probe(0, 2);`;
  const { on } = both(src, ["hits", "t1", "t2", "t3"]);
  assert.equal(on.r.shared.length, 2);
  // the constants stay in the AIM nodes, no aim variables are written
  assert.ok(!on.r.programs[0].nodes.some(n => n.t === "assign" && /^aim_/.test(n.p.varname)));
});

test("shared functions keep their own variables and temporaries", () => {
  // the caller's i, its temporary and the function's local i must not clobber each other
  const src = `let s = 0; function f(k) { let i = k * 2; i = i + 1; i = i * 3; i = i - 2; i = i + 5; i = i - 5; i = i * 1; return i; }
    for (let i = 0; i < 3; i++) s = s + (i + 1) * f(i) + f(i + 1) - f(i + 2);`;
  const { on } = both(src, ["s"]);
  assert.ok(on.r.shared.length === 1, "f() is shared");
  const f = k => (k * 2 + 1) * 3 - 2;
  assert.equal(on.vars("s"), [0, 1, 2].reduce((a, i) => a + (i + 1) * f(i) + f(i + 1) - f(i + 2), 0));
});

test("nested shared functions and 'use inline'", () => {
  const src = `let hits = 0, t1 = 0, t2 = 0, t3 = 0, q = 0; ${BIG}
    function twice(a) { probe(a, 1); probe(a, 2); q = q + a; q = q * 2; }
    twice(q); twice(q + 1); twice(q + 2);`;
  const { on } = both(src, ["hits", "t1", "t2", "t3", "q"]);
  assert.ok(on.r.shared.length >= 1);
  const forced = compile(src.replace("function twice(a) {", 'function twice(a) { "use inline";'));
  assert.ok(!forced.shared.some(s => s.name === "twice"));
});

test("sharing can be switched off", () => {
  const src = `let hits = 0, t1 = 0, t2 = 0, t3 = 0, a = 1; ${BIG} probe(a, a); probe(a, a); probe(a, a);`;
  assert.deepEqual(compile(src, { share: false }).shared, []);
});

// ---------------------------------------------------------------- lint
test("lint reports every error, not just the first, with exact ranges", async () => {
  const { lint } = await import("../src/compiler.js");
  const { errors } = lint(`let a = b + 1;
step(1);
turn(30);
scan(Category.Foo);
hp = 3;
if (dig() === "dugg") pass();
aim(1);
use(Cell.DenseOre);
a = a + c;`);
  const got = errors.map(e => `${e.loc.line}:${e.loc.col} ${e.msg}`);
  assert.deepEqual(got, [
    '1:9 "b" is not defined',
    "2:6 step() takes no arguments",
    "3:6 turn() takes multiples of 45 degrees",
    "4:15 Category.Foo does not exist",
    "5:1 hp is read-only",
    '6:15 "dugg" is not an outcome of DIG ("success", "cantDig", "nothingToDig")',
    "7:1 aim() needs 2 arguments",
    "8:5 use() item: expected item, got cell",
    '9:9 "c" is not defined',
  ]);
  assert.deepEqual(errors[0].loc, { line: 1, col: 9, endLine: 1, endCol: 10 });
});

test("lint: a failed declaration still declares its name; code the compiler skips is checked too", async () => {
  const { lint } = await import("../src/compiler.js");
  const r = lint(`let a = nope + 1;\nstep();\nlet z = a * 2;\nfunction never() { missing(); return q; }\nlet unused = 3;\nstep(z);`);
  assert.deepEqual(r.errors.map(e => e.msg), ['"nope" is not defined', "unknown function missing()", '"q" is not defined', "step() takes no arguments"]);
  assert.deepEqual(r.warnings.map(w => w.msg), ['"unused" is never used']);
});

test("lint: syntax errors, extra arguments to functions, clean examples", async () => {
  const { lint } = await import("../src/compiler.js");
  assert.deepEqual(lint("let x = ;").errors.map(e => e.msg), ["Unexpected token"]);
  assert.deepEqual(lint("function f(p) { step(); }\nf(1, 2);").warnings.map(w => w.msg), ["f() takes 1 parameter; the rest are ignored"]);
  for (const ex of EXAMPLES) assert.deepEqual(lint(ex.code), { errors: [], warnings: [] }, ex.id);
});

test("compile still stops at the first error", () => {
  assert.throws(() => compile("step(1); turn(30);"), /^Error: step\(\) takes no arguments$/);
});
