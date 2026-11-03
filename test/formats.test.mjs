// erzstat.site JSON export / import: round trips per node type, empty operands, import cleaning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toErzstat, importJson } from "../src/formats.js";
import { T, DEFAULTS, CATEGORIES, ITEMS, INV_TARGETS, OPS, FUN_TO_TYPE } from "../src/nodes.js";

const START = { id: 0, t: "start", x: 0, y: 0, outs: [1], p: { params: [] } };
// start -> one node of type t (output 0 loops back to start)
const one = (t, p) => ({ name: "rt", params: [], nodes: [{ ...START }, { id: 1, t, x: 2.5, y: -1.25, outs: T[t].outs.map((_, i) => (i === 0 ? 0 : null)), p }] });
const roundTrip = prog => importJson(JSON.stringify(toErzstat(prog)));
const strip = nodes => nodes.map(({ id, t, x, y, outs, p }) => ({ id, t, x, y, outs, p }));
// erzstat node 1 with the given fun fields, after node 0 = start
const withFun = (fun, extra = {}) => JSON.stringify({ nodes: [{ x: 0, y: 0, outputs: [1], start: { params: [] } }, { x: 3, y: 0, outputs: [null, null, null, null], fun, ...extra }] });

const VARIANTS = {
  rotA: [0, 1, 2, 3, 4, 5, 6, 7].map(dir => ({ dir })),
  rotR: [-3, -2, -1, 1, 2, 3, 4].map(dir => ({ dir })),
  aimA: [{ front: -3, right: 3 }, { front: 0, right: 0 }],
  aimR: [{ front: 3, right: -3 }],
  scan: CATEGORIES.map(category => ({ category })),
  cell: [...CATEGORIES.map(category => ({ value: { var: "v" }, category })), { value: { cell: "DenseOre" }, category: "Rare" }, { value: { num: 5 }, category: "Rare" }],
  use: ITEMS.map(item => ({ item })),
  inv: INV_TARGETS.flatMap(target => [true, false].map(positive => ({ target, positive }))),
  call: [{ program: "Sub", args: [{ var: "a" }, { num: 1.5 }, { cell: "Road" }] }, { program: "", args: [] }],
  exit: [{ fail: true }, { fail: false }],
  assign: [{ varname: "a", value: { num: -2.5 } }, { varname: "a", value: { cell: "Empty" } }, { varname: "a", value: { var: "x" } }],
  oper: [...OPS.map(op => ({ varname: "i", op, left: { var: "i" }, right: { num: -0.5 } })), { varname: "i", op: "Plus", left: { cell: "Road" }, right: { num: 0 } }],
  cmp: [{ left: { var: "i" }, right: { num: 3 } }, { left: { num: 1 }, right: { cell: "Road" } }],
  eq: [{ value: { var: "scan_cell_front" }, set: [{ cell: "Road" }, { num: 3 }, { var: "q" }] }, { value: { num: 1 }, set: [] }],
  move: [{}], dig: [{}], movedig: [{}], cargo: [{}], pass: [{}],
};

test("every node type round-trips through the erzstat JSON (defaults and edge values)", () => {
  for (const t of Object.keys(T)) {
    if (t === "start") {
      const prog = { name: "rt", params: ["a", "b"], nodes: [{ id: 0, t, x: 0, y: 0, outs: [null], p: { params: ["a", "b"] } }] };
      assert.deepEqual(strip(roundTrip(prog).nodes), prog.nodes);
      continue;
    }
    const cases = [...(VARIANTS[t] || []), ...(DEFAULTS[t] ? [DEFAULTS[t]()] : [])];
    assert.ok(cases.length, t);
    for (const p of cases) {
      const prog = one(t, p);
      assert.deepEqual(strip(roundTrip(prog).nodes), prog.nodes, `${t} ${JSON.stringify(p)}`);
    }
  }
});

test("every fun maps back to its type; no fun maps to nothing", () => {
  for (const [t, d] of Object.entries(T)) if (d.fun) assert.equal(FUN_TO_TYPE(d.fun, d.rel), t);
  assert.equal(FUN_TO_TYPE(undefined), null);
  assert.equal(FUN_TO_TYPE(""), null);
});

