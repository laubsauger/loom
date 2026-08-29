import type { NodeId } from "../domain/types/ids.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import type { CompiledGraph } from "./types.ts";

/**
 * Recompile classifier (T31, §V5, §V21).
 *
 * An edit is classified into the SMALLEST amount of work that can still be correct.
 * Dragging a slider must not rebuild a pipeline; moving a node must not touch the GPU at
 * all. The classifier is deliberately conservative in one direction only: when it cannot
 * prove an edit is cheap, it asks for more work, never less.
 */

export type GraphEdit =
  /** A parameter value changed on one node. */
  | { readonly kind: "parameter"; readonly nodeId: NodeId; readonly parameters: ReadonlyArray<string> }
  /** Node moved, resized, or the canvas viewport changed. */
  | { readonly kind: "nodePosition" }
  /** Selection changed. */
  | { readonly kind: "selection" }
  /** A `GraphNode.ui` flag changed: `preview`, `collapsed`, `bypassed`, ... */
  | { readonly kind: "nodeUi"; readonly nodeId: NodeId; readonly fields: ReadonlyArray<string> }
  /** Nodes or edges added or removed. */
  | { readonly kind: "topology"; readonly nodeIds: ReadonlyArray<NodeId> }
  /** WGSL source edited on one node. */
  | { readonly kind: "shaderSource"; readonly nodeId: NodeId; readonly interfaceChanged: boolean }
  | { readonly kind: "nodeResolution"; readonly nodeId: NodeId }
  | { readonly kind: "nodeFormat"; readonly nodeId: NodeId }
  /** Project settings changed: output resolution, working format, limits. */
  | { readonly kind: "projectSettings" };

export type RecompileWork =
  /** Nothing to do outside the editor's own state. */
  | "editor-only"
  /** Which previews are scheduled changed; the render plan itself is unaffected (§V28). */
  | "preview-plan"
  /** Write new uniform values into existing buffers. No recompile (§V5). */
  | "uniform-update"
  /** Rebuild one node's pipeline; nothing downstream changed shape. */
  | "recompile-shader"
  /** Recompile the affected region: this node and everything downstream of it. */
  | "recompile-region"
  /** Re-run resolution/format propagation and recreate the targets that changed (§V21, §V50). */
  | "repropagate";

export interface RecompileDecision {
  readonly work: RecompileWork;
  readonly reason: string;
  /** Nodes whose compilation may have changed. Empty when nothing GPU-side is affected. */
  readonly nodes: ReadonlyArray<NodeId>;
  readonly recreateTargets: boolean;
  /** True when temporal history can no longer be reused (§V22). */
  readonly resetFeedback: boolean;
}

/** The node and everything reachable forward from it, sorted. */
export function downstreamOf(graph: GraphDocument, nodeIds: ReadonlyArray<NodeId>): ReadonlyArray<NodeId> {
  const consumers = new Map<NodeId, NodeId[]>();
  for (const edgeId of Object.keys(graph.edges).sort()) {
    const edge = graph.edges[edgeId];
    if (edge === undefined) continue;
    const list = consumers.get(edge.source.nodeId);
    if (list === undefined) consumers.set(edge.source.nodeId, [edge.target.nodeId]);
    else list.push(edge.target.nodeId);
  }

  const seen = new Set<NodeId>();
  const queue = [...nodeIds].sort();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined) break;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    for (const next of [...(consumers.get(nodeId) ?? [])].sort()) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

export interface ClassifyContext {
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
}

export function classifyEdit(edit: GraphEdit, context: ClassifyContext): RecompileDecision {
  switch (edit.kind) {
    case "nodePosition":
      return {
        work: "editor-only",
        reason: "Layout is presentation, not execution (§V1).",
        nodes: [],
        recreateTargets: false,
        resetFeedback: false,
      };

    case "selection":
      return {
        work: "editor-only",
        reason: "Selection lives in the editor and never reaches the plan.",
        nodes: [],
        recreateTargets: false,
        resetFeedback: false,
      };

    case "nodeUi": {
      // Bypass and mute change what actually renders; the rest is presentation.
      const structural = edit.fields.filter((field) => field === "bypassed" || field === "muted");
      if (structural.length > 0) {
        return {
          work: "recompile-region",
          reason: `"${structural.join(", ")}" changes which nodes render.`,
          nodes: downstreamOf(context.graph, [edit.nodeId]),
          recreateTargets: false,
          resetFeedback: false,
        };
      }
      if (edit.fields.includes("preview")) {
        return {
          work: "preview-plan",
          reason: "Only visible or pinned previews are scheduled (§V28).",
          nodes: [edit.nodeId],
          recreateTargets: false,
          resetFeedback: false,
        };
      }
      return {
        work: "editor-only",
        reason: "Node chrome does not affect the plan.",
        nodes: [],
        recreateTargets: false,
        resetFeedback: false,
      };
    }

    case "parameter": {
      const node = context.graph.nodes[edit.nodeId];
      const definition = node === undefined ? undefined : context.registry.get(node.type);
      // §V5 has one documented exception: a parameter the manifest marks `compileTime`
      // changes shader STRUCTURE, so it cannot be a buffer write.
      const compileTime = edit.parameters.filter(
        (key) => definition?.parameters[key]?.compileTime === true,
      );
      if (compileTime.length > 0) {
        return {
          work: "recompile-region",
          reason: `Parameter(s) ${compileTime.map((key) => `"${key}"`).join(", ")} are compile-time and change shader structure.`,
          nodes: downstreamOf(context.graph, [edit.nodeId]),
          recreateTargets: false,
          resetFeedback: false,
        };
      }
      return {
        work: "uniform-update",
        reason: "A uniform value changed; the pipeline is untouched (§V5).",
        nodes: [edit.nodeId],
        recreateTargets: false,
        resetFeedback: false,
      };
    }

    case "topology":
      return {
        work: "recompile-region",
        reason: "The graph shape changed; the affected region must be recompiled.",
        nodes: downstreamOf(context.graph, edit.nodeIds),
        recreateTargets: true,
        resetFeedback: false,
      };

    case "shaderSource":
      return edit.interfaceChanged
        ? {
            work: "recompile-region",
            reason: "The shader's interface changed, so consumers may bind differently.",
            nodes: downstreamOf(context.graph, [edit.nodeId]),
            recreateTargets: false,
            resetFeedback: true,
          }
        : {
            work: "recompile-shader",
            reason: "Only this shader's body changed; downstream bindings are unaffected.",
            nodes: [edit.nodeId],
            recreateTargets: false,
            resetFeedback: false,
          };

    case "nodeResolution":
      return {
        work: "repropagate",
        reason: "Resolution is resolved at compile/resize and propagates downstream (§V21, §V50).",
        nodes: downstreamOf(context.graph, [edit.nodeId]),
        recreateTargets: true,
        resetFeedback: true,
      };

    case "nodeFormat":
      return {
        work: "repropagate",
        reason: "Format is resolved at compile and propagates downstream (§V21, §V51).",
        nodes: downstreamOf(context.graph, [edit.nodeId]),
        recreateTargets: true,
        resetFeedback: true,
      };

    case "projectSettings":
      return {
        work: "repropagate",
        reason: "Project resolution, working format or limits changed.",
        nodes: Object.keys(context.graph.nodes).sort(),
        recreateTargets: true,
        resetFeedback: true,
      };
  }
}

