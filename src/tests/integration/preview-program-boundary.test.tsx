// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { PreviewProgram } from "@runtime/previews/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * B143 — the preview PROGRAM installed in the backend is the closed document's while the
 * incoming document's main plan is live.
 *
 * ## The report
 *
 * Load E24-Audio-Reaction-Diffusion, then E2-Reaction-Diffusion, and the problems pane
 * fills with `backend/unknown-resource`:
 *
 *     Pass "preview/pass/blend:out" binds unknown texture resource "target:blend:out".
 *
 * `blend`, `born`, `bowl`, `chem`, `dish` are E24 node ids. E2 does not have them. The
 * count is arithmetic, not folklore: the tile pool is 48 (`PREVIEW_TILE_CAPACITY`), E24
 * fills it, E2 has eleven nodes of which nine survive as preview tiles — 48 − 9 = 39, the
 * number the owner saw.
 *
 * ## The ordering, which is the bug
 *
 * A load has two installs, and they are not ordered with respect to each other:
 *
 *  1. THE MAIN PLAN. `backend.compile` is scheduled from an effect during the commit and
 *     resolves on a microtask; installing it re-points every attached preview host
 *     (`refreshPreviewExternals`), and rebuilds any host the last build left dirty — which
 *     for a document the size of E24 is the steady state, because a tile always reaches
 *     the host a compile before the sink it binds does (T258).
 *  2. THE PREVIEW PROGRAM. `PreviewSystem.reset()` nulls `lastSignature` so the next
 *     `plan()` re-pushes — but that is the preview tick, and the next rAF is a display
 *     frame away. `reset()` empties the atlas; it never touched the host.
 *
 * So (1) beats (2) by a frame, and in between, the closed document's forty-eight-tile
 * program is measured against the incoming document's plan. Every diagnostic it produces
 * is TRUE. The fix is therefore not to quiet them but to make them untrue: uninstall the
 * closed document's program at the boundary, synchronously, during the same commit that
 * schedules the compile. That is what this test pins.
 *
 * ## Why this gate can see it (§V701)
 *
 * §T519's `document-boundary.test.tsx` stayed green through B141 because it resolved
 * `compile` on a microtask and so never opened the window the race lives in. This one
 * OWNS the window: `compile` is parked on a promise the test resolves by hand, and the
 * claim is checked while the main-plan install is outstanding and provably before any rAF
 * tick could have run (`presents`, the preview tick's own counter, has not moved). A
 * single-document render cannot fail this — the leak IS the previous document.
 */

/**
 * The rAF door, held by the TEST.
 *
 * jsdom drives `requestAnimationFrame` off a ~16 ms timer, so any await that reaches the
 * macrotask queue — and `project.open` does — hands the preview tick frames the test did
 * not ask for. Owning the window means owning that door: callbacks queue here and run only
 * when `runFrames` says so. `cancelAnimationFrame` is honoured, or an unmounted tick would
 * keep re-registering itself against a disposed host.
 */
const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let frameClock = 0;

async function runFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const due = [...frameCallbacks.values()];
    frameCallbacks.clear();
    frameClock += 16;
    await act(async () => {
      for (const callback of due) callback(frameClock);
      await Promise.resolve();
    });
  }
}

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals["requestAnimationFrame"] = (callback: FrameRequestCallback): number => {
    const id = (nextFrameId += 1);
    frameCallbacks.set(id, callback);
    return id;
  };
  globals["cancelAnimationFrame"] = (id: number): void => {
    frameCallbacks.delete(id);
  };
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** The node id document A has and document B does not — the `blend`/`born`/`bowl` of the pair. */
const A_ONLY_NODE = "midtones";

