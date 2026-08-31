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
const HOLDER_STORE = Symbol.for("shaderloom.commands.holders");

/** What a surface writes itself into, and what the command handler reads at call time. */
export interface CommandHolder<T> {
  current: T | null;
}

type HolderStore = WeakMap<object, Map<string, CommandHolder<unknown>>>;

function store(): HolderStore {
  const root = globalThis as unknown as Record<symbol, unknown>;
  const existing = root[HOLDER_STORE];
  if (existing !== undefined) return existing as HolderStore;
  const created: HolderStore = new WeakMap();
  root[HOLDER_STORE] = created;
  return created;
}

/**
 * The one holder for `key` on `bus`, whichever copy of whichever module asks.
 *
 * `key` is the COMMAND NAME. Two commands on one bus must not share a holder, and using
 * the command name means the key cannot drift from the thing it identifies — there is no
 * second string to keep in agreement.
 */
export function commandHolder<T>(bus: object, key: string): CommandHolder<T> {
  const byBus = store();
  let byKey = byBus.get(bus);
  if (byKey === undefined) {
    byKey = new Map();
    byBus.set(bus, byKey);
  }
  const existing = byKey.get(key);
  if (existing !== undefined) return existing as CommandHolder<T>;
  const holder: CommandHolder<T> = { current: null };
  byKey.set(key, holder);
  return holder;
}
