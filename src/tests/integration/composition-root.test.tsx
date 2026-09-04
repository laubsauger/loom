// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { probeGpu } from "../../app/gpu-status.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * The composition root, mounted (T51).
 *
 * Every subsystem in this repo has its own suite and every one of them passed while the
 * application rendered an empty shell. What no single track's suite can see is the
 * wiring: whether the panes are actually mounted, whether the library reaches the store,
 * and whether a machine without WebGPU gets a message instead of a blank rectangle.
 * That seam is what this file tests.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = {
  kind: "unavailable",
  reason: "This browser does not expose WebGPU.",
};

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const READY: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true };

function newRuntime(): AppRuntime {
  // No ambient storage: identity must not leak between tests or into the real browser.
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

async function mountApp(status: GpuStatus = NO_WEBGPU, runtime: AppRuntime = newRuntime()) {
  // Stable identity: a fresh function every render would restart the probe effect.
  const probe = () => Promise.resolve(status);
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  });
  return { runtime };
}

describe("the composition root builds", () => {
  it("constructs one registry, one store and one bus without throwing", () => {
    const runtime = newRuntime();

    // The whole catalogue is registered, not a hand-listed subset — asserting the exact
    // list here would fail every time a node is added, which is noise rather than a guard.
    // What matters is that the composition root wires the REAL catalogue: the spike nodes
    // and the TD-vocabulary set both present, from one registry.
    const types = runtime.registry.list().map((definition) => definition.type);
    expect(new Set(types).size).toBe(types.length);
    for (const required of ["solid", "customWgsl", "output", "noise", "level", "over"]) {
      expect(types).toContain(required);
    }
    expect(types.length).toBeGreaterThanOrEqual(20);
    expect(runtime.bus.store.getRevision()).toBe(0);
    // §V30: the identity every command is stamped with exists before anything mounts.
    expect(runtime.invocation.actor.id).toBe("tester");
    expect(runtime.invocation.projectId).toMatch(/^project-/);
  });

  it("registers the editing commands the default keymap names", () => {
    const runtime = newRuntime();

    for (const command of [
      "graph.applyPatch",
      "graph.undo",
      "graph.redo",
      "graph.removeNodes",
      "graph.duplicateSelection",
      "graph.copySelection",
      "graph.cutSelection",
      "graph.paste",
      "node.toggleBypass",
      "node.toggleDisplay",
      "node.toggleRender",
    ]) {
      expect(runtime.bus.hasCommand(command)).toBe(true);
    }
  });
});

