// Import / export: erzstat.site Programmator JSON and the text build list.
import { T, FUN_TO_TYPE, CATEGORIES, CELLS, INV_TARGETS, OPS, nodeSummary } from "./nodes.js";

// ---------------------------------------------------------------- erzstat.site ("5.20 decoder" Executable)
// Node: {x, y, outputs, start: {params}} | {x, y, outputs, fun: {fun: "FunMove", relative?, …}}; x, y in grid cells.
// Operands: {var, const: null} | {var: null, const: {double} | {cell: index}}; COMP / OPER literals are bare numbers.
const erzOperand = (o, bare) => {
  if (o.var != null) return { var: o.var, const: null };
  if (o.cell != null) return { var: null, const: { cell: CELLS.indexOf(o.cell) } };
  return { var: null, const: bare ? o.num : { double: o.num } };
};
const fromErzOperand = o => {
  if (!o) return null;
  if (o.var != null) return { var: o.var };
  const c = o.const;
  if (c == null) return null;
  if (typeof c === "number") return { num: c };
  if ("double" in c) return { num: c.double };
  if ("cell" in c) return { cell: CELLS[c.cell] ?? "Unknown" };
  return null;
};
export function toErzstat(prog) {
  return {
    name: prog.name,
    nodes: prog.nodes.map(n => {
      const o = { x: +n.x.toFixed(3), y: +n.y.toFixed(3), outputs: n.outs.slice() };
      if (n.t === "start") { o.start = { params: n.p.params || [] }; return o; }
      const p = n.p, f = { fun: T[n.t].fun };
      switch (n.t) {
        case "rotA": case "rotR": Object.assign(f, { relative: T[n.t].rel, dir: p.dir }); break;
        case "aimA": case "aimR": Object.assign(f, { relative: T[n.t].rel, frontNotY: p.front, rightNotX: p.right }); break;
        case "scan": f.category = CATEGORIES.indexOf(p.category); break;
        case "cell": Object.assign(f, { value: erzOperand(p.value), category: CATEGORIES.indexOf(p.category) }); break;
        case "use": f.item = p.item; break;
        case "inv": Object.assign(f, { target: INV_TARGETS.indexOf(p.target), positive: p.positive }); break;
        case "call": Object.assign(f, { programId: p.program, parameters: (p.args || []).map(a => erzOperand(a)) }); break;
        case "exit": f.asFail = !!p.fail; break;
        case "assign": Object.assign(f, { varname: p.varname, value: erzOperand(p.value) }); break;
        case "oper": Object.assign(f, { varname: p.varname, operation: OPS.indexOf(p.op), left: erzOperand(p.left, true), right: erzOperand(p.right, true) }); break;
        case "cmp": Object.assign(f, { left: erzOperand(p.left, true), right: erzOperand(p.right, true) }); break;
        case "eq": Object.assign(f, { value: erzOperand(p.value), set: (p.set || []).map(a => erzOperand(a)) }); break;
      }
      o.fun = f;
      return o;
    }),
  };
}
function fromErzNode(dn) {
  if (dn.start) return { t: "start", p: { params: dn.start.params || [] } };
  const f = dn.fun || {}, t = FUN_TO_TYPE(f.fun, f.relative);
  if (!t) throw new Error(`unknown node ${f.fun}`);
  const p = {};
  switch (t) {
    case "rotA": case "rotR": p.dir = f.dir; break;
    case "aimA": case "aimR": p.front = f.frontNotY; p.right = f.rightNotX; break;
    case "scan": p.category = CATEGORIES[f.category] ?? "Walkable"; break;
    case "cell": p.value = fromErzOperand(f.value); p.category = CATEGORIES[f.category] ?? "Walkable"; break;
    case "use": p.item = f.item; break;
    case "inv": p.target = INV_TARGETS[f.target] ?? "Storage"; p.positive = !!f.positive; break;
    case "call": p.program = f.programId || ""; p.args = (f.parameters || []).map(fromErzOperand); break;
    case "exit": p.fail = !!f.asFail; break;
    case "assign": p.varname = f.varname; p.value = fromErzOperand(f.value); break;
    case "oper": p.varname = f.varname; p.op = OPS[f.operation] ?? "Plus"; p.left = fromErzOperand(f.left); p.right = fromErzOperand(f.right); break;
    case "cmp": p.left = fromErzOperand(f.left); p.right = fromErzOperand(f.right); break;
    case "eq": p.value = fromErzOperand(f.value); p.set = (f.set || []).map(fromErzOperand); break;
  }
  return { t, p };
}

// ---------------------------------------------------------------- import (an Executable, or any object that contains one)
function findNodes(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 6) return null;
  if (Array.isArray(o.nodes) && o.nodes.length && o.nodes.every(n => n && typeof n === "object" && "outputs" in n)) return o;
  for (const v of Object.values(o)) { const r = findNodes(v, depth + 1); if (r) return r; }
  return null;
}
export function importJson(text, name = "Imported") {
  const obj = JSON.parse(text);
  const exe = findNodes(obj);
  if (!exe) throw new Error("no program found: expected an object with a nodes array whose nodes have outputs");
  if (exe.nodes.some(n => n._type)) throw new Error("unsupported format: expected the erzstat.site Programmator JSON");
  const conv = exe.nodes.map(fromErzNode);
  const nodes = conv.map((c, i) => {
    const dn = exe.nodes[i], want = T[c.t].outs.length;
    const outs = (dn.outputs || []).slice(0, want).map(o => (o != null && o < exe.nodes.length ? o : null));
    while (outs.length < want) outs.push(null);
    return { id: i, t: c.t, x: dn.x || 0, y: dn.y || 0, outs, p: c.p };
  });
  if (nodes[0]?.t !== "start") throw new Error("node 0 must be the start node");
  return { name: exe.name || obj.name || name, params: nodes[0].p.params, nodes };
}

// ---------------------------------------------------------------- text build list
export function buildList(prog) {
  const lines = [`${prog.name} — ${prog.nodes.length} nodes`, ""];
  for (const n of prog.nodes) {
    const t = T[n.t], s = nodeSummary(n);
    const outs = n.outs.map((o, i) => `${t.outs[i][1]} → ${o == null ? "END" : `#${o}`}`).join(", ");
    lines.push(`#${n.id} ${t.label}${s ? `  [${s}]` : ""}${outs ? `   ${outs}` : ""}`);
  }
  return lines.join("\n");
}
