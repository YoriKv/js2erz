# js2erz

Write a bot program for **ERZ Online** in JavaScript and get a picture of the Programmator node graph, so you can rebuild it
in the game.

**Open it:** https://yorikv.github.io/js2erz/

```js
while (cargo < cargo_max * 0.95) {
  aim(2, 0);
  if (scan(Category.Rare)) { while (dig() === "success"); }
  else if (!step()) turnRight();
}
unload(Target.Storage);
```

- Each built-in call (`step()`, `dig()`, `moveDig()`, `scan(…)`, `turn(90)`, `aim(2, 0)`, …) becomes one node. What the call
  returns is the output the node took, so `if`, `while` and `switch` route the arrows.
- `let` variables, arithmetic and comparisons become VALUE, OPER, COMP and EQ nodes. Functions are inlined; a function
  that starts with `"use program";` becomes its own program, called with a CALL node.
- Export the graph as PNG or SVG, copy the numbered build list, or export JSON for the
  [erzstat.site](https://erzstat.site/programs/) editor.
- Check the program in the built-in simulator before you build it.

The **Reference** tab lists every function, constant and system variable, and the **Examples** menu has programs to start from.

## Run it locally

```sh
python3 -m http.server 8000    # then open http://localhost:8000
```

Credits: the node model and look follow the [erzstat.site Programmator wiki](https://erzstat.site/programs/).
JavaScript parsing by [acorn](https://github.com/acornjs/acorn) (MIT).

License: [MIT](LICENSE). The bundled acorn parser keeps its own MIT licence (`vendor/acorn.LICENSE`).
