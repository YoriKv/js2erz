// Node types, enums and the graph IR shared by the compiler, layout, renderer, simulator and exporters.
//
// IR
//   Program  { name, params: string[], nodes: Node[] }       nodes[0] is always the START node
//   Node     { id, t, x, y, outs: (id|null)[], p, src? }     id = index in nodes; x, y in grid cells
//   Operand  { var: "name" } | { num: 1.5 } | { cell: "DenseOre" } | null     null = empty field (editor); exported as {var: null, const: null}
//
// Node params (p) per type:
//   start {params}            rotA/rotR {dir}            aimA/aimR {front, right}
//   scan {category}           use {item}                 inv {target, positive}
//   call {program, args}      exit {fail}                assign {varname, value}
//   oper {varname, op, left, right}                      cmp {left, right}
//   eq {value, set}           cell {value, category}     move/dig/movedig/cargo/pass {}

export const COL = { w: "#FFFFFF", r: "#E5484D", b: "#3E8BFF", g: "#3FBF5F", y: "#F59E0B" };
export const TITLE = "#FFE4A3";

// Colours follow the game client (as documented by the erzstat.site Programmator wiki).
// outs: [key, label, colour], top to bottom = output index. ok: outputs that count as "true" in a condition.
// size: [w, h] in grid cells. tech: what the in-game editor needs to show the node.
export const T = {
  start:   { label: "START",     bg: "#4D4D4D", body: "#8A8A8A", size: [2, 2], outs: [["next", "next", COL.w]], ok: [0] },
  rotA:    { label: "ROT ABS",   fun: "FunRotate", rel: false, bg: "#414893", body: "#20254C", size: [2, 2], outs: [["done", "done", COL.w]], ok: [0], key: "R" },
  rotR:    { label: "ROT REL",   fun: "FunRotate", rel: true,  bg: "#414893", body: "#20254C", size: [2, 2], outs: [["done", "done", COL.w]], ok: [0], key: "R" },
  move:    { label: "STEP",      fun: "FunMove", bg: "#166196", body: "#094062", size: [2, 2], outs: [["success", "success", COL.w], ["fail", "fail", COL.r]], ok: [0], key: "F" },
  dig:     { label: "DIG",       fun: "FunDig", bg: "#B2542F", body: "#442519", size: [2, 2], outs: [["success", "success", COL.w], ["cantDig", "can't dig", COL.r], ["nothingToDig", "nothing to dig", COL.b]], ok: [0], key: "B" },
  movedig: { label: "MOVEDIG",   fun: "FunMoveDig", bg: "#B2742F", body: "#442F19", size: [2, 2], outs: [["moved", "moved", COL.w], ["dug", "dug", COL.g], ["fail", "fail", COL.r]], ok: [0, 1], key: "B", tech: "Move-dig setting" },
  use:     { label: "USE",       fun: "FunUseItem", bg: "#6F7E3E", body: "#2E341A", size: [2, 2], outs: [["success", "success", COL.w], ["fail", "fail", COL.r], ["noItem", "no item", COL.b]], ok: [0], key: "E" },
  inv:     { label: "INVENTORY", fun: "FunInventoryOperation", bg: "#2992A0", body: "#13434A", size: [2, 2], outs: [["success", "success", COL.w], ["fail", "fail", COL.r], ["boxLocked", "box is locked", COL.y]], ok: [0], key: "I" },
  cargo:   { label: "AUTOCARGO", fun: "FunAutoCargo", bg: "#00A09A", body: "#01423F", size: [2, 2], outs: [["success", "success", COL.w], ["fail", "fail", COL.r]], ok: [0], key: "I" },
  aimA:    { label: "AIM ABS",   fun: "FunAim", rel: false, bg: "#259559", body: "#1D3127", size: [2, 2], outs: [["done", "done", COL.w]], ok: [0], key: "Q" },
  aimR:    { label: "AIM REL",   fun: "FunAim", rel: true,  bg: "#259559", body: "#1D3127", size: [2, 2], outs: [["done", "done", COL.w]], ok: [0], key: "Q" },
  scan:    { label: "SCAN",      fun: "FunScan", bg: "#644E84", body: "#322840", size: [2, 2], outs: [["pass", "pass", COL.g], ["fail", "fail", COL.r]], ok: [0], key: "Q" },
  pass:    { label: ".",         fun: "FunPassthrough", bg: "#4A4A4A", body: "#3A3A3A", size: [1, 1], outs: [["next", "next", COL.w]], ok: [0], key: "P" },
  call:    { label: "CALL",      fun: "FunCallProgram", bg: "#A064DB", body: "#3B2752", size: [2, 2], outs: [["success", "success", COL.w], ["fail", "fail", COL.r], ["halt", "halt", COL.y]], ok: [0], key: "G", tech: "Subroutines" },
  exit:    { label: "EXIT",      fun: "FunExitProgram", bg: "#05B047", body: "#202020", size: [1, 1], outs: [], ok: [], key: "G", tech: "Subroutines" },
  assign:  { label: "VALUE",     fun: "FunVarAssignValue", bg: "#EEEEEE", body: "#7D7D7D", fg: "#181C24", size: [3, 2], outs: [["success", "success", COL.w], ["fail", "fail", COL.y]], ok: [0], key: "T", tech: "Variables" },
  oper:    { label: "OPER",      fun: "FunVarAssignOperation", bg: "#EEEEEE", body: "#7D7D7D", fg: "#181C24", size: [3, 3], outs: [["success", "success", COL.w], ["fail", "fail", COL.y]], ok: [0], key: "T", tech: "Variables" },
  cmp:     { label: "COMP",      fun: "FunCompare", bg: "#292929", body: "#131313", size: [3, 2], outs: [["gt", ">", COL.g], ["eq", "=", COL.w], ["lt", "<", COL.r], ["fail", "fail", COL.y]], ok: [], key: "T", tech: "Variables" },
  eq:      { label: "EQ",        fun: "FunEqualsAnyOf", bg: "#292929", body: "#131313", size: [3, 2], outs: [["match", "match", COL.g], ["mismatch", "mismatch", COL.r]], ok: [0], key: "T", tech: "Variables" },
  cell:    { label: "CELL",      fun: "FunIsCellInCathegory", bg: "#292929", body: "#131313", size: [2, 2], outs: [["match", "match", COL.g], ["mismatch", "mismatch", COL.r]], ok: [0], key: "T", tech: "Variables" },
};
export const FUN_TO_TYPE = (fun, rel) => {
  if (!fun) return null;
  if (fun === "FunRotate") return rel ? "rotR" : "rotA";
  if (fun === "FunAim") return rel ? "aimR" : "aimA";
  return Object.keys(T).find(k => T[k].fun === fun) || null;
};
export const PALETTE = [
  ["Movement", ["rotA", "rotR", "move", "dig", "movedig"]],
  ["Aim and scan", ["aimA", "aimR", "scan"]],
  ["Items", ["use", "inv", "cargo"]],
  ["Control", ["pass", "call", "exit"]],
  ["Variables", ["assign", "oper", "cmp", "eq", "cell"]],
];
export const DEFAULTS = {
  start: () => ({ params: [] }),
  rotA: () => ({ dir: 0 }), rotR: () => ({ dir: 2 }),
  aimA: () => ({ front: -2, right: 0 }), aimR: () => ({ front: 2, right: 0 }),
  scan: () => ({ category: "Diggable" }), use: () => ({ item: "Block" }),
  inv: () => ({ target: "Storage", positive: true }),
  call: () => ({ program: "", args: [] }), exit: () => ({ fail: false }),
  assign: () => ({ varname: "a", value: { num: 0 } }),
  oper: () => ({ varname: "i", op: "Plus", left: { var: "i" }, right: { num: 1 } }),
  cmp: () => ({ left: { var: "i" }, right: { num: 0 } }),
  eq: () => ({ value: { var: "scan_cell_front" }, set: [] }),
  cell: () => ({ value: { var: "scan_cell_front" }, category: "Diggable" }),
};

