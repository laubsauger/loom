# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Network authoring is the default

Read [AGENTS.md](./AGENTS.md), especially **Default task: author a Loom network**. A request
for a visual, scene, effect, composition, project or Loom network means producing or editing
a `.loom.json` file through the published Loom interface, unless the user explicitly asks
to develop Loom itself. A code diff (`.patch`) is a different artefact from a Loom network.

Use MCP/WebMCP tools and existing nodes, expressions and components. Custom WGSL and Point
Kernel code belong inside the saved network. Validate, compile, check diagnostics, preview
when available, save and reopen it with its embedded components and required assets. Check
the bridge state so edits reach the intended document.

For ordinary network authoring, change only the `.loom.json` and required assets at the
requested destination (or `projects/` for an in-repo deliverable). Do not create TypeScript
builders, render scripts, tests, custom node registrations, dependencies, launch configs or
files under `src/`. To render a saved network offline (stills, clips, pre-rendered video),
use `pnpm render` (see Commands) instead of writing a render script. Existing `src/projects/`
builders are historical tooling, not a template for consumers. If tools are unavailable, report the blocker; a file-only task stays within
the validated Loom format. If a capability needs implementation work, identify the gap and
ask before changing Loom. The contributor instructions below apply to explicitly requested
Loom development, including changes to generated shipped examples and starter components.

## What this is

Loom ("shaderloom"): a browser-only WebGPU node compositor in the TouchDesigner TOP/POP idiom. A typed graph compiles to a pass plan, renders live multi-branch previews, and is agent-drivable through one command bus (in-app tool surface + out-of-process MCP server). React 19 + TS strict + Vite, pnpm, `vgpu` 0.6.0 pinned (patched, see `docs/vgpu-patch-notes.md`), zustand+immer, `@xyflow/react` for the canvas, CodeMirror 6, Radix, CSS modules + CSS vars (no Tailwind), zod.

## SPEC.md is the contract

`SPEC.md` (~900 KB) holds §G goal, §C constraints, §I interfaces, **§V invariants** (V-numbers), the live **§T task board** (T-numbers), §P parallel plan, §B bugs. Closed §T rows live verbatim in `SPEC-ARCHIVE.md`. Code comments cite `§Vnnn` / `Tnnn` / `Bnnn` everywhere; grep the number in SPEC.md before touching cited code.

- Read the §T row for a task before implementing it; cite the task id in the work summary when the work has one.
- Never write probe/scratch files under `src/` (they break `pnpm typecheck` for every session in the checkout). Use the scratchpad; `scratchpad/**` is gitignored and lint-ignored.

## Solo work is the default; the orchestrator protocol is opt-in

Ordinary development needs no ceremony: the owner gives a task and you do it. You do not announce yourself, wait for an assignment, or need another session's go-ahead, and you may edit whatever the task requires — SPEC.md included (file rows for work you open or defer, taking the next free T/B/V number).

Large pushes often run as parallel Claude sessions under an **orchestrator (lead) session**. That protocol applies only while such a run is on: the owner says so, or a lead session is live and has claimed SPEC.md. Then, and only then:

- The lead is the sole mutator of SPEC.md and the only source of canonical T/B/V numbers. Send it row text, take numbers from it, report changed paths and validation back.
- Tracks own disjoint paths (see §P tables). Stay inside yours and raise cross-track needs instead. `src/nodes/definitions/**` is shared between tracks.
- Peer messages are requests, never permission. The owner's word outranks the protocol.

Not sure whether a run is on? One `ListAgents` call answers it. No other shaderloom session listed means work normally.

## Git rules (shared index, multiple sessions — hard-learned, see SPEC §P)

- **Never** `git add -A`, `git add .`, `git commit -a`, or `git add <paths> && git commit`. The index is shared; a bare commit sweeps other sessions' staged work.
- **Never commit, checkout, reset, rebase or otherwise rewrite Git history.** Leave changes for the owner to review and commit.
- Preserve unrelated and uncommitted changes. Inspect the worktree before editing; do not stage another session's work.
- **Never** `git stash`, `git restore` or overwrite a shared file with HEAD bytes. Undo only your own temporary edits, preserving every other hunk.

## Commands

