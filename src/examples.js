// Example programs shown in the New… menu. The first one loads on a first visit.
export const EXAMPLES = [
  {
    id: "basic", title: "Basic",
    code: `// Dig out a square: ROWS rows, each 3 cells wide (the bot's width) and COLS cells long.
"use program Basic";

const ROWS = 4, COLS = 12;

function forward(n) {
  for (let i = 0; i < n; i++) while (moveDig() === "dug");
}

for (let row = 0; row < ROWS; row++) {
  forward(COLS - 3);
  if (row < ROWS - 1) {
    turn(row % 2 === 0 ? 90 : -90);
    forward(3);
    turn(row % 2 === 0 ? 90 : -90);
  }
}
exit();
`,
  },
  {
    id: "road", title: "Follow a road",
    code: `// Drive along a road, turning left where it ends.
// Needs a road in front of the bot: paint one in the simulator (generated worlds have no roads).
while (true) {
  aim(2, 0);
  if (scan(Category.Artificial)) {
    if (!step()) halt();
  } else {
    turn(-45);
  }
}
`,
  },
  {
    id: "line", title: "Line of length LEN",
    code: `// Dig a straight tunnel LEN cells long.
const LEN = 10;
let i = 0;
while (i < LEN) {
  switch (moveDig()) {
    case "moved": i++; break;
    case "fail": exit(false);
  }
}
exit();
`,
  },
  {
    id: "spiral", title: "45° spiral",
    code: `const GROW = 4, MAX_LEN = 20;
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
    code: `// Follow valuable ore; with none ahead or beside the bot, dig straight on.
const ORES = [Cell.DenseOre, Cell.SulfideRock, Cell.PhosphateRock, Cell.SilicateRock, Cell.MetallicRock];

function oreAt(front, right) {
  aim(front, right);
  scan(Category.Diggable);
  return anyOf(scan_cell_front, ...ORES);
}

while (cargo < cargo_max * 0.95) {
  if (!oreAt(2, 0)) {
    if (oreAt(0, 2)) turnRight();
    else if (oreAt(0, -2)) turnLeft();
  }
  if (moveDig() === "fail") turnRight();
}
unload(Target.Storage);
`,
  },
  {
    id: "sub", title: "Subprograms (CALL / EXIT)",
    code: `// Each "use program" function is a separate program, run with CALL.
"use program Square";

function Side(n) {
  "use program";
  for (let i = 0; i < n; i++) {
    if (moveDig() === "fail") return false;
  }
  return true;
}

for (const d of [Dir.E, Dir.S, Dir.W, Dir.N]) {
  rotateTo(d);
  if (!Side(6)) exit(false);
}
`,
  },
  {
    id: "wall", title: "Wall follower",
    code: `// Keep a wall on the right.
// Needs open ground along a wall: paint some in the simulator (generated worlds box the bot in with rock).
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