// ---------------------------------------------------------------- enums (game client)
// Directions: 0 east, clockwise, y grows south.
export const DIRS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
export const DIR_NAMES = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
export const DIR_ARROW = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
export const REL_ROT = { [-3]: "−135°", [-2]: "−90°", [-1]: "−45°", 1: "+45°", 2: "+90°", 3: "+135°", 4: "180°" };
export const OPS = ["Plus", "Minus", "Mult", "Div", "Mod"];
export const OP_SYM = { Plus: "+", Minus: "−", Mult: "×", Div: "÷", Mod: "mod" };

// cell categories, in game order
export const CATEGORIES = ["Walkable", "Diggable", "DiggableHard", "Bombable", "Extractable", "Artificial", "Pushable", "Falling", "Damaging", "Rare"];
// labels the in-game editor shows for the categories it offers
export const CATEGORY_LABEL = { Walkable: "Walkable", Diggable: "Diggable", DiggableHard: "Hard", Bombable: "Bombable", Extractable: "Extractable",
  Artificial: "Artificial", Pushable: "Pushable", Falling: "Falling", Damaging: "Damaging", Rare: "Rare" };

// cell types, in game order (46 values)
export const CELLS = ["Unknown", "Empty", "Service", "ServiceWalkableCorner", "ServiceWalkableFull", "ServiceDiggable",
  "ServiceDiggableWalkableCorner", "Darkness", "ServiceHiddenEmpty", "Blank", "Hole", "Back", "BackBurning", "Road", "FedRoad",
  "TectonicMass", "MetallicCrust", "Regolith", "Chondrite", "Breccia", "SinterCrust", "SulfideRock", "MetallicRock",
  "PhosphateRock", "DenseOre", "SilicateRock", "ConsolidatedRock", "WaterIce", "CarbonaceousRock", "CryoIce", "PressurizedIce",
  "ReactiveSulfide", "BlockFed", "BlockSimple", "BlockMetal", "BlockMilitary0", "BlockMilitary1", "BlockMilitary2",
  "BlockMilitary3", "BlockEnergy0", "BlockEnergy1", "BlockEnergy2", "TechHole", "BlackHole", "BackWorn", "Protofluid"];

