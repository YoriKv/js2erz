// Node editor: mirrors the game's Programmator node inspector (erz.ui.NodeInspector).
// Frame: title bar in the node colour, description, the per-type controls, then the outputs and DELETE.
// Text fields follow the game: numbers ^[+-]?\d+(\.\d+)?$, names 1..20 of [a-zA-Z0-9_] (no leading digit),
// cells as C.<Cell>; invalid text turns red and keeps the old value; typing commits without rebuilding the panel.
import { T, DIR_ARROW, CATEGORIES, CELLS, ITEMS, BUILTIN_VARS, TITLE } from "./nodes.js";
import { t, tOr, has } from "./i18n.js";

const NUM_RX = /^[+-]?\d+(?:\.\d+)?$/;
const NAME_RX = /^[a-zA-Z_][a-zA-Z0-9_]{0,19}$/;
const COLOR = { cell: "#FFB86C", num: "#00CC00", sys: "#66CCFF", bad: "#FF6666" };
const SERVICE_CELLS = new Set(["Unknown", "Service", "ServiceWalkableCorner", "ServiceWalkableFull", "ServiceDiggable",
  "ServiceDiggableWalkableCorner", "Darkness", "ServiceHiddenEmpty"]);
const CELL_CONSTS = CELLS.filter(c => !SERVICE_CELLS.has(c)).map(c => "C." + c);
const CELL_VARS = ["scan_cell_front", "scan_cell_back"];
const ASSIGNABLE = ["aim_x", "aim_y", "aim_rel", "aim_front", "aim_right", "auto_war", "auto_attack_mobs", "auto_attack_miners"];
const HIDDEN_CATS = new Set(["Bombable", "Extractable", "Pushable", "Falling", "Damaging"]);
const REL_BTNS = [[4, "180°"], [-3, "-135°"], [-2, "-90°"], [-1, "-45°"], [1, "+45°"], [2, "+90°"], [3, "+135°"]];   // our REL 180° is 4
const OP_LIST = [["Plus", "+"], ["Minus", "−"], ["Mult", "×"], ["Div", "÷"], ["Mod", "%"]];
const INV_ORDER = ["Storage", "Bot", "Box"];
const ICON = { rotA: "↻", rotR: "↻", move: "→•", dig: "⛏", movedig: "⛏", use: "▣", inv: "⇅", cargo: "⇄", aimA: "⌖", aimR: "⌖",
  scan: "◎", pass: "•", call: "▶▶", exit: "⏏", assign: "x=", oper: "x=", cmp: "⋚", eq: "∈", cell: "▦" };

const parseNum = s => NUM_RX.test(s) ? +s : null;
const fmtNum = v => String(Math.round(v * 1e6) / 1e6);
export const operandText = o => o == null ? "" : o.var != null ? o.var : o.cell != null ? "C." + o.cell : o.num != null ? fmtNum(o.num) : "";
const relDir = d => ((((d + 4) % 8) + 8) % 8) - 4;          // game's relativeDir: -4..3

