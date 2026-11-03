// Build: npm i codemirror @codemirror/{view,state,language,commands,autocomplete,lint,search,lang-javascript} @lezer/highlight esbuild
//        npx esbuild codemirror.entry.js --bundle --format=esm --minify --legal-comments=none --outfile=codemirror.mjs
// CodeMirror 6 for js2erz: the parts src/codeedit.js uses, bundled into one module (vendor/codemirror.mjs).
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  highlightSpecialChars, rectangularSelection, crosshairCursor, Decoration, ViewPlugin, GutterMarker, gutter, gutterLineClass, hoverTooltip } from "@codemirror/view";
export { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment, EditorSelection } from "@codemirror/state";
export { history, defaultKeymap, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
export { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxTree, indentUnit } from "@codemirror/language";
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, snippetCompletion } from "@codemirror/autocomplete";
export { lintGutter, setDiagnostics, lintKeymap } from "@codemirror/lint";
export { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
export { javascript } from "@codemirror/lang-javascript";
export { tags } from "@lezer/highlight";
