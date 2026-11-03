// Code editor: CodeMirror 6 (vendor/codemirror.mjs) with the game API added: completion of the built-in functions,
// enum members, system variables and the program's own names, highlighting of game names, lint diagnostics,
// and line marks (node hover, current simulator node, the CALL nodes waiting on its stack). The API (value, setValue,
// setMarks, setDiagnostics, reveal, select, focus) is what app.js uses.
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars,
  rectangularSelection, crosshairCursor, Decoration, ViewPlugin, GutterMarker, gutterLineClass, EditorState, StateField, StateEffect,
  RangeSetBuilder, history, defaultKeymap, historyKeymap, indentWithTab, syntaxHighlighting, HighlightStyle, bracketMatching,
  indentOnInput, syntaxTree, indentUnit, autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion,
  setDiagnostics, lintKeymap, searchKeymap, highlightSelectionMatches, javascript, tags,
} from "../vendor/codemirror.mjs";
import { BUILTIN_DOCS } from "./compiler.js";
import { DIRS, CATEGORIES, CELLS, ITEMS, INV_TARGETS, BUILTIN_VARS, WRITABLE_BUILTINS } from "./nodes.js";
import { t, tOr, has, builtinDoc } from "./i18n.js";

// ---------------------------------------------------------------- the game API
const FUNCS = ["step", "move", "dig", "moveDig", "rotateTo", "turn", "turnLeft", "turnRight", "turnAround", "aim", "aimAt", "scan",
  "use", "useItem", "unload", "load", "inventory", "autoCargo", "pass", "call", "exit", "fail", "halt", "anyOf", "inCategory", "log"];
// service cells stay valid in code but aren't offered (the game's suggestions leave them out too)
const SERVICE_CELLS = new Set(["Unknown", "Service", "ServiceWalkableCorner", "ServiceWalkableFull", "ServiceDiggable",
  "ServiceDiggableWalkableCorner", "Darkness", "ServiceHiddenEmpty"]);
const ENUMS = {
  Dir: DIRS, Category: [...CATEGORIES, "Hard"], Cell: CELLS.filter(c => !SERVICE_CELLS.has(c)), Item: ITEMS, Target: [...INV_TARGETS, "Base"],
  Math: ["abs", "min", "max", "sign", "random", "PI"],
};
const SIGS = {      // what is inserted (snippet fields in ${…}) for the calls BUILTIN_DOCS doesn't spell out
  move: "move()", useItem: "useItem(${Item.MiningCharge})", load: "load(${Target.Storage})", inventory: "inventory(${Target.Storage}, ${true})",
  turnLeft: "turnLeft()", turnRight: "turnRight()", turnAround: "turnAround()", fail: "fail()", exit: "exit()", log: "log(${})",
};
const ALIAS = { move: "step()", useItem: "use(Item.MiningCharge)", load: "unload(Target.Storage)", inventory: "unload(Target.Storage)",
  turnLeft: "turn(90)", turnRight: "turn(90)", turnAround: "turn(90)", fail: "exit() / exit(false) / fail()", exit: "exit() / exit(false) / fail()" };
// BUILTIN_DOCS: [call, node, description]; "turn(90)" -> name turn, insert turn(${90})
const DOC = new Map();
for (const [call, node, desc] of BUILTIN_DOCS) {
  for (const part of call.split(" / ")) {
    const m = part.match(/^(\w+)\((.*)\)$/);
    if (m && !DOC.has(m[1])) DOC.set(m[1], { call, node, desc, insert: `${m[1]}(${m[2] ? m[2].split(/,\s*/).map(a => /^\.\.\.|^…$/.test(a) ? "" : `\${${a}}`).filter(Boolean).join(", ") : ""})` });
  }
}
const KEYWORDS = ["let", "const", "if", "else", "while", "do", "for", "of", "break", "continue", "return", "function", "switch", "case", "default", "true", "false"];
const fnInfo = name => {
  const d = DOC.get(name) || (ALIAS[name] && BUILTIN_DOCS.find(x => x[0] === ALIAS[name]) && { call: ALIAS[name], desc: BUILTIN_DOCS.find(x => x[0] === ALIAS[name])[2] });
  return d ? builtinDoc(d.call, d.desc) : null;
};
function memberInfo(en, m) {
  switch (en) {
    case "Cell": return tOr("cell." + m, "");
    case "Category": return tOr("catd." + (m === "Hard" ? "DiggableHard" : m), "");
    case "Dir": return t("dir." + DIRS.indexOf(m));
    case "Item": return tOr("item." + m, "");
    case "Target": return tOr("tgt." + (m === "Base" ? "Storage" : m), "");
    default: return "";
  }
}

