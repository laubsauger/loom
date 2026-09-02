/**
 * The mutable holder a surface-opening command dispatches through, kept PAGE-GLOBAL
 * rather than module-local (§V442, §V483, §B107's family).
 *
 * ## The bug this exists to make impossible, measured
 *
 * Every `ui.open*` command in this app follows one shape: the bus has no unregister, so
 * registration is idempotent (`if (bus.hasCommand(name)) return holder;`) and the handler
 * closes over a holder the mounted surface writes itself into. The holder was a
 * MODULE-LEVEL `WeakMap` keyed by the bus.
 *
 * A module-level map assumes there is one copy of the module. Under Vite HMR there is
 * not: re-executing the module mints a SECOND `WeakMap`, and therefore a second, empty
 * holder — while the handler already registered on the bus still closes over the first
 * one. The surface then writes itself into holder #2, the command still reads holder #1,
 * finds `null`, and refuses. Nothing throws. Nothing is logged.
 *
 * Measured on T709's node browser against a real Chromium and a real dev server: a single
 * HMR update to `node-search-command.ts` took the double-click, the `tab` binding and the
 * canvas menu's "Search nodes…" row from working to dead in one step — the browser opened
 * before the update and did not open after it, with an empty console. All three doors go
 * together because all three name one command, which is exactly §V78's point working in
 * reverse. Only a hard reload brought it back.
 *
 * That is the owner-visible shape of T709's second report: a feature that is present,
 * committed, green in its own e2e suite against a cold server, and dead in the long-lived
 * dev session they actually use.
 *
 * ## Why the symbol registry, and not a WeakMap
 *
 * §V483 already recorded this once: `src/mcp/webmcp.ts` guards its page-global
 * registration with `Symbol.for` on the host document for precisely this reason, having
 * measured that a module-level `WeakSet` "absorbs nothing" when two copies of the module
 * exist. `Symbol.for` keys the cross-realm symbol registry, so every copy of every module
 * resolves the same symbol and reaches the same store. That is the only part of this that
 * has to be global; the store itself stays a `WeakMap` keyed by the bus, so a bus that
 * goes away takes its holders with it.
 *
 * ⚠ ADOPTION IS INCOMPLETE AND THAT IS KNOWN. Twenty-one other command modules still
 * carry their own module-level `WeakMap` — `ui.showNodeInfo`, `ui.openSettings`,
 * `ui.openHelp`, `graph.diveIn`, `view.toggleFullscreen`, the transport, the palette, the
 * viewer, the layout commands. Every one of them dies the same silent death on an HMR
 * update to its own file, and each is a live report of the form "the menu row does
 * nothing". They are not converted here because they belong to other tracks; this module
 * is where they go when they are.
 */

/**
 * The cross-realm key for the whole store. One symbol for the app, not one per command:
 * the per-command split is inside, so a second copy of ANY command module still finds the
 * store a first copy created.
 */
// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
const HOLDER_STORE = Symbol.for("shaderloom.commands.holders");

/** What a surface writes itself into, and what the command handler reads at call time. */
export interface CommandHolder<T> {
  current: T | null;
}

type HolderStore = WeakMap<object, Map<string, object>>;

function store(): HolderStore {
  const root = globalThis as unknown as Record<symbol, unknown>;
  const existing = root[HOLDER_STORE];
  if (existing !== undefined) return existing as HolderStore;
  const created: HolderStore = new WeakMap();
  root[HOLDER_STORE] = created;
  return created;
}

/**
 * THE ONE `T` FOR `key` ON `bus`, whichever copy of whichever module asks.
 *
 * The primitive, and deliberately shaped around identity rather than around a field
 * layout: what has to survive a re-executed module is the OBJECT, not its members. That
 * matters because the modules being converted do not all hold the same thing —
 * `FullscreenHolder` carries two slots (`current` for the viewer, `app` for the shell,
 * T551), `state-queries` holds `{ sources }` and never a null, and wave 2's stores hold
 * subscriber lists. Generalising here rather than reshaping sixteen published holder types
 * is the difference between a conversion and a refactor of other people's surfaces.
 *
 * `create` runs at most once per key per bus, so a caller cannot accidentally reset live
 * state by asking for its own holder twice.
 *
 * ⚠ `key` MUST BE UNIQUE ACROSS EVERY MODULE THAT ASKS. Two modules choosing one key share
 * one object, and the last surface to mount answers for both — which is a worse failure
 * than the one this module exists to fix, because it is silent AND wrong rather than
 * silent and absent. `command-holder.test.ts` asserts that no two of them collide, by
 * comparing the actual objects rather than by reviewing the strings.
 */
export function sharedForBus<T extends object>(bus: object, key: string, create: () => T): T {
  const byBus = store();
  let byKey = byBus.get(bus);
  if (byKey === undefined) {
    byKey = new Map();
    byBus.set(bus, byKey);
  }
  const existing = byKey.get(key);
  if (existing !== undefined) return existing as T;
  const made = create();
  byKey.set(key, made);
  return made;
}

/**
 * The common case: a `{ current }` slot a mounted surface writes itself into.
 *
 * `key` is the COMMAND NAME wherever there is one command, because the bus already
 * guarantees command names are unique — reusing that is cheaper than minting a second
 * namespace to police. A module registering SEVERAL commands from one holder names its
 * primary one, and a module holding two distinct things (`preview-view-command` holds a
 * target holder beside its store) suffixes the second, since both are on one bus.
 */
export function commandHolder<T>(bus: object, key: string): CommandHolder<T> {
  return sharedForBus<CommandHolder<T>>(bus, key, () => ({ current: null }));
}
