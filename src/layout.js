// Automatic left-to-right layout (layered / Sugiyama style) for a Program.
// Sets node.x / node.y (grid cells) and returns routes for long forward edges: Map "nodeId:output" -> [[x, y], …] px.
import { T } from "./nodes.js";
import { U, portOffY, inOffY, portPos, inPos } from "./geom.js";

const GAP_X = 1.5 * U;     // between layers
const GAP_Y = 0.6 * U;     // between nodes in a layer
const DUMMY_H = 14;

export function layout(prog, opts = {}) {
  const nodes = prog.nodes, N = nodes.length;
  if (!N) return new Map();
  const edges = [];
  nodes.forEach(a => a.outs.forEach((b, i) => { if (b != null && nodes[b]) edges.push({ a: a.id, i, b }); }));

  // 1. back edges by DFS from the start node (then from anything left over)
  const state = new Array(N).fill(0), disc = new Array(N).fill(-1);
  let tick = 0;
  const back = new Set();
  const outE = Array.from({ length: N }, () => []);
  edges.forEach((e, k) => outE[e.a].push(k));
  const dfs = root => {
    const stack = [[root, 0]];
    state[root] = 1; disc[root] = tick++;
    while (stack.length) {
      const top = stack[stack.length - 1], [v, k] = top;
      if (k < outE[v].length) {
        top[1]++;
        const e = edges[outE[v][k]];
        if (state[e.b] === 1) back.add(outE[v][k]);
        else if (state[e.b] === 0) { state[e.b] = 1; disc[e.b] = tick++; stack.push([e.b, 0]); }
      } else { state[v] = 2; stack.pop(); }
    }
  };
  dfs(0);
  for (let v = 0; v < N; v++) if (!state[v]) dfs(v);
  const fwd = edges.filter((_, k) => !back.has(k));

  // 2. longest-path layering over the forward edges
  const indeg = new Array(N).fill(0);
  fwd.forEach(e => indeg[e.b]++);
  const layer = new Array(N).fill(0), q = [];
  for (let v = 0; v < N; v++) if (!indeg[v]) q.push(v);
  const outF = Array.from({ length: N }, () => []);
  fwd.forEach(e => outF[e.a].push(e));
  for (let k = 0; k < q.length; k++) {
    const v = q[k];
    for (const e of outF[v]) { layer[e.b] = Math.max(layer[e.b], layer[v] + 1); if (--indeg[e.b] === 0) q.push(e.b); }
  }

  // 2b. wrap a long chain of layers into bands stacked top to bottom
  const band = bandsFor(nodes, layer, fwd, opts.wrap !== false);
  const nB = Math.max(...band) + 1;
  const cross = fwd.filter(e => band[layer[e.a]] !== band[layer[e.b]]).concat(edges.filter((e, k) => back.has(k) && band[layer[e.a]] !== band[layer[e.b]]));

  // 3. items per layer (real nodes + dummies for long edges); links between adjacent layers
  const items = nodes.map(n => ({ id: n.id, node: n, layer: layer[n.id], h: T[n.t].size[1] * U, w: T[n.t].size[0] * U, key: disc[n.id], y: 0 }));
  const links = [];     // {s, so (source offset y), t, to (target offset y), w}
  const chains = [];    // {edge, dummies}
  for (const e of fwd) {
    if (band[layer[e.a]] !== band[layer[e.b]]) continue;
    const span = layer[e.b] - layer[e.a];
    const so = portOffY(nodes[e.a].t, e.i), to = inOffY(nodes[e.b].t), w = e.i === 0 ? 2 : 1;
    if (span === 1) { links.push({ s: items[e.a], so, t: items[e.b], to, w }); continue; }
    let prev = items[e.a], prevOff = so;
    const ds = [];
    for (let L = layer[e.a] + 1; L < layer[e.b]; L++) {
      const d = { dummy: true, layer: L, h: DUMMY_H, w: 0, key: disc[e.a] + e.i * 0.01, y: 0 };
      items.push(d); ds.push(d);
      links.push({ s: prev, so: prevOff, t: d, to: DUMMY_H / 2, w: 2 });
      prev = d; prevOff = DUMMY_H / 2;
    }
    links.push({ s: prev, so: prevOff, t: items[e.b], to, w: 2 });
    chains.push({ e, ds });
  }
  const nL = Math.max(...items.map(it => it.layer)) + 1;
  const layers = Array.from({ length: nL }, () => []);
  items.forEach(it => layers[it.layer].push(it));
  layers.forEach(l => l.sort((a, b) => a.key - b.key));
  const inL = new Map(items.map(it => [it, []])), outL = new Map(items.map(it => [it, []]));
  links.forEach(l => { outL.get(l.s).push(l); inL.get(l.t).push(l); });

  // 4. crossing reduction: barycentre sweeps, keep the best order
  const pos = new Map();
  const index = () => layers.forEach(l => l.forEach((it, k) => pos.set(it, k)));
  index();
  const crossings = () => {
    let c = 0;
    for (let L = 0; L + 1 < nL; L++) {
      const ls = links.filter(l => l.s.layer === L).map(l => [pos.get(l.s) + l.so / 1000, pos.get(l.t)]);
      for (let a = 0; a < ls.length; a++) for (let b = a + 1; b < ls.length; b++)
        if ((ls[a][0] - ls[b][0]) * (ls[a][1] - ls[b][1]) < 0) c++;
    }
    return c;
  };
  let best = layers.map(l => l.slice()), bestC = crossings();
  for (let it = 0; it < 8 && bestC > 0; it++) {
    const down = it % 2 === 0;
    const order = down ? [...Array(nL).keys()].slice(1) : [...Array(nL).keys()].reverse().slice(1);
    for (const L of order) {
      const bary = new Map();
      for (const v of layers[L]) {
        const ls = down ? inL.get(v) : outL.get(v);
        if (!ls.length) { bary.set(v, pos.get(v)); continue; }
        let s = 0, w = 0;
        for (const l of ls) { const o = down ? l.s : l.t; s += (pos.get(o) + (down ? l.so / 1000 : 0)) * l.w; w += l.w; }
        bary.set(v, s / w);
      }
      layers[L].sort((a, b) => bary.get(a) - bary.get(b) || a.key - b.key);
      layers[L].forEach((v, k) => pos.set(v, k));
    }
    const c = crossings();
    if (c < bestC) { bestC = c; best = layers.map(l => l.slice()); }
  }
  best.forEach((l, L) => { layers[L] = l; });
  index();

  // 5. vertical placement: stack, then pull each item toward its neighbours (isotonic regression keeps order + gaps)
  for (const l of layers) { let y = 0; for (const it of l) { it.y = y; y += it.h + GAP_Y; } }
  const place = (l, desired) => {
    // minimise sum w (y - d)^2 subject to y[k] >= y[k-1] + h[k-1] + gap  (pool adjacent violators)
    const off = []; let acc = 0;
    l.forEach((it, k) => { off.push(acc); acc += it.h + (k < l.length - 1 ? gapAfter(it, l[k + 1]) : 0); });
    const blocks = [];
    l.forEach((it, k) => {
      let b = { sum: (desired[k] - off[k]) * 1, w: 1, n: 1, start: k };
      b.v = b.sum / b.w;
      while (blocks.length && blocks[blocks.length - 1].v > b.v) {
        const p = blocks.pop();
        b = { sum: p.sum + b.sum, w: p.w + b.w, n: p.n + b.n, start: p.start };
        b.v = b.sum / b.w;
      }
      blocks.push(b);
    });
    for (const b of blocks) for (let k = b.start; k < b.start + b.n; k++) l[k].y = b.v + off[k];
  };
  const sweep = down => {
    const order = down ? [...Array(nL).keys()] : [...Array(nL).keys()].reverse();
    for (const L of order) {
      const l = layers[L];
      const desired = l.map(v => {
        const ls = down ? inL.get(v) : outL.get(v);
        if (!ls.length) return v.y;
        let s = 0, w = 0;
        for (const k of ls) {
          const d = down ? k.s.y + k.so - k.to : k.t.y + k.to - k.so;
          s += d * k.w; w += k.w;
        }
        return s / w;
      });
      place(l, desired);
    }
  };
  for (let k = 0; k < 6; k++) sweep(k % 2 === 0);
  sweep(true);

  // 6. x per layer (restarting in every band), bands stacked with room for the edges that run between them
  const lw = layers.map(l => Math.max(0, ...l.map(it => it.w)));
  // lanes: gap g lies below band g (g = -1: above band 0); the left column carries edges that skip bands
  const gapLanes = new Map(), laneOf = new Map();
  let leftCols = 0;
  const takeLane = g => { const k = gapLanes.get(g) || 0; gapLanes.set(g, k + 1); return k; };
  for (const e of cross) {
    const sb = band[layer[e.a]], tb = band[layer[e.b]];
    const r = { sb, tb, gA: sb, kA: takeLane(sb) };
    if (!(tb === sb + 1)) { r.gB = tb - 1; r.kB = takeLane(tb - 1); r.col = leftCols++; }
    laneOf.set(e, r);
  }
  const LEFT = leftCols ? 24 + leftCols * 9 : 0;
  const lx = []; let x = LEFT, prevBand = 0;
  for (let L = 0; L < nL; L++) {
    if (band[L] !== prevBand) { x = LEFT; prevBand = band[L]; }
    lx.push(x); x += lw[L] + GAP_X + extraGap(layers[L], links);
  }
  const gapH = g => (gapLanes.get(g) ? 0.8 * U + gapLanes.get(g) * 9 : 0) + (g >= 0 && g < nB - 1 ? 1.2 * U : 0);
  const bandTop = [], bandBot = [], regionStart = new Map();
  let yAcc = 0;
  regionStart.set(-1, 0); yAcc += gapH(-1);
  for (let b = 0; b < nB; b++) {
    const its = items.filter(it => band[it.layer] === b);
    const y0 = Math.min(...its.map(it => it.y)), y1 = Math.max(...its.map(it => it.y + it.h));
    for (const it of its) it.y += yAcc - y0;
    bandTop.push(yAcc); bandBot.push(yAcc + y1 - y0);
    yAcc += y1 - y0;
    regionStart.set(b, yAcc);
    yAcc += gapH(b);
  }
  for (const it of items) if (!it.dummy) { it.node.x = lx[it.layer] / U; it.node.y = it.y / U; }

  const routes = new Map();
  for (const { e, ds } of chains) {
    const pts = [];
    for (const d of ds) { const yc = d.y + DUMMY_H / 2; pts.push([lx[d.layer] - GAP_X * 0.25, yc], [lx[d.layer] + lw[d.layer] + GAP_X * 0.25, yc]); }
    routes.set(`${e.a}:${e.i}`, pts);
  }
  const laneY = (g, k) => regionStart.get(g) + (g >= 0 && g < nB - 1 ? 0.6 * U : 0.4 * U) + k * 9;
  for (const e of cross) {
    const r = laneOf.get(e), a = nodes[e.a], b = nodes[e.b];
    const [x1, y1] = portPos(a, e.i), [x2, y2] = inPos(b), s = 12 + e.i * 6;
    const gA = laneY(r.gA, r.kA);
    const pts = r.col == null
      ? [[x1 + s, y1], [x1 + s, gA], [x2 - 16, gA], [x2 - 16, y2]]
      : [[x1 + s, y1], [x1 + s, gA], [LEFT - 16 - r.col * 9, gA], [LEFT - 16 - r.col * 9, laneY(r.gB, r.kB)], [x2 - 16, laneY(r.gB, r.kB)], [x2 - 16, y2]];
    routes.set(`${e.a}:${e.i}`, { poly: true, pts });
  }
  return routes;
}

