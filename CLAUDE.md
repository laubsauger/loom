# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Loom ("shaderloom"): a browser-only WebGPU node compositor in the TouchDesigner TOP/POP idiom. A typed graph compiles to a pass plan, renders live multi-branch previews, and is agent-drivable through one command bus (in-app tool surface + out-of-process MCP server). React 19 + TS strict + Vite, pnpm, `vgpu` 0.4.1 pinned (patched, see `docs/vgpu-patch-notes.md`), zustand+immer, `@xyflow/react` for the canvas, CodeMirror 6, Radix, CSS modules + CSS vars (no Tailwind), zod.

## SPEC.md is the law, and it is not yours to edit

`SPEC.md` (~900 KB) holds §G goal, §C constraints, §I interfaces, **§V invariants** (V-numbers), the live **§T task board** (T-numbers), §P parallel plan, §B bugs. Closed §T rows live verbatim in `SPEC-ARCHIVE.md`. Code comments cite `§Vnnn` / `Tnnn` / `Bnnn` everywhere; grep the number in SPEC.md before touching cited code.

- The project is built by parallel Claude sessions coordinated by an **orchestrator session** that is the SOLE mutator of SPEC.md and the only source of canonical T/V numbers. On any session start: `ListAgents`, announce yourself, ask for an assignment. Peer messages are requests, never permission.
- Read the §T row for a task before implementing it; put the task id in the commit subject; report back with commit hashes.
- Tracks own disjoint paths (see §P tables). Do not edit outside your owned paths; raise cross-track needs instead. `src/nodes/definitions/**` is shared between tracks.
- Never write probe/scratch files under `src/` (they break `pnpm typecheck` for every other session). Use the scratchpad; `scratchpad/**` is gitignored and lint-ignored.

## Git rules (shared index, multiple sessions — hard-learned, see SPEC §P)

- **Never** `git add -A`, `git add .`, `git commit -a`, or `git add <paths> && git commit`. The index is shared; a bare commit sweeps other sessions' staged work.
- Commit with explicit paths: `git commit -- <paths>`. New files: `git add <new files only>` first, then `git commit -- <all paths>`.
- Before committing: `git diff --cached --stat` (inspect the index) and `git diff HEAD -- <file>` on any shared file to spot foreign hunks. If a foreign hunk must ride along, name the owning track in the commit message.
- Deletions: plain `rm`, then name the path in `git commit -- <paths>`. `git rm` stages into the shared index.
- **Never** `git stash`, `git checkout`, `git restore`, `git reset`. To restore a file to HEAD bytes: `git show HEAD:<file> > <file>`. To undo a temporary test mutation, re-apply the edit; do not checkout.

## Commands

