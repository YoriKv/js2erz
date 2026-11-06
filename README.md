# js2erz

<sub>Simulator based on the [erzstat.site Programmator simulator](https://erzstat.site/programs/prog.html).</sub>

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
- `let` variables, arithmetic and comparisons become VALUE, OPER, COMP and EQ nodes. Functions are inlined, or compiled
  once and shared when that saves nodes; a function that starts with `"use program";` becomes its own program, called
  with a CALL node.
- Export the graph as PNG or SVG, or export JSON for the
  [erzstat.site](https://erzstat.site/programs/) editor.
- Check the program in the built-in simulator before you build it.

Your programs are saved in the browser. **New…** starts one from a blank page or an example; editing a template
saves it as a new program, which you can rename. The **Reference** tab lists the functions, constants and system
variables.

## Run it locally

```sh
python3 -m http.server 8000 --bind 127.0.0.1    # then open http://localhost:8000
```

Credits: the node model and look follow the [erzstat.site Programmator wiki](https://erzstat.site/programs/).
The built-in simulator is based on the original implementation in the [erzstat.site program simulator](https://erzstat.site/programs/prog.html).
JavaScript parsing by [acorn](https://github.com/acornjs/acorn) (MIT); the code editor is [CodeMirror 6](https://codemirror.net) (MIT).

License: [MIT](LICENSE). The bundled acorn parser and CodeMirror keep their own MIT licences (`vendor/acorn.LICENSE`, `vendor/codemirror.LICENSE`).
