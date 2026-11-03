// SVG rendering of a Program in the look of the in-game Programmator.
// Used by the interactive canvas and by the PNG / SVG export.
import { T, COL, TITLE, DIRS, DIR_ARROW, REL_ROT, OP_SYM, CATEGORY_LABEL, fmtOperand } from "./nodes.js";
import { U, HDR, sizePx, tiny, portPos, inPos } from "./geom.js";

export const FONT = `"Tektur", "Bahnschrift", "Arial Narrow", "Roboto Condensed", sans-serif`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const colKey = c => Object.keys(COL).find(k => COL[k] === c) || "w";
const V_COL = TITLE, C_COL = "#4CE36A", BAD = "#FF5A4E";

// ---------------------------------------------------------------- edges
function bezier(x1, y1, x2, y2) {
  const dx = Math.max(30, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
function roundPath(pts, r = 10) {
  pts = pts.filter((p, k) => k === 0 || Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) > 0.5);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const [px, py] = pts[k - 1], [cx, cy] = pts[k], [nx, ny] = pts[k + 1];
    const d1 = Math.hypot(cx - px, cy - py), d2 = Math.hypot(nx - cx, ny - cy), rr = Math.min(r, d1 / 2, d2 / 2);
    d += ` L${cx + (px - cx) / d1 * rr},${cy + (py - cy) / d1 * rr} Q${cx},${cy} ${cx + (nx - cx) / d2 * rr},${cy + (ny - cy) / d2 * rr}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0]},${l[1]}`;
}
function smoothThrough(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let k = 1; k < pts.length; k++) {
    const [x1, y1] = pts[k - 1], [x2, y2] = pts[k];
    if (Math.abs(y2 - y1) < 0.5) { d += ` L${x2},${y2}`; continue; }
    const dx = Math.max(20, (x2 - x1) / 2);
    d += ` C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  return d;
}
// Edges that go backwards (loops) run around the nodes they would cross, above or below.
function makeRouter(prog) {
  const boxes = prog.nodes.map(n => { const [w, h] = sizePx(n); return [n.x * U, n.y * U, n.x * U + w, n.y * U + h]; });
  const lanesUsed = [];
  return function backPath(a, i, b) {
    const [x1, y1] = portPos(a, i), [x2, y2] = inPos(b), s = 12 + i * 6;
    const lo = Math.min(x2 - 16, x1), hi = Math.max(x1 + s, x2);
    if (a === b) return roundPath([[x1, y1], [x1 + s, y1], [x1 + s, a.y * U - 12 - i * 6], [x2 - 16, a.y * U - 12 - i * 6], [x2 - 16, y2], [x2, y2]]);
    // obstacles: nodes in the x range that form one vertical cluster with the two ends (other bands stay out)
    let top = Math.min(y1, y2), bot = Math.max(y1, y2);
    const inX = boxes.filter(([bx0, , bx1]) => bx1 > lo && bx0 < hi);
    for (let changed = true; changed;) {
      changed = false;
      for (const [, by0, , by1] of inX) if (by1 > top - 40 && by0 < bot + 40 && (by0 < top || by1 > bot)) { top = Math.min(top, by0); bot = Math.max(bot, by1); changed = true; }
    }
    const yRef = (y1 + y2) / 2;
    const above = yRef - top <= bot - yRef;
    let lane = above ? top - 16 : bot + 16;
    // keep parallel loops apart
    for (let k = 0; k < 40; k++) {
      if (!lanesUsed.some(u => Math.abs(u.y - lane) < 6 && u.hi > lo && u.lo < hi)) break;
      lane += above ? -7 : 7;
    }
    lanesUsed.push({ y: lane, lo, hi });
    return roundPath([[x1, y1], [x1 + s, y1], [x1 + s, lane], [x2 - 16, lane], [x2 - 16, y2], [x2, y2]]);
  };
}
export function edgePath(prog, a, i, b, routes, router) {
  const [x1, y1] = portPos(a, i), [x2, y2] = inPos(b);
  const r = routes && routes.get(`${a.id}:${i}`);
  if (r && r.poly) return roundPath([[x1, y1], ...r.pts, [x2, y2]]);
  if (r && r.length && r[0][0] > x1 - 1 && r[r.length - 1][0] < x2 + 1) return smoothThrough([[x1, y1], ...r, [x2, y2]]);
  if (a !== b && x2 > x1 + 24) return bezier(x1, y1, x2, y2);
  return router(a, i, b);
}

// ---------------------------------------------------------------- node bodies
function shade(hex, k, bg = [0x1d, 0x18, 0x14]) {
  const c = parseInt(hex.slice(1), 16), v = [c >> 16, (c >> 8) & 255, c & 255];
  return "#" + v.map((x, i) => Math.round(x * k + bg[i] * (1 - k)).toString(16).padStart(2, "0")).join("");
}
const text = (x, y, s, { size = 15, fill = TITLE, anchor = "middle", weight = 400, opacity } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="central" font-weight="${weight}"${opacity ? ` opacity="${opacity}"` : ""}>${esc(s)}</text>`;
const fit = (s, max) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
// text shrunk to fit a width: font size down to `min`, then squeezed with textLength
const CHAR_W = 0.6;
function fitText(x, y, s, maxW, o = {}) {
  s = String(s);
  const size = o.size || 15, min = o.min || 10;
  let fs = size, est = s.length * fs * CHAR_W;
  if (est > maxW) { fs = Math.max(min, Math.floor(maxW / (s.length * CHAR_W) * 10) / 10); est = s.length * fs * CHAR_W; }
  const squeeze = est > maxW ? ` textLength="${Math.floor(maxW)}" lengthAdjust="spacingAndGlyphs"` : "";
  return text(x, y, s, { ...o, size: fs }).replace("<text ", `<text${squeeze} `);
}
// one line if it fits at 11px or more, else two lines split at the middle space
function itemText(x, y, s, maxW) {
  const sp = [...s.matchAll(/ /g)].map(m => m.index);
  if (s.length * 11 * CHAR_W <= maxW || !sp.length) return fitText(x, y, s, maxW, { size: 12, min: 9 });
  const k = sp.reduce((a, b) => (Math.abs(b - s.length / 2) < Math.abs(a - s.length / 2) ? b : a));
  return fitText(x, y - 5, s.slice(0, k), maxW, { size: 11, min: 9 }) + fitText(x, y + 8, s.slice(k + 1), maxW, { size: 11, min: 9 });
}
// Words drawn on nodes. graphSvg / exportSvg take an optional `labels` object that overrides any of these
// (the app passes the chosen UI language); the defaults are the English names.
export const EN_LABELS = {
  node: t => T[t].label,                      // header title
  cat: c => CATEGORY_LABEL[c] || c,           // SCAN / CELL category
  dir: d => DIRS[d],                          // ROT ABS direction letters
  item: i => i,                               // USE item
  target: x => x,                             // INVENTORY target
  bot: () => "bot",                           // INVENTORY: this bot
  outTip: (t, key, label) => label,           // output tooltip
};

function tokenLine(tokens, cx, y, w, size = 19) {
  const chars = tokens.reduce((a, [s]) => a + String(s ?? "?").length + 1, 0);
  const fs = Math.max(11, Math.min(size, Math.floor((w - 14) / (chars * 0.56))));
  const tsp = tokens.map(([s, kind]) => {
    const fill = s == null ? BAD : kind === "v" ? V_COL : kind === "c" ? C_COL : kind === "o" ? "#F2EBDD" : TITLE;
    return `<tspan fill="${fill}">${esc(s == null ? "?" : s)}</tspan>`;
  }).join(" ");
  return `<text x="${cx}" y="${y}" font-size="${fs}" font-weight="600" text-anchor="middle" dominant-baseline="central" stroke="#0d0f13" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${tsp}</text>`;
}
const tok = o => o == null ? [null, "v"] : o.var != null ? [o.var, "v"] : [fmtOperand(o), "c"];

function icon(n, cx, cy) {
  const p = n.p || {};
  const sty = (stroke = TITLE, w = 3) => `fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
  const st = sty();
  switch (n.t) {
    case "start": return `<path d="M${cx - 11},${cy - 15} L${cx + 15},${cy} L${cx - 11},${cy + 15} Z" fill="${TITLE}"/>`;
    case "move": return `<path d="M${cx - 18},${cy} H${cx + 12} M${cx + 2},${cy - 11} L${cx + 14},${cy} L${cx + 2},${cy + 11}" ${sty(TITLE, 4)}/>`;
    case "dig": return drill(cx, cy, st);
    case "movedig": return `<path d="M${cx - 24},${cy + 12} H${cx - 6} M${cx - 12},${cy + 6} L${cx - 5},${cy + 12} L${cx - 12},${cy + 18}" ${st}/>` + drill(cx + 6, cy - 6, st, 0.8);
    case "cargo": return `<path d="M${cx - 16},${cy - 7} H${cx + 14} M${cx + 7},${cy - 13} L${cx + 14},${cy - 7} L${cx + 7},${cy - 1} M${cx + 16},${cy + 9} H${cx - 14} M${cx - 7},${cy + 3} L${cx - 14},${cy + 9} L${cx - 7},${cy + 15}" ${st}/>`;
    case "pass": return `<circle cx="${cx}" cy="${cy}" r="7" fill="${TITLE}"/>`;
    case "exit": return p.fail
      ? `<path d="M${cx - 8},${cy - 8} L${cx + 8},${cy + 8} M${cx + 8},${cy - 8} L${cx - 8},${cy + 8}" ${sty("#fff", 4)}/>`
      : `<path d="M${cx - 10},${cy} l6,7 l12,-14" ${sty("#fff", 4)}/>`;
  }
  return "";
}
function drill(cx, cy, st, k = 1) {
  const s = v => v * k;
  return `<path d="M${cx - s(16)},${cy - s(9)} H${cx + s(2)} L${cx + s(16)},${cy} L${cx + s(2)},${cy + s(9)} H${cx - s(16)} Z M${cx - s(6)},${cy - s(9)} L${cx + s(2)},${cy + s(9)} M${cx + s(4)},${cy - s(8)} L${cx + s(8)},${cy + s(6)}" ${st}/>`;
}
// 7x7 aim grid: bot body in the middle, target cell highlighted
function aimGrid(n, cx, cy) {
  const p = n.p, rel = n.t === "aimR", cs = 6, o = cx - 3.5 * cs, oy = cy - 3.5 * cs;
  let s = "";
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const gx = c - 3, gy = r - 3, body = Math.abs(gx) <= 1 && Math.abs(gy) <= 1;
    const hit = rel ? (p.right === gx && p.front === -gy) : (p.right === gx && p.front === gy);
    s += `<rect x="${o + c * cs + 0.5}" y="${oy + r * cs + 0.5}" width="${cs - 1}" height="${cs - 1}" fill="${hit ? C_COL : body ? "#5a6390" : "#2f3a33"}"/>`;
  }
  if (rel) s += `<path d="M${cx},${oy - 5} l-4,4 h8 z" fill="${TITLE}"/>`;
  return s;
}

function nodeBody(n, w, h, L) {
  const p = n.p || {}, small = tiny(n), top = small ? 0 : HDR;
  const cx = w / 2, cy = top + (h - top) / 2 - (small ? 0 : 4);
  switch (n.t) {
    case "assign": return tokenLine([[p.varname, "v"], ["=", "o"], tok(p.value)], cx, cy, w, 21);
    case "oper": return tokenLine([[p.varname, "v"], ["=", "o"]], cx, cy - 16, w, 21) + tokenLine([tok(p.left), [OP_SYM[p.op] || "?", "o"], tok(p.right)], cx, cy + 16, w, 21);
    case "cmp": return tokenLine([tok(p.left), ["?", "o"], tok(p.right)], cx, cy, w, 21);
    case "eq": {
      const set = (p.set || []).map(fmtOperand);
      const rows = [];
      let cur = "";
      for (const v of set) { if (cur && (cur + ", " + v).length > 20) { rows.push(cur + ","); cur = v; } else cur = cur ? cur + ", " + v : v; }
      if (cur || !rows.length) rows.push(cur || "∅");
      const shown = rows.length > 2 ? [rows[0], rows[1].replace(/,?$/, " …")] : rows;
      return tokenLine([tok(p.value), ["∈", "o"]], cx, cy - (shown.length === 2 ? 18 : 12), w, 18) +
        shown.map((r, k) => tokenLine([[r, "c"]], cx, cy + (shown.length === 2 ? 2 + k * 17 : 12), w, 14)).join("");
    }
    case "cell": return tokenLine([tok(p.value)], cx, cy - 14, w, 16) + tokenLine([["∈", "o"], [L.cat(p.category), "c"]], cx, cy + 12, w, 15);
    case "aimA": case "aimR": {
      const sg = v => `${v > 0 ? "+" : ""}${v}`;
      const t1 = n.t === "aimR" ? `F ${sg(p.front)}  R ${sg(p.right)}` : `X ${sg(p.right)}  Y ${sg(p.front)}`;
      return aimGrid(n, cx, cy - 8) + text(cx, cy + 26, t1, { size: 13 });
    }
    case "rotA": {
      const d = ((p.dir % 8) + 8) % 8;
      return `<g transform="translate(${cx},${cy - 6}) rotate(${d * 45})"><circle r="17" fill="none" stroke="${TITLE}" stroke-opacity=".35" stroke-width="2"/><path d="M-11,0 H11 M3,-8 L12,0 L3,8" fill="none" stroke="${TITLE}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></g>` + text(cx, cy + 26, DIR_ARROW[d] + " " + L.dir(d), { size: 13 });
    }
    case "rotR": {
      const d = p.dir, cw = d > 0 || d === 4;
      const arc = cw ? `M${cx - 12},${cy - 2} A13,13 0 1 1 ${cx + 6},${cy + 6}` : `M${cx + 12},${cy - 2} A13,13 0 1 0 ${cx - 6},${cy + 6}`;
      const head = cw ? `M${cx + 9},${cy - 3} L${cx + 6},${cy + 7} L${cx - 3},${cy + 4}` : `M${cx - 9},${cy - 3} L${cx - 6},${cy + 7} L${cx + 3},${cy + 4}`;
      return `<path d="${arc} ${head}" fill="none" stroke="${TITLE}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-10)"/>` + text(cx, cy + 22, REL_ROT[d] || String(d), { size: 15 });
    }
    case "scan": return `<g transform="translate(${cx},${cy - 10})"><circle r="15" fill="none" stroke="${TITLE}" stroke-width="2.5"/><circle r="7" fill="none" stroke="${TITLE}" stroke-width="2"/><path d="M0,0 L11,-11" stroke="${TITLE}" stroke-width="2.5" stroke-linecap="round"/></g>` + fitText(cx, cy + 22, L.cat(p.category), w - 10, { size: 13 });
    case "use": return `<path d="M${cx - 12},${cy - 18} h24 v20 h-24 z M${cx - 12},${cy - 10} h24" fill="none" stroke="${TITLE}" stroke-width="2.5" stroke-linejoin="round"/>` + itemText(cx - 10, cy + 20, p.item ? L.item(p.item) : "?", w - 38);   // left of the output pills
    case "inv": {
      const from = p.positive ? L.bot() : L.target(p.target), to = p.positive ? L.target(p.target) : L.bot();
      return fitText(cx, cy - 18, from, w - 10, { size: 15 }) + text(cx, cy, "↓", { size: 15 }) + fitText(cx, cy + 18, to, w - 10, { size: 15 });
    }
    case "call": return text(cx, cy - 12, "▶▶", { size: 16 }) + text(cx, cy + 8, fit(p.program || "?", 14), { size: 14 }) +
      (p.args && p.args.length ? text(cx, cy + 26, fit(`(${p.args.map(fmtOperand).join(", ")})`, 16), { size: 11, fill: V_COL }) : "");
    case "start": return icon(n, cx, cy) + (p.params && p.params.length ? text(cx, cy + 26, fit(p.params.join(", "), 14), { size: 12, fill: V_COL }) : "");
    default: return icon(n, cx, cy);
  }
}

// output glyph: ✓ success-like, × failure-like, symbols for COMP, a pill when the colour alone is ambiguous
const PILLS = { nothingToDig: "empty", dug: "dug", noItem: "none", boxLocked: "lock", halt: "halt", cantDig: "cant" };
function portGlyph(key, lx, ly, col, active) {
  if (PILLS[key]) {
    const s = PILLS[key], pw = s.length * 7.2 + 12, x0 = lx - pw + 10;
    return { svg: `<rect x="${x0}" y="${ly - 9}" width="${pw}" height="18" rx="9" fill="${active ? "#3a3326" : "#15110e"}" stroke="${col}" stroke-width="${active ? 3 : 2}"/>` +
      `<text x="${x0 + pw / 2}" y="${ly + 0.5}" font-size="11.5" font-weight="600" fill="${col}" text-anchor="middle" dominant-baseline="central">${s}</text>`, ex: x0 + pw + 4 };
  }
  let g = `<circle cx="${lx}" cy="${ly}" r="8" fill="#15110e" stroke="${col}" stroke-width="${active ? 3.5 : 2}"/>`;
  if (key === "gt" || key === "eq" || key === "lt") g += `<text x="${lx}" y="${ly + 0.5}" font-size="12" font-weight="700" fill="${col}" text-anchor="middle" dominant-baseline="central">${esc({ gt: ">", eq: "=", lt: "<" }[key])}</text>`;
  else if (/fail|mismatch/i.test(key)) g += `<path d="M${lx - 3.5},${ly - 3.5} l7,7 M${lx + 3.5},${ly - 3.5} l-7,7" stroke="${col}" stroke-width="2" stroke-linecap="round"/>`;
  else g += `<path d="M${lx - 4},${ly + 0.5} l2.8,2.8 l5.2,-5.6" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return { svg: g, ex: lx + 11 };
}

function nodeSvg(n, index, o) {
  const t = T[n.t], [w, h] = sizePx(n), small = tiny(n), L = o.labels;
  const fg = t.fg || TITLE;
  let g = `<g data-node="${n.id}" transform="translate(${n.x * U},${n.y * U})"${o.interactive ? ` style="cursor:move"` : ""}>`;
  if (o.current === n.id) g += `<rect x="-7" y="-7" width="${w + 14}" height="${h + 14}" fill="none" stroke="#3fbf5f" stroke-width="4" rx="4"/>`;
  if (o.sel && o.sel.has(n.id)) g += `<rect x="-5" y="-5" width="${w + 10}" height="${h + 10}" fill="none" stroke="${TITLE}" stroke-width="2" stroke-dasharray="6 4" rx="3"/>`;
  if (o.hl && o.hl.has(n.id)) g += `<rect x="-5" y="-5" width="${w + 10}" height="${h + 10}" fill="${TITLE}" fill-opacity=".12" stroke="#7fb4ff" stroke-width="2.5" rx="3"/>`;
  const edgeCol = n.t === "exit" ? (n.p.fail ? "#D93A35" : "#1FA246") : t.bg;
  g += `<rect width="${w}" height="${h}" fill="${t.body || shade(t.bg, 0.45)}"/>`;
  if (!small) g += `<rect width="${w}" height="${HDR}" fill="${t.bg}"/>`;
  g += `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="${edgeCol}" stroke-width="2"/>`;
  if (!small) {
    const room = w - 13 - (String(index).length * 6.6 + 6);
    g += fitText(7, HDR / 2 + 1, L.node(n.t), room, { size: 16, min: 11, fill: fg, anchor: "start" });
    g += text(w - 6, HDR / 2 + 1, String(index), { size: 11, fill: fg, anchor: "end", opacity: ".55" });
  } else g += text(w / 2, -8, String(index), { size: 11, fill: TITLE, opacity: ".6" });
  g += nodeBody(n, w, h, L);
  if (n.t !== "start") {
    const iy = inPos(n)[1] - n.y * U, has = o.linked.has(n.id);
    g += `<circle cx="0" cy="${iy}" r="7" fill="${has ? "#fff" : "#2a2f45"}" stroke="${has ? "#fff" : "#6b7088"}" stroke-width="1.5"/>`;
  }
  n.outs.forEach((tid, i) => {
    const [px, py] = portPos(n, i), [key, label, col] = t.outs[i] || ["?", "?", "#888"];
    const lx = px - n.x * U, ly = py - n.y * U;
    const act = o.activePort && o.activePort.id === n.id && o.activePort.i === i;
    const pg = portGlyph(key, lx, ly, col, act);
    g += `<g class="port" data-port="${n.id}:${i}"${o.interactive ? ` style="cursor:crosshair"` : ""}><title>${esc(L.outTip(n.t, key, label))}</title>${pg.svg}`;
    if (tid == null && n.t !== "start") g += `<text x="${pg.ex}" y="${ly + 0.5}" font-size="11" font-weight="600" fill="${col}" dominant-baseline="central">END</text>`;
    g += `</g>`;
  });
  return g + `</g>`;
}

