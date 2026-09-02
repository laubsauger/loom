// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ReadbackImage } from "@runtime/previews/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T726 / B106 — the viewer's PIN does not survive a load.
 *
 * The owner, using the app: "seeing output node and viewer listings sometimes being stale
 * when loading new examples or files". T519 fixed the half of B106 that lives in the
 * compiler and the tile atlas — the classifier now treats a load as a discontinuity, the
 * preview system resets, temporal history is cleared. It left the half that lives in the
 * VIEWER'S OWN STATE: which output the pane is pointed at is a `${nodeId}:${portId}` key
 * held in React state, in a component `adoptDocument` never remounts.
 *
 * MEASURED in the running app before this landed: open E2-Reaction-Diffusion, pin the
 * viewer to `rd:out`, open E24-Audio-Reaction-Diffusion — a different project, eleven
 * shared node ids — and the selector still reads `rd:out`. The new project's Output node
 * is not what is on screen and nothing says so. That is the whole bug: a pin is a NAME,
 * names collide across documents (E31/E32 share twenty-one ids; `out` is in all twenty-nine
 * shipped examples), and a key that still matches is exactly what "the pin is still valid"
 * looks like from inside one document.
 *
 * ## The fixture is adversarial on purpose (§V461)
 *
 * A and B share every node id, every type and every edge id. If they did not, the pinned
 * key would simply be ABSENT from B's outputs and the pre-existing "a pin the graph no
 * longer produces falls back to the sink" branch would carry the test — green, and about
 * nothing. The bug only exists where the incoming document CAN honour the stale key, so a
 * fixture that cannot produce that situation cannot fail whatever it asserts. The gate
 * therefore checks, out loud, that B's listing still offers `extra:out` before asserting
 * that the viewer did not choose it.
 *
 * ## TWO documents, and that is not decoration (§V681's sibling)
 *
 * One load proves nothing here: with a single document the pin is correct by construction.
 * The claim is about what CROSSES a boundary, so the gate must cross one.
 *
 * ## The pixel READOUT is the same defect on the same pane (T733)
 *
 * The probe's target is memoised on `${nodeId}` and `${portId}`, and every one of the
 * twenty-nine shipped examples declares its sink on a node called `out` — so those two
 * primitives do not move across a load, the memo stays referentially stable, and every
 * reset hanging off it stays asleep. The sampled value survives into a project that never
 * produced it, as a NUMBER, which is the worst possible disguise for stale data.
 *
 * ## The control (§V32's direction, restated)
 *
 * Clearing the pin on every render would satisfy everything above and would be a worse
 * product — the pin exists so a user can watch an intermediate node while they edit. So
 * the negative direction is gated in the same file: an ordinary patch inside ONE document
 * must leave the pin exactly where the user put it.
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

/**
 * One `.loom.json`, parameterised by the one thing that differs.
 *
 * `field` -> `out` is the picture; `extra` is an unwired texture node, which every
 * visible texture node being a preview sink (§V28b) makes a real, selectable output. It
 * is the thing a user pins when they want to watch an intermediate, and the thing whose
 * name collides with the next project's.
 */
function documentText(name: string, color: readonly number[]): string {
  return JSON.stringify({
    schemaVersion: 3,
    projectId: `t726-${name}`,
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
    graph: {
      revision: 1,
      nodes: {
        field: {
          id: "field",
          type: "solid",
          definitionVersion: 1,
          label: "solid1",
          position: { x: 0, y: 0 },
          parameters: { color },
        },
        extra: {
          id: "extra",
          type: "noise",
          definitionVersion: 1,
          label: "noise1",
          position: { x: 0, y: 200 },
          parameters: {},
        },
        out: {
          id: "out",
          type: "output",
          definitionVersion: 1,
          label: "out1",
          position: { x: 240, y: 0 },
          parameters: {},
        },
      },
      edges: {
        "e-field-out": {
          id: "e-field-out",
          source: { nodeId: "field", portId: "out" },
          target: { nodeId: "out", portId: "input" },
        },
      },
      groups: {},
    },
  });
}

/** Red. */
const DOCUMENT_A = documentText("T726 A", [1, 0, 0, 1]);
/** Blue — the same document in every respect a node-id comparison can see. */
const DOCUMENT_B = documentText("T726 B", [0, 0, 1, 1]);

/** The intermediate a user pins. Present in BOTH documents, which is the whole point. */
const PINNED = "extra:out";

