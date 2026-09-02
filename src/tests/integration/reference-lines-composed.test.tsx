// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { loadProject } from "@domain/project/index.ts";
import { parameterDependencies } from "@domain/graph/parameter-dependencies.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * The reference line, at the COMPOSED surface (T374, T248, §V151, §V220).
 *
 * `reference-lines.test.tsx` already asserts the line on a real `GraphCanvas` — and it
 * passed green the whole time the shipped app drew nothing for E10. That is §V220's shape
 * one layer up: the canvas test mounts the canvas DIRECTLY, so it supplies the React Flow
 * provider itself, and the one thing it therefore cannot observe is what the app supplies.
 * `GraphPane` hoists its own `<ReactFlowProvider>` above the canvas so the pane's hooks
 * share the canvas store — which is exactly the arrangement no test covered.
 *
 * So this mounts the real `App`, on the real shipped E10 file, through the real loader.
 * Nothing here constructs a flow provider, a canvas or a dependency list: if the wiring
 * between them breaks, this goes red and the unit tests stay green.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};
const READY: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true };

/** The shipped bytes, through the shipped loader — never a fixture (§V88). */
function loadExample(fileName: string) {
  // `process.cwd()`, not `import.meta.url`: under the jsdom project a module URL is a
  // web URL and `fileURLToPath` loses the repo prefix. Vitest's cwd is the repo root.
  const path = join(process.cwd(), "examples", fileName);
  const loaded = loadProject(readFileSync(path, "utf8"), {});
  if (!loaded.ok) throw new Error(`E10 did not load: ${loaded.reason}`);
  return loaded.document;
}

function mountExample(fileName: string): { runtime: AppRuntime } {
  const document = loadExample(fileName);
  const runtime = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
    document,
  });
  const probe = () => Promise.resolve(READY);
  render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  return { runtime };
}

describe("E10's driven parameter draws its reference line in the real app (T248)", () => {
  it("has the dependency in the document at all", () => {
    const document = loadExample("E10-Instanced-Torus.loom.json");
    // The premise, asserted separately so a failure below is unambiguously the VIEW.
    expect([...parameterDependencies(document.graph).values()].flat()).toEqual([
      // §T897: the driver is an expression op-ref now (`op('lfo1').chan.value`), and the
      // reference line draws from the same dependency walk — only the kind changed.
      { from: "draw", parameterKey: "rotate.y", kind: "reference", address: "lfo1", to: "lfo" },
    ]);
  });

  it("draws lfo1 → instances1 on the mounted canvas", async () => {
    await act(async () => {
      mountExample("E10-Instanced-Torus.loom.json");
    });

    // `reference-line-<source>-<target>`: the arrow follows the data, so the node being
    // READ is the source. lfo1 (`lfo`) drives instances1 (`draw`).
    await waitFor(() => {
      expect(window.document.querySelector('[data-testid="reference-line-lfo-draw"]')).not.toBeNull();
    });
  });

  /**
   * B47 — and the assertion that would have caught it, which existence never could.
   *
   * The `<g>` above was in the DOM the entire time the shipped app drew nothing: the
   * LAYER was a zero-sized `<svg>` leaning on `overflow: visible`, and an outermost
   * `<svg>` with a zero-width or zero-height viewport renders nothing at all. jsdom
   * paints nothing either, so "the element exists" stayed green through the whole bug.
   * What is checkable without a compositor is the PRECONDITION: the layer has a real
   * viewport and its coordinate system contains the line.
   */
  it("gives the layer a viewport that actually contains the line", async () => {
    await act(async () => {
      mountExample("E10-Instanced-Torus.loom.json");
    });

    const layer = await waitFor(() => {
      const found = window.document.querySelector('[data-testid="reference-lines"]');
      if (found === null) throw new Error("no reference-lines layer");
      return found as SVGSVGElement;
    });

    const [minX, minY, width, height] = (layer.getAttribute("viewBox") ?? "")
      .split(/\s+/)
      .map(Number);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    // The element's own box, not just its coordinate system: a viewBox on a 0x0 element
    // is exactly the state that shipped.
    expect(Number.parseFloat(layer.style.width)).toBe(width);
    expect(Number.parseFloat(layer.style.height)).toBe(height);
    expect(Number.parseFloat(layer.style.left)).toBe(minX);
    expect(Number.parseFloat(layer.style.top)).toBe(minY);

    const line = layer.querySelector('[data-testid="reference-line-lfo-draw"] line');
    if (line === null) throw new Error("no line inside the layer");
    for (const [axis, min, extent] of [
      ["x", minX, width],
      ["y", minY, height],
    ] as const) {
      for (const end of ["1", "2"] as const) {
        const value = Number(line.getAttribute(`${axis}${end}`));
        expect(value).toBeGreaterThanOrEqual(min ?? 0);
        expect(value).toBeLessThanOrEqual((min ?? 0) + (extent ?? 0));
      }
    }
  });
});

/**
 * The gesture the user actually made: File → Open on the shipped file.
 *
 * `project.open` REPLACES the runtime (see `project-commands.ts`), which means a new bus,
 * a new document store and — because the reference-lines store is keyed per bus — a new
 * visibility store. Mounting a runtime that already holds the document never exercises
 * that swap, so it is asserted separately rather than assumed equivalent.
 */
describe("opening E10 through the bus draws the line too", () => {
  it("draws lfo1 → instances1 after project.open", async () => {
    const path = join(process.cwd(), "examples", "E10-Instanced-Torus.loom.json");
    const text = readFileSync(path, "utf8");
    const runtime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
    });
    const probe = () => Promise.resolve(READY);

    let current: AppRuntime = runtime;
    await act(async () => {
      render(
        <App
          runtime={runtime}
          storage={createMemoryStorage()}
          gpuProbe={probe}
          onRuntimeChange={(next) => {
            current = next;
          }}
        />,
      );
    });

    await act(async () => {
      await runtime.bus.execute(
        "project.open",
        { text, fileName: "E10-Instanced-Torus.loom.json" },
        runtime.invocation,
      );
    });

    expect(Object.keys(current.bus.store.getGraph().nodes).sort()).toEqual([
      "draw",
      "lfo",
      "out",
      "points",
    ]);
    await waitFor(() => {
      expect(window.document.querySelector('[data-testid="reference-line-lfo-draw"]')).not.toBeNull();
    });
  });
});
