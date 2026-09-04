import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import type { ComponentRegistryView } from "../../domain/components/index.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { SelectableColorFormat } from "../../domain/types/node-definition.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { listExamples } from "../catalogue.ts";
import { TIER_B_CAPABILITIES, messagesOf, requireExample } from "../runner.ts";


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

/**
 * THE REGISTRY PAIR EACH EXAMPLE WAS ACTUALLY LOADED AND COMPILED WITH (§V854, T1066/T1067).
 *
 * `recompile()` and `valueGraphRun()` used to call `exampleRegistry()` themselves — a BARE
 * node view with no `components`. That is harmless only while every caller happens to be a
 * component-free example. Pointed at E47/E51/E53, which instantiate library components, a
 * bare view has no `component:...` type at all: the compile emits
 * `compiler/unknown-node-type`, severs the output edge, and returns a plan with (E51) ZERO
 * passes. The assertions above it then run against a graph that is not the example — §T1066
 * is the same mistake in the cook oracle, where only the non-vacuity guard caught it.
 *
 * So the safe construction is now THE ONLY ONE AVAILABLE here: `exampleRegistry` is no
 * longer imported by this module, and the pair is remembered against the document identity
 * `example()` handed out. A caller cannot re-derive a bare registry through these helpers,
 * and a document from somewhere else fails loudly instead of compiling something severed.
 */
const REGISTRIES = new WeakMap<
  ProjectDocument,
  { readonly nodes: NodeRegistryView; readonly components: ComponentRegistryView }
>();

function registryFor(document: ProjectDocument): {
  readonly nodes: NodeRegistryView;
  readonly components: ComponentRegistryView;
} {
  const pair = REGISTRIES.get(document);
  if (pair === undefined) {
    throw new Error(
      "this document did not come from example(): its component-aware registry is unknown, and " +
        "compiling it with a bare registry would silently sever every component instance (§V854, T1067).",
    );
  }
  return pair;
}

export function example(fileName: string): { document: ProjectDocument; plan: CompiledGraph } {
  const file = byName.get(fileName);
  if (file === undefined) throw new Error(`missing example ${fileName}`);
  const { document, plan, result } = requireExample(file);
  /* Both halves or neither: `components` is what the COMPILE needs to flatten instances,
     `nodes` is what every other reader needs for a component instance to be a node at all. */
  if (result.nodes === undefined || result.components === undefined) {
    throw new Error(`${fileName} loaded without its component-aware registry pair (§V854)`);
  }
  REGISTRIES.set(document, { nodes: result.nodes, components: result.components });
  return { document, plan };
}

/**
 * §V883 — a plan these helpers hand back must be one the assertions can actually fail on.
 *
 * The severed-graph failure mode is SILENT: it produces a well-formed `CompiledGraph` whose
 * passes are simply missing, so a `find(...)` in a concept test throws something unrelated
 * or, worse, an absence-shaped assertion passes. Both preconditions are needed — diagnostics
 * name the unknown type when the registry is wrong, and a non-zero pass count catches the
 * severing itself for any other cause.
 */
function requireLivePlan(
  plan: CompiledGraph,
  what: string,
  expected: readonly string[] = [],
): CompiledGraph {
  /*
   * ZERO PASSES is the severing itself, and is never legitimate: it is the shape T1066 hid
   * behind, and no concept claim is about an empty plan. Unconditional.
   */
  if (plan.passes.length === 0) {
    throw new Error(`${what}: compiled to ZERO passes — a severed graph, on which nothing below can fail (§V883).`);
  }
  /*
   * Diagnostics are allowed only by CODE the caller named. A blanket "ignore diagnostics"
   * switch would be the trap again with a nicer spelling — the point is that a caller
   * deliberately compiling an unrenderable control (E6's r32float field) says so and still
   * gets caught by any OTHER diagnostic, `unknown-node-type` above all.
   */
  /* `info` is excluded for the same reason `messagesOf` excludes it — it is commentary, not
     a defect, and E36's projector recompiles legitimately emit some. Warnings and errors,
     which is where `unknown-node-type` and a severed graph announce themselves, are kept. */
  const unexpected = plan.diagnostics.filter(
    (entry) => entry.severity !== "info" && !expected.includes(entry.code),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${what}: compiled with diagnostics the caller did not declare, so the assertions below are ` +
        `not about the example:\n  ${messagesOf(unexpected).join("\n  ")}`,
    );
  }
  return plan;
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

/**
 * Recompile one example's graph, mutated, with THAT example's own registry pair.
 *
 * `expectDiagnostics` names the codes a deliberately-degenerate control is expected to
 * produce (E6 compiles an r32float field that a baseline Tier B device cannot filter). Any
 * code not named fails loudly — the guard stays live for the case it exists to catch.
 */
export function recompile(
  document: ProjectDocument,
  graph: GraphDocument,
  expectDiagnostics: readonly string[] = [],
): CompiledGraph {
  const { nodes, components } = registryFor(document);
  return requireLivePlan(
    compileGraph({
      graph,
      settings: document.settings,
      registry: nodes,
      capabilities: TIER_B_CAPABILITIES,
      components,
    }),
    "recompile",
    expectDiagnostics,
  );
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
  const { nodes, components } = registryFor(document);
  const session = createValueGraphSession(nodes);
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
      const plan = requireLivePlan(
        compileGraph({
          graph: document.graph,
          settings: document.settings,
          registry: nodes,
          capabilities: TIER_B_CAPABILITIES,
          components,
          resolution: { frame, channels: resolver },
        }),
        `valueGraphRun step ${frame.frameIndex}`,
      );
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

