// JavaScript subset -> ERZ Programmator node graphs.
//
// The compiler walks the acorn AST and emits nodes in source order. Control flow is built by back-patching:
// `pending` holds the open references (node outputs or unresolved labels) that the next emitted node will
// receive. A branch splits `pending`, a loop places a label and jumps back to it. User functions are inlined;
// functions with a "use program" directive become separate programs reached through CALL nodes.

import * as acorn from "../vendor/acorn.mjs";
import { T, DIRS, CATEGORIES, CELLS, ITEMS, INV_TARGETS, BUILTIN_VARS, WRITABLE_BUILTINS, NODE_LIMIT } from "./nodes.js";

export class CompileError extends Error {
  constructor(msg, node) {
    super(msg);
    this.loc = node && node.loc ? { line: node.loc.start.line, col: node.loc.start.column + 1, endLine: node.loc.end.line, endCol: node.loc.end.column + 1 } : null;
  }
}
const fail = (msg, node) => { throw new CompileError(msg, node); };
const locOf = node => node && node.loc ? { line: node.loc.start.line, col: node.loc.start.column + 1, endLine: node.loc.end.line, endCol: node.loc.end.column + 1 } : null;

// ---------------------------------------------------------------- references (open edges)
class Hole {
  constructor(b, node, i) { this.b = b; this.node = node; this.i = i; this.done = false; }
  patch(target) {
    if (this.done) throw new Error("internal: output patched twice");
    this.done = true;
    if (target != null) this.b.nodes[this.node].outs[this.i] = target;
  }
}
class Label {
  constructor() { this.id = undefined; this.waiters = []; }
  get resolved() { return this.id !== undefined; }
  patch(target) {
    if (this.resolved) throw new Error("internal: label resolved twice");
    this.id = target;
    for (const w of this.waiters) w.patch(target);
    this.waiters = [];
  }
}

// ---------------------------------------------------------------- compile-time constants
// {k: "num", v} {k: "cell", v} {k: "str", v} {k: "cat", v} {k: "item", v} {k: "target", v} {k: "arr", v: const[]}
const ENUMS = {
  Dir: Object.fromEntries(DIRS.map((d, i) => [d, { k: "num", v: i }])),
  Category: Object.fromEntries(CATEGORIES.map(c => [c, { k: "cat", v: c }])),
  Cell: Object.fromEntries(CELLS.map(c => [c, { k: "cell", v: c }])),
  Item: Object.fromEntries(ITEMS.map(c => [c, { k: "item", v: c }])),
  Target: Object.fromEntries(INV_TARGETS.map(c => [c, { k: "target", v: c }])),
};
ENUMS.Category.Hard = ENUMS.Category.DiggableHard;
ENUMS.Target.Base = ENUMS.Target.Storage;
const constOperand = (c, node) => {
  if (c.k === "num") return { num: c.v };
  if (c.k === "cell") return { cell: c.v };
  fail(`a ${c.k === "str" ? "string" : c.k} constant can't be used as a value here`, node);
};
const truthy = c => c.k === "num" ? c.v !== 0 : c.k === "str" ? c.v !== "" : true;

// ---------------------------------------------------------------- builtin functions
// kind "action": one node, single output. "outcome": one node with several outputs.
const ROT_NAMES = { turnLeft: -2, turnRight: 2, turnAround: 4 };
const OUTCOME_FUNS = new Set(["step", "move", "dig", "moveDig", "scan", "use", "useItem", "inventory", "unload", "load", "autoCargo", "call"]);
const ACTION_FUNS = new Set(["rotateTo", "turn", "turnLeft", "turnRight", "turnAround", "aim", "aimAt", "pass"]);
const SPECIAL_FUNS = new Set(["exit", "fail", "halt", "anyOf", "inCategory", "log"]);
// [min, max] arguments of the built-in calls (anyOf, inCategory, call and log check their own)
const ARITY = { step: [0, 0], move: [0, 0], dig: [0, 0], moveDig: [0, 0], autoCargo: [0, 0], pass: [0, 0], halt: [0, 0], fail: [0, 0],
  turnLeft: [0, 0], turnRight: [0, 0], turnAround: [0, 0], turn: [1, 1], rotateTo: [1, 1], aim: [2, 2], aimAt: [2, 2],
  scan: [1, 1], use: [1, 1], useItem: [1, 1], unload: [0, 1], load: [0, 1], inventory: [1, 2], exit: [0, 1] };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function checkArity(name, e) {
  const r = ARITY[name]; if (!r) return;
  const n = e.arguments.length, [lo, hi] = r;
  if (n > hi) fail(hi === 0 ? `${name}() takes no arguments` : lo === hi ? `${name}() takes ${plural(hi, "argument")}` : `${name}() takes at most ${plural(hi, "argument")}`, e.arguments[hi]);
  if (n < lo) fail(lo === hi ? `${name}() needs ${plural(lo, "argument")}` : `${name}() needs at least ${plural(lo, "argument")}`, e);
}
// outputs that a statement or condition leaves unconnected (the program stops there): real errors only
const ERROR_OUTS = { assign: [1], oper: [1], cmp: [3], call: [2] };
const normKey = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export const BUILTIN_DOCS = [
  ["step()", "STEP", "Move one cell forward. → \"success\" | \"fail\""],
  ["dig()", "DIG", "One strike at the front row. → \"success\" | \"cantDig\" | \"nothingToDig\""],
  ["moveDig()", "MOVEDIG", "Step if free, otherwise strike. → \"moved\" | \"dug\" | \"fail\""],
  ["rotateTo(Dir.N)", "ROT ABS", "Face a map direction (constant, or a variable: compiled to an EQ dispatch)."],
  ["turn(90)", "ROT REL", "Turn by ±45, ±90, ±135 or 180 degrees (+ = clockwise). Also turnLeft(), turnRight(), turnAround()."],
  ["aim(front, right)", "AIM REL", "Aim relative to the facing, −3..3. Variables are written to aim_front / aim_right."],
  ["aimAt(dx, dy)", "AIM ABS", "Aim at a map-axis offset from the bot, −3..3. Variables are written to aim_x / aim_y."],
  ["scan(Category.Diggable)", "SCAN", "Is the aimed cell in the category? → \"pass\" | \"fail\""],
  ["use(Item.MiningCharge)", "USE", "Use an item on the aimed cell. → \"success\" | \"fail\" | \"noItem\""],
  ["unload(Target.Storage)", "INVENTORY", "Move cargo from the bot to Storage / Box / Bot. load(target) takes from it. → \"success\" | \"fail\" | \"boxLocked\""],
  ["autoCargo()", "AUTOCARGO", "Unload by the auto-cargo settings at a base. → \"success\" | \"fail\""],
  ["pass()", ".", "Passthrough node (costs nothing). Useful for wait loops."],
  ["call(\"Program\", ...args)", "CALL", "Run another program. → \"success\" | \"fail\" | \"halt\""],
  ["exit() / exit(false) / fail()", "EXIT", "End the program with SUCCESS or FAIL."],
  ["halt()", "—", "Stop here: leaves the output unconnected."],
  ["anyOf(v, a, b, …)", "EQ", "Is v equal to any of the values (numbers, cells, variables or a const array)?"],
  ["inCategory(cell, Category.Rare)", "CELL", "Is the cell value in the category?"],
  ["a < b, a == b, …", "COMP / EQ", "Ordering uses COMP, equality uses EQ."],
  ["x = a + b * c", "VALUE / OPER", "Arithmetic (+ − × ÷ %) compiles to OPER nodes, plain copies to VALUE."],
];

// ---------------------------------------------------------------- scopes
class Scope {
  constructor(parent, owner) { this.parent = parent; this.owner = owner; this.map = new Map(); }
  lookup(name) { for (let s = this; s; s = s.parent) if (s.map.has(name)) return s.map.get(name); return null; }
}

// ---------------------------------------------------------------- program builder
class Builder {
  constructor(name, params) {
    this.name = name; this.params = params;
    this.nodes = []; this.pending = [];
    this.live = new Map();        // game variable name -> number of live JS bindings using it
    this.types = new Map();       // game variable name -> "num" | "cell" | "any" | {outcome: type}
    this.temps = 0; this.maxTemps = 0; this.tempPrefix = "_t";
    this.everNames = new Set();   // every game variable name bound in this program
    this.reserved = new Set();    // names taken by shared functions (parameters, return site, return value)
    this.shared = new Map();      // key -> shared function (compiled once, see sharedCall)
    const s = this.emit("start", { params: params.slice() }, null);
    this.pending = [new Hole(this, s, 0)];
  }
  emit(t, p, astNode) {
    const id = this.nodes.length;
    this.nodes.push({ id, t, x: 0, y: 0, outs: T[t].outs.map(() => null), p, src: locOf(astNode) });
    const pend = this.pending; this.pending = [];
    for (const r of pend) r.patch(id);
    return id;
  }
  holes(id, idx) { return idx.map(i => new Hole(this, id, i)); }
  outsExcept(id, t, skip) { return T[t].outs.map((_, i) => i).filter(i => !skip.includes(i)); }
  drop() { for (const r of this.pending) r.patch(null); this.pending = []; }
  place(label) { this.pending.push(label); }
  jump(label, astNode) {
    if (label.resolved) { for (const r of this.pending) r.patch(label.id); }
    else if (this.pending.includes(label)) {
      // a loop with no node in it: give it a passthrough so the cycle has something to run
      const id = this.emit("pass", {}, astNode);
      new Hole(this, id, 0).patch(id);
    } else label.waiters.push(...this.pending);
    this.pending = [];
  }
  temp() { this.temps++; this.maxTemps = Math.max(this.maxTemps, this.temps); return `${this.tempPrefix}${this.temps}`; }
}

