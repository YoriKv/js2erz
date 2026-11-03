// Example programs shown in the Examples menu. The first one loads on a first visit.
export const EXAMPLES = [
  {
    id: "tour", title: "Tour: the basics",
    code: `// js2erz: write JavaScript, get the node graph to rebuild in the ERZ Programmator.
// Calls like step() and dig() become nodes. Their outcome steers if / while / switch.
// Hover a node to see its source line; click a line to find its nodes.
"use program Tour";

const ROWS = 3;          // a const with a constant value costs no node
let row = 0;             // a let becomes a variable (VALUE node)

while (row < ROWS) {     // COMP node: > = < outputs
  // dig straight ahead until the bot can't move or dig any more
  while (moveDig() !== "fail");
  turn(row % 2 === 0 ? 90 : -90);   // a ternary in an argument becomes a branch
  row++;                 // OPER node: row = row + 1
}
exit();                  // EXIT SUCCESS
`,
  },
  {
    id: "digForward", title: "Dig forward",
    code: `// Dig forward until something stops the bot.
// MOVEDIG steps when the way is free, otherwise strikes; "fail" ends the loop.
while (moveDig() !== "fail");
`,
  },
  {
    id: "road", title: "Follow a road",
    code: `// Drive along a road: look two cells ahead, step on road, turn left when the road ends.
while (true) {
  aim(2, 0);                         // AIM REL: 2 cells in front
  if (scan(Category.Artificial)) {   // roads are in the Artificial category
    if (!step()) halt();             // halt(): leave the output unconnected (program stops)
  } else {
    turn(-45);
  }
}
`,
  },
  {
    id: "line", title: "Line of length len",
    code: `// Dig a straight tunnel of a given length, then stop with SUCCESS.
let len = 10;
for (let i = 0; i < len; i++) {
  if (moveDig() === "fail") exit(false);   // blocked: EXIT FAIL
  // "dug" means the cell was only struck; strike again instead of counting it
  while (moveDig() === "dug");
}
exit();
`,
  },
  {
    id: "spiral", title: "45° spiral",
    code: `// A square-ish spiral: every grow turns the side gets one cell longer.
const GROW = 4, MAX_LEN = 20;
let len = 1, k = 0;
while (len <= MAX_LEN) {
  for (let i = 0; i < len; i++) moveDig();
  turn(45);
  k++;
  if (k % GROW === 0) len++;
}
`,
  },
  {
    id: "ore", title: "Selective ore miner",
    code: `// Mine only valuable ore cells in front of the bot, walk over everything else.
const ORES = [Cell.DenseOre, Cell.PhosphateRock, Cell.MetallicRock, Cell.SulfideRock];

// Inlined helper: its return value steers the caller's if.
function oreAhead() {
  aim(2, 0);
  scan(Category.Diggable);           // SCAN refreshes scan_cell_front
  return anyOf(scan_cell_front, ...ORES);
}

while (cargo < cargo_max * 0.95) {
  if (oreAhead()) {
    while (dig() === "success");
  } else if (!step()) {
    turnRight();
  }
}
unload(Target.Storage);
`,
  },
  {
    id: "sub", title: "Subprograms (CALL / EXIT)",
    code: `// "use program" turns a function into its own program, reached with CALL.
// Build each program in the game; the CALL node picks it by name.
"use program Square";

function Side(n) {
  "use program";
  for (let i = 0; i < n; i++) {
    if (moveDig() === "fail") return false;   // EXIT FAIL
  }
  return true;                                // EXIT SUCCESS
}

for (const d of [Dir.E, Dir.S, Dir.W, Dir.N]) {   // unrolled at compile time
  rotateTo(d);
  if (!Side(6)) exit(false);
}
`,
  },
  {
    id: "wall", title: "Wall follower",
    code: `// Keep a wall on the right-hand side.
function freeAt(front, right) {
  aim(front, right);
  return scan(Category.Walkable);
}

while (true) {
  if (freeAt(0, 2)) { turnRight(); step(); }
  else if (freeAt(2, 0)) step();
  else turnLeft();
}
`,
  },
  {
    id: "seismic", title: "Seismic: mine, then leave the radius",
    code: `// Seismic hazard: when the rock around a seismic initiator is about 80% mined out, the initiator starts working,
// and about 10 minutes later it breaks the layer: the rock grows back and bots within 40 cells are crushed.
// Programs cannot see buildings, so the break centre is a constant here: the initiator's centre (64, 48).
// To try it, make a 128×96 world in the Simulator tab and click the Initiator brush on the bot's start (64, 48).
// Each round digs lanes over the whole disc, which starts the initiator, then drives out of the radius and waits
// for the break before it digs the new rock.
"use program SeismicLanes";

const CX = 64, CY = 48;         // break centre
const SAFE = 45;                // wait this far from it (the break radius is 40)
const LANES = 26;               // north-south lanes over the disc, each one 3 cells further west
const WAIT = 220000;            // rounds of the wait loop: ~660 s at 1000 nodes per game second (3 nodes a round)

function go() {                 // one cell on, digging the way
  while (moveDig() === "dug");
}
function ahead() {              // the same, or 3 cells to the side (left, else right) if the rock can't be dug
  if (moveDig() === "fail") {
    turnLeft();
    if (moveDig() === "fail") turnAround();
    go(); go(); go();
  }
}
function goTo(tx, ty) {         // x first, then y
  while (x !== tx) { rotateTo(x < tx ? Dir.E : Dir.W); ahead(); }
  while (y !== ty) { rotateTo(y < ty ? Dir.S : Dir.N); ahead(); }
}
function far() {                // outside the break radius, with some margin?
  let dx = x - CX, dy = y - CY;
  return dx * dx + dy * dy > SAFE * SAFE;
}

while (true) {
  // 1. dig the field: lanes from the east edge of the disc to the west edge
  for (let lane = 0; lane < LANES; lane++) {
    let ty = CY - 35;
    if (lane % 2 === 1) ty = CY + 35;
    goTo(CX + 38 - 3 * lane, ty);
  }
  // 2. leave the radius, away from the centre
  while (!far()) {
    rotateTo(x < CX ? Dir.W : Dir.E);
    ahead();
  }
  // 3. wait until the break has passed
  for (let k = 0; k < WAIT; k++) pass();
}
`,
  },
];
