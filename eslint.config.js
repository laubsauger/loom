import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

// §V145 — a domain type whose name is ALSO a DOM/Node global must be imported
// explicitly at every use.
//
// This exists because of a bug that produced no error at all: `vgpu-backend.ts`
// referenced `MediaSource` without importing ours, TypeScript happily resolved the
// DOM's Media Source Extensions interface, and the file typechecked green against
// the WRONG contract. Nothing was red; the type simply meant something else.
//
// The list is OUR names that collide, not every global that could — a blanket rule
// on `Node`, `Event`, `Range` and friends would drown the UI code in false
// positives for legitimate DOM types. ADD A NAME HERE when a domain type starts
// colliding: `Cache` is the next one due, once T237's Cache node lands.
const COLLIDING_DOMAIN_TYPES = new Set(["MediaSource"]);

const v145Plugin = {
  rules: {
    "explicit-colliding-type-import": {
      meta: {
        type: "problem",
        docs: { description: "§V145: import domain types that shadow DOM globals explicitly." },
        schema: [],
      },
      create(context) {
        // Names the FILE introduces itself — by import, or by declaring its own.
        // Either one means the reference cannot silently resolve to the global.
        const local = new Set();
        // Reports are DEFERRED to Program:exit rather than emitted as we walk, because
        // a type may legitimately be used above its own declaration — `backend-types.ts`
        // uses MediaSource at line 174 and declares it at 202. Reporting inline made the
        // rule order-dependent and produced exactly that false positive on its first run.
        const suspects = [];
        return {
          ImportDeclaration(node) {
            for (const specifier of node.specifiers) local.add(specifier.local.name);
          },
          "TSInterfaceDeclaration, TSTypeAliasDeclaration, ClassDeclaration"(node) {
            if (node.id?.name) local.add(node.id.name);
          },
          "TSTypeReference > Identifier"(node) {
            if (COLLIDING_DOMAIN_TYPES.has(node.name)) suspects.push(node);
          },
          "Program:exit"() {
            for (const node of suspects) {
              if (local.has(node.name)) continue;
              context.report({
                node,
                message:
                  `§V145: "${node.name}" is both one of our domain types and a DOM global. ` +
                  "Without an explicit import this resolves to the GLOBAL and typechecks green " +
                  "against the wrong contract — the silence is the bug. Import it explicitly.",
              });
            }
          },
        };
      },
    },
  },
};

// §V834 / T1061 — a backtick inside WGSL text ends the TypeScript template
// literal that holds the shader. Four casualties now; the last one (backticks
// around `mix` in switch.wgsl.ts) 500'd the whole dev bundle and was chased
// TWICE as a transient, because a module that fails to load surfaces in vitest
// as `FAIL [ file ]` with no test failures at all.
//
// WHAT THIS RULE CAN AND CANNOT SEE, stated rather than implied.
//
// The FATAL form is an UNESCAPED backtick: it terminates the template, the rest
// of the shader is read as TypeScript, and the file stops parsing. No lint rule
// ever runs on a file that does not parse — ESLint reports it as a bare
// `Parsing error: ',' expected`, which is red but anonymous, and anonymous is
// how it got chased twice. That half of §V834 is already caught by `pnpm lint`
// and cannot be improved from inside a rule.
//
// What IS reachable, and what this rule owns, is the ESCAPED form `\``: legal
// TypeScript, invisible in review, and one deleted backslash away from the
// fatal one. Every casualty so far started as somebody writing a backtick in
// WGSL prose, so the habit is the thing to remove — there is no correct use of
// a backtick inside a shader string, and the escaped spelling only teaches the
// hand the wrong motion.
//
// An odd-backtick-count heuristic on the file was the cheaper option offered in
// §T1061 and it is NOT what this is, for a measured reason: casualty #4 wrote a
// PAIR of backticks, so the count stayed even and the heuristic would have
// missed the exact bug it was written for. (Every `.wgsl.ts` in the tree has an
// even count today, including while broken.)
const V834_MESSAGE =
  "§V834: a backtick inside a shader's own text ends the TypeScript template literal " +
  "that holds it, and the rest of the WGSL is then read as TypeScript — four builds have " +
  "died this way. Quote the identifier with ' or leave it bare.";

const v834Plugin = {
  rules: {
    "no-backtick-in-shader-text": {
      meta: {
        type: "problem",
        docs: { description: "§V834: no backtick inside a template literal in a .wgsl.ts file." },
        schema: [],
      },
      create(context) {
        const source = context.sourceCode;
        const text = source.getText();
        return {
          TemplateElement(node) {
            const raw = node.value.raw;
            if (!raw.includes("`")) return;
            // Report AT THE BACKTICK, not at the template that contains it: a shader
            // string is hundreds of lines long, and a rule that points at line 1 of
            // the quasi leaves the author hunting for the character it just found.
            // The raw text is located by search rather than by arithmetic on the
            // node's range, because whether a TemplateElement's range includes its
            // own delimiters is a parser detail this rule should not depend on.
            const start = text.indexOf(raw, node.range[0]);
            for (let at = raw.indexOf("`"); at >= 0; at = raw.indexOf("`", at + 1)) {
              const index = start < 0 ? node.range[0] : start + at;
              const loc = source.getLocFromIndex(index);
              context.report({
                loc: { start: loc, end: { line: loc.line, column: loc.column + 1 } },
                message: V834_MESSAGE,
              });
            }
          },
        };
      },
    },
  },
};

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