export function createInspector(ctx) {
  const box = ctx.box;
  const sugg = el("div", { class: "insp-sugg", hidden: true });
  const suggDesc = el("div", { class: "insp-sdesc", hidden: true });
  ctx.overlay.append(sugg, suggDesc);
  let S = null;            // open suggestion list: { field, slot, items, sel, off, nav }
  let shown = null;        // node shown (to keep the scroll position while the same node is rebuilt)

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const label = s => el("div", { class: "insp-l" }, s);
  const gap = h => el("div", { style: `height:${h}px` });
  const btn = (text, on, onclick, cls = "insp-mode") => el("button", { type: "button", class: cls + (on ? " on" : ""), onclick }, text);
  const choice = (text, on, onclick) => btn(text, on, onclick, "insp-choice");
  const rowOf = (...kids) => el("div", { class: "insp-row" }, ...kids);

  // ------------------------------------------------------------ changes
  // buttons: snapshot, change, rebuild; text fields: one snapshot per focus, no rebuild
  const change = fn => { ctx.snapshot(); fn(); ctx.commit(); render(); };
  let typedSnap = false;
  const typed = fn => { if (!typedSnap) { ctx.snapshot(); typedSnap = true; } fn(); ctx.commit(); };

  // ------------------------------------------------------------ operand fields
  // opts: { value: text, slot: "any"|"number"|"cell"|"assignable", num, cell, name, empty, onValue(v), onInvalid() }
  // onValue gets an operand ({var}|{num}|{cell}) or, for name-only fields, the name; null for empty
  function field(opts) {
    const inp = el("input", { class: "insp-f", value: opts.value, spellcheck: "false", autocomplete: "off",
      maxlength: opts.cell ? 31 : 20 });
    let prev = opts.value;
    const colorFor = (s, build) => {
      if (opts.cell && s.startsWith("C.") && CELLS.includes(s.slice(2))) return COLOR.cell;
      if (opts.num && parseNum(s) != null) return build ? COLOR.num : "";
      if (opts.name !== false && NAME_RX.test(s)) return BUILTIN_VARS.includes(s) ? COLOR.sys : "";
      return null;
    };
    inp.style.color = colorFor(opts.value, true) || "";
    inp.addEventListener("focus", () => { typedSnap = false; showSugg(inp, opts.slot); });
    inp.addEventListener("blur", () => setTimeout(() => { if (S && S.field === inp && document.activeElement !== inp) hideSugg(); }, 150));
    inp.addEventListener("input", () => {
      const s = inp.value;
      if (s !== s.trim()) { const at = Math.max(0, inp.selectionStart - 1); inp.value = prev; inp.setSelectionRange(at, at); return; }
      prev = s;
      if (S && S.field === inp && S.nav === s) S.nav = null; else showSugg(inp, opts.slot);
      classify(s);
    });
    inp.addEventListener("keydown", e => {
      if (!S || S.field !== inp) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSel(e.key === "ArrowDown" ? 1 : -1); }
      else if (e.key === "Enter") {
        if (inp.value.toLowerCase() === "c.") { e.preventDefault(); showSugg(inp, opts.slot); }
        else { if (S.sel >= 0) e.preventDefault(); hideSugg(); }
      } else if (e.key === "Escape") { e.stopPropagation(); hideSugg(); }
    });
    function classify(s) {
      if (s === "" && opts.empty) { inp.style.color = ""; typed(() => opts.onValue(null)); return; }
      if (opts.num && parseNum(s) != null) { inp.style.color = ""; typed(() => opts.onValue({ num: parseNum(s) })); return; }
      if (opts.cell && s.startsWith("C.") && CELLS.includes(s.slice(2))) { inp.style.color = COLOR.cell; typed(() => opts.onValue({ cell: s.slice(2) })); return; }
      if (opts.name !== false && NAME_RX.test(s)) {
        inp.style.color = BUILTIN_VARS.includes(s) ? COLOR.sys : "";
        typed(() => opts.onValue(opts.nameOnly ? s : { var: s })); return;
      }
      inp.style.color = COLOR.bad;
      if (opts.onInvalid) typed(opts.onInvalid);
    }
    inp.setValue = s => { inp.value = s; prev = s; classify(s); };
    return inp;
  }

  // ------------------------------------------------------------ suggestions (system variables and C.* cells only)
  function suggestions(slot, text) {
    const lc = text.toLowerCase();
    if ((slot === "any" || slot === "cell") && lc.startsWith("c.")) {
      const rest = lc.slice(2);
      const hit = CELL_CONSTS.filter(c => c.slice(2).toLowerCase().includes(rest));
      return [...hit.filter(c => c.slice(2).toLowerCase().startsWith(rest)), ...hit.filter(c => !c.slice(2).toLowerCase().startsWith(rest))];
    }
    const pool = slot === "number" ? BUILTIN_VARS.filter(v => !CELL_VARS.includes(v)) : slot === "cell" ? CELL_VARS
      : slot === "assignable" ? BUILTIN_VARS.filter(v => ASSIGNABLE.includes(v)) : BUILTIN_VARS;
    const hit = pool.filter(v => v.toLowerCase().includes(lc));
    const list = [...hit.filter(v => v.toLowerCase().startsWith(lc)), ...hit.filter(v => !v.toLowerCase().startsWith(lc))];
    if ((slot === "any" || slot === "cell") && "c.".startsWith(lc)) list.unshift("C.");
    return list;
  }
  function showSugg(inp, slot) {
    const items = suggestions(slot, inp.value);
    if (!items.length) { hideSugg(); return; }
    S = { field: inp, slot, items, sel: items.indexOf(inp.value), off: 0, nav: null };
    keepVisible(); drawSugg();
  }
  function hideSugg() { S = null; sugg.hidden = true; suggDesc.hidden = true; }
  function keepVisible() {
    if (S.sel >= 0) { if (S.sel - 2 < S.off) S.off = S.sel - 2; if (S.off + 10 <= S.sel + 2) S.off = S.sel - 7; }
    S.off = Math.max(0, Math.min(S.off, Math.max(0, S.items.length - 10)));
  }
  function pick(v) {
    const inp = S.field, slot = S.slot;
    inp.setValue(v);
    if (v === "C.") { inp.focus(); inp.setSelectionRange(2, 2); showSugg(inp, slot); } else hideSugg();
  }
  function moveSel(d) {
    S.sel = S.sel < 0 ? (d > 0 ? 0 : S.items.length - 1) : Math.max(0, Math.min(S.items.length - 1, S.sel + d));
    keepVisible(); drawSugg();
    const v = S.items[S.sel];
    if (S.field.value !== v) { S.nav = v; S.field.setValue(v); S.field.setSelectionRange(v.length, v.length); }
  }
  function describe(v) {
    if (v === "C.") return t("insp.cellTypes");
    if (v.startsWith("C.")) { const c = v.slice(2); return tOr("cell." + c, c); }
    return has("var." + v) ? t("var." + v) : null;
  }
  function drawSugg() {
    const end = Math.min(S.items.length, S.off + 10);
    sugg.replaceChildren(
      ...(S.off > 0 ? [el("div", { class: "insp-more" }, `+${S.off}…`)] : []),
      ...S.items.slice(S.off, end).map((v, k) => el("div", {
        class: "insp-si" + (S.off + k === S.sel ? " on" : ""), style: `color:${v.startsWith("C.") ? COLOR.cell : COLOR.sys}`,
        onpointerdown: e => { e.preventDefault(); pick(v); } }, v)),
      ...(end < S.items.length ? [el("div", { class: "insp-more" }, `+${S.items.length - end}…`)] : []));
    const o = ctx.overlay.getBoundingClientRect(), r = S.field.getBoundingClientRect();
    Object.assign(sugg.style, { left: `${r.left - o.left}px`, top: `${r.bottom - o.top + 2}px`, width: `${r.width}px` });
    sugg.hidden = false;
    const d = S.sel >= 0 ? describe(S.items[S.sel]) : null;
    suggDesc.hidden = !d;
    if (d) {
      suggDesc.textContent = d;
      Object.assign(suggDesc.style, { right: `${o.right - r.left + 4}px`, top: `${r.bottom - o.top + 2 + (S.sel - S.off + (S.off > 0 ? 1 : 0)) * 18 + 5}px` });
    }
  }

  // ------------------------------------------------------------ per-type controls
  function categoryControls(E, n) {
    E.append(label(t("f.category")));
    const wrap = el("div", { class: "insp-wrap" });
    for (const c of CATEGORIES) if (!HIDDEN_CATS.has(c) || n.p.category === c)
      wrap.append(choice(ctx.catLabel(c).toUpperCase(), n.p.category === c, () => change(() => { n.p.category = c; })));
    E.append(wrap, el("div", { class: "insp-note", style: "margin-top:6px" }, tOr("catd." + n.p.category, "")));
  }
  const operandField = (get, set, slot, kinds) => field({ value: operandText(get()), slot, num: kinds.includes("num"),
    cell: kinds.includes("cell"), empty: true, onValue: set });
  const targetField = n => field({ value: n.p.varname || "", slot: "assignable", empty: true, nameOnly: true,
    onValue: v => { n.p.varname = v; } });
  const eqSign = () => el("div", { class: "insp-eq" }, "=");

  function controls(E, n) {
    const P = n.p;
    switch (n.t) {
      case "rotA": case "rotR": {
        const rel = n.t === "rotR";
        E.append(label(t("insp.mode")), rowOf(
          btn("ABS", !rel, () => { if (rel) change(() => { n.t = "rotA"; P.dir = ((P.dir % 8) + 8) % 8; }); }),
          btn("REL", rel, () => { if (!rel) change(() => { n.t = "rotR"; let d = relDir(P.dir); if (d === 0) d = 2; P.dir = d === -4 ? 4 : d; }); })),
          label(t("f.direction")));
        if (!rel) {
          const g = el("div", { class: "insp-compass" }), cur = ((P.dir % 8) + 8) % 8;
          for (const d of [5, 6, 7, 4, null, 0, 3, 2, 1]) g.append(d == null ? el("span")
            : el("button", { type: "button", class: "insp-mode" + (cur === d ? " on" : ""), title: ctx.dirName(d), "aria-label": ctx.dirName(d),
              onclick: () => change(() => { P.dir = d; }) }, DIR_ARROW[d]));
          E.append(g);
        } else {
          const cur = relDir(P.dir);
          E.append(el("div", { class: "insp-wrap" }, ...REL_BTNS.map(([v, s]) => choice(s, relDir(v) === cur, () => change(() => { P.dir = v; })))));
        }
        break;
      }
      case "aimA": case "aimR": {
        const rel = n.t === "aimR";
        E.append(label(t("insp.mode")), rowOf(
          btn("ABS", !rel, () => { if (rel) change(() => { n.t = "aimA"; P.front = -P.front; }); }),
          btn("REL", rel, () => { if (!rel) change(() => { n.t = "aimR"; P.front = -P.front; }); })));
        const sg = v => v > 0 ? `+${v}` : String(v);
        let read;
        if (!rel) read = `x: ${sg(P.right)}, y: ${sg(P.front)}`;
        else if (!P.front && !P.right) read = t("insp.aimCenter");
        else read = `${P.front > 0 ? `${t("insp.aFront")}: ${P.front}` : P.front < 0 ? `${t("insp.aBack")}: ${-P.front}` : t("insp.aMiddle")}, ` +
          `${P.right > 0 ? `${t("insp.aRight")}: ${P.right}` : P.right < 0 ? `${t("insp.aLeft")}: ${-P.right}` : t("insp.aCentre")}`;
        E.append(label(read));
        const g = el("div", { class: "insp-aim" });
        for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
          const fx = c - 3, fy = rel ? 3 - r : r - 3, hit = P.right === fx && P.front === fy;
          g.append(el("button", { type: "button", class: (hit ? "on" : "") + (Math.abs(fx) <= 1 && Math.abs(r - 3) <= 1 ? " body" : ""),
            "aria-label": rel ? `${fy}, ${fx}` : `${fx}, ${fy}`, onclick: () => change(() => { P.right = fx; P.front = fy; }) }));
        }
        const side = (k, cls) => el("div", { class: cls }, t(k));
        E.append(el("div", { class: "insp-aimbox" }, side(rel ? "insp.front" : "insp.north", "insp-aimt"),
          el("div", { class: "insp-aimmid" }, side(rel ? "insp.left" : "insp.west", "insp-aiml"), g, side(rel ? "insp.right" : "insp.east", "insp-aimr")),
          side(rel ? "insp.back" : "insp.south", "insp-aimt")));
        break;
      }
      case "scan": categoryControls(E, n); break;
      case "cell":
        E.append(label(t("f.cell")), operandField(() => P.value, v => { P.value = v; }, "cell", ["cell"]), gap(8));
        categoryControls(E, n); break;
      case "use":
        E.append(label(t("f.item")), el("div", { class: "insp-cur" }, P.item || "—"),
          el("div", { class: "insp-wrap insp-items" }, ...ITEMS.map(i => choice(ctx.itemLabel(i), P.item === i, () => change(() => { P.item = i; })))));
        break;
      case "inv":
        E.append(el("div", { class: "insp-l insp-c" }, t("insp.bot")),
          el("div", { class: "insp-row insp-c", style: "margin:4px 0" },
            btn("↓", !!P.positive, () => change(() => { P.positive = true; })), btn("↑", !P.positive, () => change(() => { P.positive = false; }))),
          el("div", { class: "insp-row insp-c" }, ...INV_ORDER.map(x => btn(t("insp.tgt." + x), P.target === x, () => change(() => { P.target = x; })))));
        break;
      case "call": {
        const names = ctx.programNames();
        E.append(label(t("f.target")), el("div", { class: "insp-cur" }, P.program || t("insp.notSelected")),
          el("div", { class: "insp-wrap" }, ...names.map(nm => el("button", { type: "button", class: "insp-prog" + (P.program === nm ? " on" : ""),
            onclick: () => change(() => { P.program = nm; }) }, nm))));
        break;
      }
      case "exit":
        E.append(label(t("f.exitVia")), rowOf(btn(t("exit.success"), !P.fail, () => change(() => { P.fail = false; })),
          btn(t("exit.fail"), !!P.fail, () => change(() => { P.fail = true; }))));
        break;
      case "assign":
        E.append(targetField(n), eqSign(), operandField(() => P.value, v => { P.value = v; }, "any", ["num", "cell"]));
        break;
      case "oper":
        E.append(targetField(n), eqSign(), operandField(() => P.left, v => { P.left = v; }, "number", ["num"]), gap(8),
          el("div", { class: "insp-row insp-c" }, ...OP_LIST.map(([op, s]) => choice(s, P.op === op, () => change(() => { P.op = op; })))), gap(8),
          operandField(() => P.right, v => { P.right = v; }, "number", ["num"]));
        break;
      case "cmp":
        E.append(operandField(() => P.left, v => { P.left = v; }, "number", ["num"]), gap(8),
          operandField(() => P.right, v => { P.right = v; }, "number", ["num"]));
        break;
      case "eq": eqControls(E, n); break;
    }
  }

  // EQ "Any of": always one trailing empty row; clearing a row drops the empty rows after it; invalid rows stay but don't count
  function eqControls(E, n) {
    const P = n.p;
    E.append(label(t("f.value")), operandField(() => P.value, v => { P.value = v; }, "any", ["num", "cell"]), gap(8), label(t("f.anyOf")));
    const list = el("div", { class: "insp-list" }), rows = [], values = [];
    const key = v => v == null ? "" : v.var != null ? "v:" + v.var : v.cell != null ? "c:" + v.cell : "n:" + v.num;
    const commit = () => { const seen = new Set(); P.set = values.filter(v => v && !seen.has(key(v)) && seen.add(key(v))); };
    const addEmpty = () => { if (rows.length < 128 && (!rows.length || values[values.length - 1])) addRow(null); };
    function addRow(v) {
      const r = field({ value: operandText(v), slot: "any", num: true, cell: true, empty: true,
        onValue: x => {
          const i = rows.indexOf(r); values[i] = x;
          if (x == null) { if (values.slice(i + 1).every(y => !y)) while (rows.length > i + 1) { rows.pop().remove(); values.pop(); } }
          else addEmpty();
          commit();
        },
        onInvalid: () => { values[rows.indexOf(r)] = null; commit(); } });
      r.addEventListener("blur", () => {
        const i = rows.indexOf(r);
        if (i >= 0 && i < rows.length - 1 && r.value === "") { rows.splice(i, 1); values.splice(i, 1); r.remove(); addEmpty(); }
      });
      rows.push(r); values.push(v); list.append(r);
    }
    for (const v of P.set || []) addRow(v);
    addEmpty();
    E.append(list);
  }

  // ------------------------------------------------------------ frame
  const glyph = (ty, key) => ty === "start" ? "▸" : /fail|mismatch|cantDig/.test(key) ? "×" : /success|done|moved|match|pass/.test(key) ? "✓" : "";
  function render() {
    hideSugg();
    const n = ctx.node();
    box.hidden = !n;
    if (!n) { shown = null; return; }
    const keep = shown === n ? box.scrollTop : 0;
    shown = n;
    const tp = T[n.t];
    box.replaceChildren();
    box.append(el("div", { class: "insp-title", style: `background:${tp.bg};color:${tp.fg || TITLE}` },
      ICON[n.t] ? el("span", { class: "insp-icon" }, ICON[n.t]) : null, el("span", {}, ctx.nodeLabel(n.t).toUpperCase()),
      el("button", { type: "button", class: "insp-x", title: t("ins.close"), "aria-label": t("ins.close"), onclick: ctx.close }, "×")));
    const E = el("div", { class: "insp-body" });
    E.append(el("div", { class: "insp-desc" }, ctx.nodeDesc(n)));
    if (n.src) E.append(el("div", { class: "insp-src" }, el("button", { type: "button", class: "link", onclick: () => ctx.selectLine(n.src) },
      n.src.endLine > n.src.line ? t("ins.lines", n.src.line, n.src.endLine) : t("ins.line", n.src.line))));
    controls(E, n);
    if (tp.outs.length) {
      E.append(el("div", { class: "insp-sep" }), label(t("ins.outputs")));
      tp.outs.forEach(([key, word, col], i) => {
        const ring = n.t === "start" ? "#3FBF5F" : col, g = glyph(n.t, key);
        E.append(el("div", { class: "insp-out" }, el("span", { class: "insp-dot", style: `border-color:${ring}` }),
          el("span", {}, `${g ? g + " " : ""}${n.t === "start" ? "start" : word}`)));
        const d = ctx.outDesc(n.t, key);
        if (d) E.append(el("div", { class: "insp-note insp-odesc" }, d));
      });
    }
    if (n.t !== "start") E.append(el("div", { class: "insp-c", style: "margin-top:12px" },
      el("button", { type: "button", class: "insp-mode insp-del", onclick: ctx.remove }, t("insp.delete"))));
    box.append(E);
    box.scrollTop = keep;
  }
  return { render, hideSuggestions: hideSugg };
}
