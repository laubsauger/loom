# AGENTS.md

## Scope

These instructions apply to the entire repository. `SPEC.md` is the authoritative product and architecture contract; read the relevant section before changing behavior.

## Non-negotiables

- Never commit, checkout, reset, rebase, or otherwise rewrite Git history.
- Preserve unrelated and uncommitted user changes. Inspect the worktree before editing.
- Fix root causes. Do not add silent catches, speculative compatibility paths, or fallback behavior for core functionality. Surface an explicit diagnostic or throw when an invariant cannot be satisfied.
- Use current stable APIs and verify time-sensitive assumptions instead of choosing legacy patterns by default.
- Use pnpm. Keep the exact package-manager version declared in `package.json` as the single source of truth.
- Do not introduce Tailwind; this project uses Radix primitives, CSS variables, and CSS Modules.
- If a shadcn component is explicitly required, install it with the official shadcn CLI. Never recreate one from memory.
- Never run `pnpm deploy` unless the user explicitly asks to deploy production.

## Architecture

- All graph and project mutations go through `src/domain/commands`; do not create a second mutation path.
- Keep direct `vgpu` access inside `src/runtime/backend`.
- Keep the local device bridge in `src/devices` (OSC, laser, Apple Vision, and the loopback transport they share). It is not an agent surface: `src/mcp` and `src/app/use-*-bridge.ts` import it, and nothing under `src/devices` may import `src/mcp`.
- The helper is one process with two doors. `pnpm helper` opens both; `pnpm helper --devices-only` opens the device door alone (no MCP server, no tool surface, no GPU). The command is spelled once, in `src/devices/helper.ts`, and `helper.test.ts` fails if any other file under `src/` spells it. `mcp:serve` survives as a `package.json` alias for one release.
- Keep domain, compiler, and runtime code independent of the DOM except at an existing documented adapter boundary.
- Pass time through `FrameEvaluationInput`; do not read wall-clock time in nodes or shaders.
- Keep persisted projects versioned and validated. Use the existing serializer and migration paths.
- Treat IDs as opaque stable identifiers, never array positions.
- Treat `examples/*.loom.json` and `examples/components/*.loom.json` as generated executable specifications. Never hand-edit them. For an example, edit its TypeScript source under `src/examples/documents/`, then regenerate only that example with:

```bash
node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts --only <Name>
```

Starter components are authored in `src/examples/starter-components.ts`. Their generator currently rewrites the complete generated set, so inspect the shared worktree before running it without `--only`.

## Working method

- Read nearby implementation and tests before editing; follow existing module boundaries and naming.
- Make the smallest coherent change that fully solves the problem. Avoid unrelated cleanup.
- Add or update tests for changed behavior, including the failure mode that motivated a bug fix.
- Run the narrowest relevant test while iterating, then validate the affected surface.
- Use the repository commands, not bare `tsc` or an ad hoc test configuration.

## Validation

For application or shared-library changes, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Also run `pnpm test:headless` for backend, rendering, or WGSL changes and `pnpm test:e2e` for browser interaction changes when the environment supports them. Report commands that could not be run and why.
