// Layout and rendering invariants: no overlapping nodes, routes that start and end at the ports, NaN-free SVG,
// export bounds that contain every edge, and no stack overflow on very wide graphs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compiler.js";
import { layout } from "../src/layout.js";
import { exportSvg } from "../src/render.js";
import { T, DEFAULTS } from "../src/nodes.js";
import { U, sizePx, portPos, inPos } from "../src/geom.js";
import { EXAMPLES } from "../src/examples.js";

function randomProgram(n, backP, seed) {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const types = Object.keys(T).filter(t => t !== "start");
  const nodes = [{ id: 0, t: "start", x: 0, y: 0, outs: [n > 1 ? 1 : null], p: { params: [] } }];
  for (let i = 1; i < n; i++) {
    const t = types[Math.floor(rnd() * types.length)];
    const outs = T[t].outs.map(() => (rnd() < 0.3 ? null : rnd() < backP ? Math.floor(rnd() * n) : Math.min(n - 1, i + 1 + Math.floor(rnd() * 4))));
    nodes.push({ id: i, t, x: 0, y: 0, outs, p: DEFAULTS[t] ? DEFAULTS[t]() : {} });
  }
  return { name: "random", params: [], nodes };
}

function assertLaidOut(p, label, opts) {
  const routes = layout(p, opts);
  assert.ok(p.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), `${label}: finite positions`);
  const box = n => { const [w, h] = sizePx(n); return [n.x * U, n.y * U, n.x * U + w, n.y * U + h]; };
  const boxes = p.nodes.map(box);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(!(a[0] < b[2] - 0.01 && b[0] < a[2] - 0.01 && a[1] < b[3] - 0.01 && b[1] < a[3] - 0.01), `${label}: nodes ${i} and ${j} overlap`);
  }
  for (const [key, r] of routes) {
    const [a, i] = key.split(":").map(Number), A = p.nodes[a], B = p.nodes[A.outs[i]];
    const pts = r.poly ? r.pts : r;
    assert.ok(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), `${label}: route ${key} finite`);
    if (r.poly) {   // polylines leave the output port horizontally and enter the target input horizontally
      assert.equal(pts[0][1], portPos(A, i)[1], `${label}: route ${key} start`);
      assert.equal(pts[pts.length - 1][1], inPos(B)[1], `${label}: route ${key} end`);
    } else {        // dummy chains run between the two ports
      assert.ok(pts[0][0] > portPos(A, i)[0] && pts[pts.length - 1][0] < inPos(B)[0], `${label}: chain ${key} inside`);
    }
  }
  return routes;
}

// every path coordinate inside the SVG canvas, and no NaN / undefined anywhere
function assertSvgClean(svg, label) {
  assert.ok(!/NaN|undefined/.test(svg), `${label}: NaN or undefined in SVG`);
  const [W, H] = svg.match(/width="(\d+)" height="(\d+)"/).slice(1).map(Number);
  const [tx, ty] = svg.match(/<g transform="translate\(([-\d.e]+),([-\d.e]+)\)">/).slice(1).map(Number);
  for (const m of svg.matchAll(/<path d="(M[^"]*)" fill="none" stroke="#/g))
    for (const q of m[1].matchAll(/(-?[\d.]+(?:e-?\d+)?),(-?[\d.]+(?:e-?\d+)?)/g)) {
      const x = +q[1] + tx, y = +q[2] + ty;
      assert.ok(x >= 0 && x <= W && y >= 0 && y <= H, `${label}: edge point ${x},${y} outside ${W}x${H}`);
    }
}

test("layout: no overlapping nodes, routes at the ports, clean SVG (examples, wrapped and not)", () => {
  for (const ex of EXAMPLES) for (const p of compile(ex.code).programs) for (const wrap of [true, false]) {
    const routes = assertLaidOut(p, `${ex.id} wrap=${wrap}`, { wrap });
    assertSvgClean(exportSvg(p, { routes, title: p.name }), ex.id);
  }
});

test("layout: no overlapping nodes on seeded random graphs up to 1000 nodes", () => {
  for (const [n, backP, seed] of [[1, 0, 1], [2, 1, 2], [50, 0.3, 3], [300, 0.2, 4], [1000, 0.1, 12345]]) {
    const p = randomProgram(n, backP, seed);
    const routes = assertLaidOut(p, `random ${n}`);
    assertSvgClean(exportSvg(p, { routes }), `random ${n}`);
  }
});

test("layout: a very wide unwrapped graph does not overflow the stack", () => {
  // every node also links to the last one: ~180 000 dummy nodes without wrapping (a spread Math.max overflowed here)
  const n = 600, nodes = [{ id: 0, t: "start", x: 0, y: 0, outs: [1], p: { params: [] } }];
  for (let i = 1; i < n - 1; i++) nodes.push({ id: i, t: "move", x: 0, y: 0, outs: [i + 1, n - 1], p: {} });
  nodes.push({ id: n - 1, t: "exit", x: 0, y: 0, outs: [], p: { fail: false } });
  assert.doesNotThrow(() => layout({ name: "fan-in", params: [], nodes }, { wrap: false }));
  assert.ok(nodes.every(nd => Number.isFinite(nd.x) && Number.isFinite(nd.y)));
});

test("export: loops routed around the nodes stay inside the SVG", () => {
  // a row of 12 STEP nodes whose fail outputs all loop back to #1: the loop lanes stack up below / above the row
  const nodes = [{ id: 0, t: "start", x: 0, y: 0, outs: [1], p: { params: [] } }];
  for (let i = 1; i <= 12; i++) nodes.push({ id: i, t: "move", x: i * 3.5, y: 0, outs: [i < 12 ? i + 1 : null, 1], p: {} });
  const prog = { name: "loops", params: [], nodes };
  assertSvgClean(exportSvg(prog, { routes: new Map() }), "loops");
  assertSvgClean(exportSvg(prog, { routes: new Map(), title: "loops", subtitle: "x" }), "loops titled");
  assertSvgClean(exportSvg(prog, { routes: layout(prog) }), "loops laid out");
});

test("export: odd parameters draw without NaN or undefined", () => {
  const odd = {
    rotA: { dir: 9 }, rotR: { dir: -4 }, aimA: { front: 7, right: -9 }, aimR: { front: -0.5, right: 2 },
    scan: { category: "Bogus" }, use: { item: "Block" }, inv: { target: "Box", positive: false },
    call: { program: "", args: [null] }, exit: { fail: true },
    assign: { varname: "a", value: null }, oper: { varname: "x", op: "Pow", left: null, right: { num: NaN } },
    cmp: { left: null, right: { cell: "Road" } }, eq: { value: null, set: [{ num: 1e21 }] }, cell: { value: null, category: "Bogus" },
  };
  const types = Object.keys(T).filter(t => t !== "start");
  const nodes = [{ id: 0, t: "start", x: 0, y: 0, outs: [1], p: { params: [] } }];
  types.forEach((t, k) => nodes.push({ id: k + 1, t, x: 0, y: 0, outs: T[t].outs.map((_, i) => (i === 0 && k + 2 <= types.length ? k + 2 : i === 1 ? 1 : null)), p: odd[t] || {} }));
  nodes.push({ id: nodes.length, t: "rotR", x: 0, y: 0, outs: [null], p: { dir: 0 } });
  const prog = { name: "odd", params: [], nodes };
  const routes = layout(prog);
  assertSvgClean(exportSvg(prog, { routes, title: "odd" }), "odd");
});