function documentText(name: string, withMid: boolean): string {
  const nodes: Record<string, unknown> = {
    field: {
      id: "field",
      type: "solid",
      definitionVersion: 1,
      label: "solid1",
      position: { x: 0, y: 0 },
      parameters: { color: [1, 0, 0, 1] },
    },
    out: {
      id: "out",
      type: "output",
      definitionVersion: 1,
      label: "out1",
      position: { x: 480, y: 0 },
      parameters: {},
    },
  };
  const edges: Record<string, unknown> = {};
  if (withMid) {
    nodes[A_ONLY_NODE] = {
      id: A_ONLY_NODE,
      type: "level",
      definitionVersion: 1,
      label: "level1",
      position: { x: 240, y: 0 },
      parameters: {},
    };
    edges["e-field-mid"] = {
      id: "e-field-mid",
      source: { nodeId: "field", portId: "out" },
      target: { nodeId: A_ONLY_NODE, portId: "input" },
    };
    edges["e-mid-out"] = {
      id: "e-mid-out",
      source: { nodeId: A_ONLY_NODE, portId: "out" },
      target: { nodeId: "out", portId: "input" },
    };
  } else {
    edges["e-field-out"] = {
      id: "e-field-out",
      source: { nodeId: "field", portId: "out" },
      target: { nodeId: "out", portId: "input" },
    };
  }
  return JSON.stringify({
    schemaVersion: 3,
    projectId: `b143-${name}`,
    name,
    assets: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    settings: {
      outputResolution: { width: 320, height: 180 },
      workingFormat: "rgba16float",
      randomSeed: 1,
      previewLongEdge: 192,
      previewFps: 20,
      limits: {
        maxResolution: 4096,
        maxDispatch: 65_535,
        maxBufferBytes: 268_435_456,
        memoryBudgetBytes: 1_073_741_824,
      },
    },
    graph: { revision: 1, nodes, edges, groups: {} },
  });
}

/** Three nodes — `field`, `midtones`, `out`. */
const DOCUMENT_A = documentText("B143 A", true);
/** Two — `field`, `out`. Shares both with A, which is why the leak has somewhere to hide. */
const DOCUMENT_B = documentText("B143 B", false);

interface Journal {
  /** `compile` when a plan is handed over, `installed` when that compile RESOLVES. */
  readonly calls: string[];
  /** Latest program per attached preview host, as the texture resource ids it binds. */
  readonly installed: Map<number, readonly string[]>;
  /** Preview TICKS: `presentPreviews` is the second half of `PreviewSystem.update()`. */
  presents: number;
  /** Resolvers for compiles parked by `park()`. */
  readonly parked: Array<() => void>;
  /** While true, a compile does not resolve until `release()` is called. */
  parking: boolean;
}

function boundResourceIds(program: PreviewProgram): readonly string[] {
  return program.passes.flatMap((pass) =>
    (pass.textures ?? []).map((binding) => binding.resourceId),
  );
}