// Cut the layers into bands so the picture is not one long strip. Cuts go where few edges cross.
function bandsFor(nodes, layer, fwd, wrap) {
  const nL = Math.max(...layer) + 1;
  const lw = new Array(nL).fill(0), lh = new Array(nL).fill(0);
  nodes.forEach(n => { const L = layer[n.id]; lw[L] = Math.max(lw[L], T[n.t].size[0] * U); lh[L] += T[n.t].size[1] * U + GAP_Y; });
  const cum = [0];
  for (let L = 0; L < nL; L++) cum.push(cum[L] + lw[L] + GAP_X);
  const TW = cum[nL], H = Math.max(3 * U, ...lh) * 1.3;
  const k = wrap ? Math.max(1, Math.min(nL, Math.round(Math.sqrt(TW / (H * 1.8))))) : 1;
  const band = new Array(nL).fill(0);
  if (k < 2 || TW < 2600) return band;
  const crossing = c => fwd.reduce((a, e) => a + (layer[e.a] < c && layer[e.b] >= c ? 1 : 0), 0);
  const cuts = [];
  for (let j = 1; j < k; j++) {
    const ideal = TW * j / k;
    let best = null, bestCost = Infinity;
    for (let c = (cuts[cuts.length - 1] || 0) + 2; c < nL - 1; c++) {
      const d = Math.abs(cum[c] - ideal) / TW;
      if (d > 0.12) { if (cum[c] > ideal) break; continue; }
      const cost = crossing(c) + d * 20;
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (best != null) cuts.push(best);
  }
  let b = 0;
  for (let L = 0; L < nL; L++) { if (cuts.includes(L)) b++; band[L] = b; }
  return band;
}

const gapAfter = (a, b) => (a.dummy && b.dummy) ? 6 : (a.dummy || b.dummy) ? GAP_Y * 0.6 : GAP_Y;
// layers whose nodes fan out to many targets get a little more room for the arrows
function extraGap(l, links) {
  let n = 0;
  for (const it of l) if (!it.dummy) n = Math.max(n, links.filter(k => k.s === it).length);
  return Math.max(0, n - 2) * 12;
}
