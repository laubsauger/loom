# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Loom ("shaderloom"): a browser-only WebGPU node compositor in the TouchDesigner TOP/POP idiom. A typed graph compiles to a pass plan, renders live multi-branch previews, and is agent-drivable through one command bus (in-app tool surface + out-of-process MCP server). React 19 + TS strict + Vite, pnpm, `vgpu` 0.3.1 pinned, zustand+immer, `@xyflow/react` for the canvas, CodeMirror 6, Radix, CSS modules + CSS vars (no Tailwind), zod.

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
pnpm test                # vitest run, both workspace projects
pnpm test:headless       # only the "headless" (node env) project
pnpm test:e2e            # playwright, src/tests/e2e, boots dev server itself
pnpm mcp:serve           # headless Loom MCP server on stdio (+ loopback bridge for a Loom tab)
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
node --import ./src/mcp/alias-hooks.ts src/examples/build-examples.ts --only E13   # regenerate ONE example
node --import ./src/mcp/alias-hooks.ts src/examples/build-thumbnails.ts --only E13
```

The bare `node --experimental-strip-types src/...` form is dead and has been "fixed" in docblocks three times; run a command before trusting it.

## GPU tests (Dawn)

`*.gpu.test.ts` and `src/tests/headless/{dawn-render,headless-parity}` run on a real GPU via `vgpu/node` (Dawn, Metal on macOS). They **fail loudly** when Dawn is unavailable (`probeDawn()` error verbatim); they never skip. Everything else runs on `vgpu/mock`. Assertions on Dawn are exact or analytically derived, never tolerance bands (§V147); pixel tolerances are defined once in `src/tests/headless/pixel-compare.ts`.

## Architecture

Path aliases: `@domain @compiler @runtime @editor @nodes @ui @agent` → `src/<name>`, plus `@` → `src`.

**Data flow:** `GraphDocument` (zustand store, `src/domain/graph/store.ts`) → `compileGraph` (`src/compiler/`, pure, headless: flatten components → validate → order → prune to active sinks → resolve resolution/format/color space → emit `LogicalExecutionPlan`) → `RenderBackend` (`src/runtime/backend/vgpu/vgpu-backend.ts`, the ONLY place that imports `vgpu`) → frame driver (`src/runtime/execution/`) → presentation surfaces / previews (`src/runtime/previews/`, `src/editor/viewer/`) → export/readback (`src/runtime/export/`, the only readback path).

**Mutation path:** every change to the document goes through `AppCommandBus.execute(name, input, InvocationContext)` (`src/domain/commands/`). Commands carry an actor (human/agent/system), produce audit entries, and apply atomic `GraphPatch`es with revision checks. UI, keymap, menus, palette, inspector, and agent tools are all adapters over this bus. Store internals are unreachable outside `src/domain/commands` (lint-enforced).

**Composition root:** `src/app/app-runtime.ts` (no React) + `src/app/app.tsx` build the one bus, registry, component system, flattened-graph source, telemetry hub. `src/mcp/serve.ts` builds the same object graph headlessly. `src/tests/integration/composition-seams.test.ts` derives every exported `create*`/`open*` factory from the source tree and asserts a product entry point reaches it; a new service that is only constructed by its own test fails that gate ("built, tested, never wired" is this project's dominant bug class).

**Nodes:** `src/nodes/definitions/*.ts` (definition + WGSL emission via `src/nodes/shaders/*.wgsl.ts`), registered in `src/nodes/registry/`. Definitions must run headless: no React, no xyflow, no `src/ui` / `src/editor` imports, no wall clock (`Date.now`, `performance.now`, rAF, timers) — time arrives only as `FrameEvaluationInput`. Points/particles: `src/points/` (SoA attribute buffers, codegen'd WGSL `Point` struct, scan/compact lifecycle, no atomics).

**Domain:** `src/domain/types/` is the frozen contract (document, ports, patch, commands, node-definition, frame). `domain/components` = TD-style COMP subgraphs flattened at compile. `domain/expressions` = the sole expression engine (own grammar, no `eval`). `domain/parameters/resolve.ts` = the single parameter read path for evaluation. `domain/project` + `domain/migrations` = versioned `.loom.json` persistence.

**Editor:** `src/editor/*` feature folders (graph-canvas, nodes, edges, inspector, library, keymap-as-data, menus-as-data, palette, shader-editor, viewer, component, agent, help, inspect). `src/ui/` = tokens (`tokens.css`), primitives, controls. All colors come from CSS var tokens; no literal hex in components.

**Agent surface:** `src/agent/` = bus adapters + zod tool schemas only, no app logic. `src/mcp/` = stdio MCP server, loopback bridge so a browser tab can serve tools against the live document, WebMCP adapter.

## Lint-enforced invariants (eslint.config.js)

- §V3: `vgpu` (any subpath, dynamic import, require) only under `src/runtime/backend/vgpu/`.
- §V11: `src/nodes/definitions/**` may not import react, react-dom, @xyflow/react, `src/ui`, `src/editor`.
- §V44: no `Date.now` / `new Date` / `performance.now` / rAF / timers anywhere under `src/nodes/**`, including via `window.`/`globalThis.` aliases.
- §V63: no `window`/`document` globals under `src/compiler/**` and `src/runtime/**` (worker-movable).
- §V29: no `.internals` / `.raw` store access outside `src/domain/commands`.
- §V145: domain types whose names collide with DOM globals (`MediaSource`, …) must be imported explicitly.

## Examples are executable specs

`examples/E*.loom.json` (+ sibling `E*.md`, `examples/components/*.loom.json`) are GENERATED from `src/examples/documents/*.ts` through the real save path. Never hand-edit the JSON. Edit the document source, regenerate with `--only <name>`, commit both. Guards: `sync.test.ts` (bytes match source), `doc-drift.test.ts` (fenced `name(type)` claims in the `.md` match the graph), `readme.test.ts` (README index row per example), plus per-example `*.gpu.test.ts` / `*-claims.gpu.test.ts` asserting the concept from rendered pixels. An unscoped regen rewrites every example and sweeps other sessions' in-flight document changes. Starter components (`src/examples/starter-components.ts`) are only regenerated by the unscoped run.

`AGENTS.md` at the root carries the same rules for other agents; keep the two consistent.

## Testing bar (enforced in review)

- Assert values the consumer reads back, not mechanisms ("which buffer was bound" is mechanism).
- For any driven parameter or wire, assert what differs if the edge were cut, ideally a render diff.
- Write bug repros as the literal bug through the real stack (compiler + backend + Dawn), not as a unit test of the fix.
- Guards go against the cause, not the observable, and the test must exercise the legitimate case the guard could swallow.
- Verify a gate can fail before trusting it green (red-verify by editing, restore by editing).
- Comments that predict future work carry their task id; landing the work deletes or past-tenses the comment.
