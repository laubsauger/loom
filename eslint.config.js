import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

// §V3: vgpu is pre-1.0 (pinned 0.3.1). Every subpath funnels through the
// backend adapter so a future migration doesn't require touching every file
// that happens to import a renderer primitive.
const V3_MESSAGE =
  "§V3: vgpu imports belong behind the backend adapter at src/runtime/backend/vgpu/ " +
  "— importing vgpu directly elsewhere breaks the adapter boundary that makes a future migration survivable.";
// Exact specifiers, not a glob `patterns` group: `no-restricted-imports`
// matches `patterns` with the `ignore` package's gitignore-style semantics,
// where an unanchored glob like "vgpu/*" matches a "vgpu" path segment at
// ANY depth — including inside a *relative* import such as
// `./vgpu/vgpu-backend.ts`, which is exactly how the backend adapter's own
// index.ts legitimately wires up its files under src/runtime/backend/vgpu/.
// Exact `paths` entries can't collide with a relative specifier like that.
const vgpuRestrictedPaths = ["vgpu", "vgpu/node", "vgpu/mock", "vgpu/scene", "vgpu/client", "vgpu/core"].map(
  (name) => ({ name, message: V3_MESSAGE }),
);

// An exact-specifier allowlist leaves two holes a review probe confirmed open:
// an UNLISTED subpath (`vgpu/webgpu`) and a DYNAMIC `import("vgpu")`, which the
// core no-restricted-imports rule never sees because it only visits static
// ImportDeclaration nodes. These selectors close both. The regex is anchored at
// the start, so a relative `./vgpu/vgpu-backend.ts` still cannot match it —
// which was the original reason for avoiding glob patterns.
const vgpuRestrictedSyntax = [
  {
    selector: "ImportExpression[source.value=/^vgpu(\\/|$)/]",
    message: `${V3_MESSAGE} (dynamic import)`,
  },
  {
    selector: "ImportDeclaration[source.value=/^vgpu\\//]",
    message: `${V3_MESSAGE} (subpath import)`,
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/^vgpu(\\/|$)/]",
    message: `${V3_MESSAGE} (require)`,
  },
];

// §V11: a built-in node must be testable without the visual editor.
const V11_MESSAGE_PREFIX = "§V11: node definitions must run headless — ";
const v11RestrictedPaths = [
  { name: "react", message: `${V11_MESSAGE_PREFIX}react may not be imported under src/nodes/definitions/**.` },
  { name: "react-dom", message: `${V11_MESSAGE_PREFIX}react-dom may not be imported under src/nodes/definitions/**.` },
  {
    name: "@xyflow/react",
    message: `${V11_MESSAGE_PREFIX}@xyflow/react may not be imported under src/nodes/definitions/**.`,
  },
];
const v11RestrictedUiEditorPattern = {
  group: ["@ui/*", "@ui", "@editor/*", "@editor", "**/ui/*", "**/editor/*", "**/src/ui/*", "**/src/editor/*"],
  message: `${V11_MESSAGE_PREFIX}imports from src/ui/ or src/editor/ are forbidden under src/nodes/definitions/**.`,
};

// §V44: time arrives as FrameEvaluationInput. Wall-clock reads inside nodes
// would make a timeline or offline renderer impossible without rewriting
// every node.
const V44_MESSAGE_SUFFIX =
  "§V44: nodes must consume FrameEvaluationInput for time — reading the wall clock directly " +
  "breaks the seam that lets a timeline and an offline renderer exist later without rewriting every node.";