test("empty (null) operands export as {var: null, const: null} and import as null", () => {
  const cases = [
    ["assign", { varname: "a", value: null }],
    ["oper", { varname: "i", op: "Plus", left: null, right: null }],
    ["cmp", { left: { var: "i" }, right: null }],
    ["cell", { value: null, category: "Rare" }],
    ["eq", { value: null, set: [null, { num: 2 }] }],
    ["call", { program: "x", args: [null] }],
  ];
  for (const [t, p] of cases) {
    const prog = one(t, p);
    const json = toErzstat(prog);
    assert.ok(JSON.stringify(json).includes('{"var":null,"const":null}'), t);
    assert.deepEqual(roundTrip(prog).nodes[1].p, p, t);
  }
  // an imported empty operand can be exported again
  const imp = importJson(withFun({ fun: "FunEqualsAnyOf", value: { var: "a", const: null }, set: [{ var: null, const: null }] }));
  assert.deepEqual(imp.nodes[1].p, { value: { var: "a" }, set: [null] });
  assert.doesNotThrow(() => toErzstat(imp));
});

test("import cleans outputs, coordinates, names and parameters", () => {
  const p = importJson(JSON.stringify({
    name: { not: "a string" },
    nodes: [
      { x: "5", y: "abc", outputs: [-1], start: { params: ["a", 3, null] } },
      { x: null, y: Infinity, outputs: [0.5, "0", true, 1], fun: { fun: "FunMove" } },
      { x: 1, y: 2, outputs: [0, 99, 2], fun: { fun: "FunUseItem", item: "Bogus" } },
      { x: 0, y: 0, outputs: [], fun: { fun: "FunCallProgram", programId: 7 } },
      { x: 0, y: 0, outputs: [], fun: { fun: "FunScan", category: 42 } },
      { x: 0, y: 0, outputs: [], fun: { fun: "FunRotate", relative: true } },
    ],
  }), "Fallback");
  assert.equal(p.name, "Fallback");
  assert.deepEqual(p.params, ["a"]);
  assert.deepEqual(p.nodes.map(n => [n.x, n.y]), [[5, 0], [0, 0], [1, 2], [0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(p.nodes[0].outs, [null]);
  assert.deepEqual(p.nodes[1].outs, [null, null]);
  assert.deepEqual(p.nodes[2].outs, [0, null, 2]);
  assert.equal(p.nodes[2].p.item, "Block");
  assert.equal(p.nodes[3].p.program, "7");
  assert.equal(p.nodes[4].p.category, "Diggable");
  assert.equal(p.nodes[5].p.dir, 0);
  assert.deepEqual(p.nodes.map(n => n.id), [0, 1, 2, 3, 4, 5]);
  assert.doesNotThrow(() => toErzstat(p));
});

test("import: a node without fun is rejected, also as node 0", () => {
  assert.throws(() => importJson(withFun({})), /unknown node/);
  assert.throws(() => importJson(JSON.stringify({ nodes: [{ x: 0, y: 0, outputs: [1] }, { x: 1, y: 0, outputs: [], fun: { fun: "FunExitProgram" } }] })), /unknown node/);
  assert.throws(() => importJson(JSON.stringify({ nodes: [{ x: 0, y: 0, outputs: [], fun: { fun: "FunMove" } }] })), /start node/);
});

test("import: operand constants are type-checked", () => {
  const value = v => importJson(withFun({ fun: "FunVarAssignValue", varname: "a", value: v })).nodes[1].p.value;
  assert.deepEqual(value({ var: null, const: { double: "5" } }), { num: 5 });
  assert.deepEqual(value({ var: null, const: { double: 2.5 } }), { num: 2.5 });
  assert.equal(value({ var: null, const: { double: "x" } }), null);
  assert.equal(value({ var: null, const: { double: null } }), null);
  assert.equal(value({ var: null, const: "abc" }), null);
  assert.equal(value({ var: null, const: true }), null);
  assert.equal(value({ var: null, const: { cell: -1 } }), null);
  assert.equal(value({ var: null, const: { cell: 1.5 } }), null);
  assert.deepEqual(value({ var: null, const: { cell: 24 } }), { cell: "DenseOre" });
  assert.equal(value("junk"), null);
  const cmp = importJson(withFun({ fun: "FunCompare", left: { var: null, const: 3 }, right: { var: null, const: "3" } })).nodes[1].p;
  assert.deepEqual(cmp, { left: { num: 3 }, right: null });
});