function journallingBackend(): { backend: ShaderloomBackend; journal: Journal } {
  const journal: Journal = {
    calls: [],
    installed: new Map(),
    presents: 0,
    parked: [],
    parking: false,
  };
  let hostCount = 0;
  const backend = {
    status: {
      initialized: true,
      disposed: false,
      halted: false,
      deviceGeneration: 1,
      temporalResets: 0,
      resourceBuilds: 0,
      framesSubmitted: 0,
      readbacks: 0,
      stale: false,
      estimatedResourceBytes: 0,
    },
    onDiagnostic: () => () => {},
    recover: async () => {},
    loop: () => ({ stop: () => {} }),
    previewHost: () => {
      const id = (hostCount += 1);
      journal.installed.set(id, []);
      return {
        setPreviewProgram(program: PreviewProgram) {
          journal.installed.set(id, boundResourceIds(program));
        },
        presentPreviews() {
          journal.presents += 1;
        },
        dispose() {
          journal.installed.delete(id);
        },
      };
    },
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    compile: async (plan: unknown) => {
      journal.calls.push("compile");
      if (journal.parking) {
        await new Promise<void>((resolve) => journal.parked.push(resolve));
      }
      // The MAIN PLAN IS NOW LIVE. Everything the backend does on install — re-pointing
      // and rebuilding every preview host — happens against whatever program the hosts
      // are holding at this instant.
      journal.calls.push("installed");
      return { id: `plan-${journal.calls.length}`, logical: plan, passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as ShaderloomBackend;
  return { backend, journal };
}

/** Everything a load's preview hosts are currently holding, flattened. */
function heldResourceIds(journal: Journal): string[] {
  return [...journal.installed.values()].flat();
}

/** Timers AND frames: the ordinary "let everything catch up" of the other boundary tests. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await runFrames(2);
  }
}

/**
 * MICROTASKS AND TIMERS, BUT NO FRAMES. Effects flush and promises chain; the preview tick
 * does not run, because the test is holding its door shut. This is the window.
 */
async function pump(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

interface Session {
  runtime(): AppRuntime;
  open(text: string, fileName: string): Promise<void>;
  journal: Journal;
}

async function mount(): Promise<Session> {
  const first = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  let current = first;
  const { backend, journal } = journallingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };

  render(
    <App
      runtime={first}
      storage={createMemoryStorage()}
      gpuProbe={() => Promise.resolve(status)}
      onRuntimeChange={(next) => {
        current = next;
      }}
    />,
  );
  await act(async () => {});
  await settle();

  return {
    runtime: () => current,
    journal,
    // Through the BUS, the door the example library and the file picker both use (§V29).
    // Deliberately WITHOUT a settle: the caller decides how much of the window to spend.
    async open(text, fileName) {
      await act(async () => {
        await current.bus.execute("project.open", { text, fileName }, current.invocation);
      });
    },
  };
}

describe("B143 — the closed document's preview program is uninstalled before the incoming plan lands", () => {
  it("holds no resource of the closed document while the new main plan is being installed", async () => {
    const session = await mount();

    await session.open(DOCUMENT_A, "A.loom.json");
    await settle();

    // NON-VACUITY, and the whole basis of the claim: the preview hosts are holding a
    // program that is SPECIFIC TO DOCUMENT A — it binds a resource of a node only A has.
    // Without this the assertion below passes on an empty program and proves nothing.
    await waitFor(
      () => {
        expect(heldResourceIds(session.journal).some((id) => id.includes(A_ONLY_NODE))).toBe(true);
      },
      { timeout: 5_000 },
    );

    // From here the backend does not finish a compile until this test says so.
    session.journal.parking = true;
    const presentsBefore = session.journal.presents;
    const callsBefore = session.journal.calls.length;

    await session.open(DOCUMENT_B, "B.loom.json");
    await pump();

    const since = session.journal.calls.slice(callsBefore);

    // THE WINDOW IS OPEN, asserted rather than assumed (§V701). A compile for B has been
    // handed to the backend and has NOT resolved, so the main-plan install is outstanding
    // right now...
    expect(since).toContain("compile");
    expect(since).not.toContain("installed");
    expect(session.journal.parked.length).toBeGreaterThan(0);
    // ...and the preview tick has not run since the load, so nothing that rides rAF can
    // be what cleaned up. If this ever moves, the test is measuring the wrong path.
    expect(session.journal.presents).toBe(presentsBefore);

    // THE CLAIM. The other install — the preview program — is already free of the closed
    // document. A backend installing B's plan into this state has nothing of A's to bind
    // against, so there is no `backend/unknown-resource` to report and none is suppressed.
    expect(heldResourceIds(session.journal).filter((id) => id.includes(A_ONLY_NODE))).toEqual([]);

    // And the previews are not simply switched off for good: once the plan lands and the
    // tick runs again, B's own program is installed.
    session.journal.parking = false;
    for (const resolve of session.journal.parked.splice(0)) resolve();
    await settle();
    await waitFor(
      () => {
        expect(heldResourceIds(session.journal).some((id) => id.includes("field"))).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(heldResourceIds(session.journal).filter((id) => id.includes(A_ONLY_NODE))).toEqual([]);
  }, 30_000);
});