// completions: Enum.member after a dot, otherwise functions, enums, system variables, keywords and the program's own names
function ownNames(state) {
  const out = new Map();
  syntaxTree(state).iterate({
    enter: n => {
      if (n.name === "VariableDefinition" || n.name === "FunctionDeclaration") {
        const node = n.name === "FunctionDeclaration" ? n.node.getChild("VariableDefinition") : n.node;
        if (!node) return;
        const name = state.sliceDoc(node.from, node.to);
        const isFn = n.name === "FunctionDeclaration" || node.parent?.name === "FunctionDeclaration";
        if (!out.has(name) || isFn) out.set(name, isFn ? "function" : "variable");
      }
    },
  });
  return out;
}
function complete(ctx) {
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  if (["String", "LineComment", "BlockComment", "TemplateString"].includes(node.name)) return null;
  const mem = ctx.matchBefore(/\b(Dir|Category|Cell|Item|Target|Math)\.\w*$/);
  if (mem) {
    const en = mem.text.split(".")[0];
    return {
      from: mem.from + en.length + 1, validFor: /^\w*$/,
      options: ENUMS[en].map(m => en === "Math" && m !== "PI"
        ? snippetCompletion(m === "random" ? `${m}()` : m === "abs" || m === "sign" ? `${m}(\${x})` : `${m}(\${a}, \${b})`, { label: m, type: "function" })
        : { label: m, type: "constant", info: memberInfo(en, m) || undefined }),
    };
  }
  const word = ctx.matchBefore(/[A-Za-z_$][\w$]*/);
  if (!word && !ctx.explicit) return null;
  if (word && ctx.state.sliceDoc(word.from - 1, word.from) === ".") return null;
  const opts = [];
  for (const f of FUNCS) {
    const d = DOC.get(f);
    opts.push(snippetCompletion(SIGS[f] || (d ? d.insert : `${f}()`), { label: f, type: "function", detail: d ? d.node : undefined, info: fnInfo(f) || undefined, boost: 2 }));
  }
  for (const en of Object.keys(ENUMS)) opts.push({ label: en, type: "namespace", apply: en + ".", boost: 1 });
  for (const v of BUILTIN_VARS) opts.push({ label: v, type: "variable", detail: WRITABLE_BUILTINS.includes(v) ? "system, writable" : "system", info: tOr("var." + v, "") || undefined });
  for (const k of KEYWORDS) opts.push({ label: k, type: "keyword", boost: -1 });
  for (const [name, kind] of ownNames(ctx.state)) {
    if (FUNCS.includes(name) || BUILTIN_VARS.includes(name)) continue;
    opts.push(kind === "function" ? snippetCompletion(`${name}(\${})`, { label: name, type: "function", boost: 3 }) : { label: name, type: "variable", boost: 3 });
  }
  return { from: word ? word.from : ctx.pos, options: opts, validFor: /^[\w$]*$/ };
}

