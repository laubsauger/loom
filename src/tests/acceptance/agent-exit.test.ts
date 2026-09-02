import { beforeAll, describe, expect, it } from "vitest";

import { createAgentToolSurface } from "../../agent/index.ts";
import type { AgentToolSurface } from "../../agent/surface.ts";
import type { AgentPorts, AgentRuntimeMetrics, PreviewExport, ToolResult } from "../../agent/types.ts";
import { registerCompileCommand } from "../../app/compile-command.ts";
import type { CompileReport } from "../../app/compile-command.ts";
import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import { attachStateSources, createDomainBus } from "../../domain/commands/index.ts";
import type { LoomBus } from "../../domain/commands/bus.ts";
import type { HistorySummary } from "../../domain/commands/graph-commands.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import type { GraphStore } from "../../domain/graph/store.ts";
import type { BackendCapabilities, FrameInputs } from "../../domain/types/backend.ts";
import type { Actor, AuditEntry } from "../../domain/types/commands.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { LoomBackend } from "../../runtime/backend/index.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import {
  createExportInterface,
  exportOutputsFrom,
  readbackSourceFromBackend,
  renderPreviewPng,
} from "../../runtime/export/index.ts";
import { createTelemetryHub, telemetryPlan } from "../../runtime/telemetry/index.ts";
import { pocSettings } from "./poc-graph.ts";

/**
 * T62 — the Phase 1 AGENT exit criterion (§T): an agent adds three nodes and wires them in
 * ONE patch, compiles, renders a preview, reads GPU timings, and undoes as one group.
 *
 * ## Where a weak version of this would pass
 *
 * "Undoes as one group" is the clause with the easy false pass. `undo` followed by "the
 * nodes are gone" is satisfied by three separate undo entries if the test happens to call
 * undo three times, or by one undo that reverted only the last operation and left the two
 * nodes behind that nobody checked for. The assertion here is on the HISTORY: exactly one
 * group before the undo, zero after it, one redo entry, and the document byte-identical to
 * what it was before the patch (§V34). A second `undo` must then find nothing.
 *
 * "Renders a preview" is the clause where a stub would prove nothing, so the preview port
 * is wired to the real export interface (§V48) over a real Dawn device, and the PNG that
 * comes back is checked for its signature bytes and its dimensions.
 *
 * "Reads GPU timings" is the clause that invites a fabricated number. This machine's Dawn
 * device reports no timestamp-query, so §V86's requirement is that every millisecond field
 * reads UNAVAILABLE rather than zero — and that is what is asserted. A test asserting
 * `frameGpuMs >= 0` would pass against a product that made the number up.
 *
 * ## What this file gates, and what it does not
 *
 * The surface is assembled here the way the composition root assembles it, so what is
 * gated is the SURFACE's ability to do the job. That it is also CONSTRUCTED by the
 * running app — B12, closed by T220 — is asserted where it belongs, in
 * `src/tests/integration/composition-wiring.test.tsx`, because only a mounted app can
 * show it.
 */

const AGENT: Actor = { kind: "agent", id: "claude", label: "Claude" };

let dawnError: string | undefined;

beforeAll(async () => {
  const probe = await probeDawn();
  dawnError = probe.error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(`Dawn (vgpu/node) could not start, so T62 is unverified: ${dawnError}`);
  }
}

interface Fixture {
  readonly bus: LoomBus;
  readonly store: GraphStore;
  readonly registry: NodeRegistryView;
  readonly surface: AgentToolSurface;
}

function fixture(ports: AgentPorts = {}): Fixture {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const surface = createAgentToolSurface({ bus, actor: AGENT, projectId: "acceptance", ports });
  return { bus, store, registry, surface };
}

/**
 * The ONE patch. Three nodes and the edges that wire them, in a single call, with the
 * new nodes referred to by `$temp` refs because their stable ids do not exist yet (§V35).
 */