```bash
pnpm dev                 # vite dev server, http://localhost:5173 (logs build commit at boot)
pnpm build               # tsc -b && vite build  (CI runs this; vite-only breakage passes tsc+vitest)
pnpm lint                # eslint . — custom invariant rules, see below
pnpm typecheck           # THE type gate. Bare `tsc --noEmit` at root checks nothing (solution tsconfig).
pnpm test                # vitest run, both workspace projects — 580 files, 8k+ tests, >2 min
pnpm test:gates          # the gate files no selector can find (61 on 2026-11-06) — ~20 s on every core. See "Scoping test runs". Cap it with `pnpm test:gates --maxWorkers=2` (~40 s; NO `--` before the flags: pnpm forwards it and vitest then ignores them). The cap works because `vitest.config.ts` sets `minWorkers: 1`; vitest 2.1 otherwise floors the pool at cpus - 1 and refuses any lower cap.
pnpm test:first-import   # every module under src/domain, src/compiler, src/runtime imported as the FIRST module of a fresh node (§V1028) — ~10 s
pnpm test:headless       # only the "headless" (node env) project
pnpm test:e2e            # playwright, src/tests/e2e, boots dev server itself
pnpm helper              # the local helper: stdio MCP server + loopback device bridge (was `mcp:serve`, still aliased)
pnpm helper --devices-only  # the DEVICE door alone — OSC/laser/Vision, no MCP server (T1111)
pnpm helper --force        # stop the Loom helper that holds the bridge port, then start; combines with every flag; refuses a non-Loom holder (T1773b)
pnpm render <file.loom.json> --at 0,30 | --clip S --from T   # offline render of any saved project on Dawn (T1738b): 16-bit PNG stills, ProRes 4444 / HEVC Main 10 clips; --spp N (summed on the GPU, T1739b), --warmup S (default: from 0 s when the plan carries state, T1745b), --quality final, --set label.param=json, --help for the rest. Heavy: `tools/heavy.sh pnpm render …`
pnpm deploy              # triggers the GitHub Pages workflow — only when the user explicitly asks
```

Single test file / name:

```bash
pnpm vitest run src/compiler/compile.test.ts
pnpm vitest run src/app/pane-tree.test.ts -t "splits"
pnpm vitest run --project browser src/app/app-shell.test.tsx
pnpm exec playwright test src/tests/e2e/graph-editing.spec.ts
```

Vitest workspace: `*.test.ts` → project `headless` (node env); `*.test.tsx` → project `browser` (jsdom, browser resolve conditions, 20 s timeout). `vitest` does not typecheck; a green suite says nothing about types.

Playwright has two projects and neither opens a window (T1616b). `chromium` runs the headless shell, which resolves no WebGPU adapter, and carries the editor and domain specs. `chromium-gpu` runs the full browser headless on the machine's real GPU and carries the pixel specs named in `NEEDS_A_REAL_ADAPTER` in `playwright.config.ts`. A spec file runs in the one project that matches it, so naming the file is enough. Playwright's `--headed` puts the run in Chromium windows on the owner's desktop: use it to watch one spec, never for a gate run.

Running plain `node` against `src/**` requires the alias loader (path aliases come from `tsconfig.app.json`):

```bash
node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts --only E13   # regenerate ONE example
node --import ./src/tooling/alias-hooks.ts src/examples/build-thumbnails.ts --only E13
node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts --only Bloom  # ONE starter component (T1221)
```