const v44RestrictedSyntax = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: `Date.now() is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: `new Date() is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  {
    selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
    message: `performance.now() is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  {
    selector: "CallExpression[callee.name='requestAnimationFrame']",
    message: `requestAnimationFrame() is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  {
    selector: "CallExpression[callee.object.name='window'][callee.property.name='requestAnimationFrame']",
    message: `requestAnimationFrame() is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  // A review probe confirmed the literal-spelling selectors above are bypassable
  // via a global object prefix or an alias. These close that: any member access
  // of `now` on window/globalThis/self.performance, any rAF on those globals, and
  // any bare reference to the `performance` identifier at all (which also catches
  // `const p = performance; p.now()` at the point of aliasing).
  {
    selector:
      "MemberExpression[object.object.name=/^(window|globalThis|self)$/][object.property.name='performance'][property.name='now']",
    message: `performance.now() via a global object is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  {
    selector:
      "CallExpression[callee.object.name=/^(window|globalThis|self)$/][callee.property.name=/^(requestAnimationFrame|setInterval|setTimeout)$/]",
    message: `Timers and rAF via a global object are forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  {
    selector: "CallExpression[callee.name=/^(setInterval|setTimeout)$/]",
    message: `Timers are forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
  {
    selector:
      "MemberExpression[object.object.name=/^(window|globalThis|self)$/][object.property.name='Date'][property.name='now']",
    message: `Date.now() via a global object is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
  },
];

export default tseslint.config(
  {
    // .probe/** is scratch API-exploration scripts (plain Node, not part of
    // the app) — not app source, not owned by any track, not lint's concern.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".probe/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The "omit a key via destructuring" idiom (`const { x: _dropped, ...rest } = y`)
    // is not a real unused-variable bug — it's how you drop a field from `rest`.
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // Config/tooling files run under Node, not the browser.
    files: ["*.config.{js,ts}", "vitest.workspace.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Cherry-picked rather than eslint-plugin-react-hooks's full
      // "recommended"/"recommended-latest" bundle: this plugin (v7) now
      // ships a large set of React-Compiler-oriented "safety" rules on by
      // default (set-state-in-effect, purity, immutability, etc). This repo
      // doesn't use the React Compiler, and those rules are unrelated to
      // this track's guardrails (T7/T8/T64) — pulling them in would put
      // unrelated, debatable constraints on every other track's React code.
      // Keep the two rules this plugin has always been for.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // "warn" + allowConstantExport matches the react-refresh plugin's own
      // documented Vite-template default (the plugin's bundled "recommended"
      // preset is stricter than that). Radix wrapper files that re-export a
      // primitive as `export const XRoot = XPrimitive.Root` are a legitimate,
      // deliberate pattern this rule can't always see through statically —
      // "warn" surfaces that instead of hard-failing lint over it.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // T7 / §V3 — everywhere under src/ EXCEPT the vgpu adapter itself and
    // src/nodes/definitions/** (which gets a combined rule below so the two
    // no-restricted-imports configs don't clobber each other on overlap).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/runtime/backend/vgpu/**", "src/nodes/definitions/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: vgpuRestrictedPaths }],
      "no-restricted-syntax": ["error", ...vgpuRestrictedSyntax],
    },
  },
  {
    // T8 / §V11, combined with T7 / §V3 for this directory so a single
    // no-restricted-imports config controls both — flat config rule values
    // replace rather than merge across matching configs, so splitting these
    // into two overlapping configs would silently drop one of them here.
    files: ["src/nodes/definitions/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...vgpuRestrictedPaths, ...v11RestrictedPaths],
          patterns: [v11RestrictedUiEditorPattern],
        },
      ],
    },
  },
  {
    // T64 / §V44 — no wall-clock reads anywhere under src/nodes/**.
    files: ["src/nodes/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...v44RestrictedSyntax],
      // Selectors match spellings; this catches the ALIAS (`const p = performance`)
      // by restricting the global identifier itself wherever it is referenced.
      "no-restricted-globals": [
        "error",
        { name: "performance", message: `The performance global is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}` },
        { name: "Date", message: `The Date global is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}` },
        {
          name: "requestAnimationFrame",
          message: `requestAnimationFrame is forbidden in src/nodes/**. ${V44_MESSAGE_SUFFIX}`,
        },
      ],
    },
  },
);
