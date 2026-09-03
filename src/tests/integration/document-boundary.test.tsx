// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T519 / B106 — opening a second project must not render the first one's pixels.
 *
 * The owner, using the app: "if we're loading another loom or example and that happens to
 * share the same name with the prior rendered one, we need to manually kick the different
 * nodes to update and not show the prior rendered one's content / being stale."
 *
 * ## The fixture is adversarial on purpose (§V461)
 *
 * `documentA` and `documentB` share every node id, every node type, every label and every
 * edge id, and differ in exactly one parameter — a colour, which is the whole picture for
 * a Solid. That is not a contrived pair: node ids in a `.loom.json` are human names, and
 * the shipped examples collide heavily — every one of them has a node called `out`, and
 * E2 and E24 share ELEVEN ids including the one holding the reaction-diffusion state.
 *
 * Two documents that differ visibly would prove nothing here. The bug only appears where
 * the id diff BELIEVES the two documents have something in common, so a fixture that
 * cannot produce that belief cannot fail, whatever it asserts.
 *
 * ## What is asserted, and why THESE things
 *
 * A load is a discontinuity: nothing built for the previous document may be reused,
 * whatever the ids say. Two consequences are observable at this seam and both are
 * checked — the incoming plan reaches the backend carrying B's values, and TEMPORAL
 * HISTORY is cleared, because `backend.compile` carries resources over BY RESOURCE ID and
 * a carried ping-pong or ring keeps its CONTENTS (§V62b, T143). That carry-over is the
 * thing that makes an unrelated edit cheap inside one document and leaks one project's
 * feedback into the next across two.
 *
 * The ORDER is asserted too, because getting it backwards is a plausible fix that does
 * nothing: `resetTemporalHistory` clears the ACTIVE program, and the active program is
 * still the previous document's until `backend.compile` resolves.
 *
 * And the negative direction is gated in the same file (§V32, §V5): an ordinary parameter
 * edit inside one document must still take the cheap path. A fix that made every revision
 * a full rebuild would trade a correctness bug for a performance bug, and the assertions
 * above would not notice.
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
 * Node ids `field` and `out`, labels `solid1` and `out1`, edge id `e-field-out` — the
 * names a person types, which is why two unrelated documents collide on them.
 */