function threeNodePatch(baseRevision: number) {
  return {
    baseRevision,
    label: "Build a noise chain",
    operations: [
      { op: "addNode", ref: "$src", type: "noise", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$grade", type: "level", position: { x: 220, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 440, y: 0 } },
      {
        op: "connect",
        source: { nodeId: "$src", portId: "out" },
        target: { nodeId: "$grade", portId: "input" },
      },
      {
        op: "connect",
        source: { nodeId: "$grade", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
    ],
  };
}

function history(bus: LoomBus): Promise<HistorySummary> {
  return bus.query("graph.history", {}, { actor: AGENT, projectId: "acceptance", capabilities: [] });
}

function audit(bus: LoomBus): Promise<AuditEntry[]> {
  return bus.query("graph.audit", {}, { actor: AGENT, projectId: "acceptance", capabilities: [] });
}

function frameInputs(frameIndex: number, size: number): FrameInputs {
  return {
    frame: {
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      frameIndex,
      mode: "offline",
      randomSeed: 7,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [size, size],
  };
}

function expectOk<T>(result: ToolResult<T>): T {
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.status).toBe("ok");
  if (result.data === null) throw new Error(`${result.tool} returned no data`);
  return result.data;
}

describe("T62 Phase 1 agent exit — three nodes and their wiring in ONE patch", () => {
  it("applies five operations atomically, mints stable ids, and records ONE undo group", async () => {
    const { bus, store, surface } = fixture();
    const before = store.view.getGraph();
    expect(Object.keys(before.nodes)).toHaveLength(0);

    const result = await surface.callTool("apply_graph_patch", threeNodePatch(before.revision));
    const data = expectOk(result) as { appliedOperations: number; createdIds: Record<string, string> };

    // §V32: one call, all five operations. Not three calls that happened to succeed.
    expect(data.appliedOperations).toBe(5);
    // §V35: every temp ref resolved, and the ids handed back are the ones in the document.
    expect(Object.keys(data.createdIds).sort()).toEqual(["$grade", "$out", "$src"]);
    const graph = store.view.getGraph();
    for (const id of Object.values(data.createdIds)) expect(graph.nodes[id]).toBeDefined();
    expect(Object.keys(graph.nodes)).toHaveLength(3);
    expect(Object.keys(graph.edges)).toHaveLength(2);

    // §V34: one patch, ONE undo group — the assertion the whole criterion turns on.
    const stacks = await history(bus);
    expect(stacks.undo).toHaveLength(1);
    expect(stacks.undo[0]?.label).toBe("Build a noise chain");
    expect(stacks.redo).toEqual([]);

    // §V31/§V30: one audit entry, attributed to the agent, naming the command.
    const log = await audit(bus);
    expect(log).toHaveLength(1);
    expect(log[0]?.actor).toEqual(AGENT);
    expect(log[0]?.command).toBe("graph.applyPatch");
    expect(log[0]?.status).toBe("applied");

    // Exactly one revision for the whole patch — five revisions would mean five edits.
    expect(graph.revision).toBe(before.revision + 1);
  });

  it("undoes the whole patch as ONE group and leaves nothing behind", async () => {
    const { bus, store, surface } = fixture();
    const before = store.view.getGraph();
    await surface.callTool("apply_graph_patch", threeNodePatch(before.revision));

    const undone = await surface.callTool("undo", {});
    expect(undone.status).toBe("ok");

    const after = store.view.getGraph();
    // Not "the last node is gone" — ALL of it, including the edges (§V40 on restore).
    expect(Object.keys(after.nodes)).toEqual([]);
    expect(Object.keys(after.edges)).toEqual([]);

    const stacks = await history(bus);
    expect(stacks.undo, "the patch left more than one undo group behind").toEqual([]);
    expect(stacks.redo).toHaveLength(1);

    // A second undo must find nothing. If the patch had produced three groups, this
    // would succeed — which is exactly the false pass this test exists to close.
    const again = await surface.callTool("undo", {});
    expect(again.status).not.toBe("ok");
  });
});

describe("T62 Phase 1 agent exit — compile, preview, timings", () => {
  it("validates the graph it just built, through the bus (§V39)", async () => {
    const { store, surface } = fixture();
    await surface.callTool("apply_graph_patch", threeNodePatch(store.view.getRevision()));

    const report = expectOk(await surface.callTool("validate_project", {})) as {
      ok: boolean;
      nodeCount: number;
      edgeCount: number;
      cycles: string[][];
      diagnostics: readonly { severity: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.nodeCount).toBe(3);
    expect(report.edgeCount).toBe(2);
    expect(report.cycles).toEqual([]);
    expect(report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  /**
   * T62 says the agent "compiles" — and until T220 it could not.
   *
   * `compile_project` was declared, named the `project.compile` command it needed, and
   * reported itself `unavailable`, which was the honest behaviour for the tool and a
   * failing clause for the criterion. The reasoning in
   * `src/domain/commands/validate-command.ts` for why compiling cannot live in the domain
   * layer still stands: it needs `ProjectSettings`, a LIVE `BackendCapabilities` report,
   * and the retained-plan scheduling the composition root owns. So the command was
   * registered where the compile already happens — `src/app/compile-command.ts`, driven
   * by `useGraphCompile` — and this test wires it exactly as that hook does.
   *
   * The two things that would make this a false pass are both closed here. The device
   * report is REAL (Dawn), not a hand-written capability object, because compiling
   * validates formats against the device (§V51). And the compile is asked for AFTER the
   * patch: the handler reads the store at call time rather than returning whatever plan
   * the UI last rendered, so an agent that edits and then compiles sees its own edit.
   */
  it("compiles the graph it just built, through the bus", async () => {
    requireDawn();
    const backend: LoomBackend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      const capabilities: BackendCapabilities = await backend.initialize({});
      const { bus, store, registry, surface } = fixture();

      // What `useGraphCompile` does on mount: one compile path, on the bus.
      const holder = registerCompileCommand(bus);
      holder.current = {
        compileNow: () => {
          const compiled = compileGraph({
            graph: store.view.getGraph(),
            settings: pocSettings(),
            registry,
            capabilities,
          });
          return { compiled, diagnostics: compiled.diagnostics };
        },
      };

      expect(
        surface.describeTool("compile_project")?.available,
        "compile_project has no command behind it",
      ).toBe(true);

      await surface.callTool("apply_graph_patch", threeNodePatch(store.view.getRevision()));
      const report = expectOk(await surface.callTool("compile_project", {})) as CompileReport;

      expect(report.compiled).toBe(true);
      expect(report.ok).toBe(true);
      // The plan is of the graph the agent just built — three nodes, one output — and not
      // an empty plan from before the patch.
      expect(report.nodeCount).toBe(3);
      expect(report.passCount).toBeGreaterThan(0);
      expect(report.outputs.length).toBeGreaterThan(0);
    } finally {
      backend.dispose();
    }
  }, 60_000);

  it("renders a preview of what it built, through the export interface (§V48)", async () => {
    requireDawn();
    const backend: LoomBackend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      const capabilities: BackendCapabilities = await backend.initialize({});

      // The document the agent will build, and the compile the composition root would run.
      const registry = createNodeRegistry(allNodeDefinitions).view();
      const store = createGraphStore({ ids: createSequentialIdFactory("n"), now: () => "t" });
      const { bus } = createDomainBus({ store, registry });

      let plan: CompiledGraph | null = null;
      const graphOf = (): GraphDocument => store.view.getGraph();
      const recompile = (): CompiledGraph => {
        plan = compileGraph({
          graph: graphOf(),
          settings: pocSettings(),
          registry,
          capabilities,
        });
        return plan;
      };

      // The export interface is the ONLY readback surface (§V48), so the agent's preview
      // port is built on it rather than calling the backend directly.
      const exports = createExportInterface({
        source: readbackSourceFromBackend(backend),
        outputs: () => exportOutputsFrom(plan?.outputs ?? []),
        isPlaying: () => false,
      });
      const previewPort: PreviewExport = {
        async renderPreview({ ref, maxSize }) {
          const capture = await renderPreviewPng(exports, ref, {
            maxWidth: maxSize,
            maxHeight: maxSize,
          });
          return {
            ref,
            mimeType: "image/png",
            width: capture.width,
            height: capture.height,
            bytes: capture.bytes,
          };
        },
      };

      const surface = createAgentToolSurface({
        bus,
        actor: AGENT,
        projectId: "acceptance",
        ports: { preview: previewPort },
      });

      const applied = await surface.callTool(
        "apply_graph_patch",
        threeNodePatch(graphOf().revision),
      );
      const ids = (expectOk(applied) as { createdIds: Record<string, string> }).createdIds;
      const gradeId = ids["$grade"];
      expect(gradeId).toBeDefined();

      const built = recompile();
      expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const compiledPlan = await backend.compile(built);
      backend.render(compiledPlan, frameInputs(0, pocSettings().outputResolution.width));

      // §V38: rendering an image out of the app is the `export` capability class, and a
      // tool call never grants it. Without the grant the answer is `denied`, not a PNG.
      const denied = await surface.callTool("render_preview", { nodeId: gradeId, maxSize: 64 });
      expect(denied.status).toBe("denied");

      bus.grants.grant(AGENT, "export");
      const rendered = await surface.callTool("render_preview", { nodeId: gradeId, maxSize: 64 });
      const image = expectOk(rendered) as {
        width: number;
        height: number;
        byteLength: number;
        base64: string;
      };

      // A real PNG, at the size that was asked for — not an empty envelope.
      expect(image.width).toBe(64);
      expect(image.height).toBe(64);
      expect(image.byteLength).toBeGreaterThan(0);
      // "\x89PNG" is `iVBORw0KGgo` in base64. A stub returning four bytes fails this.
      expect(image.base64.startsWith("iVBORw0KGgo")).toBe(true);
      expect(image.byteLength).toBeGreaterThan(100);
    } finally {
      backend.dispose();
    }
  }, 60_000);

  it("reads GPU timings, and gets 'unavailable' rather than a fabricated zero (§V86)", async () => {
    requireDawn();
    const backend: LoomBackend = createVgpuBackend({ host: nodeGpuHost() });
    const hub = createTelemetryHub({ intervalMs: 0 });
    try {
      const capabilities = await backend.initialize({});
      const registry = createNodeRegistry(allNodeDefinitions).view();
      const store = createGraphStore({ ids: createSequentialIdFactory("n"), now: () => "t" });
      const { bus } = createDomainBus({ store, registry });

      // T175: the telemetry hub attaches a READ SOURCE and the bus publishes it as the
      // `runtime.metrics` query — the same thing the composition root does. An injected
      // port would have worked in-tab only.
      attachStateSources(bus, {
        metrics: (): AgentRuntimeMetrics => {
          const snapshot = hub.snapshot();
          return {
            frameClock: { kind: "paused" as const },
            timingAvailable: snapshot.timingAvailable,
            framesRendered: snapshot.framesRendered,
            lastFrameIndex: snapshot.lastFrameIndex,
            frameGpuMs: snapshot.frame.gpuMs,
            passCount: snapshot.plan?.passes.length ?? 0,
            nodeCount: snapshot.plan?.nodeCount ?? 0,
            prunedCount: snapshot.plan?.prunedCount ?? 0,
            estimatedResourceBytes: snapshot.plan?.estimatedResourceBytes ?? null,
            memoryBudgetBytes: snapshot.plan?.memoryBudgetBytes ?? null,
            overBudget: snapshot.overBudget,
          };
        },
      });

      const surface = createAgentToolSurface({ bus, actor: AGENT, projectId: "acceptance" });

      await surface.callTool("apply_graph_patch", threeNodePatch(store.view.getRevision()));
      const plan = compileGraph({
        graph: store.view.getGraph(),
        settings: pocSettings(),
        registry,
        capabilities,
      });
      hub.setPlan(telemetryPlan(plan, { memoryBudgetBytes: pocSettings().limits.memoryBudgetBytes }));
      // The backend's own timer, honest about what the device does and does not have.
      hub.attachTimingSource({
        timestampQuery: capabilities.timestampQuery,
        onPassTimings: (listener) => backend.onGpuTimings(listener),
      });

      const compiled = await backend.compile(plan);
      for (let index = 0; index < 5; index += 1) {
        backend.render(compiled, frameInputs(index, pocSettings().outputResolution.width));
        hub.noteFrame(index);
      }

      const metrics = expectOk(
        await surface.callTool("get_runtime_metrics", {}),
      ) as AgentRuntimeMetrics;

      // The plan facts are real — a snapshot with nothing in it would pass a null check.
      expect(metrics.passCount).toBe(plan.passes.length);
      expect(metrics.nodeCount).toBe(plan.order.length);
      expect(metrics.framesRendered).toBe(5);
      expect(metrics.lastFrameIndex).toBe(4);
      expect(metrics.estimatedResourceBytes).toBe(plan.estimatedResourceBytes);

      // §V86 / §V12: this Dawn build reports no timestamp-query, so the ONLY correct
      // answer is that timings are unavailable and every millisecond field is null. A
      // zero here would be a number the agent could act on and nothing measured it.
      expect(capabilities.timestampQuery).toBe(false);
      expect(metrics.timingAvailable).toBe(false);
      expect(metrics.frameGpuMs).toBeNull();
    } finally {
      hub.dispose();
      backend.dispose();
    }
  }, 60_000);
});