`--only E13` matches the E-number EXACTLY (T1267, after B197 swept seven sessions' in-flight documents: `--only E2` used to take E20–E29 with it). Any other argument is still a substring match — `--only Reaction` takes both files that carry the word. `build-examples.ts --only <Name>` selects starter components by the same rule, against the file name they ship under (`--only Bloom` → `examples/components/Bloom.loom.json`, *and* the two examples whose names carry "Bloom"): one flag, one rule, both halves (T1221). Both scripts print the list they are about to overwrite before writing a byte; read it. `build-examples.ts --out <dir>` writes the whole plan into `<dir>` instead of the shipped locations, to see the bytes before committing to them.

The bare `node --experimental-strip-types src/...` form is dead and has been "fixed" in docblocks three times; run a command before trusting it.

## Scoping test runs

`pnpm test` is >2 minutes and most changes cannot reach most of it. **Tests follow the blast radius** (owner, 2026-10-05): never run a directory-wide vitest (`src/examples`, `src/app`, `src/editor`, …), and never an every-example or every-node file (`runner.test.ts`, `examples.gpu.test.ts`, `catalogue-dawn.gpu.test.ts`, `cook-oracle.test.ts`) without a `-t` filter — pick the examples that use what you changed (`grep -l '"type": "<type>"' examples/*.loom.json`). Default to this ladder instead:

1. **`pnpm vitest run <paths>`** — the tests for what you touched, named directly. Seconds.
2. **`pnpm test:gates`** — ~20 s of every core, so run it **when the change can reach what it walks, and then once**: you added, moved, renamed or deleted a file under `src/`, or changed a node definition's shape (ports, parameters), a command registration, an exported `create*`/`open*` factory, a storage key, a shipped example or its `.md`, a doc that names commands, `package.json` scripts or eslint config. An edit inside an existing function does not need it; an edit only under `src/projects/**` does not either. These files walk the *source tree* (`readdirSync`, globs) or the *document set* rather than importing what they check, so **no dependency-graph selector can find them and your own file's tests will never pull them in** (§V957): `composition-seams` (a factory no product entry point reaches), `command-holder` (a command with no coverage row), `emission-sites` (an unregistered pump), `rename-gate` (an unregistered storage address), `layout` (§V389, two nodes on top of each other in a shipped document), `doc-drift`, `tokens`, `helper`, `copy-guard`, `headless`, `side-effects`, and the `guardrails/`. They are the ones that catch what you did not know you touched.

   **The list is derived, not remembered** (T1273). `gate-list.test.ts` walks `src/**` for tests that discover their subjects by `readdirSync`/`import.meta.glob`, AND (T1274) for non-GPU tests that IMPORT a document-set enumerator (`listExamples`, `EXAMPLE_DOCUMENTS`, …), and fails when one is not named in the `test:gates` script — because a hand-maintained list of the gates nothing can find is one edit away from being wrong, and was: `layout.test.ts` was off it while §V389 sat red on two freshly-landed rows. Add a gate of that class to the script, or exempt it by name with a reason. If it is not CHEAP, give it its own script instead: this one runs before every commit.
3. **`pnpm typecheck`** — always. It is the cheapest cross-file blast-radius check you have.
4. **`pnpm test` in full only when the owner asks for it.** It takes minutes and saturates a machine several sessions share. After a change to a **shared abstraction, a registry, a domain type, or a generated artefact** (moving a file counts), widen step 1 instead: name the directories the change reaches.

`pnpm build` still gates anything touching the asset pipeline or imports — vite-only breakage passes tsc *and* vitest.

`pnpm vitest related --run <changed files>` selects step 1 for you off the module graph (≈7 s for a leaf module). **It is not cheap wherever the module graph fans out through a registry** — measured at ~5 minutes under `src/examples/**` (the whole GPU claims suite, T1211) and 332 files / 219 s for a single node definition, `src/nodes/definitions/audio.ts` (T1228). A node definition reaches the registry, and the registry reaches everything. **Name the paths yourself in those directories.** It needs `assetsInclude: ["**/*.md"]` in `vitest.config.ts` — without it, import analysis reaches `example-catalogue.ts`'s `examples/*.md` glob, resolves the specifier before its `?raw` query applies, and throws on prose. **It still does not select the step-2 gates** — nothing does.

## Heavy commands share one queue

Several agent sessions and the owner share this machine. Run anything heavy through `tools/heavy.sh <command…>`: GPU/Dawn tests (`*.gpu.test.ts`), Playwright, `pnpm build`, `pnpm test:gates`, `pnpm render`, render and build scripts under `src/projects/**`, and any vitest run over more than about twenty files. It is a machine-wide counting semaphore (two slots by default, `LOOM_HEAVY_SLOTS` to change), shared by every session and git worktree, so six agents never render at once; the rest wait in line. `pnpm typecheck`, eslint and a few named test files do not need it.

## GPU tests (Dawn)

`*.gpu.test.ts` and `src/tests/headless/{dawn-render,headless-parity}` run on a real GPU via `vgpu/node` (Dawn, Metal on macOS). They **fail loudly** when Dawn is unavailable (`probeDawn()` error verbatim); they never skip. Everything else runs on `vgpu/mock`. Assertions on Dawn are exact or analytically derived, never tolerance bands (§V147); pixel tolerances are defined once in `src/tests/headless/pixel-compare.ts`.

## Architecture

Path aliases: `@domain @compiler @runtime @editor @nodes @ui @agent @devices` → `src/<name>`, plus `@` → `src`.

**Data flow:** `GraphDocument` (zustand store, `src/domain/graph/store.ts`) → `compileGraph` (`src/compiler/`, pure, headless: flatten components → validate → order → prune to active sinks → resolve resolution/format/color space → emit `LogicalExecutionPlan`) → `RenderBackend` (`src/runtime/backend/vgpu/vgpu-backend.ts`, the ONLY place that imports `vgpu`) → frame driver (`src/runtime/execution/`) → presentation surfaces / previews (`src/runtime/previews/`, `src/editor/viewer/`) → export/readback (`src/runtime/export/`, the only readback path).

**Mutation path:** every change to the document goes through `AppCommandBus.execute(name, input, InvocationContext)` (`src/domain/commands/`). Commands carry an actor (human/agent/system), produce audit entries, and apply atomic `GraphPatch`es with revision checks. UI, keymap, menus, palette, inspector, and agent tools are all adapters over this bus. Store internals are unreachable outside `src/domain/commands` (lint-enforced).

**Composition root:** `src/app/app-runtime.ts` (no React) + `src/app/app.tsx` build the one bus, registry, component system, flattened-graph source, telemetry hub. `src/mcp/serve.ts` builds the same object graph headlessly. `src/tests/integration/composition-seams.test.ts` derives every exported `create*`/`open*` factory from the source tree and asserts a product entry point reaches it; a new service that is only constructed by its own test fails that gate ("built, tested, never wired" is this project's dominant bug class).

**Nodes:** `src/nodes/definitions/*.ts` (definition + WGSL emission via `src/nodes/shaders/*.wgsl.ts`), registered in `src/nodes/registry/`. Definitions must run headless: no React, no xyflow, no `src/ui` / `src/editor` imports, no wall clock (`Date.now`, `performance.now`, rAF, timers) — time arrives only as `FrameEvaluationInput`. Points/particles: `src/points/` (SoA attribute buffers, codegen'd WGSL `Point` struct, scan/compact lifecycle, no atomics).

**Domain:** `src/domain/types/` is the frozen contract (document, ports, patch, commands, node-definition, frame). `domain/components` = TD-style COMP subgraphs flattened at compile. `domain/expressions` = the sole expression engine (own grammar, no `eval`). `domain/parameters/resolve.ts` = the single parameter read path for evaluation. `domain/project` + `domain/migrations` = versioned `.loom.json` persistence.

**Editor:** `src/editor/*` feature folders (graph-canvas, nodes, edges, inspector, library, keymap-as-data, menus-as-data, palette, shader-editor, viewer, component, agent, help, inspect). `src/ui/` = tokens (`tokens.css`), primitives, controls. All colors come from CSS var tokens; no literal hex in components.

**Agent surface:** `src/agent/` = bus adapters + zod tool schemas only, no app logic. `src/mcp/` = stdio MCP server, loopback bridge so a browser tab can serve tools against the live document, WebMCP adapter. `bridge-host.ts` multiplexes three roles on one listener: `page` and `proxy` (MCP) and `device`. Built without a `headless` surface it registers NO agent roles and refuses `attach`/`proxyAttach` by name — that is `createDeviceHelper`/`serveDevices` in `serve.ts`, i.e. `pnpm helper --devices-only` (T1111).

**Devices:** `src/devices/` = the LOCAL DEVICE BRIDGE, and it is not an agent surface (T1103). OSC (`osc-codec`, `device-hub`), the Ether Dream laser path (`ether-dream`, `laser-service`, `laser-host`), the Apple Vision worker (`vision-host`), and the page-side `device-client`. `src/devices/doors.ts` builds the three doors a page cannot open for itself (both entry points call it, so a fourth door cannot land in one and not the other). `src/devices/transport/` holds what both roles on the one loopback socket share — the wire constants and pairing rules (`bridge-wire.ts`), the browser socket and pairing memory (`bridge-socket.ts`), the RFC 6455 server (`loopback-ws.ts`). **The dependency runs `src/mcp/` → `src/devices/` and `src/app/use-*-bridge.ts` → `src/devices/`; nothing under `src/devices/` may import `src/mcp/`.** One helper process serves both halves, which is why `pnpm helper` starts the device bridge too — and `pnpm helper --devices-only` starts the device door with no MCP server, no tool surface and no GPU (T1111). Every user-facing sentence naming that command comes from `src/devices/helper.ts`, and `helper.test.ts` fails if any other file under `src/` spells it (T1110).

## Lint-enforced invariants (eslint.config.js)

- §V3: `vgpu` (any subpath, dynamic import, require) only under `src/runtime/backend/vgpu/`.
- §V11: `src/nodes/definitions/**` may not import react, react-dom, @xyflow/react, `src/ui`, `src/editor`.
- §V44: no `Date.now` / `new Date` / `performance.now` / rAF / timers anywhere under `src/nodes/**`, including via `window.`/`globalThis.` aliases.
- §V63: no `window`/`document` globals under `src/compiler/**` and `src/runtime/**` (worker-movable).
- §V29: no `.internals` / `.raw` store access outside `src/domain/commands`.
- §V145: domain types whose names collide with DOM globals (`MediaSource`, …) must be imported explicitly.
- §V1028 (`v1028/layering-zone`): a layer may not import the layer that imports it — `src/domain/parameters` ↛ `presets`, `components`; `src/domain` ↛ `src/ui`, `src/editor`, react; type-only imports included. A module-scope read across an import cycle fails only under plain `node` (B246), which is why `first-import.test.ts` is on `test:gates`.

## Examples are executable specs

`examples/E*.loom.json` (+ sibling `E*.md`, `examples/components/*.loom.json`) are GENERATED from `src/examples/documents/*.ts` through the real save path. Never hand-edit the JSON. Edit the document source, regenerate with `--only <name>`, commit both. Guards: `sync.test.ts` (bytes match source), `doc-drift.test.ts` (fenced `name(type)` claims in the `.md` match the graph), `readme.test.ts` (README index row per example), plus per-example `*.gpu.test.ts` / `*-claims.gpu.test.ts` asserting the concept from rendered pixels. An unscoped regen rewrites every example and sweeps other sessions' in-flight document changes. Starter components (`src/examples/starter-components.ts`) scope the same way — `--only <ComponentName>` (T1221).

`AGENTS.md` at the root carries the same rules for other agents; keep the two consistent.

## Node names are `kind_role` (T1593b)

A node's name carries its kind as a prefix: `slider_lamp`, `light_lamp`, `blur_diffuse`, `kernel_joints`. The kind is one lowercase word per node type, declared in ONE table, `NODE_KINDS` in `src/domain/graph/node-kinds.ts` (`pointKernel` is `kernel`, `movieFileIn` is `movie`); then one underscore; then the role, which holds letters, digits and underscores only. A new node is auto-named kind plus a number (`blur1`), which already conforms. Full rule, the table and the phase 2 plan: `docs/node-naming-2026-10-05.md`.

- `conformsToKind(name, kind)` is the one answer to whether a name conforms. Do not write a second regex.
- A component instance is named for its COMPONENT: an instance of Bloom is `bloom1`, then `bloom_glow`. Its kind is the component's own name, lowercased, letters only, and it is not in the type string (a component's id is minted), so ask `kindOf(definition)`; `kindOfType(type)` refuses an instance type. A new instance is auto-named (from the library, an import or an `addNode`; the one a saved selection becomes follows with the phase 2 sweep, because it changes the shipped starter component files). Renaming a component renames no node.
- In a document source, `named(role, type, …)` (`src/examples/documents/builders.ts`) writes the name from the role alone, and `namedInstance(role, componentName, type, …)` does it for a component instance. New examples, projects, tests and fixtures use `kind_role`.
- A new node type needs a row in `NODE_KINDS`; sharing a kind with another type needs an entry in `KIND_FAMILIES`.
- `node.rename` puts the kind in front of a name that lacks it and says so; `exact: true` stores a name as given. A `label` inside a patch (`addNode`, `setNodeLabel`) is always stored exactly: write it in full. The agent tool `apply_graph_patch` stores it and WARNS when it lacks its kind (`data.unconformingLabels` gives the conforming form).
- Stored names never move. Changing a kind renames nothing in any document.
- `src/examples/node-names.test.ts` (on `test:gates`) fails a shipped node whose name lacks its kind. Files written before the rule are in its `NOT_YET_RENAMED` ledger with the exact count each still owes; the count must match, so it can only go down. A component's In and Out are exempt: their name is the socket's label.
- A surface with room for one word (a Panel board, the Layers list, the phone) captions a Presets bank, a Layer, a Cue List and an untitled Panel by the ROLE of the name: `presets_looks` reads `looks`. Use `surfaceNameOf(node, catalogue)` (`src/nodes/definitions/controls.ts`); it is a caption, never an address, and a name that does not carry its kind is shown whole.
- Below 70 % zoom every node carries a label, its kind and then the rest of its name, that does not shrink with the canvas (T1597b, `src/editor/nodes/kind-label.ts`). The canvas writes the zoom on each label element; never put it on an ancestor of the nodes as an inherited custom property (measured: twelve times the cost).

## Testing bar (enforced in review)

- Assert values the consumer reads back, not mechanisms ("which buffer was bound" is mechanism).
- For any driven parameter or wire, assert what differs if the edge were cut, ideally a render diff.
- Write bug repros as the literal bug through the real stack (compiler + backend + Dawn), not as a unit test of the fix.
- Guards go against the cause, not the observable, and the test must exercise the legitimate case the guard could swallow.
- Verify a gate can fail before trusting it green (red-verify by editing, restore by editing).
- Comments that predict future work carry their task id; landing the work deletes or past-tenses the comment.
