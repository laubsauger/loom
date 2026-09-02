import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { SelectableColorFormat } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { listExamples } from "../catalogue.ts";
import { TIER_B_CAPABILITIES, exampleRegistry, requireExample } from "../runner.ts";


/**
 * What each example CLAIMS to demonstrate, asserted (T153-T156).
 *
 * `runner.test.ts` proves every example loads, compiles and replays — the §V89 gate. That
 * gate is deliberately blind to what an example is FOR: an example could be reduced to a
 * Solid into an Output and still sail through it. These tests are the other half. Each one
 * checks the specific claim its example's `.md` makes, so an example cannot quietly stop
 * demonstrating the thing it exists to demonstrate.
 *
 * Unlike the gate, these name their example. That is unavoidable — "E4 proves the HDR
 * format override" is a statement about E4 — and it is why the gate is kept separate and
 * generic rather than merged into here.
 */

const byName = new Map(listExamples().map((file) => [file.fileName, file]));

export function example(fileName: string): { document: ProjectDocument; plan: CompiledGraph } {
  const file = byName.get(fileName);
  if (file === undefined) throw new Error(`missing example ${fileName}`);
  return requireExample(file);
}

export function effectFor(plan: CompiledGraph, nodeId: string): EffectPassDescriptor {
  const pass = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === nodeId);
  if (pass === undefined || pass.kind !== "effect") throw new Error(`no effect pass for ${nodeId}`);
  return pass;
}

export function outputFor(plan: CompiledGraph, nodeId: string) {
  const output = plan.outputs.find((entry) => entry.nodeId === nodeId);
  if (output === undefined) throw new Error(`no output for ${nodeId}`);
  return output;
}

export function recompile(document: ProjectDocument, graph: GraphDocument): CompiledGraph {
  return compileGraph({
    graph,
    settings: document.settings,
    registry: exampleRegistry(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

export interface Pointer {
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
}

/**
 * A LIVE value-graph session over one example, stepped a frame at a time (§V179).
 *
 * The examples' own gate compiles with no `resolution` at all, so every driven parameter
 * there resolves to its §V108 retained value — which is correct for a structural compile
 * and proves nothing about whether the wiring WORKS. This runs the real session, hands its
 * resolver to the real compiler, and returns the plan the runtime would push.
 *
 * The session is held ACROSS steps deliberately: a Lag is stateful (§V181), so a fresh
 * session per frame would restart its trajectory and every smoothing assertion below would
 * pass against a build with no smoothing in it at all.
 */
export function valueGraphRun(document: ProjectDocument) {
  const session = createValueGraphSession(exampleRegistry());
  let frameIndex = 0;

  const frameAt = (index: number): FrameEvaluationInput => ({
    timeSeconds: index / 60,
    deltaSeconds: 1 / 60,
    frameIndex: index,
    mode: "offline",
    randomSeed: document.settings.randomSeed,
  });

  return {
    /** Advance one frame at this pointer and compile at the values it produced. */
    step(pointer: Pointer): { plan: CompiledGraph; frame: FrameEvaluationInput } {
      const frame = frameAt(frameIndex);
      frameIndex += 1;
      const { resolver } = session.evaluate(document.graph, frame, { pointer: { ...pointer } });
      const plan = compileGraph({
        graph: document.graph,
        settings: document.settings,
        registry: exampleRegistry(),
        capabilities: TIER_B_CAPABILITIES,
        resolution: { frame, channels: resolver },
      });
      return { plan, frame };
    },
    /** Advance `count` frames at one pointer; the last plan is returned. */
    hold(pointer: Pointer, count: number): { plan: CompiledGraph; frame: FrameEvaluationInput } {
      let last = this.step(pointer);
      for (let index = 1; index < count; index += 1) last = this.step(pointer);
      return last;
    },
  };
}

export const CENTRE: Pointer = { x: 0.5, y: 0.5, buttons: 0 };

/** Same graph with one node's `format` override replaced or dropped. For the control cases. */
export function withFormat(
  graph: GraphDocument,
  nodeId: string,
  format: SelectableColorFormat | undefined,
): GraphDocument {
  const node = graph.nodes[nodeId];
  if (node === undefined) throw new Error(`no node ${nodeId}`);
  const { format: _dropped, ...rest } = node;
  const next: GraphNode = format === undefined ? rest : { ...rest, format: { mode: "fixed", format } };
  return { ...graph, nodes: { ...graph.nodes, [nodeId]: next } };
}

