// Node geometry in canvas pixels. Node x, y are stored in grid cells; one cell is U px.
import { T } from "./nodes.js";

export const U = 64;
export const HDR = 26;          // header band height
export const PORT_ROW = 23;     // vertical distance between output ports
export const PORT_BOT = 20;     // distance of the lowest port from the node bottom

export const tiny = n => T[n.t].size[0] === 1;
export const sizePx = n => { const s = T[n.t].size; return [s[0] * U, s[1] * U]; };
export function portPos(n, i) {
  const [w, h] = sizePx(n), k = T[n.t].outs.length;
  if (tiny(n)) return [n.x * U + w, n.y * U + h / 2];
  return [n.x * U + w, n.y * U + h - PORT_BOT - (k - 1 - i) * PORT_ROW];
}
export function inPos(n) {
  const [, h] = sizePx(n);
  return [n.x * U, n.y * U + (tiny(n) ? h / 2 : h - PORT_BOT)];
}
// offsets inside the node, for layout before x/y are known
export const portOffY = (t, i) => {
  const [, h] = T[t].size.map(v => v * U), k = T[t].outs.length;
  return T[t].size[0] === 1 ? h / 2 : h - PORT_BOT - (k - 1 - i) * PORT_ROW;
};
export const inOffY = t => { const h = T[t].size[1] * U; return T[t].size[0] === 1 ? h / 2 : h - PORT_BOT; };
