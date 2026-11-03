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
];