function documentText(name: string, color: readonly number[]): string {
  return JSON.stringify({
    schemaVersion: 3,
    projectId: `t519-${name}`,
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
const DOCUMENT_A = documentText("T519 A", [1, 0, 0, 1]);
/** Blue — the same document in every respect a node-id diff can see. */
const DOCUMENT_B = documentText("T519 B", [0, 0, 1, 1]);

interface Journal {
  /** Every backend call that matters here, in order. */
  readonly calls: string[];
  /** The pass uniforms of each plan handed to `backend.compile`, newest last. */
  readonly compiledUniforms: Array<Record<string, unknown>>;
}

function journallingBackend(): {
  backend: LoomBackend;
  journal: Journal;
  /** T792: push a diagnostic the way the real backend would (unknown-resource bursts). */
  emitDiagnostic(diagnostic: { severity: string; code: string; message: string }): void;
} {
  const journal: Journal = { calls: [], compiledUniforms: [] };
  const listeners = new Set<(diagnostic: unknown) => void>();
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
    onDiagnostic: (listener: (diagnostic: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover: async () => {},
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compile: async (plan: { passes?: ReadonlyArray<{ uniforms?: Record<string, unknown> }> }) => {
      journal.calls.push("compile");
      const uniforms: Record<string, unknown> = {};
      for (const pass of plan.passes ?? []) Object.assign(uniforms, pass.uniforms ?? {});
      journal.compiledUniforms.push(uniforms);
      return { id: `plan-${journal.compiledUniforms.length}`, passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {
      journal.calls.push("updateUniforms");
    },
    resetTemporalHistory: (resourceIds?: readonly string[]) => {
      journal.calls.push(resourceIds === undefined ? "resetTemporalHistory" : "resetTemporalHistory:scoped");
    },
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return {
    backend,
    journal,
    emitDiagnostic: (diagnostic) => {
      for (const listener of listeners) listener(diagnostic);
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

interface Session {
  /** The CURRENT runtime — an open replaces it wholesale (`adoptDocument`). */
  runtime(): AppRuntime;
  open(text: string, fileName: string): Promise<void>;
  patch(operations: GraphPatchOperation[]): Promise<void>;
  journal: Journal;
  /** T792: push a backend diagnostic (an unknown-resource burst, in miniature). */
  emitDiagnostic(diagnostic: { severity: string; code: string; message: string }): void;
  /** T792: the problems list, read through the same bus query the agent surface uses. */
  problems(): Promise<ReadonlyArray<{ code: string }>>;
}

async function mount(): Promise<Session> {
  const first = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  let current = first;
  const { backend, journal, emitDiagnostic } = journallingBackend();
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
    emitDiagnostic,
    async problems() {
      const snapshot = await current.bus.query("diagnostics.get", {}, current.invocation);
      return snapshot.diagnostics;
    },
    async open(text, fileName) {
      // Through the BUS, which is the door the example library and the file picker both
      // use (§V29, §V88) — not a hand-rolled adopt that would prove something else works.
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
  };
}

describe("T519 — a second document does not render the first one's pixels (B106)", () => {
  it("rebuilds and clears history when a load crosses a document boundary", async () => {
    const session = await mount();

    await session.open(DOCUMENT_A, "A.loom.json");
    // NON-VACUITY. Everything below is about what the SECOND load does; if the first one
    // never reached the backend there would be nothing to contaminate and no claim.
    await waitFor(() => {
      expect(session.journal.compiledUniforms.length).toBeGreaterThan(0);
    });
    const red = session.journal.compiledUniforms.at(-1)?.["color"] as number[] | undefined;
    expect(red?.[0]).toBeGreaterThan(0.5);
    expect(red?.[2]).toBeLessThan(0.5);

    const before = session.journal.calls.length;
    await session.open(DOCUMENT_B, "B.loom.json");

    // 1. THE PIXELS COME FROM B. The plan the backend was last given carries B's colour,
    //    not A's — and the two documents are otherwise indistinguishable by node id.
    const blue = session.journal.compiledUniforms.at(-1)?.["color"] as number[] | undefined;
    expect(blue).toBeDefined();
    expect(blue?.[2]).toBeGreaterThan(0.5);
    expect(blue?.[0]).toBeLessThan(0.5);
    // The document agrees, so this is one story and not two.
    expect(session.runtime().bus.store.getGraph().nodes["field"]?.parameters["color"]).toEqual([
      0, 0, 1, 1,
    ]);

    // 2. TEMPORAL HISTORY IS CLEARED, and cleared WHOLESALE: a load invalidates every
    //    pair, not a named one. Without this the backend's id-keyed carry-over hands the
    //    incoming document the previous project's feedback contents (§V62b, T143, §V22).
    const since = session.journal.calls.slice(before);
    expect(since).toContain("resetTemporalHistory");
    expect(since).not.toContain("resetTemporalHistory:scoped");

    // 3. AFTER the plan is installed, never before. `resetTemporalHistory` clears the
    //    ACTIVE program, and until `backend.compile` resolves that is still A's — so the
    //    reversed order would wipe the picture the user is looking at and leave B's
    //    carried-over resources exactly as contaminated as they were.
    expect(since.indexOf("resetTemporalHistory")).toBeGreaterThan(since.indexOf("compile"));
  }, 30_000);

  it("leaves an ordinary edit on the cheap path (§V5, §V32 — the control)", async () => {
    // The negative direction, and it is the reason this test lives beside the one above:
    // making every revision a full rebuild would satisfy every assertion in the first
    // test and would be a worse product. §V32's take-the-maximum rule means a batch costs
    // what its most expensive member costs, and a value edit's maximum is a uniform write.
    const session = await mount();
    await session.open(DOCUMENT_A, "A.loom.json");
    await waitFor(() => {
      expect(session.journal.compiledUniforms.length).toBeGreaterThan(0);
    });

    const before = session.journal.calls.length;
    await session.patch([
      { op: "setParameters", nodeId: "field", parameters: { color: [0, 1, 0, 1] } },
    ]);
    const since = session.journal.calls.slice(before);

    // No plan rebuild, and no history clear — a slider drag must not throw away a
    // feedback loop the user has been growing for a minute (§V22, §V5).
    expect(since).not.toContain("compile");
    expect(since).not.toContain("resetTemporalHistory");
    // ...and it is not "nothing happened": the new value did reach the GPU. Without this
    // the two assertions above would pass on a gate stuck shut.
    expect(since).toContain("updateUniforms");
  }, 30_000);
});

/**
 * T792 — accumulated backend diagnostics belong to the DOCUMENT they were emitted under.
 *
 * Every document transition runs one burst of preview passes against the not-yet-adopted
 * program, and each warns `backend/unknown-resource`. The store retained them across
 * opens: five documents deep, the problems pane held 51 warnings spanning documents no
 * longer on screen, and a live B155 hunt lost an hour to leads the pane itself planted.
 * A diagnostics pane that accumulates other documents' noise teaches its reader to
 * ignore it, which is the opposite of a diagnostics pane.
 *
 * T465's clear semantics make the emptying safe: anything still true about the NEW
 * document re-reports on its own — the assertion here that a POST-open diagnostic
 * survives is the half that keeps this from being a test of "the pane is always empty".
 */
describe("T792 — a document boundary empties the accumulated backend diagnostics", () => {
  it("drops the outgoing document's warnings and keeps the new one's", async () => {
    const session = await mount();
    await session.open(DOCUMENT_A, "A.loom.json");
    await waitFor(() => {
      expect(session.journal.compiledUniforms.length).toBeGreaterThan(0);
    });

    session.emitDiagnostic({
      severity: "warning",
      code: "backend/unknown-resource",
      message: 'Pass "preview/pass/field:out" binds unknown texture resource "target:field:out".',
    });
    await settle();
    expect((await session.problems()).map((entry) => entry.code)).toContain(
      "backend/unknown-resource",
    );

    await session.open(DOCUMENT_B, "B.loom.json");
    expect((await session.problems()).map((entry) => entry.code)).not.toContain(
      "backend/unknown-resource",
    );

    // The store still LISTENS after the boundary: a warning emitted under the new
    // document lands, proving the emptying was a reset and not a disconnection.
    session.emitDiagnostic({
      severity: "warning",
      code: "backend/unknown-resource",
      message: 'Pass "preview/pass/out:$target" binds unknown texture resource "target:out:$target".',
    });
    await settle();
    expect((await session.problems()).map((entry) => entry.code)).toContain(
      "backend/unknown-resource",
    );
  }, 30_000);
});
