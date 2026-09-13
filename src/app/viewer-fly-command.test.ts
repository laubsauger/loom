import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import { FLY_AXES } from "@editor/viewer/orbit-gestures.ts";
import { registerViewerCommands } from "./viewer-commands.ts";
import type { ViewerHandlers } from "./viewer-commands.ts";

/**
 * §T1311b(b) — `viewer.fly` as the AGENT-FACING half of the gesture.
 *
 * The held key never reaches the bus (it is a gesture on the focused pane, integrated at
 * frame rate), so everything asserted here is about the OTHER caller: the command palette,
 * a rebound key with no auto-repeat, and an agent driving the viewer through the same door
 * a human uses. Its contract is its refusals — this project's shape is "refuse BY NAME"
 * (§T1111), and a fly that quietly did nothing when there was no camera, or that picked a
 * direction for a caller who named none (§V986), would be worse than one that is absent.
 */

const context = contextFor(alice);

function setup(handlers?: Partial<ViewerHandlers>) {
  const { bus } = createHarness();
  const holder = registerViewerCommands(bus);
  const flown: string[] = [];
  if (handlers !== undefined) {
    holder.current = {
      show: () => null,
      cameraHome: () => false,
      frameContent: async () => false,
      fly: (direction) => {
        flown.push(direction);
        return true;
      },
      ...handlers,
    };
  }
  return { bus, flown };
}

describe("viewer.fly", () => {
  it("flies the direction it was given, and reports that it moved", async () => {
    const { bus, flown } = setup({});
    for (const direction of FLY_AXES) {
      const result = await bus.execute("viewer.fly", { direction }, context);
      expect(result.status).toBe("applied");
      expect(result.output).toEqual({ moved: true });
    }
    // Every direction the gesture knows is reachable from here — an agent is not offered a
    // narrower camera than a keyboard.
    expect(flown).toEqual([...FLY_AXES]);
  });

  it("refuses an unnamed or unknown direction BY NAME, rather than picking one", async () => {
    const { bus, flown } = setup({});
    const result = await bus.execute("viewer.fly", { direction: "northwest" }, context);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("viewer.flyDirection");
    // The refusal has to be usable: it names what was asked for AND what is accepted.
    expect(result.diagnostics?.[0]?.message).toContain("northwest");
    expect(result.diagnostics?.[0]?.suggestion).toContain("forward");
    expect(flown).toEqual([]);
  });

  it("refuses when no viewer is on screen, and moves nothing", async () => {
    const { bus, flown } = setup();
    const result = await bus.execute("viewer.fly", { direction: "forward" }, context);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("viewer.noOrbit");
    expect(result.output).toEqual({ moved: false });
    expect(flown).toEqual([]);
  });

  it("refuses when the viewer is showing something with no camera", async () => {
    // The pane answers false when the presented output declares neither a rig nor a view
    // camera — the same condition that greys the control out, reported with the same words.
    const { bus } = setup({ fly: () => false });
    const result = await bus.execute("viewer.fly", { direction: "forward" }, context);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("viewer.noOrbit");
  });

  it("moves nothing on a dry run", async () => {
    // A dry run is how a caller asks whether a command would be accepted; one that flew the
    // camera to answer would make "check first" the destructive path.
    const { bus, flown } = setup({});
    const result = await bus.execute("viewer.fly", { direction: "forward" }, { ...context, dryRun: true });
    expect(result.status).toBe("validated");
    expect(flown).toEqual([]);
  });
});