describe("every shell slot is filled with a real pane", () => {
  it("mounts the library, canvas, inspector, viewer, editor, problems and performance", async () => {
    await mountApp();

    expect(screen.getByLabelText("Search nodes")).toBeDefined();
    expect(screen.getByTestId("graph-canvas")).toBeDefined();
    expect(screen.getByText("No node selected")).toBeDefined();
    // The viewer's output selector (T329). It replaced a static "outputs" list when T36's
    // features were folded in, and it is a better marker for "the viewer is mounted":
    // the list rendered with no device, the selector is the pane doing its job.
    expect(screen.getByTestId("viewer-output-select")).toBeDefined();
    expect(screen.getByText("No code selected")).toBeDefined();
    // The real T41 panel, reading the telemetry hub — not the hand-rolled placeholder
    // that used to re-derive the plan's counts from `CompiledGraph` beside it.
    expect(screen.getByTestId("performance-panel")).toBeDefined();
    expect(screen.getByLabelText("Problems")).toBeDefined();
  });

  it("leaves no 'another track fills this later' placeholder behind", async () => {
    await mountApp();

    for (const hint of [
      "searchable catalog, drag onto canvas",
      "typed node graph — the source of truth",
      "parameters of the selected node",
      "pinned output, full resolution",
      "CodeMirror 6 WGSL editor mounts here",
      "compile and runtime diagnostics",
      "per-pass GPU ms, resource count, memory estimate",
    ]) {
      expect(screen.queryByText(hint)).toBeNull();
    }
  });

  /**
   * T1130 — NO TWO CONTROLS ON SCREEN AT ONCE ANSWER TO THE SAME NAME.
   *
   * The report was two `button[aria-label="Filter by category"]`s: `0cce047`/`9be113c` put
   * a node library in the left dock and an examples pane in the bottom, and both shipped
   * the shared `LibrarySearch` with its one hard-coded trigger label. A sighted user tells
   * them apart by which pane they are in. A screen-reader user has only the name, and the
   * two names were the same string — and Playwright's strict mode had already reported the
   * same fact from the other side (§T1124: the bare locator resolved to two elements and
   * the click refused, so the spec had to be scoped around it).
   *
   * ⚑ THE CLAIM IS THE GENERAL DEFECT, NOT THOSE TWO STRINGS. It walks the mounted tree
   * and asserts every INTERACTIVE control's `aria-label` is unique, so the pane that gets
   * added next month is in this gate the day it lands and nothing below names a pane, a
   * label or a count. §V908's shape: the inclusion is derived (anything that takes a
   * click or a keystroke), and only the exclusions are enumerated.
   *
   * CONTROLS, not every labelled element, and the line is drawn where the consequence is.
   * A `section` landmark and the `tablist` inside it deliberately share a name — the
   * region and its tab strip are the same thing to a reader — and two library panes each
   * heading a "points" category section is a repeated GROUP name, which is how grouping
   * works. A repeated BUTTON name is a person unable to say which of two things they are
   * about to press.
   *
   * The scope is the DEFAULT ARRANGEMENT, which is what "simultaneously mounted" means to
   * someone who has just opened the app. A surface that only co-mounts behind a gesture
   * (the cursor-anchored node browser reuses "Search nodes") is out of reach here and
   * would need its own, opened, mounting.
   */
  const CONTROL = [
    "button",
    "input",
    "select",
    "textarea",
    "a[href]",
    ...["button", "tab", "menuitem", "checkbox", "switch", "slider", "combobox"].map(
      (role) => `[role="${role}"]`,
    ),
  ].join(", ");

  /**
   * ⚑ KNOWN, PRE-EXISTING, AND NOT THIS ROW'S TO FIX (§V749, §V740).
   *
   * Every dock in the pane tree ships these two buttons, so the default arrangement has
   * FIVE of each: they are T1130's exact defect, at five times the scale, and they arrived
   * with the same T1123/T1125 layout work that produced the filter triggers. They live in
   * the pane furniture rather than the library, so fixing them here would be widening this
   * row into another one's files — the flag belongs on the board instead, and the fix is
   * the same shape the filter triggers just took (name the dock in the button).
   *
   * This list is the ONLY way past this gate, it is two entries long, and each says why.
   * A name added here is a visible decision on the diff, never a way to launder a new
   * collision past the guard.
   */
  const KNOWN_DUPLICATE_CONTROL_NAMES: ReadonlyArray<string> = [
    "Add a tab to this area",
    "Split or close this pane area",
  ];

  it("gives every control on screen at once its own accessible name", async () => {
    await mountApp();

    const byLabel = new Map<string, number>();
    for (const element of document.body.querySelectorAll(CONTROL)) {
      const label = element.getAttribute("aria-label");
      if (label === null) continue;
      byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    }

    // NON-VACUITY: an unmounted shell has no controls at all and every claim below is free.
    expect(byLabel.size).toBeGreaterThan(5);
    // AND THE EXCLUSIONS STAY HONEST: a name excused here must still be on screen, or the
    // list has outlived its reason and is quietly widening the gate (§B153).
    for (const name of KNOWN_DUPLICATE_CONTROL_NAMES) {
      expect(
        byLabel.get(name) ?? 0,
        `"${name}" is excused as a known duplicate but is not mounted`,
      ).toBeGreaterThan(1);
    }

    const shared = [...byLabel]
      .filter(([label, count]) => count > 1 && !KNOWN_DUPLICATE_CONTROL_NAMES.includes(label))
      .map(([label, count]) => `${label} (${count})`);
    expect(
      shared,
      `two or more controls are mounted together under one name: ${shared.join(", ")}. ` +
        `A sighted user tells them apart by where they sit; someone navigating by name cannot.`,
    ).toEqual([]);
  });
});