// which cells belong to each category (game rules)
export const CATEGORY_CELLS = {
  Walkable: ["Empty", "ServiceWalkableFull", "Blank", "Hole", "Back", "BackBurning", "Road", "FedRoad", "TechHole", "BlackHole", "BackWorn", "Protofluid"],
  Diggable: ["ServiceDiggable", "ServiceDiggableWalkableCorner", "Darkness", "Regolith", "Chondrite", "Breccia", "SinterCrust", "SulfideRock",
    "MetallicRock", "PhosphateRock", "DenseOre", "SilicateRock", "ConsolidatedRock", "WaterIce", "CarbonaceousRock", "CryoIce", "PressurizedIce",
    "ReactiveSulfide", "BlockSimple", "BlockMetal", "BlockMilitary0", "BlockMilitary1", "BlockMilitary2", "BlockMilitary3", "BlockEnergy0",
    "BlockEnergy1", "BlockEnergy2"],
  DiggableHard: ["MetallicCrust", "SinterCrust", "ConsolidatedRock"],
  Bombable: ["Road", "MetallicCrust", "Regolith", "Chondrite", "Breccia", "SinterCrust", "SulfideRock", "MetallicRock", "PhosphateRock", "DenseOre",
    "SilicateRock", "ConsolidatedRock", "WaterIce", "CarbonaceousRock", "CryoIce", "PressurizedIce", "ReactiveSulfide"],
  Extractable: ["Regolith", "Chondrite", "Breccia", "ConsolidatedRock", "SinterCrust", "MetallicRock", "SulfideRock", "PhosphateRock",
    "SilicateRock", "CarbonaceousRock", "WaterIce", "CryoIce", "DenseOre"],
  Artificial: ["Road", "FedRoad", "BlockFed", "BlockSimple", "BlockMetal", "BlockMilitary0", "BlockMilitary1", "BlockMilitary2", "BlockMilitary3",
    "BlockEnergy0", "BlockEnergy1", "BlockEnergy2"],
  Pushable: [], Falling: [],
  Damaging: ["BlockMilitary0", "BlockMilitary1", "BlockMilitary2", "BlockMilitary3"],
  Rare: ["SilicateRock", "PhosphateRock", "SulfideRock", "DenseOre"],
};
export const cellInCategory = (cell, cat) => (CATEGORY_CELLS[cat] || []).includes(cell);

export const ITEMS = ["Block", "RoadSector", "SmallBuildPack", "MediumBuildPack", "LargeBuildPack", "MiningCharge", "GeoRadar"];
// inventory targets. positive = true moves this bot's cargo to the target; false takes from the target.
export const INV_TARGETS = ["Bot", "Storage", "Box"];

// system variables
export const BUILTIN_VARS = ["rnd", "x", "y", "dir", "hp", "energy", "cargo", "hp_max", "energy_max", "cargo_max", "hp_p", "energy_p", "cargo_p",
  "zone_pvp", "aim_rel", "aim_x", "aim_y", "aim_right", "aim_front", "auto_attack_miners", "auto_attack_mobs", "auto_war",
  "scan_cell_front", "scan_cell_back", "scan_base", "scan_box", "scan_box_mine", "scan_box_other", "scan_bot", "scan_bot_mine",
  "scan_bot_other", "scan_mob"];
// system variables a program may assign (aim_x / aim_y move the aim, auto_* toggle combat)
export const WRITABLE_BUILTINS = ["aim_x", "aim_y", "aim_right", "aim_front", "auto_attack_miners", "auto_attack_mobs", "auto_war"];
export const NODE_LIMIT = 1000;

// ---------------------------------------------------------------- text helpers
export const fmtNum = v => { v = +v; return !Number.isFinite(v) ? "?" : Number.isInteger(v) ? String(v) : String(+v.toFixed(4)); };
export function fmtOperand(o) {
  if (o == null) return "?";
  if (o.var != null) return o.var;
  if (o.num != null) return fmtNum(o.num);
  if (o.cell != null) return o.cell;
  return "?";
}
