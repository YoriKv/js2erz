// Import / export: erzstat.site Programmator JSON.
import { T, FUN_TO_TYPE, CATEGORIES, CELLS, INV_TARGETS, ITEMS, OPS } from "./nodes.js";

// ---------------------------------------------------------------- erzstat.site ("5.20 decoder" Executable)
// Node: {x, y, outputs, start: {params}} | {x, y, outputs, fun: {fun: "FunMove", relative?, …}}; x, y in grid cells.
// Operands: {var, const: null} | {var: null, const: {double} | {cell: index}}; COMP / OPER literals are bare numbers.
// An empty operand (null in the IR) is {var: null, const: null} and imports as null again.
const erzOperand = (o, bare) => {
  if (o == null) return { var: null, const: null };
  if (o.var != null) return { var: o.var, const: null };
  if (o.cell != null) return { var: null, const: { cell: CELLS.indexOf(o.cell) } };
  return { var: null, const: bare ? o.num : { double: o.num } };
};
const finite = v => (v !== null && v !== "" && typeof v !== "boolean" && Number.isFinite(+v) ? +v : null);
const fromErzOperand = o => {
  if (!o || typeof o !== "object") return null;
  if (o.var != null) return { var: String(o.var) };
  const c = o.const;
  if (typeof c === "number") return Number.isFinite(c) ? { num: c } : null;
  if (!c || typeof c !== "object") return null;
  if ("double" in c) { const v = finite(c.double); return v == null ? null : { num: v }; }
  if ("cell" in c) return Number.isInteger(c.cell) && c.cell >= 0 && c.cell < CELLS.length ? { cell: CELLS[c.cell] } : null;
  return null;
};
export function toErzstat(prog) {
  return {
    name: prog.name,
    nodes: prog.nodes.map(n => {
      const o = { x: +n.x.toFixed(3), y: +n.y.toFixed(3), outputs: n.outs.slice() };
      if (n.t === "start") { o.start = { params: (n.p || {}).params || [] }; return o; }
      const p = n.p || {}, f = { fun: T[n.t].fun };
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
const category = c => CATEGORIES[c] ?? "Diggable";
function fromErzNode(dn) {
  if (dn.start) return { t: "start", p: { params: Array.isArray(dn.start.params) ? dn.start.params.filter(v => typeof v === "string") : [] } };
  const f = dn.fun && typeof dn.fun === "object" ? dn.fun : {}, t = FUN_TO_TYPE(f.fun, f.relative);
  if (!t) throw new Error(`unknown node ${f.fun}`);
  const p = {};
  switch (t) {
    case "rotA": case "rotR": p.dir = finite(f.dir) ?? 0; break;
    case "aimA": case "aimR": p.front = finite(f.frontNotY) ?? 0; p.right = finite(f.rightNotX) ?? 0; break;
    case "scan": p.category = category(f.category); break;
    case "cell": p.value = fromErzOperand(f.value); p.category = category(f.category); break;
    case "use": p.item = ITEMS.includes(f.item) ? f.item : "Block"; break;
    case "inv": p.target = INV_TARGETS[f.target] ?? "Storage"; p.positive = !!f.positive; break;
    case "call": p.program = f.programId == null ? "" : String(f.programId); p.args = (Array.isArray(f.parameters) ? f.parameters : []).map(fromErzOperand); break;
    case "exit": p.fail = !!f.asFail; break;
    case "assign": p.varname = f.varname; p.value = fromErzOperand(f.value); break;
    case "oper": p.varname = f.varname; p.op = OPS[f.operation] ?? "Plus"; p.left = fromErzOperand(f.left); p.right = fromErzOperand(f.right); break;
    case "cmp": p.left = fromErzOperand(f.left); p.right = fromErzOperand(f.right); break;
    case "eq": p.value = fromErzOperand(f.value); p.set = (Array.isArray(f.set) ? f.set : []).map(fromErzOperand); break;
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
    const dn = exe.nodes[i], want = T[c.t].outs.length, n = exe.nodes.length;
    const outs = (Array.isArray(dn.outputs) ? dn.outputs : []).slice(0, want).map(o => (Number.isInteger(o) && o >= 0 && o < n ? o : null));
    while (outs.length < want) outs.push(null);
    return { id: i, t: c.t, x: finite(dn.x) ?? 0, y: finite(dn.y) ?? 0, outs, p: c.p };
  });
  if (nodes[0]?.t !== "start") throw new Error("node 0 must be the start node");
  const nm = [exe.name, obj.name].find(v => typeof v === "string" && v) ?? String(name);
  return { name: nm, params: nodes[0].p.params, nodes };
}