describe("the node library reaches the document through the bus (§V29)", () => {
  it("adds a node, attributed to the actor, when a definition is chosen", async () => {
    const { runtime } = await mountApp();

    const item = screen.getByText("Solid").closest("button");
    if (item === null) throw new Error("expected a library item for Solid");
    await act(async () => {
      fireEvent.click(item);
    });

    await waitFor(() => {
      expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(1);
    });
    expect(Object.values(runtime.bus.store.getGraph().nodes)[0]?.type).toBe("solid");

    // §V29/§V30/§V31: it went through the bus, so it is in the audit log with an actor.
    const audit = runtime.bus.store.getAudit();
    expect(audit.at(-1)).toMatchObject({
      command: "graph.applyPatch",
      status: "applied",
      actor: { id: "tester" },
    });
  });

  it("shows the added node on the canvas, projected from the document (§V1)", async () => {
    const { runtime } = await mountApp();
    const item = screen.getByText("Solid").closest("button");
    if (item === null) throw new Error("expected a library item for Solid");

    await act(async () => {
      fireEvent.click(item);
    });

    await waitFor(() => {
      const nodeId = Object.keys(runtime.bus.store.getGraph().nodes)[0];
      expect(nodeId).toBeDefined();
      expect(screen.getByTestId(`node-${nodeId}`)).toBeDefined();
    });
  });
});

describe("§V12 — a machine without WebGPU degrades, it does not break", () => {
  it("says why, and keeps the editor usable", async () => {
    const { runtime } = await mountApp(NO_WEBGPU);

    expect(screen.getByText("gpu unavailable")).toBeDefined();
    expect(screen.getAllByText(NO_WEBGPU.reason).length).toBeGreaterThan(0);
    // The document does not need a device: the library still adds nodes.
    const item = screen.getByText("Solid").closest("button");
    if (item === null) throw new Error("expected a library item for Solid");
    await act(async () => {
      fireEvent.click(item);
    });
    await waitFor(() => {
      expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(1);
    });
  });

  it("does not invent a capability report to compile against (§V12)", async () => {
    const { runtime } = await mountApp(NO_WEBGPU);

    // No device report, so no compile — and therefore no plan on the telemetry hub. The
    // panel says so instead of showing counts from a compile that never happened.
    expect(runtime.telemetry.snapshot().plan).toBeNull();
    expect(screen.getByText("No plan is compiled.")).toBeDefined();
  });

  it("reports a below-baseline device instead of pretending it will render", async () => {
    await mountApp({
      kind: "ready",
      capabilities: { ...CAPABILITIES, tier: "C" },
      baseline: false,
    });

    expect(screen.getByText(/below the Tier B baseline/i)).toBeDefined();
  });
});

describe("the capability probe has exactly three outcomes, and never hangs", () => {
  it("reports unavailable when the environment has no WebGPU at all", async () => {
    const status = await probeGpu({ hasWebGpu: () => false });

    expect(status.kind).toBe("unavailable");
  });

  it("reports the device's own capability report, never an assumed one (§V12)", async () => {
    const status = await probeGpu({
      hasWebGpu: () => true,
      createBackend: () =>
        ({
          initialize: () => Promise.resolve(CAPABILITIES),
          dispose: () => {},
        }) as never,
    });

    expect(status).toMatchObject({ kind: "ready", capabilities: CAPABILITIES, baseline: true });
  });

  it("gives up on an adapter request that never answers", async () => {
    let disposed = false;
    const status = await probeGpu({
      hasWebGpu: () => true,
      timeoutMs: 5,
      createBackend: () =>
        ({
          // Observed for real: a browser that exposes navigator.gpu but whose
          // requestAdapter() promise never settles. Without a deadline the app sits on
          // "requesting a device" forever, which is neither ready nor unavailable.
          initialize: () => new Promise<BackendCapabilities>(() => {}),
          dispose: () => {
            disposed = true;
          },
        }) as never,
    });

    expect(status.kind).toBe("unavailable");
    expect(disposed).toBe(false);
  });
});

describe("with a device, the compiled plan reaches the viewer", () => {
  it("lists the resolved outputs of Solid → Output", async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
      {
        op: "connect",
        source: { nodeId: "$solid", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
    ]);

    await mountApp(READY, runtime);

    expect(screen.getByText("tier")).toBeDefined();
    await waitFor(() => {
      expect(screen.getAllByText(/1280 × 720/).length).toBeGreaterThan(0);
    });
  });
});