function stubBackend(): LoomBackend {
  return {
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
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => Promise.resolve({ id: "plan", logical: plan } as CompiledExecutionPlan),
    render() {},
    resize() {},
    onDiagnostic: () => () => {},
    onGpuTimings: () => () => {},
    loop: () => ({ stop() {} }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    present: (_canvas: unknown, options: { outputId: string }) => ({
      id: "present",
      outputId: options.outputId,
      setOutput() {},
      dispose() {},
    }),
    updateUniforms() {},
    resetTemporalHistory() {},
    // One opaque mid-grey pixel, so the readout has a real number to hold on to.
    readOutput: (): Promise<ReadbackImage> =>
      Promise.resolve({
        width: 1,
        height: 1,
        format: "rgba8unorm",
        rowStride: 4,
        bytes: new Uint8Array([128, 128, 128, 255]),
      }),
    recover: () => Promise.resolve(),
    setCookPolicy() {},
    dispose() {},
  } as unknown as LoomBackend;
}

interface Session {
  runtime(): AppRuntime;
  open(text: string, fileName: string): Promise<void>;
  patch(operations: GraphPatchOperation[]): Promise<void>;
  select(): HTMLSelectElement;
  pin(value: string): Promise<void>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

async function mount(): Promise<Session> {
  const first = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  let current = first;
  const status: GpuStatus = {
    kind: "ready",
    capabilities: CAPABILITIES,
    baseline: true,
    backend: stubBackend(),
  };

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

  const select = () => screen.getByTestId("viewer-output-select") as HTMLSelectElement;
  return {
    runtime: () => current,
    select,
    async open(text, fileName) {
      // Through the BUS — the door the example library and the file picker both use
      // (§V29, §V88). A hand-rolled adopt would prove something else works.
      await act(async () => {
        await current.bus.execute("project.open", { text, fileName }, current.invocation);
      });
      await settle();
    },
    async patch(operations) {
      await act(async () => {
        await current.bus.execute(
          "graph.applyPatch",
          { baseRevision: current.bus.store.getRevision(), operations },
          current.invocation,
        );
      });
      await settle();
    },
    async pin(value) {
      await act(async () => {
        fireEvent.change(select(), { target: { value } });
      });
      await settle();
    },
  };
}

/** Every option the selector is offering, by value. */
function listing(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value);
}

/** The declared sink's key — what an opened project is supposed to be showing. */
const SINK = "out:$target";

describe("T726 — a load resets the viewer's pin (B106)", () => {
  it("does not carry a pin into a document that merely shares the node's name", async () => {
    const session = await mount();

    await session.open(DOCUMENT_A, "A.loom.json");
    await waitFor(() => {
      expect(listing(session.select())).toContain(PINNED);
    });
    // The user pins an intermediate. NON-VACUITY: everything below is about what the
    // SECOND load does to this pin, so the pin has to exist first.
    await session.pin(PINNED);
    expect(session.select().value).toBe(PINNED);

    const identityA = session.runtime().documentIdentity;
    await session.open(DOCUMENT_B, "B.loom.json");
    // A load establishes a new document (§V437) — if this ever stopped being true the
    // assertions below would be measuring something else entirely.
    expect(session.runtime().documentIdentity).not.toBe(identityA);

    // ADVERSARIAL, out loud (§V461): B CAN honour the stale key. The claim below is that
    // it refuses to, not that it was unable to.
    await waitFor(() => {
      expect(listing(session.select())).toContain(PINNED);
    });

    // THE CLAIM. Opening a project shows that project's Output, not whatever the closed
    // one's pin happens to name in it.
    expect(session.select().value).toBe(SINK);
  }, 30_000);

  it("does not carry a probed pixel VALUE into the next document (T733)", async () => {
    const session = await mount();
    await session.open(DOCUMENT_A, "A.loom.json");
    await waitFor(() => {
      expect(listing(session.select())).toContain(SINK);
    });

    // The viewer's own canvas, given a box to normalise against — jsdom measures every
    // element as zero, and a zero-sized picture has no pixel to point at.
    const canvas = screen.getByTestId("viewer-canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 100,
        right: 300,
        bottom: 150,
        x: 100,
        y: 50,
        toJSON: () => "",
      }) as DOMRect;

    await act(async () => {
      fireEvent.pointerMove(canvas, { clientX: 200, clientY: 125, buttons: 0 });
    });
    // NON-VACUITY: there has to BE a reading before "the reading did not survive" means
    // anything. `—` is the empty state, so the assertion is that it is not that.
    await waitFor(() => {
      expect(screen.getByTestId("viewer-readout").textContent).toMatch(/\d/);
    });
    const sampled = screen.getByTestId("viewer-readout").textContent ?? "";

    // ADVERSARIAL (§V461): B's sink is `out:$target` too — the same nodeId and the same
    // portId — so nothing about the probe's TARGET moves. That is exactly the case the
    // memo cannot see, and a fixture whose two documents named their output differently
    // would pass on the broken code.
    await session.open(DOCUMENT_B, "B.loom.json");
    await waitFor(() => {
      expect(session.select().value).toBe(SINK);
    });

    // THE CLAIM. A number belonging to a project the user has closed is not a reading of
    // the one they just opened, so the readout is back to its empty state.
    const after = screen.getByTestId("viewer-readout").textContent ?? "";
    expect(after).not.toBe(sampled);
    expect(after).toContain("\u2014");
  }, 30_000);

  it("keeps the pin across an ordinary edit inside ONE document (the control)", async () => {
    // The negative direction, and the reason it lives beside the test above: clearing the
    // pin on every render would satisfy every assertion there and would break the feature
    // the pin exists for — watching an intermediate WHILE editing.
    const session = await mount();
    await session.open(DOCUMENT_A, "A.loom.json");
    await waitFor(() => {
      expect(listing(session.select())).toContain(PINNED);
    });
    await session.pin(PINNED);
    expect(session.select().value).toBe(PINNED);

    await session.patch([
      { op: "setParameters", nodeId: "field", parameters: { color: [0, 1, 0, 1] } },
    ]);

    expect(session.select().value).toBe(PINNED);
  }, 30_000);
});