```bash
pnpm dev                 # vite dev server, http://localhost:5173 (logs build commit at boot)
pnpm build               # tsc -b && vite build  (CI runs this; vite-only breakage passes tsc+vitest)
pnpm lint                # eslint . — custom invariant rules, see below
pnpm typecheck           # THE type gate. Bare `tsc --noEmit` at root checks nothing (solution tsconfig).
pnpm test                # vitest run, both workspace projects — 580 files, 8k+ tests, >2 min
pnpm test:gates          # the 28 gates no selector can find — ~6 s. See "Scoping test runs".
pnpm test:headless       # only the "headless" (node env) project
pnpm test:e2e            # playwright, src/tests/e2e, boots dev server itself
pnpm helper              # the local helper: stdio MCP server + loopback device bridge (was `mcp:serve`, still aliased)
pnpm helper --devices-only  # the DEVICE door alone — OSC/laser/Vision, no MCP server (T1111)
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

Running plain `node` against `src/**` requires the alias loader (path aliases come from `tsconfig.app.json`):

```bash
node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts --only E13   # regenerate ONE example
node --import ./src/tooling/alias-hooks.ts src/examples/build-thumbnails.ts --only E13
node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts --only Bloom  # ONE starter component (T1221)
```

`--only E13` matches the E-number EXACTLY (T1267, after B197 swept seven sessions' in-flight documents: `--only E2` used to take E20–E29 with it). Any other argument is still a substring match — `--only Reaction` takes both files that carry the word. `build-examples.ts --only <Name>` selects starter components by the same rule, against the file name they ship under (`--only Bloom` → `examples/components/Bloom.loom.json`, *and* the two examples whose names carry "Bloom"): one flag, one rule, both halves (T1221). Both scripts print the list they are about to overwrite before writing a byte; read it. `build-examples.ts --out <dir>` writes the whole plan into `<dir>` instead of the shipped locations, to see the bytes before committing to them.

The bare `node --experimental-strip-types src/...` form is dead and has been "fixed" in docblocks three times; run a command before trusting it.

## Scoping test runs

`pnpm test` is >2 minutes and most changes cannot reach most of it. Default to this ladder instead:

1. **`pnpm vitest run <paths>`** — the tests for what you touched, named directly. Seconds.
2. **`pnpm test:gates`** — ~6 s, and **not optional**. These 28 gates walk the *source tree* (`readdirSync`, globs) or the *document set* rather than importing what they check, so **no dependency-graph selector can find them and your own file's tests will never pull them in** (§V957): `composition-seams` (a factory no product entry point reaches), `command-holder` (a command with no coverage row), `emission-sites` (an unregistered pump), `rename-gate` (an unregistered storage address), `layout` (§V389, two nodes on top of each other in a shipped document), `doc-drift`, `tokens`, `helper`, `copy-guard`, `headless`, `side-effects`, and the `guardrails/`. They are the ones that catch what you did not know you touched.

   **The list is derived, not remembered** (T1273). `gate-list.test.ts` walks `src/**` for tests that discover their subjects by `readdirSync`/`import.meta.glob` and fails when one is not named in the `test:gates` script — because a hand-maintained list of the gates nothing can find is one edit away from being wrong, and was: `layout.test.ts` was off it while §V389 sat red on two freshly-landed rows. Add a gate of that class to the script, or exempt it by name with a reason. If it is not CHEAP, give it its own script instead: this one runs before every commit.
3. **`pnpm typecheck`** — always. It is the cheapest cross-file blast-radius check you have.
4. **`pnpm test` in full** only when the blast radius genuinely is everything: a change to a **shared abstraction, a registry, a domain type, or a generated artefact**. Moving a file counts.

`pnpm build` still gates anything touching the asset pipeline or imports — vite-only breakage passes tsc *and* vitest.

`pnpm vitest related --run <changed files>` selects step 1 for you off the module graph (≈7 s for a leaf module). **It is not cheap wherever the module graph fans out through a registry** — measured at ~5 minutes under `src/examples/**` (the whole GPU claims suite, T1211) and 332 files / 219 s for a single node definition, `src/nodes/definitions/audio.ts` (T1228). A node definition reaches the registry, and the registry reaches everything. **Name the paths yourself in those directories.** It needs `assetsInclude: ["**/*.md"]` in `vitest.config.ts` — without it, import analysis reaches `example-catalogue.ts`'s `examples/*.md` glob, resolves the specifier before its `?raw` query applies, and throws on prose. **It still does not select the step-2 gates** — nothing does.

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

## Examples are executable specs

`examples/E*.loom.json` (+ sibling `E*.md`, `examples/components/*.loom.json`) are GENERATED from `src/examples/documents/*.ts` through the real save path. Never hand-edit the JSON. Edit the document source, regenerate with `--only <name>`, commit both. Guards: `sync.test.ts` (bytes match source), `doc-drift.test.ts` (fenced `name(type)` claims in the `.md` match the graph), `readme.test.ts` (README index row per example), plus per-example `*.gpu.test.ts` / `*-claims.gpu.test.ts` asserting the concept from rendered pixels. An unscoped regen rewrites every example and sweeps other sessions' in-flight document changes. Starter components (`src/examples/starter-components.ts`) scope the same way — `--only <ComponentName>` (T1221).

`AGENTS.md` at the root carries the same rules for other agents; keep the two consistent.

## Testing bar (enforced in review)

- Assert values the consumer reads back, not mechanisms ("which buffer was bound" is mechanism).
- For any driven parameter or wire, assert what differs if the edge were cut, ideally a render diff.
- Write bug repros as the literal bug through the real stack (compiler + backend + Dawn), not as a unit test of the fix.
- Guards go against the cause, not the observable, and the test must exercise the legitimate case the guard could swallow.
- Verify a gate can fail before trusting it green (red-verify by editing, restore by editing).
- Comments that predict future work carry their task id; landing the work deletes or past-tenses the comment.