// ---------------------------------------------------------------- compiler
export function compile(source, opts = {}) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true });
  } catch (e) {
    const err = new CompileError(e.message.replace(/\s*\(\d+:\d+\)$/, ""), null);
    if (e.loc) err.loc = { line: e.loc.line, col: e.loc.column + 1, endLine: e.loc.line, endCol: e.loc.column + 2 };
    throw err;
  }
  // 1. everything inlined; this run also counts how often each function is inlined and how big it gets
  const once = share => new Compiler({ ...opts, share }).run(ast);
  const base = once(new Set());
  base.shared = [];
  if (opts.share === false) return base;
  const size = r => r.programs.reduce((a, p) => a + p.nodes.length, 0);
  // 2. greedily share functions (one compiled copy, reached through a return-site dispatch) while that saves nodes
  const cands = [...base.stats.values()].filter(st => st.count >= 2 && st.shareable)
    .sort((a, b) => (b.count - 1) * b.size - (a.count - 1) * a.size);
  let best = base, set = new Set();
  for (const st of cands) {
    if ((st.count - 1) * st.size < 3) continue;
    let trial;
    try { trial = once(new Set([...set, st.key])); } catch (e) { continue; }
    if (size(trial) <= size(best) - 2) { set.add(st.key); best = trial; }
  }
  if (best !== base) {
    best.shared = best.sharedInfo.map(sh => ({ ...sh, saved: null }));
    const saved = size(base) - size(best);
    best.sharedSaved = saved;
  } else best.shared = [];
  best.inlinedSize = size(base);
  delete best.stats; delete best.sharedInfo; delete base.stats; delete base.sharedInfo;
  return best;
}

// All diagnostics of a source: { errors: [{msg, loc}], warnings: [{msg, loc}] }. One pass, no function sharing.
export function lint(source) {
  let ast;
  try { ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true }); }
  catch (e) {
    const loc = e.loc ? { line: e.loc.line, col: e.loc.column + 1, endLine: e.loc.line, endCol: e.loc.column + 2 } : null;
    return { errors: [{ msg: e.message.replace(/\s*\(\d+:\d+\)$/, ""), loc }], warnings: [] };
  }
  let errors = [], warnings = [];
  try { warnings = new Compiler({ collect: true, share: new Set() }).run(ast).warnings; }
  catch (e) {
    if (e instanceof CompileError) { errors = e.all || [{ msg: e.message, loc: e.loc }]; warnings = e.warnings || []; }
    else errors = [{ msg: "internal error: " + e.message, loc: null }];
  }
  // names in code the compiler never reaches (uncalled functions, dead branches) and unused variables
  const names = checkNames(ast);
  const key = d => `${d.msg}@${d.loc ? d.loc.line + ":" + d.loc.col : ""}`, seen = new Set(errors.concat(warnings).map(key));
  for (const d of names.errors) if (!seen.has(key(d))) { seen.add(key(d)); errors.push(d); }
  for (const d of names.warnings) if (!seen.has(key(d))) { seen.add(key(d)); warnings.push(d); }
  const pos = d => d.loc ? d.loc.line * 1e5 + d.loc.col : 0;
  return { errors: errors.sort((a, b) => pos(a) - pos(b)), warnings: warnings.sort((a, b) => pos(a) - pos(b)) };
}

// Scope walk over the whole AST: unknown names and variables that are never read.
const GLOBAL_NAMES = new Set([...OUTCOME_FUNS, ...ACTION_FUNS, ...SPECIAL_FUNS, ...Object.keys(ENUMS), ...BUILTIN_VARS,
  "Math", "console", "undefined", "NaN", "Infinity"]);
function checkNames(ast) {
  const errors = [], warnings = [], all = [];
  const scopes = [];
  const declare = (id, kind, node) => {
    if (!id || id.type !== "Identifier") return;
    const top = scopes[scopes.length - 1];
    if (top.has(id.name)) return;
    const b = { name: id.name, kind, node: node || id, reads: 0 };
    top.set(id.name, b); all.push(b);
  };
  const lookup = name => { for (let i = scopes.length - 1; i >= 0; i--) { const b = scopes[i].get(name); if (b) return b; } return null; };
  const isFn = n => n && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");
  // var and function declarations belong to the function scope, let / const to the block
  function hoistVars(n, fnScope) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(x => hoistVars(x, fnScope)); return; }
    if (n.type === "VariableDeclaration" && n.kind === "var") n.declarations.forEach(d => declare(d.id, "var", d));
    if (isFn(n)) return;
    for (const k in n) if (k !== "loc" && n[k] && typeof n[k] === "object") hoistVars(n[k], fnScope);
  }
  function hoistBlock(stmts) {
    for (const st of stmts) {
      if (st.type === "FunctionDeclaration") declare(st.id, "fn", st);
      else if (st.type === "VariableDeclaration" && st.kind !== "var") st.declarations.forEach(d => declare(d.id, st.kind, d));
    }
  }
  function ref(id, read, call) {
    if (GLOBAL_NAMES.has(id.name) && !lookup(id.name)) return;
    const b = lookup(id.name);
    if (b) { if (read) b.reads++; return; }
    errors.push({ msg: call ? `unknown function ${id.name}()` : `"${id.name}" is not defined`, loc: locOf(id) });
  }
  function fn(n) {
    scopes.push(new Map());
    for (const p of n.params) {
      if (p.type === "AssignmentPattern") { walk(p.right); declare(p.left, "param", p); } else declare(p, "param", p);
    }
    if (n.body.type === "BlockStatement") { hoistVars(n.body.body, true); hoistBlock(n.body.body); n.body.body.forEach(walk); }
    else walk(n.body);
    scopes.pop();
  }
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    switch (n.type) {
      case "Identifier": ref(n, true); return;
      case "FunctionDeclaration": fn(n); return;
      case "FunctionExpression": case "ArrowFunctionExpression": fn(n); return;
      case "BlockStatement": scopes.push(new Map()); hoistBlock(n.body); n.body.forEach(walk); scopes.pop(); return;
      case "ForStatement": case "ForOfStatement": case "ForInStatement":
        scopes.push(new Map());
        for (const k of ["init", "left"]) if (n[k] && n[k].type === "VariableDeclaration" && n[k].kind !== "var") n[k].declarations.forEach(d => declare(d.id, n[k].kind, d));
        if (n.type === "ForStatement") { walk(n.init); walk(n.test); walk(n.update); }
        else { if (n.left.type === "VariableDeclaration") n.left.declarations.forEach(d => { if (d.id.type === "Identifier") lookup(d.id.name).reads++; }); else walk(n.left); walk(n.right); }
        walk(n.body); scopes.pop(); return;
      case "VariableDeclaration": n.declarations.forEach(d => walk(d.init)); return;
      case "MemberExpression": walk(n.object); if (n.computed) walk(n.property); return;
      case "Property": if (n.computed) walk(n.key); walk(n.value); return;
      case "LabeledStatement": walk(n.body); return;
      case "BreakStatement": case "ContinueStatement": return;
      case "CallExpression":
        if (n.callee.type === "Identifier") ref(n.callee, true, true); else walk(n.callee);
        walk(n.arguments); return;
      case "AssignmentExpression":
        if (n.left.type === "Identifier") ref(n.left, n.operator !== "="); else walk(n.left);
        walk(n.right); return;
      case "UpdateExpression": if (n.argument.type === "Identifier") ref(n.argument, false); else walk(n.argument); return;
    }
    for (const k in n) if (k !== "loc" && k !== "type" && n[k] && typeof n[k] === "object") walk(n[k]);
  }
  scopes.push(new Map());
  hoistVars(ast.body, true); hoistBlock(ast.body); ast.body.forEach(walk);
  for (const b of all) if (b.reads === 0 && (b.kind === "let" || b.kind === "const" || b.kind === "var") && !b.name.startsWith("_"))
    warnings.push({ msg: `"${b.name}" is never used`, loc: locOf(b.node.id || b.node) });
  return { errors, warnings };
}

class Compiler {
  constructor(opts) {
    this.opts = opts;
    this.warnings = [];
    this.collect = !!opts.collect;   // record errors per statement and go on (diagnostics), instead of stopping at the first
    this.errors = [];
    this.programs = [];           // Builder[] in creation order, main first
    this.progFns = new Map();     // JS function name -> {node, name, params}
    this.tech = new Set();
    this.shareSet = opts.share instanceof Set ? opts.share : new Set();
    this.stats = new Map();       // function key -> {key, name, count, size, shareable, ctx: Set}
    this.sharedMode = 0;          // > 0 while compiling the body of a shared function
  }
  warn(msg, node) { this.warnings.push({ msg, loc: locOf(node) }); }

  run(ast) {
    const body = ast.body;
    let mainName = "Main";
    for (const st of body) {
      const d = directive(st);
      if (d == null) break;
      const m = d.match(/^use program\s+([\w-]+)/);
      if (m) mainName = m[1];
    }
    this.global = new Scope(null, null);
    this.queue = [];
    const main = this.newProgram(mainName, []);
    // hoist functions; "use program" functions become separate programs
    const guard = fn => { if (!this.collect) return fn(); try { fn(); } catch (e) { if (!(e instanceof CompileError)) { if (!this.errors.length) throw e; return; } this.record(e); } };
    for (const st of body) guard(() => this.hoist(st, this.global));
    guard(() => this.compileProgram(main, body, this.global, null));
    while (this.queue.length) {
      const job = this.queue.shift();
      guard(() => this.compileProgram(job.b, job.fn.body.body, new Scope(this.global, job), job));
    }
    if (this.errors.length) {
      const first = this.errors[0], err = new CompileError(first.msg, null);
      err.loc = first.loc; err.all = this.errors.map(({ msg, loc }) => ({ msg, loc })); err.warnings = this.warnings;
      throw err;
    }
    const programs = this.programs.map(b => finish(b, this));
    for (const p of programs) {
      if (p.nodes.length > NODE_LIMIT) this.warn(`${p.name}: ${p.nodes.length} nodes, over the game's ${NODE_LIMIT}-node limit`, null);
    }
    const sharedInfo = [];
    for (const b of this.programs) for (const sh of b.shared.values())
      sharedInfo.push({ program: b.name, name: sh.bind.name, calls: sh.sites.length, entry: sh.tag });
    return { programs, warnings: this.warnings, tech: [...this.tech], stats: this.stats, sharedInfo };
  }

  newProgram(name, params) {
    if (this.programs.some(p => p.name === name)) fail(`two programs named "${name}"`, null);
    const b = new Builder(name, params);
    this.programs.push(b);
    return b;
  }