// ---------------------------------------------------------------- highlighting
const style = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#7d7064", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string)], color: "#9fd27f" },
  { tag: [tags.number, tags.bool, tags.null], color: "#f2a65a" },
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.self], color: "#d79bff" },
  { tag: [tags.propertyName], color: "#7fc8ff" },
  { tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName))], color: "#ffe4a3" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: "#b9ab9c" },
  { tag: tags.invalid, color: "#ff8a8e" },
]);
// game names: built-in calls, enum objects and system variables (not when the program declares the same name)
const FUNC_SET = new Set(FUNCS), ENUM_SET = new Set(Object.keys(ENUMS)), VAR_SET = new Set(BUILTIN_VARS);
const gameMark = { fn: Decoration.mark({ class: "t-fn" }), en: Decoration.mark({ class: "t-en" }), sv: Decoration.mark({ class: "t-sv" }) };
function gameNames(view) {
  const b = new RangeSetBuilder(), own = ownNames(view.state);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({ from, to, enter: n => {
      if (n.name !== "VariableName") return;
      const s = view.state.sliceDoc(n.from, n.to);
      if (own.has(s)) return;
      const call = n.node.parent?.name === "CallExpression" && n.node.parent.firstChild?.from === n.from;
      const k = FUNC_SET.has(s) && call ? "fn" : ENUM_SET.has(s) ? "en" : VAR_SET.has(s) ? "sv" : null;
      if (k) b.add(n.from, n.to, gameMark[k]);
    } });
  }
  return b.finish();
}
const gameHighlight = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = gameNames(v); }
  update(u) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = gameNames(u.view); }
}, { decorations: v => v.decorations });

