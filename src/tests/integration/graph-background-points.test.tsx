// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { BackendStatus, LoomBackend } from "@runtime/backend/index.ts";
import type { PreviewFrameCommand, PreviewProgram } from "@runtime/previews/index.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { createPreviewSinkStore } from "../../app/preview-sinks.ts";
import { useGraphBackground } from "../../app/use-graph-background.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";

/**
 * T563/§V521 — A POINT NODE MARKED AS GRAPH BACKGROUND HAS TO ACTUALLY DRAW.
 *
 * Reported by the owner: "the laser path node doesn't render as graph background... same
 * for the point carrier. Everything that's just video texture works."
 *
 * A pointset has no texture anywhere in it. Its preview is SYNTHESIZED (T373): the
 * compiler hands the output row a `synthesis` block — the splat draw passes and the
 * nominal size — and the PREVIEW PROGRAM owns the target those passes render into,
 * sized to the granted tile. So a caller that assembles a `PreviewRequest` and drops
 * `synthesis` asks the host to sample a resource that exists in neither the plan nor the
 * program: `backend/unknown-resource` per tile, forever, and a background that stays
 * black while every texture node behind it works. `use-node-previews.ts` has carried
 * `synthesis` since T563; the background hook did not, and that is the whole defect.
 *
 * This drives the REAL composition (`useGraphCompile` → `PreviewSinkStore` →
 * `useGraphBackground`) and asserts what the preview HOST is handed, because that is the
 * whole of what it can draw: which resources exist, which passes render them, which
 * passes are encoded this frame, and where the result composites. A "the mark is there"
 * assertion would pass with the picture black.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
};

/**
 * A SQUARE pane, deliberately — the project is 1280x720 (the store's default) and the
 * pane is 1:1, so "letterboxed at the output's aspect" and "filling the pane" are
 * different numbers and the aspect claim below cannot pass by coincidence (§V118).
 */
const PANE = 900;
/**
 * What the compiler nominates for a synthesized preview at `previewLongEdge` 192:
 * `previewLongEdge x MAX_TILE_SCALE` on the long edge (T502), at the PROJECT's aspect
 * (T663) — 384 x round(384 * 720 / 1280).
 */
const SYNTHESIZED_SIZE: readonly [number, number] = [384, 216];

interface Captured {
  readonly programs: PreviewProgram[];
  readonly commands: PreviewFrameCommand[];
}

function fakeBackend(captured: Captured): LoomBackend {
  const status: BackendStatus = {
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
  };
  return {
    status,
    previewHost: () => ({
      setPreviewProgram: (program: PreviewProgram) => captured.programs.push(program),
      presentPreviews: (command: PreviewFrameCommand) => captured.commands.push(command),
      dispose: () => {},
    }),
  } as unknown as LoomBackend;
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Seeds `operations`, marks the named refs as background (default: all of them), and
 * ticks the pane.
 */
async function mount(operations: GraphPatchOperation[], markRefs?: ReadonlyArray<string>) {
  const runtime = newRuntime();
  const previewSinks = createPreviewSinkStore();
  const captured: Captured = { programs: [], commands: [] };

  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: PANE, bottom: PANE, width: PANE, height: PANE }) as DOMRect;
  const canvasRef = { current: canvas };

  const hook = renderHook(() => {
    const compile = useGraphCompile(runtime, CAPABILITIES, previewSinks);
    useGraphBackground({
      backend: fakeBackend(captured),
      canvasRef,
      graph: compile.graph,
      compiledOutputs: compile.compiled?.outputs ?? [],
      previewSinks,
      previewFps: 20,
      previewLongEdge: 192,
      documentIdentity: "document-under-test",
    });
    return compile;
  });

  let created: Record<string, string> = {};
  await act(async () => {
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), label: "seed", operations },
      runtime.invocation,
    );
    expect(result.status).toBe("applied");
    created = (result.output as { createdIds: Record<string, string> }).createdIds;
  });
  await act(async () => {
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "mark",
        operations: (markRefs ?? Object.keys(created)).map((ref) => ({
          op: "setNodeUi" as const,
          nodeId: created[ref] as NodeId,
          ui: { background: true },
        })),
      },
      runtime.invocation,
    );
    expect(result.status).toBe("applied");
  });

  /**
   * Display frames. Three is the sink dance, not a settling delay: frame 1 registers the
   * mark's preview sink, the recompile synthesizes the splat, frame 2 requests it with
   * that row and frame 3 is drawn from a program built with it.
   */
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }

  return { runtime, created, hook, captured, previewSinks };
}

