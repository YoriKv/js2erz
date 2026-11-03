// Small code editor: a transparent textarea over a highlighted <pre>, with a line gutter and line markers.
const KW = new Set(["let", "const", "var", "if", "else", "while", "do", "for", "of", "in", "break", "continue", "return", "function",
  "switch", "case", "default", "true", "false", "null", "undefined", "new", "typeof"]);
const BUILTINS = new Set(["step", "move", "dig", "moveDig", "rotateTo", "turn", "turnLeft", "turnRight", "turnAround", "aim", "aimAt", "scan",
  "use", "useItem", "unload", "load", "inventory", "autoCargo", "pass", "call", "exit", "fail", "halt", "anyOf", "inCategory", "log"]);
const ENUMS = new Set(["Dir", "Category", "Cell", "Item", "Target", "Math"]);
const SYSVARS = new Set(["rnd", "x", "y", "dir", "hp", "energy", "cargo", "hp_max", "energy_max", "cargo_max", "hp_p", "energy_p", "cargo_p",
  "zone_pvp", "aim_rel", "aim_x", "aim_y", "aim_right", "aim_front", "auto_attack_miners", "auto_attack_mobs", "auto_war",
  "scan_cell_front", "scan_cell_back", "scan_base", "scan_box", "scan_box_mine", "scan_box_other", "scan_bot", "scan_bot_mine",
  "scan_bot_other", "scan_mob"]);
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([^\sA-Za-z_$\d"'`/]+|\/)/g;

export function highlight(src) {
  let out = "", last = 0;
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(src));) {
    out += esc(src.slice(last, m.index));
    const [s, com, str, num, id] = m;
    let cls = null;
    if (com) cls = "com"; else if (str) cls = "str"; else if (num) cls = "num";
    else if (id) {
      const prevDot = src[m.index - 1] === ".";
      if (prevDot) cls = "mem";
      else if (KW.has(id)) cls = "kw"; else if (BUILTINS.has(id) && src.slice(TOKEN.lastIndex).match(/^\s*\(/)) cls = "fn";
      else if (ENUMS.has(id)) cls = "en"; else if (SYSVARS.has(id)) cls = "sv";
    } else cls = "op";
    out += cls ? `<span class="t-${cls}">${esc(s)}</span>` : esc(s);
    last = TOKEN.lastIndex;
  }
  return out + esc(src.slice(last)) + "\n";
}

export function createEditor(root, { value = "", onChange = () => {}, onCursor = () => {} } = {}) {
  root.classList.add("ce");
  root.innerHTML = `<div class="ce-gutter" aria-hidden="true"></div><div class="ce-scroll"><div class="ce-lines" aria-hidden="true"></div><pre class="ce-hl" aria-hidden="true"></pre><div class="ce-sq" aria-hidden="true"></div><textarea class="ce-ta" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="JavaScript source"></textarea></div>`;
  const ta = root.querySelector(".ce-ta"), hl = root.querySelector(".ce-hl"), gutter = root.querySelector(".ce-gutter"),
    scroll = root.querySelector(".ce-scroll"), linesBox = root.querySelector(".ce-lines"), sqBox = root.querySelector(".ce-sq");
  let marks = { err: new Set(), warn: new Set(), hl: new Set(), cur: null };
  let diags = [];            // [{ sev: "err" | "warn", msg, loc: {line, col, endLine, endCol} }]
  const tip = document.createElement("div"); tip.className = "ce-tip"; tip.hidden = true; document.body.append(tip);
  ta.value = value;
  const LH = () => parseFloat(getComputedStyle(ta).lineHeight) || 20;
  function paint() {
    hl.innerHTML = highlight(ta.value);
    const n = ta.value.split("\n").length;
    let g = "";
    const byLine = new Map();
    for (const d of diags) if (d.loc) { const l = byLine.get(d.loc.line) || []; l.push(d); byLine.set(d.loc.line, l); }
    for (let i = 1; i <= n; i++) {
      const ds = byLine.get(i) || [];
      const c = marks.err.has(i) || ds.some(d => d.sev === "err") ? " err" : marks.warn.has(i) || ds.length ? " warn" : "";
      const title = ds.length ? ` title="${esc(ds.map(d => d.msg).join("\n")).replace(/"/g, "&quot;")}"` : "";
      g += `<div class="${c}${marks.hl.has(i) ? " hl" : ""}${marks.cur === i ? " cur" : ""}"${title}>${i}</div>`;
    }
    gutter.innerHTML = g;
    // full-width line backgrounds
    const lh = LH();
    let bg = "";
    const add = (set, cls) => { for (const i of set) bg += `<div class="${cls}" style="top:${(i - 1) * lh}px;height:${lh}px"></div>`; };
    add(marks.hl, "hl"); add(new Set([...marks.err, ...diags.filter(d => d.sev === "err" && d.loc).map(d => d.loc.line)]), "err");
    if (marks.cur) add([marks.cur], "cur");
    linesBox.innerHTML = bg;
    paintSquiggles(lh);
    syncSize();
  }
  // monospace geometry: column -> x, with tabs expanded to the tab size
  let cw = 0;
  const charW = () => {
    if (!cw) { const sp = document.createElement("span"); sp.textContent = "0".repeat(200); hl.append(sp); cw = sp.getBoundingClientRect().width / 200 || 7.8; sp.remove(); }
    return cw;
  };
  const TAB = 2, PADX = 12, PADY = 8;
  const visCol = (text, col) => { let v = 0; for (let i = 0; i < col && i < text.length; i++) v = text[i] === "\t" ? v + TAB - (v % TAB) : v + 1; return v + Math.max(0, col - text.length); };
  function paintSquiggles(lh) {
    const lines = ta.value.split("\n"), w = charW();
    let out = "";
    for (const d of diags) {
      if (!d.loc) continue;
      const { line, col } = d.loc, endLine = d.loc.endLine || line, endCol = d.loc.endCol || col + 1;
      for (let l = line; l <= endLine && l <= lines.length; l++) {
        const text = lines[l - 1] || "";
        const a = l === line ? col - 1 : text.match(/^\s*/)[0].length, b = l === endLine ? endCol - 1 : text.length;
        const x0 = visCol(text, a), x1 = Math.max(x0 + 1, visCol(text, b));
        out += `<div class="${d.sev}" style="left:${PADX + x0 * w}px;top:${PADY + (l - 1) * lh + lh - 4}px;width:${(x1 - x0) * w}px"></div>`;
      }
    }
    sqBox.innerHTML = out;
  }
  // hover: the messages of the diagnostics under the mouse
  function diagsAt(e) {
    const r = ta.getBoundingClientRect(), lh = LH(), w = charW();
    const line = Math.floor((e.clientY - r.top - PADY) / lh) + 1, text = ta.value.split("\n")[line - 1];
    if (text == null) return [];
    const vx = (e.clientX - r.left - PADX) / w;
    let col = 0; while (col < text.length && visCol(text, col + 1) <= vx) col++;
    col += 1;                  // 1-based column under the mouse
    return diags.filter(d => {
      if (!d.loc) return false;
      const { line: l0, col: c0 } = d.loc, l1 = d.loc.endLine || l0, c1 = Math.max(d.loc.endCol || c0 + 1, c0 + 1);
      if (line < l0 || line > l1) return false;
      return (line > l0 || col >= c0) && (line < l1 || col < c1);
    });
  }
  ta.addEventListener("mousemove", e => {
    const ds = diagsAt(e);
    if (!ds.length) { tip.hidden = true; return; }
    tip.replaceChildren(...ds.map(d => { const x = document.createElement("div"); x.className = d.sev; x.textContent = d.msg; return x; }));
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(e.clientX + 12, innerWidth - tw - 8) + "px";
    tip.style.top = (e.clientY + 18 + th > innerHeight ? e.clientY - th - 10 : e.clientY + 18) + "px";
  });
  ta.addEventListener("mouseleave", () => { tip.hidden = true; });
  ta.addEventListener("keydown", () => { tip.hidden = true; });
  function syncSize() {
    hl.style.minHeight = ta.style.height = "0px";
    const h = Math.max(ta.scrollHeight, scroll.clientHeight);
    ta.style.height = hl.style.minHeight = h + "px";
    const w = Math.max(hl.scrollWidth, scroll.clientWidth);
    ta.style.width = w + "px";
    gutter.style.transform = `translateY(${-scroll.scrollTop}px)`;
  }
  scroll.addEventListener("scroll", () => { gutter.style.transform = `translateY(${-scroll.scrollTop}px)`; });
  ta.addEventListener("input", () => { paint(); onChange(ta.value); });
  const cursorLine = () => ta.value.slice(0, ta.selectionStart).split("\n").length;
  const fireCursor = () => onCursor(cursorLine(), ta.selectionStart !== ta.selectionEnd ? ta.value.slice(0, ta.selectionEnd).split("\n").length : null);
  ta.addEventListener("keyup", fireCursor); ta.addEventListener("click", fireCursor);
  ta.addEventListener("keydown", e => {
    const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
    if (e.key === "Tab") {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      if (s === en && !e.shiftKey) { ta.setRangeText("  ", s, en, "end"); }
      else {
        const le = v.indexOf("\n", en - 1) < 0 ? v.length : v.indexOf("\n", en - (en > s && v[en - 1] === "\n" ? 1 : 0));
        const block = v.slice(ls, le);
        const nb = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
        ta.setRangeText(nb, ls, le, "select");
      }
      paint(); onChange(ta.value);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1, ind = v.slice(ls).match(/^ */)[0];
      const extra = /[{([]\s*$/.test(v.slice(ls, s)) ? "  " : "";
      ta.setRangeText("\n" + ind + extra, s, en, "end");
      paint(); onChange(ta.value);
    } else if (e.key === "}" && s === en) {
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      if (/^ +$/.test(v.slice(ls, s))) { e.preventDefault(); ta.setRangeText(v.slice(ls, s).slice(2) + "}", ls, s, "end"); paint(); onChange(ta.value); }
    } else if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1, le = v.indexOf("\n", Math.max(en - 1, s)) < 0 ? v.length : v.indexOf("\n", Math.max(en - 1, s));
      const block = v.slice(ls, le), on = block.split("\n").every(l => /^\s*\/\//.test(l) || !l.trim());
      ta.setRangeText(on ? block.replace(/^(\s*)\/\/ ?/gm, "$1") : block.replace(/^(\s*)/gm, "$1// "), ls, le, "select");
      paint(); onChange(ta.value);
    }
  });
  new ResizeObserver(syncSize).observe(scroll);
  paint();
  return {
    get value() { return ta.value; },
    setValue(v) { ta.value = v; scroll.scrollTop = 0; paint(); },
    setMarks(m) { marks = { ...marks, ...m }; paint(); },
    setDiagnostics(list) { diags = list || []; paint(); },
    reveal(line) {
      const lh = LH(), top = (line - 1) * lh;
      if (top < scroll.scrollTop || top > scroll.scrollTop + scroll.clientHeight - 2 * lh) scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 3);
    },
    select(line, col = 1) {
      const ls = ta.value.split("\n");
      let pos = 0; for (let i = 0; i < line - 1 && i < ls.length; i++) pos += ls[i].length + 1;
      ta.focus(); ta.setSelectionRange(pos + col - 1, pos + col - 1); this.reveal(line); fireCursor();
    },
    focus() { ta.focus(); },
  };
}