/**
 * §V5 verification: two plans that differ only in uniform values share a signature, so a
 * caller can prove an edit was uniform-only rather than trusting the classifier.
 */
export function isUniformOnlyChange(previous: CompiledGraph, next: CompiledGraph): boolean {
  return previous.signature === next.signature;
}

export interface PlanDiff {
  /** Resources that do not exist yet, or whose identity changed: build these. */
  readonly resourcesToCreate: ReadonlyArray<string>;
  /** Resources the new plan no longer names: destroy these. */
  readonly resourcesToDestroy: ReadonlyArray<string>;
  /** Resources whose identity is unchanged: KEEP the GPU objects and their contents. */
  readonly resourcesToKeep: ReadonlyArray<string>;
  readonly passesToBuild: ReadonlyArray<string>;
  readonly passesToDrop: ReadonlyArray<string>;
  readonly feedbackToReset: ReadonlyArray<string>;
}

/**
 * Per-entry diff of two plans (§V5, §V22, §V50).
 *
 * The point of this function is what it does NOT say: a plan that gained one unrelated node
 * reports one new resource and one new pass, and every other resource — including every
 * ping-pong pair — comes back in `resourcesToKeep`. Rebuilding on a whole-plan hash would
 * silently zero every feedback loop in the project whenever anything at all was edited.
 */
export function diffPlans(previous: CompiledGraph | undefined, next: CompiledGraph): PlanDiff {
  const before = new Map((previous?.resourceSignatures ?? []).map((entry) => [entry.id, entry.signature]));
  const beforePasses = new Map((previous?.passSignatures ?? []).map((entry) => [entry.id, entry.signature]));

  const resourcesToCreate: string[] = [];
  const resourcesToKeep: string[] = [];
  for (const entry of next.resourceSignatures) {
    if (before.get(entry.id) === entry.signature) resourcesToKeep.push(entry.id);
    else resourcesToCreate.push(entry.id);
  }
  const nextResourceIds = new Set(next.resourceSignatures.map((entry) => entry.id));
  const resourcesToDestroy = [...before.keys()].filter((id) => !nextResourceIds.has(id));

  const passesToBuild = next.passSignatures
    .filter((entry) => beforePasses.get(entry.id) !== entry.signature)
    .map((entry) => entry.id);
  const nextPassIds = new Set(next.passSignatures.map((entry) => entry.id));
  const passesToDrop = [...beforePasses.keys()].filter((id) => !nextPassIds.has(id));

  return {
    resourcesToCreate: resourcesToCreate.sort(),
    resourcesToDestroy: resourcesToDestroy.sort(),
    resourcesToKeep: resourcesToKeep.sort(),
    passesToBuild: passesToBuild.sort(),
    passesToDrop: passesToDrop.sort(),
    feedbackToReset: feedbackToReset(previous, next),
  };
}

/** Resources whose identity changed, or that are new: these must be recreated (§V50, §V24). */
export function targetsToRecreate(
  previous: CompiledGraph | undefined,
  next: CompiledGraph,
): ReadonlyArray<string> {
  return diffPlans(previous, next).resourcesToCreate;
}

/**
 * Feedback pairs whose history is no longer valid (§V22).
 *
 * A pair resets when its reset signature changed — which folds in exactly the triggers its
 * `TemporalDefinition.resetOn` declares — or when the pair is new.
 */
export function feedbackToReset(
  previous: CompiledGraph | undefined,
  next: CompiledGraph,
): ReadonlyArray<string> {
  const before = new Map((previous?.feedback ?? []).map((pair) => [pair.resourceId, pair.resetSignature]));
  return next.feedback
    .filter((pair) => before.get(pair.resourceId) !== pair.resetSignature)
    .map((pair) => pair.resourceId)
    .sort();
}
