import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
//
// T1705b: `@vgpu/*` is behind the same boundary. vgpu 0.6.0 takes prepared shaders, and
// `prepareShader` comes from `@vgpu/wgsl`, a direct dependency since then.
const vgpuRestrictedSyntax = [
  {
    selector: "ImportExpression[source.value=/^@?vgpu(\\/|$)/]",
    message: `${V3_MESSAGE} (dynamic import)`,
  },
  {
    selector: "ImportDeclaration[source.value=/^@?vgpu\\//]",
    message: `${V3_MESSAGE} (subpath import)`,
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/^@?vgpu(\\/|$)/]",
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

// §V901 / T1103: the local DEVICE BRIDGE is not an agent surface, and the
// dependency runs ONE way — src/mcp/** imports src/devices/**, src/app's
// use-*-bridge hooks import src/devices/**, and neither consumer reaches the
// other through it.
//
// This rule exists because the inversion T1103 spent a session undoing was
// never forbidden — only never intended. `src/app/use-{osc,laser,vision}-bridge.ts`
// imported `@/mcp/device-client.ts` for years, so a laser DAC, an OSC socket and
// an Apple Vision worker all appeared to depend on an agent protocol, and the
// owner read the refusal text and correctly said it made no sense. A boundary
// defended by a paragraph in CLAUDE.md decays; that is observably this repo's
// history (§B153 is the same shape for an ignore list).
const V901_MESSAGE =
  "§V901: src/devices/** is the local device bridge and may not import src/mcp/** — " +
  "the dependency runs MCP → devices, never the reverse. If devices needs something that " +
  "lives under src/mcp/, it is either MCP-shaped (so devices should not need it) or shared " +
  "(so lift it into src/devices/transport/, the way T1103 lifted the wire and the socket).";
// Unanchored on purpose: `../mcp/serve.ts`, `@/mcp/serve.ts` and any depth of
// relative climb all carry an `mcp` path segment, and NOTHING legitimate under
// src/devices/ has one. `patterns` uses gitignore-style semantics, which is the
// hazard the §V3 comment above documents — here that looseness is the feature.
const v901RestrictedMcpPattern = {
  group: ["**/mcp", "**/mcp/**"],
  message: V901_MESSAGE,
};
// MEASURED, not assumed (eslint 10.9.1): `no-restricted-imports` with `patterns` catches
// a static ImportDeclaration and NOTHING ELSE — a red-verify probe carrying all four
// spellings at once showed `import("@/mcp/bridge-host.ts")` passing clean while the two
// static forms failed. That is the §V3 hole in this repo's own history repeating, and here
// it mattered more: `await import("../mcp/bridge-host.ts")` is the spelling already written
// in `device-bridge.test.ts`, so it is the one a future non-test file would copy. Without
// these selectors the rule would have been half-vacuous on landing.
//
// `require` is included because src/devices/** is Node-side in part (the laser and vision
// hosts, the UDP hub), so the CommonJS spelling is reachable there as it is not in the
// browser half. Both regexes require `mcp` as a whole path segment.
const v901RestrictedSyntax = [
  {
    selector: "ImportExpression[source.value=/(^|\\/)mcp\\//]",
    message: `${V901_MESSAGE} (dynamic import)`,
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/(^|\\/)mcp\\//]",
    message: `${V901_MESSAGE} (require)`,
  },
];

// §V1028 / B246 — LAYERING ZONES: a directory (or one module) that may not import another.
//
// B246: `src/domain/parameters/node-references.ts` imported a VALUE from
// `src/domain/presets/morph-index.ts` and read it at module scope. The presets layer imports
// the parameter read path, so that one line closed a cycle, and a constant read across a
// cycle is uninitialised whenever the far side happens to load first: every plain-node entry
// point died at import with `Cannot access 'NO_MORPHS' before initialization`, while Vitest —
// whose files load other modules first — stayed green. The rule it broke was already written
// down, in `resolve.ts`'s own docblock ("this module never imports the presets layer"). A
// boundary defended by a paragraph decays (§V901); these are those paragraphs, as a table.
//
// WHY A RULE OF ITS OWN and not `no-restricted-imports`, which §V3/§V11/§V901 use:
//  - a zone is about where a specifier LANDS, and one target has three spellings here
//    (`../presets/x.ts`, `@domain/presets/x.ts`, `@/domain/presets/x.ts`). This resolves the
//    specifier through the alias table in tsconfig.app.json (the one `src/tooling/alias-hooks.ts`
//    reads) and matches the resolved path, so no gitignore-style pattern has to guess — and
//    none can match a `presets` segment that belongs to somebody else;
//  - it sees every form that reaches a module in one visitor: `import`, `export … from`,
//    `import()`, `require()` and the type query `import("…").T`. The core rule sees static
//    declarations only, which is the hole §V3 and §V901 each had to close by hand;
//  - zones overlap (a file under src/domain/parameters is in three of them) and flat config
//    REPLACES a rule's value on overlap. A rule with its own id cannot be silently dropped by
//    the next `no-restricted-imports` block that happens to match the same files.
//
// TYPE-ONLY IMPORTS ARE REFUSED TOO, and that is a decision, not an oversight. `import type`
// is erased and cannot by itself cause an initialisation-order failure. But:
//  (1) the rule as written is about DIRECTION: the lower layer declares what it needs
//      (`ParameterMorphs`, `ParentBindResolver` in resolve.ts) and the upper layer implements
//      it. A type imported from above moves the declaration's home up, which is the inversion;
//  (2) MEASURED (Node 24 type stripping, which follows `verbatimModuleSyntax`): `import type
//      { X } from` is erased, but `import { type X } from` is NOT — it survives as a bare
//      module load, a real edge that closes the cycle with no value in sight. Two spellings a
//      keystroke apart, one of them harmless, is not a distinction to leave to review.
// Every zone below was already free of both spellings when it landed, so the strict form
// cost nothing.
//
// TESTS ARE EXEMPT for §V901's reason: the boundary is about what PRODUCTION modules reach, a
// test file is always its own first module, and no product entry point's graph contains one.
// `test-support.ts` is NOT a test file here — it is a module other modules import, and it is
// one of the two files B246's fix had to change.
//
// ADD A ZONE when a docblock says "never imports" / "may not import" AND it is true today.
// One that is false today is a refactor, not a lint rule: `src/domain/** ↛ src/compiler/**`
// (stated in presets/morph-index.ts) is the open one — `commands/validate-command.ts` imports
// the compiler, and that edge is what joins the compiler and the domain into one cycle.
const V1028_TYPE_NOTE = "A type-only import is refused too: `import { type X }` still loads the module.";
const LAYERING_ZONES = [
  {
    from: /^src\/domain\/parameters\//,
    to: /^src\/domain\/presets\//,
    message:
      "§V1028: src/domain/parameters/** may not import src/domain/presets/**. The presets layer " +
      "imports the parameter read path, so an import back closes a cycle, and a value read at " +
      "module scope across a cycle is uninitialised whenever the presets layer loads first — " +
      "B246: every plain-node entry point died at import while Vitest stayed green. Fix: declare " +
      "what this layer needs HERE, structurally (as ParameterMorphs and NO_MORPHS are in " +
      `resolve.ts), and let the presets layer implement or re-export it. ${V1028_TYPE_NOTE}`,
  },
  {
    from: /^src\/domain\/parameters\//,
    to: /^src\/domain\/components\//,
    message:
      "§V1028 (§V81 stays one-way): src/domain/parameters/** may not import " +
      "src/domain/components/**. The components layer imports the parameter read path, so an " +
      "import back closes the kind of cycle B246 died of. Fix: declare the seam HERE, " +
      "structurally (as ParentBindResolver is in resolve.ts), and let the components layer " +
      `supply it. ${V1028_TYPE_NOTE}`,
  },
  {
    from: /^src\/domain\//,
    to: /^(src\/(ui|editor)\/|package:(react|react-dom|@xyflow\/react)(\/|$))/,
    message:
      "§V1028 (the domain is headless): src/domain/** may not import src/ui/**, src/editor/**, " +
      "react, react-dom or @xyflow/react. The compiler and the MCP server load the domain under " +
      "plain Node, with no editor and no DOM (resolve.ts, graph/node-box.ts, graph/layout.ts all " +
      "say so). Fix: move what is shared DOWN into src/domain and let the editor import it from " +
      `there. ${V1028_TYPE_NOTE}`,
  },
  {
    from: /^src\/domain\/presets\/cue-list\.ts$/,
    to: /^src\/domain\/presets\/(commands|cue-commands)\.ts$/,
    message:
      "§V1028: src/domain/presets/cue-list.ts may not import ./commands.ts or ./cue-commands.ts. " +
      "commands.ts reads this module's CUE_GO_COMMAND / CUE_BACK_COMMAND at module scope, so an " +
      "import back would make that read happen before the constants exist (B246's shape). Fix: " +
      `keep this module data only; what needs a command belongs in cue-commands.ts. ${V1028_TYPE_NOTE}`,
  },
  {
    from: /^src\/domain\/presets\/morph\.ts$/,
    to: /^src\/(domain\/graph\/|nodes\/registry\/|domain\/parameters\/resolve\.ts$)/,
    message:
      "§V1028: src/domain/presets/morph.ts is data only — no graph, no registry, no resolver. " +
      "graph/names.ts imports it for the rename clause, so anything here that reaches back " +
      "there closes a cycle (B246's shape). Fix: which key fades belongs in morph-index.ts, and " +
      `the blend belongs to the resolver. ${V1028_TYPE_NOTE}`,
  },
];

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const toPosix = (file) => file.split(path.sep).join("/");

/** `["@domain/", "src/domain/"]` pairs, longest prefix first so `@domain/` beats `@/`. */
const ALIAS_TABLE = Object.entries(
  JSON.parse(readFileSync(path.join(REPO_ROOT, "tsconfig.app.json"), "utf8")).compilerOptions.paths,
)
  .map(([pattern, targets]) => [pattern.replace(/\*$/, ""), targets[0].replace(/^\.\//, "").replace(/\*$/, "")])
  .sort((left, right) => right[0].length - left[0].length);

/** Where a specifier lands: a repo-relative path, or `package:<specifier>` for what is not ours. */
function importTarget(filename, specifier) {
  if (specifier.startsWith(".")) {
    return toPosix(path.relative(REPO_ROOT, path.resolve(path.dirname(filename), specifier)));
  }
  for (const [prefix, target] of ALIAS_TABLE) {
    if (specifier.startsWith(prefix)) return path.posix.normalize(`${target}${specifier.slice(prefix.length)}`);
  }
  return `package:${specifier}`;
}

const v1028Plugin = {
  rules: {
    "layering-zone": {
      meta: {
        type: "problem",
        docs: { description: "§V1028: a layer may not import the layer that imports it." },
        schema: [],
      },
      create(context) {
        const file = toPosix(path.relative(REPO_ROOT, context.filename));
        if (/\.test\.tsx?$/.test(file)) return {};
        const zones = LAYERING_ZONES.filter((zone) => zone.from.test(file));
        if (zones.length === 0) return {};
        const check = (node, source) => {
          if (source?.type !== "Literal" || typeof source.value !== "string") return;
          const target = importTarget(context.filename, source.value);
          for (const zone of zones) {
            if (zone.to.test(target)) context.report({ node, message: zone.message });
          }
        };
        return {
          ImportDeclaration: (node) => check(node, node.source),
          ExportNamedDeclaration: (node) => check(node, node.source),
          ExportAllDeclaration: (node) => check(node, node.source),
          ImportExpression: (node) => check(node, node.source),
          // `import("../presets/x.ts").T` in a type position: the same dependency, spelled
          // without a declaration. Where the literal sits has moved between parser versions.
          TSImportType: (node) => check(node, node.source ?? node.argument?.literal),
          "CallExpression[callee.name='require']": (node) => check(node, node.arguments[0]),
        };
      },
    },
  },
};

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
      ".cache/**", // Pinned native dependency sources and runtime build output.
      "dist/**",
      // Build output, like dist/. Ignored here as well as in .gitignore: a stray
      // `pnpm build:pages` otherwise reds the shared lint gate with 5000+ errors
      // from minified bundles nobody wrote.
      "dist-pages/**",
      "node_modules/**",
      ".vite/**", // Worktree-local generated dependency prebundles (T1314/T1321).
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "scratchpad/**",
      // Separate peer checkouts own their validation; never scan them from this tree.
      ".claude/worktrees/**",
      // Generated Python dependencies may contain vendored JavaScript.
      "**/.venv/**",
      // Project deliverables are .loom.json; the perfumery pillar also keeps browser scripts
      // that are not Loom source (art-direction mock-ups, a forked three.js scene under MIT).
      "projects/perfumery-pillar/art-direction/**",
      "projects/perfumery-pillar/tier3/**",
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
    // T1048: `public/coi-sw.js` is the cross-origin isolation service worker. It is copied
    // to the site root verbatim — no bundling, no TypeScript — so it is plain JS with
    // `self`, `clients` and `Response` in scope. Linted rather than ignored: it is the
    // only code in the tree that sits in front of a navigation, which is the last place a
    // silent typo should be allowed to live.
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { ...globals.serviceworker },
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
    // T1103 / §V901 — the device bridge may not import the MCP folder.
    //
    // These files already receive vgpuRestrictedPaths and vgpuRestrictedSyntax from the
    // base §V3 config; flat config REPLACES a rule's value on overlap rather than merging,
    // so both must be repeated here or this config would silently drop §V3 for src/devices/**.
    //
    // WHY THE TESTS ARE EXEMPT, so it is not rediscovered as an oversight: the boundary is
    // about what PRODUCTION code may reach. `device-bridge.test.ts` drives the device bridge
    // through the REAL helper composition (`mcp/serve.ts`, `mcp/bridge-host.ts`) on purpose —
    // that is the evidence the two halves still meet over one socket. A layering rule that
    // forbade the test from composing the real product would force it to compose a fake one,
    // and a fake counterparty proves the callbacks, not the bytes (§V382). The exemption is
    // narrow: a NON-test file under src/devices/** reaching into src/mcp/** is the inversion
    // this rule exists to stop.
    files: ["src/devices/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: vgpuRestrictedPaths, patterns: [v901RestrictedMcpPattern] },
      ],
      "no-restricted-syntax": ["error", ...vgpuRestrictedSyntax, ...v901RestrictedSyntax],
    },
  },
  {
    // B246 / §V1028 — layering zones (LAYERING_ZONES above). A rule with its own id, so no
    // other block's `no-restricted-imports` can replace it on the files they share.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { v1028: v1028Plugin },
    rules: {
      "v1028/layering-zone": "error",
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
