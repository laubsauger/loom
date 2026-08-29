import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

/**
 * CodeMirror theme, built entirely from the design tokens (§V17, T20).
 *
 * Not one literal colour lives here: every declaration resolves through a `var()` chain
 * that ends in `src/ui/tokens.css`. CodeMirror styling goes through `EditorView.theme`
 * rather than a CSS module because CodeMirror injects its own base theme through
 * style-mod with a defined precedence — a plain stylesheet would be fighting that
 * ordering, and losing intermittently.
 *
 * ## Syntax hues are aliases, on purpose
 *
 * `tokens.css` is a chrome palette: two greys, four state colours, and the port-family
 * hues that §V26 reserves for edges and ports. Syntax highlighting needs more hues than
 * that, and inventing hex literals in this file is exactly what §V17 forbids. So every
 * syntax role below is declared as a `--syntax-*` alias pointing at an existing token,
 * all of them collected in one block. Track A owns `tokens.css`; when it adds real
 * `--syntax-*` tokens, this block is the only thing that changes, and the fallbacks in
 * `var(--syntax-x, <alias>)` mean a partial migration still renders.
 *
 * Reusing the port-family hues is a compromise, not a design: those hues carry a
 * *semantic* meaning on edges (§V26), and borrowing them for keywords means the same
 * pink means "vector port" in the canvas and "keyword" in the editor. Two different
 * surfaces, so it does not actively mislead, but it is why real tokens are wanted.
 */

/** The alias block. Everything below reads these, and only these. */
const SYNTAX_VARS = {
  "--syntax-comment": "var(--text-dim)",
  "--syntax-keyword": "var(--port-vector)",
  "--syntax-modifier": "var(--port-material)",
  "--syntax-type": "var(--port-texture2d)",
  "--syntax-builtin": "var(--port-geometry)",
  "--syntax-number": "var(--port-audioFeatures)",
  "--syntax-atom": "var(--port-audioFeatures)",
  "--syntax-string": "var(--ok)",
  "--syntax-attribute": "var(--signal)",
  "--syntax-definition": "var(--port-light)",
  "--syntax-variable": "var(--text)",
  "--syntax-operator": "var(--text-dim)",
  "--syntax-punctuation": "var(--text-dim)",
  "--syntax-invalid": "var(--error)",
} as const;

/** `var(--syntax-x, <the alias it currently resolves to>)`. */
function syntaxColor(role: keyof typeof SYNTAX_VARS): string {
  return `var(${role}, ${SYNTAX_VARS[role]})`;
}

export const shaderEditorTheme: Extension = EditorView.theme(
  {
    "&": {
      ...SYNTAX_VARS,
      height: "100%",
      color: "var(--text)",
      backgroundColor: "var(--bg-sunken)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-body)",
    },
    // The shell already draws a focus ring on the editor container; a second ring on
    // the CodeMirror root would double it (§V19).
    "&.cm-focused": { outline: "none" },

    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "var(--lh-prose)",
      overflow: "auto",
    },
    ".cm-content": {
      caretColor: "var(--signal)",
      padding: "var(--space-3) 0",
    },

    ".cm-gutters": {
      backgroundColor: "var(--bg-sunken)",
      color: "var(--line-hot)",
      borderRight: "var(--border-hairline)",
      fontSize: "var(--fs-micro)",
      userSelect: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--space-4) 0 var(--space-3)" },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--bg-hover)",
      color: "var(--text-dim)",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },

    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--signal)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--bg-active)" },
    ".cm-selectionMatch": { backgroundColor: "var(--bg-active)" },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--bg-active)",
      color: "var(--signal)",
      outline: "none",
    },
    "&.cm-focused .cm-nonmatchingBracket": { color: "var(--error)" },

    // Search panel (@codemirror/search) — plain chrome, same tokens as the app's.
    ".cm-panels": {
      backgroundColor: "var(--bg-raise)",
      color: "var(--text)",
      borderTop: "var(--border-hairline)",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--fs-meta)",
    },
    ".cm-panels input, .cm-panels button": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--text)",
      border: "var(--border-hairline)",
      borderRadius: "var(--radius)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-meta)",
    },
    ".cm-searchMatch": { backgroundColor: "var(--bg-active)" },
    ".cm-searchMatch.cm-searchMatch-selected": { outline: "1px solid var(--signal)" },

    // Compilation messages (§V27) render through @codemirror/lint.
    ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "1px dashed var(--error)" },
    ".cm-lintRange-warning": { backgroundImage: "none", borderBottom: "1px dashed var(--warn)" },
    ".cm-lintRange-info": { backgroundImage: "none", borderBottom: "1px dashed var(--text-dim)" },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-raise)",
      color: "var(--text)",
      border: "var(--border-hairline)",
      borderRadius: "var(--radius)",
      boxShadow: "var(--shadow-raise)",
    },
    ".cm-tooltip .cm-diagnostic": {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-micro)",
      padding: "var(--space-2) var(--space-4)",
      borderLeft: "2px solid var(--line-hot)",
    },
    ".cm-tooltip .cm-diagnostic-error": { borderLeftColor: "var(--error)" },
    ".cm-tooltip .cm-diagnostic-warning": { borderLeftColor: "var(--warn)" },
    ".cm-gutter-lint .cm-gutterElement": { padding: "0 var(--space-1)" },
  },
  { dark: true },
);

/**
 * Token colours. The vocabulary matches `WGSL_TOKEN_TABLE` in `wgsl-language.ts` one for
 * one — a tag mapped there and missing here renders as plain text, which is the visible,
 * harmless failure mode.
 */
export const wgslHighlightStyle = HighlightStyle.define(
  [
    { tag: tags.comment, color: syntaxColor("--syntax-comment"), fontStyle: "italic" },
    { tag: tags.string, color: syntaxColor("--syntax-string") },
    { tag: tags.number, color: syntaxColor("--syntax-number") },
    { tag: tags.atom, color: syntaxColor("--syntax-atom") },
    { tag: tags.keyword, color: syntaxColor("--syntax-keyword") },
    { tag: tags.modifier, color: syntaxColor("--syntax-modifier") },
    { tag: tags.typeName, color: syntaxColor("--syntax-type") },
    {
      tag: tags.function(tags.standard(tags.variableName)),
      color: syntaxColor("--syntax-builtin"),
    },
    { tag: tags.annotation, color: syntaxColor("--syntax-attribute") },
    {
      tag: tags.definition(tags.variableName),
      color: syntaxColor("--syntax-definition"),
    },
    { tag: tags.variableName, color: syntaxColor("--syntax-variable") },
    { tag: tags.operator, color: syntaxColor("--syntax-operator") },
    { tag: tags.punctuation, color: syntaxColor("--syntax-punctuation") },
    { tag: tags.bracket, color: syntaxColor("--syntax-punctuation") },
    { tag: tags.invalid, color: syntaxColor("--syntax-invalid") },
  ],
  { themeType: "dark" },
);

/** Theme + highlighting as one extension, the way the editor consumes it. */
export const shaderEditorHighlighting: Extension = [
  shaderEditorTheme,
  syntaxHighlighting(wgslHighlightStyle),
];

/**
 * Syntax roles this track needs from `src/ui/tokens.css` (track A owns that file).
 * Exported so the request is checkable, not just prose in a report.
 */
export const REQUESTED_SYNTAX_TOKENS: readonly string[] = Object.keys(SYNTAX_VARS);