// ---------------------------------------------------------------- whole graph
export function arrowDefs(prefix = "") {
  let d = "";
  for (const [k, c] of Object.entries(COL))
    d += `<marker id="${prefix}ah-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1L8,5L1,9" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></marker>`;
  return d;
}
// o: {routes, sel, selEdge, current, hl, activePort, interactive, prefix, labels}
export function graphSvg(prog, o = {}) {
  const prefix = o.prefix || "";
  const byId = new Map(prog.nodes.map(n => [n.id, n]));
  const index = new Map(prog.nodes.map((n, i) => [n.id, i]));
  const linked = new Set();
  prog.nodes.forEach(a => a.outs.forEach(t => { if (t != null) linked.add(t); }));
  const router = makeRouter(prog);
  let edges = "", hits = "";
  for (const a of prog.nodes) a.outs.forEach((tid, i) => {
    if (tid == null) return;
    const b = byId.get(tid); if (!b) return;
    const col = (T[a.t].outs[i] || [0, 0, COL.w])[2], d = edgePath(prog, a, i, b, o.routes, router);
    const isSel = o.selEdge && o.selEdge.id === a.id && o.selEdge.i === i;
    edges += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${isSel ? 4 : 2.6}" stroke-opacity="${isSel ? 1 : 0.9}" marker-end="url(#${prefix}ah-${colKey(col)})"/>`;
    if (o.interactive) hits += `<path data-edge="${a.id}:${i}" d="${d}" fill="none" stroke="transparent" stroke-width="12" style="cursor:pointer"/>`;
  });
  const labels = { ...EN_LABELS, ...(o.labels || {}) };
  const nodes = prog.nodes.map(n => nodeSvg(n, index.get(n.id), { ...o, linked, labels })).join("");
  return { defs: arrowDefs(prefix), body: edges + hits + nodes };
}
export function graphBounds(prog, routes) {
  if (!prog.nodes.length) return { x: 0, y: 0, w: U, h: U };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of prog.nodes) {
    const [w, h] = sizePx(n);
    x0 = Math.min(x0, n.x * U); y0 = Math.min(y0, n.y * U); x1 = Math.max(x1, n.x * U + w + 44); y1 = Math.max(y1, n.y * U + h);
  }
  if (routes) for (const r of routes.values()) for (const [x, y] of (r.poly ? r.pts : r)) { x0 = Math.min(x0, x - 10); y0 = Math.min(y0, y - 10); x1 = Math.max(x1, x + 10); y1 = Math.max(y1, y + 10); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// standalone SVG document for export
export function exportSvg(prog, o = {}) {
  const { defs, body } = graphSvg(prog, { routes: o.routes, prefix: "x", labels: o.labels });
  const b = graphBounds(prog, o.routes), pad = 60, head = o.title ? 56 : 0;
  // loops routed around the graph can leave the node box; leave room for them
  const W = Math.ceil(b.w + 2 * pad), H = Math.ceil(b.h + 2 * pad + head);
  const tx = pad - b.x, ty = pad + head - b.y;
  const grid = o.grid !== false ? `<pattern id="xgp" width="${U}" height="${U}" patternUnits="userSpaceOnUse" patternTransform="translate(${tx % U},${ty % U})"><path d="M${U} 0H0V${U}" fill="none" stroke="#33281f" stroke-width="1"/></pattern>` : "";
  const title = o.title ? `<text x="${pad}" y="${pad * 0.5 + 18}" font-size="26" fill="${TITLE}" font-weight="700">${esc(o.title)}</text>` +
    (o.subtitle ? `<text x="${pad}" y="${pad * 0.5 + 46}" font-size="14" fill="#a8988a">${esc(o.subtitle)}</text>` : "") : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>` +
    `<defs>${defs}${grid}</defs><rect width="${W}" height="${H}" fill="#1d1814"/>${grid ? `<rect width="${W}" height="${H}" fill="url(#xgp)"/>` : ""}` +
    `${title}<g transform="translate(${tx},${ty})">${body}</g></svg>`;
}