// §V63 / T92: the compiler and runtime must stay movable into a worker with
// OffscreenCanvas (the multi-window Phase 2 transport). DOM globals are the
// dependency that would make that migration a rewrite; the one legitimate
// surface-attachment module adds an explicit ignore here when it lands.
const V63_MESSAGE =
  "§V63: src/compiler/** and src/runtime/** must run in a worker — no DOM globals. " +
  "Surface attachment belongs to the single presentation module, not here.";

// §V29 / T93: the store's mutating half is the command bus's private property.
// `internals`/`raw` reachable anywhere else is the one backdoor around the
// sole-mutation-path invariant, and the only major invariant with no lint.
const V29_MESSAGE =
  "§V29: every mutation goes through AppCommandBus.execute — the graph store's " +
  "internals/raw are reserved for src/domain/commands (and tests).";
const v29RestrictedSyntax = [
  {
    selector: "MemberExpression[property.name='internals']",
    message: `${V29_MESSAGE} (.internals access)`,
  },
  {
    selector: "MemberExpression[object.name=/[Ss]tore$/][property.name='raw']",
    message: `${V29_MESSAGE} (.raw store escape hatch)`,
  },
];

export default tseslint.config(
  {
    // scratchpad/** is scratch API-exploration and probe scripts (plain Node, not
    // part of the app) — not app source, not owned by any track, not lint's concern.
    // SPEC §P directs probes here ("probe ∈ the scratchpad") precisely so a transient
    // file never breaks a gate for every other session in the window it exists.
    //
    // §B153/T762: this entry used to read ".probe/**" and was never moved when the
    // convention did, so `pnpm lint` reported 359 errors of which 357 were throwaway
    // probes. Two real errors sat in that noise for hundreds of commits because the
    // gate had become unreadable (§V752). AN IGNORE LIST HAS TO MOVE WITH THE
    // CONVENTION IT SERVES — if probes move again, this line moves with them.
    ignores: [
      "dist/**",
      // Build output, like dist/. Ignored here as well as in .gitignore: a stray
      // `pnpm build:pages` otherwise reds the shared lint gate with 5000+ errors
      // from minified bundles nobody wrote.
      "dist-pages/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "scratchpad/**",
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
    // T942: the hand-testing scripts in `tools/` are Node programs run from a terminal
    // (`node tools/osc-send.mjs …`), not part of any build. Listed here rather than
    // ignored, because they are code a person reads and edits and should still be linted
    // — they simply have `process`, `console` and `Buffer`.
    files: ["tools/**/*.mjs"],
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
    // T92 / §V63 — compiler and runtime stay worker-ready: no DOM globals.
    // no-restricted-globals is unused by the other configs matching these files,
    // so this cannot clobber anything under flat config's per-rule resolution.
    files: ["src/compiler/**/*.{ts,tsx}", "src/runtime/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "window", message: V63_MESSAGE },
        { name: "document", message: V63_MESSAGE },
      ],
    },
  },
  {
    // T93 / §V29 — no store-internals access outside src/domain/commands.
    // These files already receive vgpuRestrictedSyntax from the base §V3 config;
    // flat config REPLACES a rule's value on overlap rather than merging, so the
    // vgpu selectors must be repeated here or this config would silently drop them.
    files: [
      "src/app/**/*.{ts,tsx}",
      "src/editor/**/*.{ts,tsx}",
      "src/ui/**/*.{ts,tsx}",
      "src/agent/**/*.{ts,tsx}",
      "src/compiler/**/*.{ts,tsx}",
      "src/runtime/**/*.{ts,tsx}",
    ],
    ignores: ["src/runtime/backend/vgpu/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...vgpuRestrictedSyntax, ...v29RestrictedSyntax],
    },
  },
  {
    // T244 / §V145 — domain types that shadow a DOM global need an explicit import.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { v145: v145Plugin },
    rules: {
      "v145/explicit-colliding-type-import": "error",
    },
  },
  {
    // T1061 / §V834 — no backtick inside the shader text itself.
    //
    // ONE FILE IS EXEMPT AND IT IS NOT AN OVERSIGHT. `time-grid.wgsl.ts` has an
    // escaped backtick inside `TIME_GRID_CELL_WGSL`, which is interpolated into
    // three customWgsl sources that are stored VERBATIM in generated documents
    // (`examples/components/TimeGrid.loom.json`, `examples/E51-Chorus.loom.json`).
    // Deleting the backtick changes the shader string, so `sync.test.ts` goes red
    // until the examples are regenerated — and a starter component regenerates
    // only on the UNSCOPED run, which rewrites every example and sweeps whatever
    // other tracks have in flight. Fixing it is therefore a one-line edit plus a
    // full regen, not a lint fix; T1061 leaves it to whoever holds that regen.
    // The other three sites in the tree were fixed with this rule.
    files: ["src/**/*.wgsl.ts"],
    ignores: ["src/examples/shaders/time-grid.wgsl.ts"],
    plugins: { v834: v834Plugin },
    rules: {
      "v834/no-backtick-in-shader-text": "error",
    },
  },
  {
    // T64 / §V44 — no wall-clock reads anywhere under src/nodes/**.
    files: ["src/nodes/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...v44RestrictedSyntax, ...v29RestrictedSyntax],
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