  hoist(st, scope) {
    if (st.type === "FunctionDeclaration") {
      this.declareFn(st.id.name, st, scope, st);
    } else if (st.type === "VariableDeclaration" && st.kind === "const") {
      for (const d of st.declarations) {
        if (d.id.type === "Identifier" && d.init && (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression"))
          this.declareFn(d.id.name, d.init, scope, d);
      }
    }
  }
  declareFn(name, fn, scope, node) {
    if (fn.body.type !== "BlockStatement") fn = { ...fn, body: { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: fn.body, loc: fn.body.loc }], loc: fn.body.loc } };
    for (const p of fn.params) if (p.type !== "Identifier" && !(p.type === "AssignmentPattern" && p.left.type === "Identifier"))
      fail("function parameters must be plain names (defaults allowed)", p);
    const d = directive(fn.body.body[0]);
    const m = d != null && d.match(/^use program(?:\s+([\w-]+))?/);
    if (m) {
      if (scope !== this.global) fail('"use program" functions must be declared at the top level', node);
      const progName = m[1] || name;
      const params = fn.params.map(p => p.type === "Identifier" ? p.name : p.left.name);
      const b = this.newProgram(progName, params);
      const job = { b, fn, name: progName, params };
      this.queue.push(job);
      scope.map.set(name, { kind: "prog", job });
    } else {
      scope.map.set(name, { kind: "fn", fn, scope, name, noShare: d === "use inline" });
    }
  }

  compileProgram(b, stmts, scope, job) {
    this.b = b; this.scope = scope; this.loops = []; this.fnStack = []; this.inlining = [];
    this.ctx = { kind: "program", job };
    if (job) {
      // parameters arrive as the start node's variables
      for (const name of job.params) this.bindVar(scope, name, job.fn, true);
    }
    this.block(stmts);
    b.drop();
    // shared functions: each body once, after the program's own code; bodies may add calls to other shared functions
    for (let again = true; again;) {
      again = false;
      for (const sh of b.shared.values()) if (!sh.compiled) { this.compileShared(sh); again = true; }
    }
    for (const sh of b.shared.values()) this.sharedDispatch(sh);
  }

  // ------------------------------------------------------------ variables
  bindVar(scope, jsName, node, exact = false) {
    let name = jsName;
    if (!exact) {
      if (BUILTIN_VARS.includes(name)) { this.warn(`"${jsName}" is a built-in variable; the local is renamed`, node); name = jsName + "_";}
      let k = 2;
      const base = name;
      const taken = n => this.b.live.get(n) || BUILTIN_VARS.includes(n) || this.b.reserved.has(n) || (this.sharedMode && this.b.everNames.has(n));
      while (taken(name)) name = `${base}_${k++}`;
    }
    this.b.everNames.add(name);
    const bind = { kind: "var", name };
    scope.map.set(jsName, bind);
    this.b.live.set(name, (this.b.live.get(name) || 0) + 1);
    (scope.owned || (scope.owned = [])).push(name);
    return bind;
  }
  pushScope() { this.scope = new Scope(this.scope, this.scope.owner); }
  popScope() {
    for (const n of this.scope.owned || []) this.b.live.set(n, this.b.live.get(n) - 1);
    this.scope = this.scope.parent;
  }
  resolve(name, node) {
    const bnd = this.scope.lookup(name);
    if (bnd) return bnd;
    if (BUILTIN_VARS.includes(name)) return { kind: "builtin", name };
    if (ENUMS[name]) return { kind: "enum", name };
    if (name === "undefined") return { kind: "const", value: { k: "num", v: 0 } };
    fail(`"${name}" is not defined`, node);
  }
  setType(name, op) {
    const t = op.cell != null ? "cell" : op.num != null ? "num" : (this.b.types.get(op.var) || (op.var === "scan_cell_front" || op.var === "scan_cell_back" ? "cell" : "num"));
    const cur = this.b.types.get(name);
    const tt = typeof t === "object" ? "num" : t;
    this.b.types.set(name, cur && cur !== tt ? "any" : tt);
  }
  typeOf(op) {
    if (op.cell != null) return "cell";
    if (op.num != null) return "num";
    if (op.var === "scan_cell_front" || op.var === "scan_cell_back") return "cell";
    const t = this.b.types.get(op.var);
    return typeof t === "object" ? "num" : t || "num";
  }

  // ------------------------------------------------------------ constant evaluation (no side effects)
  constEval(e) {
    switch (e.type) {
      case "Literal":
        if (typeof e.value === "number") return { k: "num", v: e.value };
        if (typeof e.value === "boolean") return { k: "num", v: e.value ? 1 : 0 };
        if (typeof e.value === "string") return { k: "str", v: e.value };
        if (e.value === null) return { k: "num", v: 0 };
        return undefined;
      case "TemplateLiteral": return e.expressions.length === 0 ? { k: "str", v: e.quasis[0].value.cooked } : undefined;
      case "Identifier": {
        const b = this.scope.lookup(e.name);
        if (b && b.kind === "const") return b.value;
        if (!b && e.name === "undefined") return { k: "num", v: 0 };
        if (!b && e.name === "Infinity") return { k: "num", v: Infinity };
        return undefined;
      }
      case "MemberExpression": {
        if (!e.computed && e.object.type === "Identifier" && ENUMS[e.object.name] && !this.scope.lookup(e.object.name)) {
          const v = ENUMS[e.object.name][e.property.name];
          if (!v) fail(`${e.object.name}.${e.property.name} does not exist`, e.property);
          return v;
        }
        if (e.object.type === "Identifier" && e.object.name === "Math" && !e.computed && e.property.name === "PI") return { k: "num", v: Math.PI };
        const o = this.constEval(e.object);
        if (o && o.k === "arr") {
          if (!e.computed && e.property.name === "length") return { k: "num", v: o.v.length };
          if (e.computed) { const i = this.constEval(e.property); if (i && i.k === "num") return o.v[i.v] ?? { k: "num", v: 0 }; }
        }
        return undefined;
      }
      case "ArrayExpression": {
        const v = [];
        for (const el of e.elements) {
          if (!el) return undefined;
          if (el.type === "SpreadElement") { const s = this.constEval(el.argument); if (!s || s.k !== "arr") return undefined; v.push(...s.v); continue; }
          const c = this.constEval(el); if (!c) return undefined; v.push(c);
        }
        return { k: "arr", v };
      }
      case "UnaryExpression": {
        const a = this.constEval(e.argument); if (!a) return undefined;
        if (e.operator === "-" && a.k === "num") return { k: "num", v: -a.v };
        if (e.operator === "+" && a.k === "num") return a;
        if (e.operator === "!") return { k: "num", v: truthy(a) ? 0 : 1 };
        return undefined;
      }
      case "BinaryExpression": {
        const a = this.constEval(e.left), b = this.constEval(e.right);
        if (!a || !b) return undefined;
        if (a.k === "num" && b.k === "num") {
          const r = { "+": a.v + b.v, "-": a.v - b.v, "*": a.v * b.v, "/": a.v / b.v, "%": a.v % b.v, "**": a.v ** b.v,
            "<": +(a.v < b.v), "<=": +(a.v <= b.v), ">": +(a.v > b.v), ">=": +(a.v >= b.v),
            "==": +(a.v === b.v), "===": +(a.v === b.v), "!=": +(a.v !== b.v), "!==": +(a.v !== b.v) }[e.operator];
          return r === undefined ? undefined : { k: "num", v: r };
        }
        if (["==", "===", "!=", "!=="].includes(e.operator) && a.k !== "arr" && b.k !== "arr") {
          const eq = a.k === b.k && a.v === b.v;
          return { k: "num", v: +(e.operator.startsWith("!") ? !eq : eq) };
        }
        return undefined;
      }
      case "LogicalExpression": {
        const a = this.constEval(e.left); if (!a) return undefined;
        if (e.operator === "&&") return truthy(a) ? this.constEval(e.right) : a;
        if (e.operator === "||") return truthy(a) ? a : this.constEval(e.right);
        return undefined;
      }
      case "ConditionalExpression": {
        const t = this.constEval(e.test); if (!t) return undefined;
        return this.constEval(truthy(t) ? e.consequent : e.alternate);
      }
      case "CallExpression": {
        const m = mathName(e);
        if (m && ["abs", "min", "max", "floor", "ceil", "round", "trunc", "sign", "sqrt"].includes(m)) {
          const args = e.arguments.map(a => this.constEval(a));
          if (args.every(a => a && a.k === "num")) return { k: "num", v: Math[m](...args.map(a => a.v)) };
        }
        return undefined;
      }
      default: return undefined;
    }
  }
  constOf(e, what, kinds) {
    const c = this.constEval(e);
    if (!c) fail(`${what} must be a compile-time constant`, e);
    if (kinds && !kinds.includes(c.k)) fail(`${what}: expected ${kinds.join(" or ")}, got ${c.k}`, e);
    return c;
  }