/** Every texture a preview pass samples must exist — in the plan, or in the program. */
function assertEveryBindingResolves(
  program: PreviewProgram | undefined,
  planResourceIds: ReadonlyArray<string>,
): void {
  expect(program).toBeDefined();
  const known = new Set([...planResourceIds, ...(program?.resources ?? []).map((r) => r.id)]);
  for (const pass of program?.passes ?? []) {
    for (const binding of pass.textures ?? []) {
      expect(
        known.has(binding.resourceId),
        `background pass "${pass.id}" samples "${binding.resourceId}", which neither the plan nor the preview program carries — the host reports backend/unknown-resource and the background stays black`,
      ).toBe(true);
    }
  }
}

describe("a point node as graph background (T563, §V521)", () => {
  it("hands the host the splat that renders it, and encodes it ahead of the lens", async () => {
    const { created, hook, captured } = await mount([
      { op: "addNode", ref: "$points", type: "pointGenerator", position: { x: 0, y: 0 } },
    ]);
    const nodeId = created["$points"] as string;

    // The compiler did its half: the row the background reads is the SYNTHESIZED target,
    // not the unbindable pointset marker.
    const row = (hook.result.current.compiled?.outputs ?? []).find(
      (output) => output.nodeId === nodeId,
    );
    expect(row?.resourceKind).toBe("target");
    expect(row?.resourceId).toBe(`preview:points:${nodeId}:out`);
    expect(row?.size).toEqual(SYNTHESIZED_SIZE);
    const splatId = `${nodeId}#pointsPreview:out`;
    expect(row?.synthesis?.passes.map((pass) => pass.id)).toEqual([splatId]);

    // And the background hook did its half. Nothing else in the system can draw those
    // points: the splat target is owned by the PROGRAM (T563), so if the request drops
    // `synthesis` the target is never declared and the lens samples nothing.
    const program = captured.programs.at(-1);
    assertEveryBindingResolves(program, (hook.result.current.compiled?.resources ?? []).map((r) => r.id));
    const target = (program?.resources ?? []).find((r) => r.id === `preview:points:${nodeId}:out`);
    expect(target?.kind).toBe("target");
    const splat = (program?.passes ?? []).find((pass) => pass.id === splatId);
    expect(splat?.kind).toBe("draw");
    expect((splat as { target?: string } | undefined)?.target).toBe(`preview:points:${nodeId}:out`);

    // T563's encode ORDER: the splat renders the source, then the lens samples it. The
    // reverse order shows the previous frame's pixels forever.
    //
    // Read off the frames that actually RE-RENDER, not off the last one: content
    // refreshes on the preview cadence (20 fps against a 60 fps tick), so most frames
    // composite an unchanged tile and encode nothing at all. That there IS such a frame
    // is half the claim — a background that never refreshes is the black picture again.
    const refreshing = captured.commands.filter((command) => command.refresh.length > 0);
    expect(refreshing.length).toBeGreaterThan(0);
    const lensId = `preview/pass/${nodeId}:out`;
    for (const command of refreshing) {
      expect(command.refresh).toContain(splatId);
      expect(command.refresh).toContain(lensId);
      expect(command.refresh.indexOf(splatId)).toBeLessThan(command.refresh.indexOf(lensId));
    }
  });

  it("letterboxes at the PROJECT's aspect, never the pane's (§V118)", async () => {
    const { created, captured } = await mount([
      { op: "addNode", ref: "$points", type: "pointGenerator", position: { x: 0, y: 0 } },
    ]);
    const nodeId = created["$points"] as string;

    // 384x216 letterboxed into a 900x900 pane: full width, 506.25 tall, centred. The
    // distorted answer — a point cloud stretched to fill a square pane — is 900x900.
    const composite = (captured.commands.at(-1)?.composite ?? []).find(
      (tile) => tile.ref.nodeId === nodeId,
    );
    expect(composite?.dest).toEqual({ x: 0, y: (PANE - 506.25) / 2, width: PANE, height: 506.25 });

    // And the SOURCE the splat renders into keeps that aspect too — a 16:9 picture drawn
    // into a square target and then letterboxed 16:9 is stretched twice over (T663).
    const target = (captured.programs.at(-1)?.resources ?? []).find(
      (resource) => resource.id === `preview:points:${nodeId}:out`,
    ) as { size?: readonly [number, number] } | undefined;
    expect(target?.size).toBeDefined();
    expect(target!.size![0] / target!.size![1]).toBeCloseTo(
      SYNTHESIZED_SIZE[0] / SYNTHESIZED_SIZE[1],
      2,
    );
  });

  /**
   * The owner's own case, node for node: "the laser path node doesn't render as graph
   * background". A downstream point CONSUMER, not a generator, so this also pins that
   * nothing here is special to the node that mints the points — every pointset output
   * is covered because the synthesis is keyed on the port KIND (§V316, §V319).
   *
   * `laserPath` is read-only here: another track owns that file and its examples.
   */
  it("draws the LASER PATH node the owner reported, not just a point generator", async () => {
    const { created, captured } = await mount(
      [
        { op: "addNode", ref: "$points", type: "pointGenerator", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$laser", type: "laserPath", position: { x: 200, y: 0 } },
        {
          op: "connect",
          source: { nodeId: "$points", portId: "out" },
          target: { nodeId: "$laser", portId: "points" },
        },
      ],
      ["$laser"],
    );
    const nodeId = created["$laser"] as string;

    const program = captured.programs.at(-1);
    const splat = (program?.passes ?? []).find(
      (pass) => pass.id === `${nodeId}#pointsPreview:out`,
    ) as { target?: string } | undefined;
    expect(splat?.target).toBe(`preview:points:${nodeId}:out`);
    expect((program?.resources ?? []).some((r) => r.id === `preview:points:${nodeId}:out`)).toBe(true);
    // Only the marked node is a background — the generator feeding it is not.
    expect((captured.commands.at(-1)?.composite ?? []).map((tile) => tile.ref.nodeId)).toEqual([
      nodeId,
    ]);
  });

  it("tiles beside a texture background, and beside a second point node (T677)", async () => {
    const { created, hook, captured } = await mount([
      { op: "addNode", ref: "$points", type: "pointGenerator", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$more", type: "pointGenerator", position: { x: 200, y: 0 } },
      { op: "addNode", ref: "$solid", type: "solid", position: { x: 400, y: 0 } },
    ]);
    const points = created["$points"] as string;
    const more = created["$more"] as string;
    const solid = created["$solid"] as string;

    const program = captured.programs.at(-1);
    assertEveryBindingResolves(program, (hook.result.current.compiled?.resources ?? []).map((r) => r.id));
    // Both point nodes splat, into their OWN targets — one shared target would show one
    // cloud twice.
    for (const nodeId of [points, more]) {
      const splat = (program?.passes ?? []).find(
        (pass) => pass.id === `${nodeId}#pointsPreview:out`,
      ) as { target?: string } | undefined;
      expect(splat?.target, `no splat for ${nodeId}`).toBe(`preview:points:${nodeId}:out`);
    }

    // Three cells, none overlapping, each at its source's aspect — the point nodes' 16:9
    // synthesized size and the solid's 1280x720 target agree here, so the claim that
    // discriminates is that all three are TILED rather than stacked.
    const composite = captured.commands.at(-1)?.composite ?? [];
    expect(composite.map((tile) => tile.ref.nodeId).sort()).toEqual([more, points, solid].sort());
    for (const tile of composite) {
      expect(tile.dest.width / tile.dest.height).toBeCloseTo(1280 / 720, 6);
    }
    for (let a = 0; a < composite.length; a += 1) {
      for (let b = a + 1; b < composite.length; b += 1) {
        const one = composite[a]!.dest;
        const two = composite[b]!.dest;
        const overlaps =
          one.x < two.x + two.width - 1e-9 &&
          two.x < one.x + one.width - 1e-9 &&
          one.y < two.y + two.height - 1e-9 &&
          two.y < one.y + one.height - 1e-9;
        expect(overlaps, `tiles ${a} and ${b} overlap`).toBe(false);
      }
    }
  });
});
