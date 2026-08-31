import { describe, expect, it, vi } from "vitest";

import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";

/**
 * `ui.openNodeSearch` SURVIVES ITS OWN MODULE BEING RE-EXECUTED (T709, §V442, §V483).
 *
 * ## The bug, and why the e2e suite could not see it
 *
 * T709 shipped with five real-browser assertions and all five were green — against a
 * COLD dev server. The owner reported the browser still never opened. Both were true:
 * the feature works on a fresh load and dies on any HMR update to `node-search-command.ts`.
 *
 * Measured in Chromium against a real Vite server, twice: double-click the graph
 * background, browser opens (1); touch `node-search-command.ts`; double-click again,
 * nothing (0). No exception, no console output. Editing `graph-canvas.tsx` or
 * `node-search.tsx` did NOT do it — only the command module's own re-execution.
 *
 * Mechanism: the holder was a MODULE-LEVEL `WeakMap`. Re-executing the module mints a
 * second map and therefore a second, empty holder, while the handler already registered
 * on the bus (registration is idempotent, because the bus has no unregister) keeps
 * reading the first. The canvas writes itself into holder #2; the command reads `null`
 * from holder #1 and refuses. All three doors — the double-click, `tab`, and the canvas
 * menu's "Search nodes…" row — go dead together, because §V78 means all three name one
 * command, and one dead command is three dead affordances.
 *
 * ## What is asserted, and why it is not "the holder is shared"
 *
 * §V655: assert the property the thing is FOR. "Two copies see one holder" is the
 * mechanism, and a mechanism assertion passes a re-implementation that shares a holder
 * and still cannot open. So the load-bearing test EXECUTES the command across the module
 * boundary and asserts the SURFACE WAS ASKED TO OPEN, at the position the caller named —
 * which is the same thing the browser spec asserts, reached the one way a browser cannot
 * reach it.
 *
 * The neighbour assertions are here for §V516's reason: a page-global store keyed only by
 * the bus would hand every `ui.open*` command one shared holder, so the fix for a dead
 * door would wire every door to whichever surface mounted last. Both separations — by
 * command, and by bus — are asserted, or "make it global" is exactly as wide as the
 * observable it was written against.
 */

type CommandModule = typeof import("./node-search-command.ts");

/**
 * Two GENUINELY distinct instances of the command module — what HMR leaves behind.
 *
 * `vi.resetModules()` between the imports is what makes them distinct; the identity
 * assertion in the caller is what stops this silently degenerating into one instance and
 * testing nothing, which is how a gate of this shape rots.
 */
async function twoModuleInstances(): Promise<[CommandModule, CommandModule]> {
  vi.resetModules();
  const first = (await import("./node-search-command.ts")) as CommandModule;
  vi.resetModules();
  const second = (await import("./node-search-command.ts")) as CommandModule;
  return [first, second];
}

describe("a re-executed command module can still open the node browser (T709)", () => {
  it("opens when the SURFACE registered through a second copy of the module", async () => {
    const [first, second] = await twoModuleInstances();
    // The precondition. Without this the test would pass trivially on one instance.
    expect(first.registerNodeSearchCommand).not.toBe(second.registerNodeSearchCommand);

    const { bus } = createHarness();

    // Copy #1 registers — this is the handler that stays on the bus, since the bus has
    // no unregister and every later registration short-circuits on `hasCommand`.
    first.registerNodeSearchCommand(bus);
    // Copy #2 registers and mounts the surface — this is the canvas after an HMR update.
    const holder = second.registerNodeSearchCommand(bus);
    const opened: Array<{ x: number; y: number } | undefined> = [];
    holder.current = {
      open: (position) => {
        opened.push(position);
        return position ?? { x: 0, y: 0 };
      },
    };

    const result = await bus.execute(
      "ui.openNodeSearch",
      { position: { x: 571.4, y: 584 } },
      contextFor(alice),
    );

    // The property: the browser OPENED, at the point the caller named. Before the fix
    // this was `rejected` with `library.noSurface` and `opened: false` — the owner's
    // "nothing happens", exactly.
    expect(result.status).toBe("applied");
    expect(result.output).toEqual({ opened: true, position: { x: 571.4, y: 584 } });
    expect(opened).toEqual([{ x: 571.4, y: 584 }]);
  });

  it("still refuses honestly when NO surface is mounted", async () => {
    // The other half (§V516): the fix must not make the command claim to have opened a
    // browser on a page with no canvas. A guard that only ever says yes is not a guard.
    const [first] = await twoModuleInstances();
    const { bus } = createHarness();
    first.registerNodeSearchCommand(bus);

    const result = await bus.execute("ui.openNodeSearch", {}, contextFor(alice));

    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ opened: false, position: null });
  });

  it("does not hand two DIFFERENT commands on one bus the same holder", async () => {
    // The page-global store is keyed by bus AND by command name. Keyed by bus alone,
    // every `ui.open*` command would share one holder and the last surface to mount
    // would answer for all of them.
    const { commandHolder } = await import("@domain/commands/command-holder.ts");
    const { bus } = createHarness();

    const search = commandHolder(bus, "ui.openNodeSearch");
    const info = commandHolder(bus, "ui.showNodeInfo");

    expect(search).not.toBe(info);
    expect(commandHolder(bus, "ui.openNodeSearch")).toBe(search);
  });

  it("does not share a holder between two buses", async () => {
    // Two app instances in one page — a floated pane's window, or a test file running
    // two harnesses — must not write into each other's surface.
    const { commandHolder } = await import("@domain/commands/command-holder.ts");
    const one = createHarness().bus;
    const other = createHarness().bus;

    expect(commandHolder(one, "ui.openNodeSearch")).not.toBe(
      commandHolder(other, "ui.openNodeSearch"),
    );
  });
});