// ---------------------------------------------------------------- line marks (node hover, simulator) and error lines
const setLineMarks = StateEffect.define();
const lineMarks = StateField.define({
  create: () => ({ hl: new Set(), cur: null, call: new Set(), err: new Set(), warn: new Set() }),
  update(v, tr) { for (const e of tr.effects) if (e.is(setLineMarks)) v = { ...v, ...e.value }; return v; },
});
const lineDeco = { hl: Decoration.line({ class: "cm-l-hl" }), cur: Decoration.line({ class: "cm-l-cur" }), call: Decoration.line({ class: "cm-l-call" }), err: Decoration.line({ class: "cm-l-err" }) };
const lineDecos = EditorView.decorations.compute([lineMarks, "doc"], state => {
  const m = state.field(lineMarks), n = state.doc.lines, by = new Map();
  const put = (line, d) => { if (line >= 1 && line <= n) (by.get(line) || by.set(line, []).get(line)).push(d); };
  for (const l of m.err) put(l, lineDeco.err);
  for (const l of m.hl) put(l, lineDeco.hl);
  for (const l of m.call) if (l !== m.cur) put(l, lineDeco.call);
  if (m.cur) put(m.cur, lineDeco.cur);
  const b = new RangeSetBuilder();
  for (const l of [...by.keys()].sort((a, c) => a - c)) { const pos = state.doc.line(l).from; for (const d of by.get(l)) b.add(pos, pos, d); }
  return b.finish();
});
class LineClass extends GutterMarker { constructor(c) { super(); this.elementClass = c; } }
const gutterMarks = { err: new LineClass("cm-g-err"), warn: new LineClass("cm-g-warn"), hl: new LineClass("cm-g-hl"), call: new LineClass("cm-g-call"), cur: new LineClass("cm-g-cur") };
const gutterClasses = gutterLineClass.compute([lineMarks, "doc"], state => {
  const m = state.field(lineMarks), n = state.doc.lines, by = new Map();
  for (const l of m.warn) by.set(l, "warn");
  for (const l of m.err) by.set(l, "err");
  for (const l of m.hl) if (!by.has(l)) by.set(l, "hl");
  for (const l of m.call) by.set(l, "call");
  if (m.cur) by.set(m.cur, "cur");
  const b = new RangeSetBuilder();
  for (const l of [...by.keys()].filter(l => l >= 1 && l <= n).sort((a, c) => a - c)) { const pos = state.doc.line(l).from; b.add(pos, pos, gutterMarks[by.get(l)]); }
  return b.finish();
});

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "transparent", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--f-mono)", lineHeight: "20px", fontVariantLigatures: "none" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 12px" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(255,228,163,.22) !important" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "#6e6258", borderRight: "1px solid var(--line)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "30px" },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,.025)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#b9ab9c" },
  ".cm-matchingBracket": { backgroundColor: "rgba(255,228,163,.18)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "rgba(127,200,255,.14)" },
  ".cm-tooltip": { backgroundColor: "#1d1611", border: "1px solid var(--line)", color: "var(--fg)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(255,228,163,.2)", color: "var(--fg)" },
  ".cm-tooltip.cm-completionInfo": { maxWidth: "340px", padding: "6px 9px", fontFamily: "var(--f-body)", fontSize: "12.5px", lineHeight: "1.4" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-completionMatchedText": { color: "var(--accent)", textDecoration: "none" },
  ".cm-diagnostic": { fontFamily: "var(--f-mono)", fontSize: "12.5px" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
  ".cm-searchMatch": { backgroundColor: "rgba(245,158,11,.25)" },
}, { dark: true });

// ---------------------------------------------------------------- the editor
export function createEditor(root, { value = "", onChange = () => {}, onCursor = () => {} } = {}) {
  root.classList.add("ce");
  let lastCur = null;
  const lineOf = (state, pos) => state.doc.lineAt(pos).number;
  const extensions = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), indentUnit.of("  "), EditorState.tabSize.of(2),
    syntaxHighlighting(style), bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(),
    highlightActiveLine(), highlightSelectionMatches(), javascript(),
    autocompletion({ override: [complete], icons: true, activateOnTyping: true }),
    gameHighlight, lineMarks, lineDecos, gutterClasses, theme,
    keymap.of([{ key: "Mod-Enter", run: () => true }, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap,
      ...completionKeymap, ...lintKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ "aria-label": "JavaScript source", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
    EditorView.updateListener.of(u => {
      if (u.docChanged) onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) {
        const s = u.state.selection.main, a = lineOf(u.state, s.from), b = s.empty ? null : lineOf(u.state, s.to);
        const key = `${a}:${b}`;
        if (key !== lastCur && (u.selectionSet || u.focusChanged)) { lastCur = key; onCursor(s.empty ? lineOf(u.state, s.head) : a, b); }
      }
    }),
  ];
  const view = new EditorView({ parent: root, state: EditorState.create({ doc: value, extensions }) });
  const posOf = (line, col = 1) => {
    const d = view.state.doc, l = d.line(Math.max(1, Math.min(line, d.lines)));
    return Math.min(l.to, l.from + Math.max(0, col - 1));
  };
  let diags = [];
  return {
    view,
    get value() { return view.state.doc.toString(); },
    // a new document: fresh state, so undo can't reach back into the previous program; no onChange / onCursor
    // (setState runs no update listeners); line marks and diagnostics start empty, the app sets them again
    setValue(v) {
      view.setState(EditorState.create({ doc: v, extensions }));
      lastCur = null;
      diags = [];
      view.scrollDOM.scrollTop = 0;
    },
    setMarks(m) {
      const v = {};
      for (const k of ["hl", "call", "err", "warn"]) if (m[k]) v[k] = new Set(m[k]);
      if ("cur" in m) v.cur = m.cur;
      view.dispatch({ effects: setLineMarks.of(v) });
    },
    setDiagnostics(list) {
      diags = list || [];
      const ds = [];
      for (const d of diags) {
        if (!d.loc) continue;
        const from = posOf(d.loc.line, d.loc.col);
        let to = posOf(d.loc.endLine || d.loc.line, d.loc.endCol || d.loc.col + 1);
        if (to <= from) to = Math.min(view.state.doc.length, from + 1);
        ds.push({ from, to, severity: d.sev === "err" ? "error" : "warning", message: d.msg });
      }
      view.dispatch(setDiagnostics(view.state, ds));
      view.dispatch({ effects: setLineMarks.of({ err: new Set(diags.filter(d => d.sev === "err" && d.loc).map(d => d.loc.line)),
        warn: new Set(diags.filter(d => d.sev !== "err" && d.loc).map(d => d.loc.line)) }) });
    },
    reveal(line) {
      const pos = posOf(line), r = view.scrollDOM.getBoundingClientRect(), c = view.coordsAtPos(pos);
      if (!c || c.top < r.top + 4 || c.bottom > r.bottom - 24) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    },
    select(line, col = 1) {
      const pos = posOf(line, col);
      view.focus();
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    },
    focus() { view.focus(); },
  };
}
