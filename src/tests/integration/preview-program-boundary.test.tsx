// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
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

function documentText(name: string, withMid: boolean, outputNodeId = "out"): string {
  const nodes: Record<string, unknown> = {
    field: {
      id: "field",
      type: "solid",
      definitionVersion: 1,
      label: "solid1",
      position: { x: 0, y: 0 },
      parameters: { color: [1, 0, 0, 1] },
    },
    [outputNodeId]: {
      id: outputNodeId,
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
      target: { nodeId: outputNodeId, portId: "input" },
    };
  } else {
    edges["e-field-out"] = {
      id: "e-field-out",
      source: { nodeId: "field", portId: "out" },
      target: { nodeId: outputNodeId, portId: "input" },
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
/**
 * T1126: the same two nodes, with the Output node named so that a node ADDED LATER sorts
 * ahead of it. `plan.outputs` is ordered by node id and the viewer takes the first row
 * that presents a picture, so `zout` is what lets a refused plan's new Output node become
 * the sink the app WANTS while the installed plan still holds this one. The `z` is the
 * whole point of the name and nothing else about the document differs.
 */
const DOCUMENT_C_OUTPUT = "zout";
const DOCUMENT_C = documentText("T1126 C", false, DOCUMENT_C_OUTPUT);

interface Journal {
  /** `compile` when a plan is handed over, `installed` when that compile RESOLVES. */
  readonly calls: string[];
  /** Latest program per attached preview host, as the texture resource ids it binds. */
  readonly installed: Map<number, readonly string[]>;
  /** T1121: the latest program object per host, kept whole so its own resources are readable. */
  readonly programs: Map<number, PreviewProgram>;
  /**
   * T1121: the resources of the plan the backend has ACTUALLY INSTALLED — written when a
   * `compile` resolves, never when one is merely handed over. A plan the app refused to
   * hand over leaves this holding the previous document's, which is the whole subject of
   * the second describe below.
   */
  planResources: readonly string[];
  /** Preview TICKS: `presentPreviews` is the second half of `PreviewSystem.update()`. */
  presents: number;
  /**
   * T1126: every output id the VIEWER has asked the backend to present, from the attach
   * and from every `setOutput` repoint. The viewer is a `compiled.outputs` consumer of the
   * same class as the preview stack, and this is the id it hands over.
   */
  readonly presented: string[];
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

function journallingBackend(): { backend: LoomBackend; journal: Journal } {
  const journal: Journal = {
    calls: [],
    installed: new Map(),
    programs: new Map(),
    planResources: [],
    presents: 0,
    presented: [],
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
          journal.programs.set(id, program);
        },
        presentPreviews() {
          journal.presents += 1;
        },
        dispose() {
          journal.installed.delete(id);
          journal.programs.delete(id);
        },
      };
    },
    present: (_canvas: unknown, options: { outputId: string }) => {
      journal.presented.push(options.outputId);
      return {
        id: "present-stub",
        outputId: options.outputId,
        setOutput: (next: string) => journal.presented.push(next),
        dispose: () => {},
      };
    },
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compile: async (plan: unknown) => {
      journal.calls.push("compile");
      if (journal.parking) {
        await new Promise<void>((resolve) => journal.parked.push(resolve));
      }
      // The MAIN PLAN IS NOW LIVE. Everything the backend does on install — re-pointing
      // and rebuilding every preview host — happens against whatever program the hosts
      // are holding at this instant.
      journal.calls.push("installed");
      journal.planResources = ((plan as { resources?: ReadonlyArray<{ id: string }> }).resources ?? []).map(
        (resource) => resource.id,
      );
      return { id: `plan-${journal.calls.length}`, logical: plan, passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
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

/**
 * B179 / T1121 — THE APP FEEDS THE PREVIEW STACK THE OUTPUTS OF THE PLAN IT WANTED, NOT
 * THE PLAN THE BACKEND HAS.
 *
 * ## The report
 *
 * The same `backend/unknown-resource` sentence as B143 above, but with no document
 * boundary anywhere near it: one node with a required input left unconnected is enough,
 * on a document that has never been closed, and it repeats every thirty frames
 * (`retryDirtyPreviewHosts`, T311) for as long as the error stands.
 *
 * ## The cause, which is one line on each side
 *
 *  1. `use-frame-loop.ts` refuses to install a plan that carries a compiler error
 *     (`if (compiled === null || !compiled.ok) return;`), so the backend keeps the
 *     PREVIOUS program. That refusal is §V9 and it is correct.
 *  2. `app.tsx` fed the whole preview stack `compile.compiled?.outputs` UNCONDITIONALLY —
 *     the outputs of the plan that was never handed over. Every row materialised only in
 *     the refused plan becomes a preview pass binding a resource the installed plan does
 *     not have.
 *
 * ## Why this gate can see it, and why it is not a list of five node ids
 *
 * The claim is checked the way the backend checks it: EVERY texture a preview pass binds
 * must be resolvable against the installed plan's resources or the program's own. It is
 * not "these five nodes do not warn" — the node types are DERIVED from the registry (any
 * type with a required texture input and a texture output), so a node added to the
 * catalogue tomorrow is in the case the day it lands, and none of the assertions name a
 * node type or a document.
 *
 * The refusal itself is asserted, not assumed: `compile` must not have been called again,
 * which is what "the backend still holds the previous program" means from out here.
 */

/** Node types whose required input is a texture and whose output is one (§V701: derived). */
function typesWithARequiredTextureInput(runtime: AppRuntime): readonly string[] {
  return runtime.registry
    .list()
    .filter(
      (definition) =>
        definition.inputs.some(
          (port) => port.optional !== true && port.type.kind === "texture2d",
        ) && definition.outputs.some((port) => port.type.kind === "texture2d"),
    )
    .map((definition) => definition.type);
}

/**
 * What the BACKEND would report: a preview pass binding a texture that neither the
 * installed plan nor the program itself carries is one `backend/unknown-resource`.
 */
function unresolvedBindings(journal: Journal): string[] {
  const unresolved: string[] = [];
  for (const program of journal.programs.values()) {
    const known = new Set([...journal.planResources, ...program.resources.map((r) => r.id)]);
    for (const pass of program.passes) {
      for (const binding of pass.textures ?? []) {
        if (!known.has(binding.resourceId)) unresolved.push(`${pass.id} -> ${binding.resourceId}`);
      }
    }
  }
  return unresolved;
}

describe("B179 — a document with a compiler error never previews against a plan the backend does not have", () => {
  it("binds no resource outside the installed plan, and says the picture is stale", async () => {
    const session = await mount();
    await session.open(DOCUMENT_B, "B.loom.json");
    await settle();

    // NON-VACUITY: previews are live and binding real resources of the installed plan. On
    // an empty program every assertion below is free.
    await waitFor(
      () => {
        expect(heldResourceIds(session.journal).length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    expect(unresolvedBindings(session.journal)).toEqual([]);
    expect(screen.queryByTestId("notice-strip")?.textContent ?? "").not.toContain("stale");

    const types = typesWithARequiredTextureInput(session.runtime());
    // Derived, and the number is not the point — that it is a class rather than a roster
    // is. If the catalogue ever stops having several such types this gate has stopped
    // being about anything.
    expect(types.length).toBeGreaterThan(3);

    let created: Record<string, string> = {};
    await act(async () => {
      const runtime = session.runtime();
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "dangling",
          operations: types.map((type, index) => ({
            op: "addNode" as const,
            ref: `$dangling${index}`,
            type,
            position: { x: 40 * (index % 8), y: 40 * Math.floor(index / 8) },
          })),
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
      created = (result.output as { createdIds: Record<string, string> }).createdIds;
    });
    await settle();

    const danglingIds = Object.values(created);
    expect(danglingIds.length).toBe(types.length);

    /**
     * THE PRECONDITION, ASSERTED RATHER THAN ASSUMED — and note what it is NOT.
     *
     * It is not "no compile was handed over". A dangling node reaches no sink, so the
     * FIRST plan after the patch prunes it and is perfectly valid; it is the preview
     * scheduler asking for those nodes as sinks that makes them live, and THAT plan is
     * the one carrying the errors and the one `use-frame-loop` refuses. What is true
     * either way, and is the only thing the claim below rests on, is that the plan the
     * backend HAS carries no resource of these nodes.
     */
    const installedDangling = session.journal.planResources.filter((id) =>
      danglingIds.some((nodeId) => id.includes(nodeId)),
    );
    expect(installedDangling).toEqual([]);

    // THE CLAIM. Every preview pass binds something the installed plan (or the program
    // itself) actually carries — so there is no `backend/unknown-resource` to report, and
    // none is suppressed.
    expect(unresolvedBindings(session.journal)).toEqual([]);

    // AND THE HALF THAT HELPS: the user is told the render is not their edit. Asserted as
    // the sentence a person reads, not as a boolean somewhere.
    await waitFor(
      () => {
        expect(screen.getByTestId("notice-strip").textContent).toContain(
          "Output stale — this document has errors, so the last version that compiled is still rendering.",
        );
      },
      { timeout: 5_000 },
    );
  }, 30_000);
});

/**
 * T1126 — THE VIEWER IS THE SAME CLASS OF CONSUMER, AND WAS DELIBERATELY LEFT OUT OF §T1121.
 *
 * `ViewerPane` reads `compiled.outputs`, picks the declared sink off it, and hands that id
 * to `backend.present`. Fed `compile.compiled` it read THE PLAN THE APP WANTED — and
 * `use-frame-loop.ts:550` refuses to install a plan carrying a compiler error, so what the
 * GPU holds is the previous one. The §T1121 worker raised this rather than widening its own
 * change, which is right, and this is the extension: the same `installedPlan` latch, one
 * more prop.
 *
 * ## Why it was "low risk today" and why that is not a reason to leave it
 *
 * Every `$target` id derives from a stable node id, so an ordinary edit — a parameter, a
 * wire, a node added mid-chain — leaves the sink's id untouched and the stale id happens to
 * still resolve. The exposure is the plan that RENAMES OR ADDS THE OUTPUT NODE while also
 * carrying an error: then the app wants a sink the installed program has never heard of,
 * and the viewer asks the backend to present it.
 *
 * ## What this gate does, and what it refuses to do
 *
 * The claim is on the id the viewer HANDS OVER — the value the consumer reads back, not
 * "which prop was passed". It is checked against the resources of the plan the backend
 * ACTUALLY INSTALLED (`planResources`, written when a `compile` RESOLVES), which is the
 * backend's own test for whether an id means anything.
 *
 * The added Output node's type and the wire's port ids are DERIVED from the registry, the
 * same way §T1121's gate derives its forty-two node types: nothing below hard-codes a node
 * type, a port name, or a resource id.
 */

/** Present calls the installed plan cannot answer — the viewer's `backend/unknown-resource`. */
function unresolvedPresents(journal: Journal): string[] {
  const known = new Set(journal.planResources);
  return [...new Set(journal.presented)].filter((id) => !known.has(id));
}

/**
 * A node type that CANNOT compile unconnected (a required texture input) and still emits a
 * texture — so wiring its output into a new Output node makes that whole chain error while
 * keeping the new Output node a live sink rather than a pruned one.
 */
function erroringLink(runtime: AppRuntime): { type: string; outPort: string } {
  for (const type of typesWithARequiredTextureInput(runtime)) {
    const definition = runtime.registry.get(type);
    const outPort = definition?.outputs.find((port) => port.type.kind === "texture2d")?.id;
    if (outPort !== undefined) return { type, outPort };
  }
  throw new Error("no registered type has both a required texture input and a texture output");
}

/** The Output node's own texture input, read off its definition rather than retyped. */
function outputInputPort(runtime: AppRuntime): string {
  const definition = runtime.registry.get("output");
  const port = definition?.inputs.find((input) => input.type.kind === "texture2d")?.id;
  if (port === undefined) throw new Error("the output node has no texture input");
  return port;
}

describe("T1126 — the viewer presents from the plan the backend has", () => {
  it("hands `present` no output id the installed plan does not carry", async () => {
    const session = await mount();
    await session.open(DOCUMENT_C, "C.loom.json");
    await settle();

    /*
     * NON-VACUITY, and it is load-bearing twice over: the viewer really is presenting
     * (so a claim about what it presents is about something), and what it presents is the
     * document's declared sink (so the latch has not simply blanked the pane).
     */
    await waitFor(
      () => {
        expect(session.journal.presented.length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    expect(session.journal.presented.some((id) => id.includes(DOCUMENT_C_OUTPUT))).toBe(true);
    expect(unresolvedPresents(session.journal)).toEqual([]);

    const runtime = session.runtime();
    const link = erroringLink(runtime);
    const inputPort = outputInputPort(runtime);

    /*
     * ONE ATOMIC PATCH that ADDS AN OUTPUT NODE AND BREAKS THE COMPILE TOGETHER. Both
     * halves matter: the new Output node is the sink the app wants, and the unconnected
     * required input on the node feeding it is what makes `use-frame-loop` refuse to hand
     * the plan over, so the backend keeps the program that has never heard of it.
     */
    let created: Record<string, string> = {};
    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "a second output, on a broken chain",
          operations: [
            { op: "addNode" as const, ref: "$bad", type: link.type, position: { x: 240, y: 200 } },
            { op: "addNode" as const, ref: "$second", type: "output", position: { x: 480, y: 200 } },
            {
              op: "connect" as const,
              source: { nodeId: "$bad", portId: link.outPort },
              target: { nodeId: "$second", portId: inputPort },
            },
          ],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
      created = (result.output as { createdIds: Record<string, string> }).createdIds;
    });
    await settle();

    /*
     * THE PRECONDITIONS, ASSERTED RATHER THAN ASSUMED — without both, the claim below is
     * true for a reason that has nothing to do with the latch.
     *
     *  1. the new Output node sorts AHEAD of the document's own, so it is the row the
     *     viewer's first-picture-presenting-sink scan reaches first in the wanted plan;
     *  2. the plan the backend HAS carries no resource of it.
     */
    const second = created["$second"];
    if (second === undefined) throw new Error("the patch created no second output node");
    expect(second.localeCompare(DOCUMENT_C_OUTPUT)).toBeLessThan(0);
    expect(session.journal.planResources.filter((id) => id.includes(second))).toEqual([]);

    // THE CLAIM. Every id the viewer has handed the backend is one the installed plan
    // carries — so the presentation surface is attached to a real program, and the picture
    // on screen is the one the GPU is actually rendering.
    expect(
      unresolvedPresents(session.journal),
      `the viewer asked the backend to present ${unresolvedPresents(session.journal).join(", ")}, ` +
        `which the installed plan does not carry — it is reading the plan the app wanted.`,
    ).toEqual([]);
  }, 30_000);
});