  // ------------------------------------------------------------ statements
  block(stmts) { for (const s of stmts) this.stmt(s); }
  stmt(s) {
    const tempMark = this.b.temps;
    if (!this.collect) { try { this.stmtInner(s); } finally { this.b.temps = tempMark; } return; }
    // collecting diagnostics: a failed statement is recorded and skipped, the rest is still checked
    const saved = { scope: this.scope, loops: this.loops, nLoops: this.loops.length, ctx: this.ctx, inlining: this.inlining,
      nInlining: this.inlining.length, nFn: this.fnStack.length, sharedMode: this.sharedMode };
    try { this.stmtInner(s); }
    catch (e) { this.recover(e, saved, s); }
    finally { this.b.temps = tempMark; }
  }
  recover(e, saved, s) {
    if (!(e instanceof CompileError)) { if (!this.errors.length) throw e; return; }   // internal errors after a real one are noise
    this.record(e);
    let sc = this.scope; while (sc && sc !== saved.scope) sc = sc.parent;
    if (sc) while (this.scope !== saved.scope) this.popScope(); else this.scope = saved.scope;
    this.loops = saved.loops; this.loops.length = saved.nLoops;
    this.inlining = saved.inlining; this.inlining.length = saved.nInlining;
    this.fnStack.length = saved.nFn; this.ctx = saved.ctx; this.sharedMode = saved.sharedMode;
    this.b.pending = [];
    // names declared by a failed declaration still exist, so later uses don't report "not defined"
    if (s && s.type === "VariableDeclaration") for (const d of s.declarations)
      if (d.id.type === "Identifier" && !this.scope.map.has(d.id.name)) this.bindVar(this.scope, d.id.name, d, true);
  }
  record(e) {
    const key = e.message + "@" + (e.loc ? `${e.loc.line}:${e.loc.col}` : "");
    if (!this.errors.some(x => x.key === key)) this.errors.push({ key, msg: e.message, loc: e.loc });
  }
  stmtInner(s) {
    const b = this.b;
    switch (s.type) {
      case "EmptyStatement": case "FunctionDeclaration": return;
      case "ExpressionStatement":
        if (s.directive) return;
        return this.exprStmt(s.expression);
      case "BlockStatement": {
        this.pushScope();
        for (const st of s.body) this.hoist(st, this.scope);
        this.block(s.body);
        this.popScope();
        return;
      }
      case "VariableDeclaration": return this.varDecl(s);
      case "IfStatement": {
        const k = this.constEval(s.test);
        if (k) { const br = truthy(k) ? s.consequent : s.alternate; if (br) this.stmt(br); return; }
        const c = this.cond(s.test);
        b.pending = c.t; this.stmt(s.consequent);
        const after = b.pending;
        b.pending = c.f; if (s.alternate) this.stmt(s.alternate);
        b.pending = after.concat(b.pending);
        return;
      }
      case "WhileStatement": {
        { const k = this.constEval(s.test); if (k && !truthy(k)) return; }
        const head = new Label();
        b.place(head);
        const c = this.cond(s.test);
        b.pending = c.t;
        const loop = this.pushLoop(s, head);
        this.stmt(s.body);
        b.jump(head, s);
        this.loops.pop();
        b.pending = c.f.concat(loop.breaks);
        return;
      }
      case "DoWhileStatement": {
        const head = new Label(), cont = new Label();
        b.place(head);
        const loop = this.pushLoop(s, cont);
        this.stmt(s.body);
        this.loops.pop();
        b.place(cont);
        const c = this.cond(s.test);
        b.pending = c.t; b.jump(head, s);
        b.pending = c.f.concat(loop.breaks);
        return;
      }
      case "ForStatement": {
        this.pushScope();
        if (s.init) { if (s.init.type === "VariableDeclaration") this.varDecl(s.init); else this.exprStmt(s.init); }
        { const k = s.test && this.constEval(s.test); if (k && !truthy(k)) { this.popScope(); return; } }
        const head = new Label(), cont = new Label();
        b.place(head);
        const c = s.test ? this.cond(s.test) : { t: b.pending, f: [] };
        b.pending = c.t;
        const loop = this.pushLoop(s, s.update ? cont : head);
        this.stmt(s.body);
        this.loops.pop();
        if (s.update) { b.place(cont); this.exprStmt(s.update); }
        b.jump(head, s);
        b.pending = c.f.concat(loop.breaks);
        this.popScope();
        return;
      }
      case "ForOfStatement": return this.forOf(s);
      case "BreakStatement": {
        const loop = this.findLoop(s, false);
        loop.breaks.push(...b.pending); b.pending = [];
        return;
      }
      case "ContinueStatement": {
        const loop = this.findLoop(s, true);
        if (loop.cont instanceof Label) b.jump(loop.cont, s);
        else { loop.contRefs.push(...b.pending); b.pending = []; }
        return;
      }
      case "LabeledStatement": {
        this.nextLabel = s.label.name;
        if (!/^(While|DoWhile|For|ForOf)Statement$/.test(s.body.type)) {
          // labelled block: break label; jumps to its end
          const loop = this.pushLoop(s.body, null); loop.label = s.label.name; loop.blockOnly = true; this.nextLabel = null;
          this.stmt(s.body);
          this.loops.pop();
          b.pending = b.pending.concat(loop.breaks);
          return;
        }
        return this.stmt(s.body);
      }
      case "SwitchStatement": return this.switchStmt(s);
      case "ReturnStatement": return this.returnStmt(s);
      case "ThrowStatement": fail("throw is not supported; use exit(false) or halt()", s);
      default: fail(`${s.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} is not supported`, s);
    }
  }
  pushLoop(node, cont) {
    const loop = { node, cont, breaks: [], contRefs: [], label: this.nextLabel || null };
    this.nextLabel = null;
    this.loops.push(loop);
    return loop;
  }
  findLoop(s, isContinue) {
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const l = this.loops[i];
      if (s.label ? l.label === s.label.name : !l.blockOnly && !l.switch) {
        if (isContinue && (l.blockOnly || l.switch)) continue;
        return l;
      }
      if (!s.label && !isContinue && l.switch) return l;
    }
    fail(`${isContinue ? "continue" : "break"} outside of a loop${s.label ? ` labelled ${s.label.name}` : ""}`, s);
  }

  varDecl(s) {
    for (const d of s.declarations) {
      if (d.id.type !== "Identifier") fail("destructuring is not supported", d.id);
      const name = d.id.name;
      if (d.init && (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression")) {
        if (!this.scope.map.has(name)) this.declareFn(name, d.init, this.scope, d);
        continue;
      }
      if (s.kind === "const" && d.init) {
        const c = this.constEval(d.init);
        if (c) { this.scope.map.set(name, { kind: "const", value: c }); continue; }
      }
      const existing = this.scope.map.get(name);
      const bind = existing && existing.kind === "var" ? existing : this.bindVar(this.scope, name, d);
      if (d.init) this.assignTo(bind.name, d.init, d);
      else if (!existing) this.emitAssign(bind.name, { num: 0 }, d);   // JS: undefined (falsy) on every entry
    }
  }

  forOf(s) {
    const b = this.b;
    if (s.left.type !== "VariableDeclaration" || s.left.declarations[0].id.type !== "Identifier") fail("for…of needs `const name of [...]`", s.left);
    const arr = this.constEval(s.right);
    if (!arr || arr.k !== "arr") fail("for…of is unrolled at compile time: the array must be a constant", s.right);
    const name = s.left.declarations[0].id.name;
    const loop = this.pushLoop(s, null);
    for (const item of arr.v) {
      this.pushScope();
      this.scope.map.set(name, { kind: "const", value: item });
      loop.contRefs = [];
      this.stmt(s.body);
      b.pending = b.pending.concat(loop.contRefs);
      this.popScope();
    }
    this.loops.pop();
    b.pending = b.pending.concat(loop.breaks);
  }

  switchStmt(s) {
    const b = this.b;
    const cases = s.cases;
    const kd = this.constEval(s.discriminant);
    if (kd) return this.switchConst(s, kd);
    const caseRefs = cases.map(() => []);
    let rest;
    const outcome = this.outcomeSource(s.discriminant);
    if (outcome) {
      // switch on an outcome: route the node's outputs straight to the cases
      const { id, t, viaVar } = outcome;
      const keys = T[t].outs.map(o => normKey(o[0]));
      const labels = T[t].outs.map(o => normKey(o[1]));
      if (viaVar) {
        // stored outcome: compare the stored output index
        return this.switchOnValue(s, { var: viaVar }, c => {
          const k = this.constOf(c, "case", ["str"]).v;
          const i = keys.indexOf(normKey(k)) >= 0 ? keys.indexOf(normKey(k)) : labels.indexOf(normKey(k));
          if (i < 0) fail(`"${k}" is not an outcome of ${T[t].label} (${T[t].outs.map(o => o[0]).join(", ")})`, c);
          return { num: i };
        });
      }
      const used = new Set();
      cases.forEach((c, k) => {
        if (!c.test) return;
        const key = this.constOf(c.test, "case", ["str"]).v;
        let i = keys.indexOf(normKey(key)); if (i < 0) i = labels.indexOf(normKey(key));
        if (i < 0) fail(`"${key}" is not an outcome of ${T[t].label} (${T[t].outs.map(o => o[0]).join(", ")})`, c.test);
        used.add(i); caseRefs[k].push(new Hole(b, id, i));
      });
      rest = T[t].outs.map((_, i) => i).filter(i => !used.has(i) && !(ERROR_OUTS[t] || []).includes(i)).map(i => new Hole(b, id, i));
      b.pending = [];
      return this.switchBodies(s, caseRefs, rest);
    }
    return this.switchOnValue(s, this.value(s.discriminant), c => {
      const v = this.constEval(c);
      if (v) return constOperand(v, c);
      return this.value(c);
    });
  }
  switchConst(s, kd) {
    const b = this.b, cases = s.cases;
    let start = cases.findIndex(c => {
      if (!c.test) return false;
      const v = this.constEval(c.test);
      if (!v) fail("a switch on a constant needs constant cases", c.test);
      return v.k === kd.k && v.v === kd.v;
    });
    if (start < 0) start = cases.findIndex(c => !c.test);
    if (start < 0) return;
    const loop = { node: s, breaks: [], contRefs: [], label: this.nextLabel || null, switch: true };
    this.nextLabel = null;
    this.loops.push(loop);
    this.pushScope();
    for (let k = start; k < cases.length; k++) {
      this.block(cases[k].consequent);
      if (!b.pending.length) break;     // break (or halt): the later cases are not reached
    }
    this.popScope();
    this.loops.pop();
    b.pending = b.pending.concat(loop.breaks);
  }
  switchOnValue(s, val, caseOperand) {
    const b = this.b;
    const cases = s.cases, caseRefs = cases.map(() => []);
    // consecutive empty cases share one EQ node
    let k = 0;
    while (k < cases.length) {
      if (!cases[k].test) { k++; continue; }
      const group = [k];
      while (cases[group[group.length - 1]].consequent.length === 0 && group[group.length - 1] + 1 < cases.length && cases[group[group.length - 1] + 1].test) group.push(group[group.length - 1] + 1);
      const set = group.map(i => caseOperand(cases[i].test));
      const id = b.emit("eq", { value: val, set }, cases[group[0]]);
      this.tech.add("Variables");
      caseRefs[group[group.length - 1]].push(new Hole(b, id, 0));
      b.pending = [new Hole(b, id, 1)];
      k = group[group.length - 1] + 1;
    }
    const rest = b.pending; b.pending = [];
    return this.switchBodies(s, caseRefs, rest);
  }
  switchBodies(s, caseRefs, rest) {
    const b = this.b;
    const loop = { node: s, breaks: [], contRefs: [], label: this.nextLabel || null, switch: true };
    this.nextLabel = null;
    this.loops.push(loop);
    this.pushScope();
    let fall = [];
    const def = s.cases.findIndex(c => !c.test);
    s.cases.forEach((c, k) => {
      b.pending = fall.concat(caseRefs[k], k === def ? rest : []);
      this.block(c.consequent);
      fall = b.pending;
    });
    this.popScope();
    this.loops.pop();
    b.pending = fall.concat(loop.breaks, def < 0 ? rest : []);
  }

  returnStmt(s) {
    const b = this.b;
    const ctx = this.ctx;
    if (ctx.kind === "program") {
      // return in a program = EXIT (SUCCESS unless the value is falsy)
      if (!s.argument) { this.exitNode(false, s); return; }
      const k = this.constEval(s.argument);
      if (k && !(k.k === "num" && (k.v === 0 || k.v === 1) && s.argument.type === "Literal" && typeof s.argument.value === "boolean"))
        fail("a program can't return a value: return true / false (EXIT SUCCESS / FAIL), or a condition", s.argument);
      if (!k && !isCondExpr(s.argument) && !["CallExpression", "Identifier"].includes(s.argument.type))
        fail("a program can't return a value: return true / false (EXIT SUCCESS / FAIL), or a condition", s.argument);
      const c = this.cond(s.argument);
      b.pending = c.t; this.exitNode(false, s);
      b.pending = c.f; this.exitNode(true, s);
      return;
    }
    if (ctx.kind === "stmt") {
      if (s.argument) this.exprStmt(s.argument);
      ctx.exits.push(...b.pending); b.pending = [];
    } else if (ctx.kind === "value") {
      if (s.argument) this.assignTo(ctx.ret, s.argument, s);
      else { b.emit("assign", { varname: ctx.ret, value: { num: 0 } }, s); this.tech.add("Variables"); b.pending = [new Hole(b, b.nodes.length - 1, 0)]; }
      ctx.exits.push(...b.pending); b.pending = [];
    } else if (ctx.kind === "cond") {
      if (!s.argument) { ctx.f.push(...b.pending); b.pending = []; return; }
      const c = this.cond(s.argument);
      ctx.t.push(...c.t); ctx.f.push(...c.f); b.pending = [];
    }
  }
  exitNode(asFail, node) {
    if (!this.b.pending.length) return;
    this.b.emit("exit", { fail: asFail }, node);
    this.tech.add("Subroutines");
  }

  // ------------------------------------------------------------ expression statements
  exprStmt(e) {
    const b = this.b;
    switch (e.type) {
      case "AssignmentExpression": this.assignment(e); return;
      case "UpdateExpression": this.update(e); return;
      case "SequenceExpression": for (const x of e.expressions) this.exprStmt(x); return;
      case "CallExpression": return this.callStmt(e);
      case "Literal": case "Identifier": return;
      case "LogicalExpression": case "ConditionalExpression": {
        // a && b(); used as a statement
        const test = e.type === "LogicalExpression" ? e.left : e.test;
        const k = this.constEval(test);
        if (k) {
          if (e.type === "ConditionalExpression") return this.exprStmt(truthy(k) ? e.consequent : e.alternate);
          if ((e.operator === "&&") === truthy(k)) return this.exprStmt(e.right);
          return;
        }
        const c = this.cond(test);
        if (e.type === "LogicalExpression") {
          b.pending = e.operator === "&&" ? c.t : c.f; this.exprStmt(e.right);
          b.pending = b.pending.concat(e.operator === "&&" ? c.f : c.t);
        } else {
          b.pending = c.t; this.exprStmt(e.consequent); const a = b.pending;
          b.pending = c.f; this.exprStmt(e.alternate); b.pending = a.concat(b.pending);
        }
        return;
      }
      case "UnaryExpression": if (e.operator === "void") return this.exprStmt(e.argument);
      // fallthrough
      default: fail(`this expression does nothing as a statement`, e);
    }
  }
  callStmt(e) {
    const b = this.b;
    const name = calleeName(e);
    const bind = name && !e.callee.object ? this.scope.lookup(name) : null;
    if (bind && bind.kind === "fn") { this.inline(bind, e, { kind: "stmt", exits: [] }); return; }
    if (bind && bind.kind === "prog") { const id = this.callProgram(bind.job.name, bind.job.params.length, e.arguments, e); b.pending = b.holes(id, [0, 1]); return; }
    if (name === "log" || (e.callee.type === "MemberExpression" && e.callee.object.name === "console")) { this.warn("log() has no node; ignored", e); return; }
    if (!bind) checkArity(name, e);
    if (name === "halt" && !bind) { b.drop(); return; }
    if ((name === "exit" || name === "fail") && !bind) {
      let asFail = name === "fail";
      if (name === "exit" && e.arguments.length) {
        const c = this.constEval(e.arguments[0]);
        if (c) asFail = !truthy(c);
        else { const cc = this.cond(e.arguments[0]); b.pending = cc.t; this.exitNode(false, e); b.pending = cc.f; this.exitNode(true, e); return; }
      }
      this.exitNode(asFail, e); b.pending = []; return;
    }
    if (ACTION_FUNS.has(name) && !bind) { this.action(name, e); return; }
    if (OUTCOME_FUNS.has(name) && !bind) {
      const { id, t } = this.outcomeNode(name, e);
      b.pending = b.holes(id, b.outsExcept(id, t, ERROR_OUTS[t] || []));
      return;
    }
    if ((name === "anyOf" || name === "inCategory") && !bind) {
      const c = this.cond(e); b.pending = c.t.concat(c.f); return;
    }
    if (mathName(e)) { this.warn("result unused", e); return; }
    fail(`unknown function ${name || "call"}()`, e.callee);
  }

  // ------------------------------------------------------------ builtin nodes
  action(name, e) {
    checkArity(name, e);
    const b = this.b, args = e.arguments;
    // f(c ? x : y) with constant x, y: branch on c, one fixed node per side
    const tern = args.findIndex(a => a.type === "ConditionalExpression" && !this.constEval(a));
    if (tern >= 0) {
      const c = this.cond(args[tern].test);
      const withArg = alt => ({ ...e, arguments: args.map((a, k) => k === tern ? alt : a) });
      b.pending = c.t; this.action(name, withArg(args[tern].consequent)); const x = b.pending;
      b.pending = c.f; this.action(name, withArg(args[tern].alternate));
      b.pending = x.concat(b.pending);
      return;
    }
    const one = (t, p) => { const id = b.emit(t, p, e); b.pending = [new Hole(b, id, 0)]; };
    switch (name) {
      case "pass": return one("pass", {});
      case "turnLeft": case "turnRight": case "turnAround": return one("rotR", { dir: ROT_NAMES[name] });
      case "turn": {
        const c = this.constEval(args[0] || {});
        if (!c) return this.dispatch(this.value(args[0]), [-135, -90, -45, 45, 90, 135, 180], d => one("rotR", { dir: d === 180 ? 4 : d / 45 }), e);
        if (c.k !== "num") fail("turn(degrees) needs a number", args[0]);
        let deg = ((c.v % 360) + 540) % 360 - 180;    // -180..180
        if (deg === -180) deg = 180;
        if (deg === 0) { this.warn("turn(0) does nothing", e); return; }
        if (deg % 45) fail("turn() takes multiples of 45 degrees", args[0]);
        return one("rotR", { dir: deg === 180 ? 4 : deg / 45 });
      }
      case "rotateTo": {
        const c = this.constEval(args[0] || {});
        if (!c) return this.dispatch(this.value(args[0]), [0, 1, 2, 3, 4, 5, 6, 7], d => one("rotA", { dir: d }), e);
        if (c.k !== "num" || !Number.isInteger(c.v)) fail("rotateTo() takes a direction: Dir.E, Dir.SE, … or 0..7", args[0]);
        return one("rotA", { dir: ((c.v % 8) + 8) % 8 });
      }
      case "aim": case "aimAt": {
        if (args.length !== 2) fail(`${name}() takes two arguments`, e);
        const rel = name === "aim";
        const [a, bArg] = args.map(x => this.constEval(x));
        const fits = c => c && c.k === "num" && Number.isInteger(c.v) && c.v >= -3 && c.v <= 3;
        // aim(front, right) / aimAt(dx, dy); node fields are frontNotY, rightNotX
        const front = rel ? a : bArg, right = rel ? bArg : a;
        const frontE = rel ? args[0] : args[1], rightE = rel ? args[1] : args[0];
        const p = { front: fits(front) ? front.v : 0, right: fits(right) ? right.v : 0 };
        one(rel ? "aimR" : "aimA", p);
        // the rest goes through the aim variables
        const vars = rel ? ["aim_front", "aim_right"] : ["aim_y", "aim_x"];
        if (!fits(front)) this.assignTo(vars[0], frontE, e, true);
        if (!fits(right)) this.assignTo(vars[1], rightE, e, true);
        if (rel && (!fits(front) || !fits(right))) this.warn("writing aim_front / aim_right is not verified in the game; aimAt() with aim_x / aim_y is", e);
        return;
      }
    }
  }
  // value -> one of several constant-parameter nodes, via a chain of EQ nodes
  dispatch(val, choices, emitOne, e) {
    const b = this.b;
    if (val.num != null) fail("internal: dispatch on a constant", e);
    const ends = [];
    choices.forEach((ch, k) => {
      if (k < choices.length - 1) {
        const id = b.emit("eq", { value: val, set: [{ num: ch }] }, e);
        this.tech.add("Variables");
        b.pending = [new Hole(b, id, 0)];
        emitOne(ch); ends.push(...b.pending);
        b.pending = [new Hole(b, id, 1)];
      } else { emitOne(ch); ends.push(...b.pending); }
    });
    b.pending = ends;
    this.warn(`a variable argument becomes ${choices.length - 1} EQ nodes + ${choices.length} fixed nodes`, e);
  }

  outcomeNode(name, e) {
    checkArity(name, e);
    const b = this.b, args = e.arguments;
    const emit = (t, p) => { const id = b.emit(t, p, e); if (T[t].tech) this.tech.add(T[t].tech); return { id, t }; };
    switch (name) {
      case "step": case "move": return emit("move", {});
      case "dig": return emit("dig", {});
      case "moveDig": return emit("movedig", {});
      case "autoCargo": return emit("cargo", {});
      case "scan": return emit("scan", { category: this.constOf(args[0] || e, "scan() category", ["cat"]).v });
      case "use": case "useItem": return emit("use", { item: this.constOf(args[0] || e, "use() item", ["item"]).v });
      case "unload": case "load": {
        const tg = args[0] ? this.constOf(args[0], `${name}() target`, ["target"]).v : "Storage";
        return emit("inv", { target: tg, positive: name === "unload" });
      }
      case "inventory": {
        const tg = this.constOf(args[0] || e, "inventory() target", ["target"]).v;
        const pos = args[1] ? truthy(this.constOf(args[1], "inventory() direction")) : true;
        return emit("inv", { target: tg, positive: pos });
      }
      case "call": {
        const prog = this.constOf(args[0] || e, "call() program name", ["str"]).v;
        const local = [...this.global.map.values()].find(v => v.kind === "prog" && v.job.name === prog);
        const id = this.callProgram(prog, local ? local.job.params.length : null, args.slice(1), e);
        return { id, t: "call" };
      }
    }
    fail(`unknown function ${name}()`, e);
  }
  callProgram(name, nParams, argNodes, e) {
    if (nParams != null && argNodes.length > nParams) this.warn(`${name} takes ${nParams} parameter(s)`, e);
    const args = argNodes.map(a => this.value(a));
    const id = this.b.emit("call", { program: name, args }, e);
    this.tech.add("Subroutines");
    return id;
  }
  // an expression whose outputs can be routed: an outcome call or a stored outcome variable
  outcomeSource(e) {
    if (e.type === "CallExpression") {
      const name = calleeName(e);
      const bind = name && !e.callee.object ? this.scope.lookup(name) : null;
      if (bind && bind.kind === "prog") return { id: this.callProgram(bind.job.name, bind.job.params.length, e.arguments, e), t: "call" };
      if (!bind && OUTCOME_FUNS.has(name)) return this.outcomeNode(name, e);
      return null;
    }
    if (e.type === "Identifier") {
      const bind = this.scope.lookup(e.name);
      if (bind && bind.kind === "var") { const t = this.b.types.get(bind.name); if (t && typeof t === "object") return { t: t.outcome, viaVar: bind.name }; }
    }
    return null;
  }

  // ------------------------------------------------------------ user functions (inlined)
  inline(bind, e, ctx) {
    const b = this.b;
    if (this.inlining.includes(bind)) fail(`${bind.name}() is recursive; inlined functions can't recurse (mark it "use program" to make it a CALL)`, e);
    const fn = bind.fn;
    if (e.arguments.length > fn.params.length) this.warn(`${bind.name}() takes ${plural(fn.params.length, "parameter")}; the rest are ignored`, e.arguments[fn.params.length]);
    // functions are keyed by their source position plus the constant arguments, so constants stay specialised
    const { key, sig, shareable } = this.callKey(bind, e);
    let st = this.stats.get(key);
    if (!st) { st = { key, name: bind.name, count: 0, size: 0, shareable, ctx: new Set() }; this.stats.set(key, st); }
    st.count++; st.ctx.add(ctx.kind);
    if (this.shareSet.has(key) && shareable && this.sharedCall(bind, e, ctx, key, sig)) return;
    const before = b.nodes.length;
    try { return this.inlineBody(bind, e, ctx); } finally { st.size = Math.max(st.size, b.nodes.length - before); }
  }
  callKey(bind, e) {
    const fn = bind.fn, assigned = assignedNames(fn.body);
    let shareable = !bind.noShare;
    const sig = fn.params.map((p, i) => {
      const pname = p.type === "Identifier" ? p.name : p.left.name;
      const a = e.arguments[i] || (p.type === "AssignmentPattern" ? p.right : null);
      if (!a) return { k: "num", v: 0 };
      if (a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression") { shareable = false; return "fn"; }
      if (a.type === "Identifier") { const ab = this.scope.lookup(a.name); if (ab && (ab.kind === "fn" || ab.kind === "prog")) { shareable = false; return "fn"; } }
      const c = this.constEval(a);
      return c && !assigned.has(pname) ? c : "*";
    });
    return { key: `${this.b.name}|${fn.start}:${fn.end}|${JSON.stringify(sig)}`, sig, shareable };
  }

  // ------------------------------------------------------------ shared functions (compiled once, called through a dispatch)
  // A call copies the non-constant arguments into the function's own variables, writes its site number into
  // <fn>_ret and jumps to the body. The body's exits come back through a COMP tree on <fn>_ret. Conditions return
  // through separate true / false trees; values through <fn>_rv.
  sharedCall(bind, e, ctx, key, sig) {
    const b = this.b;
    let sh = b.shared.get(key);
    if (!sh) {
      const st = this.stats.get(key);
      const mode = st.ctx.has("value") ? "value" : st.ctx.has("cond") ? "cond" : "stmt";
      const n = [...b.shared.values()].filter(x => x.bind.name === bind.name).length;
      const tag = this.freeName(bind.name + (n ? n + 1 : ""));
      sh = { key, bind, sig, mode, tag, sites: [], entry: new Label(), compiled: false,
        ret: this.reserve(`${tag}_ret`), rv: mode === "value" ? this.reserve(`${tag}_rv`) : null,
        params: bind.fn.params.map((p, i) => sig[i] === "*" ? this.reserve(`${tag}_${p.type === "Identifier" ? p.name : p.left.name}`) : null) };
      b.shared.set(key, sh);
    }
    if (ctx.kind === "value" && sh.mode !== "value") return false;   // not expected from the counting run: inline it
    if (ctx.kind === "cond" && sh.mode === "stmt") return false;
    if (this.inlining.includes(bind)) fail(`${bind.name}() is recursive`, e);
    // arguments first (they may call the function themselves), then the parameter copies
    const fn = bind.fn;
    const ops = fn.params.map((p, i) => sh.params[i] ? this.value(e.arguments[i] || p.right) : null);
    ops.forEach((op, i) => { if (op) this.emitAssign(sh.params[i], op, e); });
    const id = sh.sites.length;
    this.emitAssign(sh.ret, { num: id }, e);
    b.jump(sh.entry, e);
    if (ctx.kind === "cond" && sh.mode === "cond") {
      const tL = new Label(), fL = new Label();
      sh.sites.push({ tL, fL });
      ctx.t.push(tL); ctx.f.push(fL); b.pending = [];
      return true;
    }
    const L = new Label();
    sh.sites.push({ L });
    b.pending = [L];
    if (ctx.kind === "value") this.emitAssign(ctx.ret, { var: sh.rv }, e);
    else if (ctx.kind === "cond") {   // value-returning function used as a condition
      const q = b.emit("eq", { value: { var: sh.rv }, set: [{ num: 0 }] }, e); this.tech.add("Variables");
      ctx.t.push(...b.holes(q, [1])); ctx.f.push(...b.holes(q, [0])); b.pending = [];
    }
    return true;
  }
  reserve(name) { const n = this.freeName(name); this.b.reserved.add(n); this.b.everNames.add(n); return n; }
  freeName(base) {
    let name = base, k = 2;
    while (this.b.everNames.has(name) || this.b.reserved.has(name) || BUILTIN_VARS.includes(name)) name = `${base}_${k++}`;
    return name;
  }
  compileShared(sh) {
    const b = this.b, fn = sh.bind.fn;
    sh.compiled = true;
    b.pending = [];
    b.place(sh.entry);
    const saved = { scope: this.scope, loops: this.loops, ctx: this.ctx, inlining: this.inlining, prefix: b.tempPrefix, temps: b.temps };
    const scope = new Scope(sh.bind.scope, null);
    fn.params.forEach((p, i) => {
      const pname = p.type === "Identifier" ? p.name : p.left.name;
      scope.map.set(pname, sh.params[i] ? { kind: "var", name: sh.params[i] } : { kind: "const", value: sh.sig[i] });
    });
    const ctx = sh.mode === "cond" ? { kind: "cond", t: [], f: [] } : { kind: sh.mode, exits: [], ret: sh.rv };
    this.scope = scope; this.loops = []; this.ctx = ctx; this.inlining = [sh.bind];
    b.tempPrefix = `_${sh.tag}_t`; b.temps = 0;
    this.sharedMode++;
    try {
      for (const st of fn.body.body) this.hoist(st, scope);
      this.block(fn.body.body);
    } finally {
      this.sharedMode--;
      this.scope = saved.scope; this.loops = saved.loops; this.ctx = saved.ctx; this.inlining = saved.inlining;
      b.tempPrefix = saved.prefix; b.temps = saved.temps;
    }
    if (ctx.kind === "cond") { sh.exitT = ctx.t; sh.exitF = ctx.f.concat(b.pending); }
    else sh.exits = ctx.exits.concat(b.pending);
    b.pending = [];
  }
  sharedDispatch(sh) {
    const b = this.b, loc = sh.bind.fn;
    const tree = (refs, targets) => {
      if (!refs.length || !targets.length) { for (const r of refs) r.patch(null); return; }
      const go = (lo, hi, refsIn) => {
        b.pending = refsIn;
        if (lo === hi) { b.jump(targets[lo], loc); return; }
        const mid = (lo + hi) >> 1;
        const id = b.emit("cmp", { left: { var: sh.ret }, right: { num: mid } }, loc); this.tech.add("Variables");
        b.pending = b.holes(id, [1]); b.jump(targets[mid], loc);
        if (lo <= mid - 1) go(lo, mid - 1, b.holes(id, [2]));
        if (mid + 1 <= hi) go(mid + 1, hi, b.holes(id, [0]));
      };
      go(0, targets.length - 1, refs);
      b.pending = [];
    };
    if (sh.mode === "cond") {
      tree(sh.exitT, sh.sites.map(s => s.tL || s.L));
      tree(sh.exitF, sh.sites.map(s => s.fL || s.L));
    } else tree(sh.exits, sh.sites.map(s => s.L));
  }
  inlineBody(bind, e, ctx) {
    const b = this.b;
    const fn = bind.fn;
    // bind parameters: constants stay constants, the rest are copied into variables
    const scope = new Scope(bind.scope, ctx);
    const assigned = assignedNames(fn.body);
    const argVals = fn.params.map((p, i) => {
      const a = e.arguments[i] || (p.type === "AssignmentPattern" ? p.right : null);
      return a;
    });
    const saved = { scope: this.scope, loops: this.loops, ctx: this.ctx };
    const pendingBinds = [];
    fn.params.forEach((p, i) => {
      const pname = p.type === "Identifier" ? p.name : p.left.name;
      const a = argVals[i];
      if (!a) { scope.map.set(pname, { kind: "const", value: { k: "num", v: 0 } }); return; }
      const c = this.constEval(a);
      if (c && !assigned.has(pname)) { scope.map.set(pname, { kind: "const", value: c }); return; }
      if (a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression") { this.declareFn(pname, a, scope, a); return; }
      if (a.type === "Identifier") {
        const ab = this.scope.lookup(a.name);
        if (ab && (ab.kind === "fn" || ab.kind === "prog" || ab.kind === "const")) { scope.map.set(pname, ab); return; }
        // a plain variable can be shared (no copy) only if the call can't change it: the parameter is never assigned,
        // the body assigns no outer variable and calls no user function. System variables always get a copy
        // (x, y, dir, rnd, scan_* change as the program runs).
        if (ab && ab.kind === "var" && !assigned.has(pname) && !assignsOuter(fn.body) && !callsUserFn(fn.body)) { scope.map.set(pname, ab); return; }
      }
      pendingBinds.push([pname, a]);
    });
    // evaluate copied arguments in the caller's scope, then bind them in the callee's
    const copies = pendingBinds.map(([pname, a]) => [pname, this.value(a), a]);
    this.scope = scope; this.loops = []; this.ctx = ctx;
    this.inlining.push(bind);
    try {
      for (const [pname, op, a] of copies) {
        const vb = this.bindVar(scope, pname, a);
        this.emitAssign(vb.name, op, a);
      }
      for (const st of fn.body.body) this.hoist(st, scope);
      this.block(fn.body.body);
      for (const n of scope.owned || []) b.live.set(n, b.live.get(n) - 1);
    } finally {
      this.inlining.pop();
      this.scope = saved.scope; this.loops = saved.loops; this.ctx = saved.ctx;
    }
    if (ctx.kind === "stmt" || ctx.kind === "value") b.pending = b.pending.concat(ctx.exits);
    else if (ctx.kind === "cond") { ctx.f.push(...b.pending); b.pending = []; }
  }

  // ------------------------------------------------------------ assignments
  assignment(e) {
    if (e.left.type !== "Identifier") fail("only plain variables can be assigned", e.left);
    const target = this.lvalue(e.left);
    if (e.operator === "=") return this.assignTo(target, e.right, e);
    const op = { "+=": "Plus", "-=": "Minus", "*=": "Mult", "/=": "Div", "%=": "Mod" }[e.operator];
    if (!op) fail(`operator ${e.operator} is not supported`, e);
    const r = this.value(e.right);
    this.emitOper(target, op, { var: target }, r, e);
  }
  update(e) {
    if (e.argument.type !== "Identifier") fail("only plain variables can be incremented", e.argument);
    const target = this.lvalue(e.argument);
    this.emitOper(target, e.operator === "++" ? "Plus" : "Minus", { var: target }, { num: 1 }, e);
  }
  lvalue(id) {
    const bind = this.resolve(id.name, id);
    if (bind.kind === "var") return bind.name;
    if (bind.kind === "builtin") {
      if (!WRITABLE_BUILTINS.includes(bind.name)) fail(`${bind.name} is read-only`, id);
      return bind.name;
    }
    if (bind.kind === "const") fail(`${id.name} is a constant`, id);
    fail(`${id.name} can't be assigned`, id);
  }
  // target = expression; arithmetic goes straight into the target
  assignTo(target, e, node, allowBuiltin) {
    const c = this.constEval(e);
    if (c) { this.emitAssign(target, constOperand(c, e), node); return; }
    if (e.type === "BinaryExpression" && ARITH[e.operator]) {
      const l = this.value(e.left), r = this.value(e.right);
      this.emitOper(target, ARITH[e.operator], l, r, node);
      return;
    }
    if (e.type === "UnaryExpression" && e.operator === "-") {
      this.emitOper(target, "Minus", { num: 0 }, this.value(e.argument), node); return;
    }
    const src = this.outcomeSource(e);
    if (src && !src.viaVar) { this.storeOutcome(target, src, node); return; }
    if (e.type === "ConditionalExpression") { this.ternaryInto(target, e); return; }
    if (isCondExpr(e)) { this.condInto(target, e); return; }
    const op = this.value(e);
    if (op.var === target) return;
    this.emitAssign(target, op, node);
  }
  emitAssign(target, op, node) {
    const b = this.b;
    const id = b.emit("assign", { varname: target, value: op }, node);
    this.tech.add("Variables");
    this.setType(target, op);
    b.pending = [new Hole(b, id, 0)];
  }
  emitOper(target, op, l, r, node) {
    const b = this.b;
    if (this.typeOf(l) === "cell" || this.typeOf(r) === "cell") fail("arithmetic on a cell value", node);
    if (l.num != null && r.num != null) { this.emitAssign(target, { num: foldOp(op, l.num, r.num) }, node); return; }
    const id = b.emit("oper", { varname: target, op, left: l, right: r }, node);
    this.tech.add("Variables");
    b.types.set(target, "num");
    b.pending = [new Hole(b, id, 0)];
  }
  // outcome call stored in a variable: each output writes its index
  storeOutcome(target, src, node) {
    const b = this.b;
    const { id, t } = src;
    const ends = [];
    T[t].outs.forEach((o, i) => {
      if ((ERROR_OUTS[t] || []).includes(i)) return;
      b.pending = [new Hole(b, id, i)];
      const a = b.emit("assign", { varname: target, value: { num: i } }, node);
      ends.push(new Hole(b, a, 0));
    });
    this.tech.add("Variables");
    b.types.set(target, { outcome: t });
    b.pending = ends;
  }
  ternaryInto(target, e) {
    const b = this.b;
    const k = this.constEval(e.test);
    if (k) { this.assignTo(target, truthy(k) ? e.consequent : e.alternate, e); return; }
    const c = this.cond(e.test);
    b.pending = c.t; this.assignTo(target, e.consequent, e.consequent); const a = b.pending;
    b.pending = c.f; this.assignTo(target, e.alternate, e.alternate);
    b.pending = a.concat(b.pending);
  }
  condInto(target, e) {
    const b = this.b;
    const c = this.cond(e);
    b.pending = c.t; this.emitAssign(target, { num: 1 }, e); const a = b.pending;
    b.pending = c.f; this.emitAssign(target, { num: 0 }, e);
    b.pending = a.concat(b.pending);
  }

  // ------------------------------------------------------------ values: expression -> operand
  value(e) {
    const c = this.constEval(e);
    if (c) return constOperand(c, e);
    switch (e.type) {
      case "Identifier": {
        const bind = this.resolve(e.name, e);
        if (bind.kind === "var" || bind.kind === "builtin") return { var: bind.name };
        if (bind.kind === "enum") fail(`${e.name} is an enum; use ${e.name}.Something`, e);
        fail(`${e.name} is a function, not a value`, e);
      }
      case "BinaryExpression":
        if (ARITH[e.operator]) {
          const l = this.value(e.left), r = this.value(e.right);
          const t = this.b.temp();
          this.emitOper(t, ARITH[e.operator], l, r, e);
          return { var: t };
        }
        break;
      case "UnaryExpression":
        if (e.operator === "-") { const t = this.b.temp(); this.emitOper(t, "Minus", { num: 0 }, this.value(e.argument), e); return { var: t }; }
        if (e.operator === "+") return this.value(e.argument);
        break;
      case "AssignmentExpression": this.assignment(e); return { var: this.lvalue(e.left) };
      case "SequenceExpression": e.expressions.slice(0, -1).forEach(x => this.exprStmt(x)); return this.value(e.expressions[e.expressions.length - 1]);
      case "ConditionalExpression": { const t = this.b.temp(); this.ternaryInto(t, e); return { var: t }; }
      case "CallExpression": {
        const m = mathName(e);
        if (m) return this.mathCall(m, e);
        const name = calleeName(e);
        const bind = name && !e.callee.object ? this.scope.lookup(name) : null;
        if (bind && bind.kind === "fn") {
          const t = this.b.temp();
          this.inline(bind, e, { kind: "value", exits: [], ret: t });
          return { var: t };
        }
        const src = this.outcomeSource(e);
        if (src) { const t = this.b.temp(); this.storeOutcome(t, src, e); return { var: t }; }
        break;
      }
    }
    if (isCondExpr(e)) { const t = this.b.temp(); this.condInto(t, e); return { var: t }; }
    fail(`can't compute this expression in the game (${e.type})`, e);
  }
  mathCall(m, e) {
    const args = e.arguments;
    const t = this.b.temp();
    const b = this.b;
    const pick = (cmpL, cmpR, wantGreater, a, bb) => {
      // t = (a > b) == wantGreater ? a : b
      const id = b.emit("cmp", { left: cmpL, right: cmpR }, e); this.tech.add("Variables");
      b.pending = b.holes(id, wantGreater ? [0] : [2]); this.emitAssign(t, a, e); const x = b.pending;
      b.pending = b.holes(id, wantGreater ? [1, 2] : [0, 1]); this.emitAssign(t, bb, e);
      b.pending = x.concat(b.pending);
    };
    if (m === "abs") {
      const v = this.value(args[0]);
      const id = b.emit("cmp", { left: v, right: { num: 0 } }, e); this.tech.add("Variables");
      b.pending = b.holes(id, [2]); this.emitOper(t, "Minus", { num: 0 }, v, e); const x = b.pending;
      b.pending = b.holes(id, [0, 1]); this.emitAssign(t, v, e);
      b.pending = x.concat(b.pending);
      return { var: t };
    }
    if ((m === "min" || m === "max") && args.length === 2) {
      const a = this.value(args[0]), bb = this.value(args[1]);
      pick(a, bb, m === "max", a, bb);
      return { var: t };
    }
    if (m === "sign") {
      const v = this.value(args[0]);
      const id = b.emit("cmp", { left: v, right: { num: 0 } }, e); this.tech.add("Variables");
      const ends = [];
      [[0, 1], [1, 0], [2, -1]].forEach(([o, k]) => { b.pending = b.holes(id, [o]); this.emitAssign(t, { num: k }, e); ends.push(...b.pending); });
      b.pending = ends; return { var: t };
    }
    if (m === "random" && args.length === 0) return { var: "rnd" };
    fail(`Math.${m}() has no node equivalent${m === "floor" || m === "trunc" ? " (use x - x % 1 for non-negative x)" : ""}`, e);
  }

  // ------------------------------------------------------------ conditions: expression -> {t, f} open refs
  cond(e) {
    const b = this.b;
    const c = this.constEval(e);
    if (c) { const p = b.pending; b.pending = []; return truthy(c) ? { t: p, f: [] } : { t: [], f: p }; }
    switch (e.type) {
      case "UnaryExpression":
        if (e.operator === "!") { const r = this.cond(e.argument); return { t: r.f, f: r.t }; }
        break;
      case "LogicalExpression": {
        const a = this.cond(e.left);
        if (e.operator === "&&") { b.pending = a.t; const r = this.cond(e.right); return { t: r.t, f: a.f.concat(r.f) }; }
        if (e.operator === "||") { b.pending = a.f; const r = this.cond(e.right); return { t: a.t.concat(r.t), f: r.f }; }
        break;
      }
      case "BinaryExpression": {
        const op = e.operator;
        if (["==", "===", "!=", "!=="].includes(op)) {
          const neg = op.startsWith("!");
          // outcome === "key"
          const strSide = this.constEval(e.right)?.k === "str" ? "right" : this.constEval(e.left)?.k === "str" ? "left" : null;
          if (strSide) {
            const other = strSide === "right" ? e.left : e.right, key = this.constEval(e[strSide]).v;
            const src = this.outcomeSource(other);
            if (!src) fail(`a string can only be compared with an outcome such as dig() === "cantDig"`, e);
            const r = this.routeOutcome(src, [key], e[strSide]);
            return neg ? { t: r.f, f: r.t } : r;
          }
          const l = this.value(e.left), r = this.value(e.right);
          const [val, other] = l.var == null && r.var != null ? [r, l] : [l, r];
          const id = b.emit("eq", { value: val, set: [other] }, e); this.tech.add("Variables");
          return neg ? { t: b.holes(id, [1]), f: b.holes(id, [0]) } : { t: b.holes(id, [0]), f: b.holes(id, [1]) };
        }
        if (["<", "<=", ">", ">="].includes(op)) {
          const l = this.value(e.left), r = this.value(e.right);
          if (this.typeOf(l) === "cell" || this.typeOf(r) === "cell") fail("cells can't be ordered; use ==, anyOf() or inCategory()", e);
          const id = b.emit("cmp", { left: l, right: r }, e); this.tech.add("Variables");
          const tSet = { "<": [2], "<=": [1, 2], ">": [0], ">=": [0, 1] }[op];
          return { t: b.holes(id, tSet), f: b.holes(id, [0, 1, 2].filter(i => !tSet.includes(i))) };
        }
        break;
      }
      case "CallExpression": {
        const name = calleeName(e);
        const bind = name && !e.callee.object ? this.scope.lookup(name) : null;
        if (bind && bind.kind === "fn") { const ctx = { kind: "cond", t: [], f: [] }; this.inline(bind, e, ctx); return { t: ctx.t, f: ctx.f }; }
        if (!bind && name === "anyOf") {
          if (e.arguments.length < 2) fail("anyOf(value, a, b, …) needs a value and at least one candidate", e);
          const val = this.value(e.arguments[0]);
          const set = [];
          for (const a of e.arguments.slice(1)) {
            const c = this.constEval(a.type === "SpreadElement" ? a.argument : a);
            if (c && c.k === "arr") set.push(...c.v.map(x => constOperand(x, a)));
            else if (a.type === "SpreadElement") fail("spread needs a constant array", a);
            else set.push(this.value(a));
          }
          const id = b.emit("eq", { value: val, set }, e); this.tech.add("Variables");
          return { t: b.holes(id, [0]), f: b.holes(id, [1]) };
        }
        if (!bind && name === "inCategory") {
          const val = this.value(e.arguments[0]);
          const cat = this.constOf(e.arguments[1] || e, "inCategory() category", ["cat"]).v;
          const id = b.emit("cell", { value: val, category: cat }, e); this.tech.add("Variables");
          return { t: b.holes(id, [0]), f: b.holes(id, [1]) };
        }
        if (e.callee.type === "MemberExpression" && !e.callee.computed && e.callee.property.name === "includes") {
          const arr = this.constEval(e.callee.object);
          if (arr && arr.k === "arr") {
            const val = this.value(e.arguments[0]);
            const id = b.emit("eq", { value: val, set: arr.v.map(x => constOperand(x, e)) }, e); this.tech.add("Variables");
            return { t: b.holes(id, [0]), f: b.holes(id, [1]) };
          }
        }
        const src = this.outcomeSource(e);
        if (src) return this.routeOutcome(src, null, e);
        break;
      }
      case "Identifier": {
        const src = this.outcomeSource(e);
        if (src) return this.routeOutcome(src, null, e);
        break;
      }
    }
    // any other value: true when non-zero
    const v = this.value(e);
    const id = b.emit("eq", { value: v, set: [{ num: 0 }] }, e); this.tech.add("Variables");
    return { t: b.holes(id, [1]), f: b.holes(id, [0]) };
  }
  // keys = outcome names that count as true; null = the node's success outputs
  routeOutcome(src, keys, node) {
    const b = this.b, t = src.t, outs = T[t].outs;
    let idx;
    if (keys) {
      idx = keys.map(k => {
        let i = outs.findIndex(o => normKey(o[0]) === normKey(k));
        if (i < 0) i = outs.findIndex(o => normKey(o[1]) === normKey(k));
        if (i < 0) fail(`"${k}" is not an outcome of ${T[t].label} (${outs.map(o => `"${o[0]}"`).join(", ")})`, node);
        return i;
      });
    } else idx = T[t].ok;
    if (src.viaVar) {
      const id = b.emit("eq", { value: { var: src.viaVar }, set: idx.map(i => ({ num: i })) }, node); this.tech.add("Variables");
      return { t: b.holes(id, [0]), f: b.holes(id, [1]) };
    }
    const err = ERROR_OUTS[t] || [];
    const f = outs.map((_, i) => i).filter(i => !idx.includes(i) && !err.includes(i));
    return { t: b.holes(src.id, idx), f: b.holes(src.id, f) };
  }
}

// ---------------------------------------------------------------- helpers
const ARITH = { "+": "Plus", "-": "Minus", "*": "Mult", "/": "Div", "%": "Mod" };
function foldOp(op, a, b) { return { Plus: a + b, Minus: a - b, Mult: a * b, Div: a / b, Mod: a % b }[op]; }
function isCondExpr(e) {
  return (e.type === "BinaryExpression" && ["==", "===", "!=", "!==", "<", "<=", ">", ">="].includes(e.operator)) ||
    e.type === "LogicalExpression" || (e.type === "UnaryExpression" && e.operator === "!") ||
    (e.type === "CallExpression" && ["anyOf", "inCategory"].includes(calleeName(e)));
}
function directive(st) {
  return st && st.type === "ExpressionStatement" && st.expression.type === "Literal" && typeof st.expression.value === "string" ? st.expression.value : null;
}
function calleeName(e) {
  if (e.callee.type === "Identifier") return e.callee.name;
  if (e.callee.type === "MemberExpression" && !e.callee.computed) return e.callee.property.name;
  return null;
}
function mathName(e) {
  return e.type === "CallExpression" && e.callee.type === "MemberExpression" && !e.callee.computed &&
    e.callee.object.type === "Identifier" && e.callee.object.name === "Math" ? e.callee.property.name : null;
}
// names assigned anywhere inside a function body (not inside nested functions)
function assignedNames(body) {
  const out = new Set();
  walk(body, n => {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier") out.add(n.left.name);
    if (n.type === "UpdateExpression" && n.argument.type === "Identifier") out.add(n.argument.name);
  });
  return out;
}
function assignsOuter(body) {
  const local = new Set();
  walk(body, n => { if (n.type === "VariableDeclarator" && n.id.type === "Identifier") local.add(n.id.name); });
  let outer = false;
  walk(body, n => {
    const id = n.type === "AssignmentExpression" ? n.left : n.type === "UpdateExpression" ? n.argument : null;
    if (id && id.type === "Identifier" && !local.has(id.name)) outer = true;
  });
  return outer;
}
function callsUserFn(body) {
  let found = false;
  walk(body, n => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier" &&
      !OUTCOME_FUNS.has(n.callee.name) && !ACTION_FUNS.has(n.callee.name) && !SPECIAL_FUNS.has(n.callee.name)) found = true;
  });
  return found;
}
function walk(n, fn) {
  if (!n || typeof n.type !== "string") return;
  fn(n);
  if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression" || n.type === "FunctionDeclaration") return;
  for (const k of Object.keys(n)) {
    if (k === "loc") continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach(x => walk(x, fn)); else if (v && typeof v === "object" && typeof v.type === "string") walk(v, fn);
  }
}

// drop unreachable nodes, renumber, return the Program IR
function finish(b, comp) {
  const n = b.nodes;
  const seen = new Set([0]), order = [0];
  for (let k = 0; k < order.length; k++) for (const o of n[order[k]].outs) if (o != null && !seen.has(o)) { seen.add(o); order.push(o); }
  const keep = n.filter(x => seen.has(x.id));
  const dropped = n.filter(x => !seen.has(x.id) && x.src);
  if (dropped.length) {
    const lines = [...new Set(dropped.map(x => x.src.line))].sort((a, c) => a - c);
    comp.warn(`${b.name}: unreachable code on line${lines.length > 1 ? "s" : ""} ${lines.join(", ")} was left out`, { loc: { start: { line: lines[0], column: 0 }, end: { line: lines[0], column: 1 } } });
  }
  const remap = new Map(keep.map((x, i) => [x.id, i]));
  const nodes = keep.map((x, i) => ({ ...x, id: i, outs: x.outs.map(o => o == null ? null : remap.get(o)) }));
  return { name: b.name, params: b.params, nodes };
}
