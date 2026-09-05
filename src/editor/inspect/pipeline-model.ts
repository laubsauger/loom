import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { isValueSourceDefinition } from "@domain/graph/liveness.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { PassDescriptor, ResourceDescriptor } from "@runtime/backend/plan.ts";

/**
 * The pipeline inspector's model — WHAT THE COMPILER DECIDED, as data (T1188, §V285,
 * §B179).
 *
 * ## It describes the INSTALLED plan, and that is the whole point
 *
 * §B179 and §T1163 are one story told twice: the app held a plan the backend never
 * installed while the frame counter advanced and nothing said so. A pipeline inspector
 * reading `compile.compiled` would lie in exactly the situation somebody opens it —
 * they open it because the picture looks wrong, which is precisely when the compiled and
 * the installed plan differ. So `PipelineRequest.installed` is the subject of every
 * section below, `compiled` is used for ONE thing only — deciding whether the two have
 * diverged and saying so — and there is no code path here that describes a plan the GPU
 * does not hold.
 *
 * ## Why it is not a list of pass names
 *
 * An ordered list of passes is a table of contents. The findings are the content: what
 * the prune dropped, where format and resolution change mid-chain, where a component
 * flattened into prefixed ids, where the compiler SYNTHESIZED a closing edge the canvas
 * does not draw (§V285), where a substep loop expands, and where two node outputs share
 * one resource.
 *
 * ## §V85 — nothing here collects anything
 *
 * Pure function of (installed plan, compiled plan, flattened document, registry). No
 * subscription, no readback, no bus call, no document write. Hand it a fixture and it
 * renders with no GPU in sight.
 */

/** Whether what the GPU holds is what the current graph compiles to. */
export type PipelineInstallKind =
  /** The installed plan IS the current graph's plan. */
  | "running"
  /** A plan compiled cleanly and has not landed on the device yet (§T1163's interval). */
  | "waiting"
  /** The current graph does not compile; the backend kept the last plan that did (§V9). */
  | "refused"
  /** The backend holds no program at all. */
  | "none";

export interface PipelineInstallState {
  readonly kind: PipelineInstallKind;
  /** One sentence, the headline of the whole screen. */
  readonly headline: string;
  /** Why, in the user's terms. */
  readonly detail: string;
  /** True whenever what is described below is NOT the graph as it currently reads. */
  readonly diverged: boolean;
}

export type PipelineFindingKind =
  | "reachability"
  | "format"
  | "resolution"
  | "flattened"
  | "temporal"
  | "substeps"
  | "alias";

export interface PipelineFindingRow {
  /** Stable key; also the node or plan entity the row is about. */
  readonly id: string;
  readonly text: string;
  readonly nodeId?: NodeId;
  /** Rendered as a warning tone: something the user probably did not intend. */
  readonly tone?: "warn";
}

export interface PipelineFinding {
  readonly kind: PipelineFindingKind;
  readonly title: string;
  /**
   * The headline sentence. Always DERIVED from the rows it heads — never from a single
   * plan field, because `plan.pruned` is not the complement of `kept` (§B179) and a
   * summary that reads one field says "nothing was pruned" over a plan that dropped six
   * nodes.
   */
  readonly summary: string;
  readonly rows: readonly PipelineFindingRow[];
}

export interface PipelinePassRow {
  /** Position in `plan.passes`, 1-based — what the encoder does, in the order it does it. */
  readonly step: number;
  readonly id: string;
  readonly kind: PassDescriptor["kind"];
  readonly nodeId: NodeId | null;
  /** Node label, or the component source path when the node came out of one (§V82). */
  readonly label: string;
  /** 1 while inside a substep loop, so the body is indented under its marker (T387). */
  readonly depth: number;
  /** Size / format / operation — whatever this kind of pass is actually doing. */
  readonly detail: string;
}

export interface PipelineStats {
  readonly passes: number;
  readonly resources: number;
  /** Nodes in the running plan's execution order. */
  readonly nodes: number;
  /** Nodes in the document the panel is comparing against. */
  readonly documentNodes: number;
  readonly estimatedBytes: number;
  readonly signature: string;
}

export interface PipelineView {
  readonly install: PipelineInstallState;
  /** Null when nothing is installed: there is no pipeline to describe, and it says so. */
  readonly stats: PipelineStats | null;
  readonly findings: readonly PipelineFinding[];
  readonly passes: readonly PipelinePassRow[];
}

export interface PipelineRequest {
  /**
   * THE PLAN THE BACKEND HAS. `app.tsx` latches this from inside the install itself
   * (§T1163), which is the only source that cannot be a frame ahead of the device.
   */
  readonly installed: CompiledGraph | null;
  /** The plan the current graph compiles to. Used ONLY to detect divergence. */
  readonly compiled: CompiledGraph | null;
  /** The FLATTENED document — the graph whose ids the plan speaks (§V82). */
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
}

function installState(request: PipelineRequest): PipelineInstallState {
  const { installed, compiled } = request;
  if (installed === null) {
    return {
      kind: "none",
      headline: "Nothing is installed",
      detail:
        compiled !== null && !compiled.ok
          ? "The graph does not compile, so no program has ever reached the GPU. The problems pane has the errors."
          : "The backend holds no program yet — nothing has been installed on this device.",
      diverged: compiled !== null,
    };
  }
  if (compiled !== null && !compiled.ok) {
    return {
      kind: "refused",
      headline: "Running an older pipeline",
      detail:
        "The graph as it reads now does not compile, so the backend kept the last plan that did (§V9). " +
        "Every edit since then is compiled, previewed and NOT on screen.",
      diverged: true,
    };
  }
  if (compiled !== null && compiled.signature !== installed.signature) {
    return {
      kind: "waiting",
      headline: "Waiting to install",
      detail:
        "A newer plan compiled cleanly and is on its way to the device. What is described below is what the GPU " +
        "still holds.",
      diverged: true,
    };
  }
  return {
    kind: "running",
    headline: "This is the running pipeline",
    detail: "The plan the backend installed is the plan the current graph compiles to.",
    diverged: false,
  };
}

/** Resources carry a size and a format only when they are textures; the rest do not. */
function sizedResource(
  resource: ResourceDescriptor | undefined,
): { size: readonly [number, number]; format: string } | null {
  if (resource === undefined) return null;
  if (!("size" in resource) || !("format" in resource)) return null;
  return { size: resource.size, format: resource.format };
}

function describeSize(size: readonly [number, number]): string {
  return `${size[0]}x${size[1]}`;
}

/** What to call a node on screen: its source path inside a component, else its label. */
function nodeNamer(plan: CompiledGraph, graph: GraphDocument): (nodeId: NodeId) => string {
  const paths = new Map(plan.sources.map((source) => [source.nodeId, source.sourcePath] as const));
  return (nodeId) => paths.get(nodeId) ?? graph.nodes[nodeId]?.label ?? nodeId;
}

/**
 * §B179's trap, made structurally unrepeatable.
 *
 * `plan.pruned` is `computeLiveness().dead`, NOT the complement of `kept`: a value source
 * is filtered out of `dead` by construction, and a node an expression op()-references is
 * alive without ever becoming a pass. So a plan can report `pruned: []` while six nodes
 * sit outside `order`. This walks the UNION of the document and the plan and gives every
 * node one of three answers, so the count in the summary is a count of rows rather than a
 * read of one field.
 */
function reachabilityFinding(
  plan: CompiledGraph,
  graph: GraphDocument,
  registry: NodeRegistryView,
  nameOf: (nodeId: NodeId) => string,
): PipelineFinding {
  const running = new Set<NodeId>(plan.order);
  const dead = new Set<NodeId>(plan.pruned);
  const universe = [
    ...new Set<NodeId>([...Object.keys(graph.nodes), ...plan.order, ...plan.pruned]),
  ].sort();

  const rows: PipelineFindingRow[] = [];
  let unreachable = 0;
  let offPlan = 0;
  for (const nodeId of universe) {
    if (running.has(nodeId)) continue;
    const node = graph.nodes[nodeId];
    if (dead.has(nodeId)) {
      unreachable += 1;
      rows.push({
        id: nodeId,
        nodeId,
        tone: "warn",
        text: `${nameOf(nodeId)} — unreachable: no active sink reaches it, so it does no work at all.`,
      });
      continue;
    }
    offPlan += 1;
    if (node === undefined) {
      rows.push({
        id: nodeId,
        nodeId,
        text: `${nodeId} — in the running plan's records but not in the graph as it reads now.`,
      });
      continue;
    }
    const definition = registry.get(node.type);
    const reason =
      definition === undefined
        ? `off-plan: the node type "${node.type}" is not installed, so the compiler could not place it.`
        : isValueSourceDefinition(definition)
          ? "off-plan by design: a value source feeds parameters on the CPU and never becomes a pass."
          : "off-plan: alive only through a name reference (an expression, or a source parameter), so it produces no pass.";
    rows.push({ id: nodeId, nodeId, text: `${nameOf(nodeId)} — ${reason}` });
  }

  const summary =
    rows.length === 0
      ? `All ${universe.length} nodes are in the running pipeline.`
      : `${rows.length} of ${universe.length} nodes are NOT in the running pipeline — ` +
        `${unreachable} unreachable, ${offPlan} off-plan.`;

  return { kind: "reachability", title: "Reachability", summary, rows };
}

interface Transition {
  readonly passId: string;
  readonly nodeId: NodeId | null;
  readonly from: string;
  readonly to: string;
}

/** Every pass whose output differs from something it reads, per dimension. */
function transitions(plan: CompiledGraph): { format: Transition[]; resolution: Transition[] } {
  const byId = new Map(plan.resources.map((resource) => [resource.id, resource] as const));
  const format: Transition[] = [];
  const resolution: Transition[] = [];
  for (const pass of plan.passes) {
    if (!("target" in pass) || pass.target === undefined) continue;
    const target = sizedResource(byId.get(pass.target));
    if (target === null) continue;
    const nodeId = "nodeId" in pass && pass.nodeId !== undefined ? (pass.nodeId as NodeId) : null;
    const seenFormat = new Set<string>();
    const seenSize = new Set<string>();
    for (const binding of pass.textures ?? []) {
      const source = sizedResource(byId.get(binding.resourceId));
      if (source === null) continue;
      if (source.format !== target.format && !seenFormat.has(source.format)) {
        seenFormat.add(source.format);
        format.push({ passId: pass.id, nodeId, from: source.format, to: target.format });
      }
      const from = describeSize(source.size);
      const to = describeSize(target.size);
      if (from !== to && !seenSize.has(from)) {
        seenSize.add(from);
        resolution.push({ passId: pass.id, nodeId, from, to });
      }
    }
  }
  return { format, resolution };
}

function transitionFinding(
  kind: "format" | "resolution",
  found: readonly Transition[],
  nameOf: (nodeId: NodeId) => string,
): PipelineFinding {
  const noun = kind === "format" ? "format" : "resolution";
  return {
    kind,
    title: kind === "format" ? "Format changes" : "Resolution changes",
    summary:
      found.length === 0
        ? `Every pass writes at the ${noun} it reads.`
        : `${found.length} pass${found.length === 1 ? "" : "es"} change${found.length === 1 ? "s" : ""} ${noun} mid-chain.`,
    rows: found.map((entry, index) => ({
      id: `${entry.passId}:${index}`,
      text: `${entry.nodeId === null ? entry.passId : nameOf(entry.nodeId)} — reads ${entry.from}, writes ${entry.to}.`,
      ...(entry.nodeId === null ? {} : { nodeId: entry.nodeId }),
    })),
  };
}

function flattenedFinding(plan: CompiledGraph): PipelineFinding {
  const nested = plan.sources.filter((source) => source.path.length > 0);
  const instances = new Map<string, number>();
  for (const source of nested) {
    const instance = source.path[0] ?? "";
    instances.set(instance, (instances.get(instance) ?? 0) + 1);
  }
  return {
    kind: "flattened",
    title: "Components flattened",
    summary:
      nested.length === 0
        ? "No component instance is inlined in this plan."
        : `${nested.length} node${nested.length === 1 ? "" : "s"} came out of ${instances.size} component instance${instances.size === 1 ? "" : "s"} — which is where the prefixed ids come from.`,
    rows: nested.map((source) => ({
      id: source.nodeId,
      nodeId: source.nodeId,
      text: `${source.nodeId} is ${source.internalNodeId} inside ${source.sourcePath}.`,
    })),
  };
}

/**
 * §V285 — the loop the canvas does not draw.
 *
 * The document keeps a DAG: a Feedback node names its source by LABEL and the compiler
 * synthesizes the closing edge. So the graph that runs is genuinely not the graph on the
 * canvas, and this is the one screen where that can be said out loud. Whether the edge
 * was synthesized is MEASURED — the document is asked whether it holds a wire between
 * the producer the plan bound and the node that reads it — never assumed from the node
 * type.
 */
function temporalFinding(
  plan: CompiledGraph,
  graph: GraphDocument,
  nameOf: (nodeId: NodeId) => string,
): PipelineFinding {
  const producerOf = new Map(plan.outputs.map((output) => [output.resourceId, output.nodeId] as const));
  const wired = new Set(
    Object.values(graph.edges).map((edge) => `${edge.source.nodeId}->${edge.target.nodeId}`),
  );
  const rows: PipelineFindingRow[] = [];
  for (const pair of plan.feedback) {
    const sources = new Set<NodeId>();
    for (const pass of plan.passes) {
      if (!("textures" in pass) || pass.nodeId !== pair.nodeId) continue;
      for (const binding of pass.textures ?? []) {
        const producer = producerOf.get(binding.resourceId);
        if (producer !== undefined && producer !== pair.nodeId) sources.add(producer);
      }
    }
    const synthesized = [...sources].filter((source) => !wired.has(`${source}->${pair.nodeId}`));
    const records =
      sources.size === 0
        ? "records nothing this frame"
        : `records ${[...sources].sort().map(nameOf).join(", ")}`;
    const how =
      synthesized.length === 0
        ? "closed through a wire in the document"
        : "the compiler SYNTHESIZED the closing edge — the canvas shows a reference, not a wire (§V285)";
    rows.push({
      id: pair.resourceId,
      nodeId: pair.nodeId,
      text: `${nameOf(pair.nodeId)}:${pair.portId} — ping-pong pair ${describeSize(pair.size)} ${pair.format}, ${records}; ${how}. Swapped by ${pair.swapPassId}.`,
    });
  }
  return {
    kind: "temporal",
    title: "Temporal loops closed",
    summary:
      rows.length === 0
        ? "No output in this plan carries a previous frame."
        : `${rows.length} output${rows.length === 1 ? "" : "s"} carr${rows.length === 1 ? "ies" : "y"} the previous frame, so the graph that runs is not the DAG on the canvas.`,
    rows,
  };
}

function substepFinding(plan: CompiledGraph, nameOf: (nodeId: NodeId) => string): PipelineFinding {
  const rows: PipelineFindingRow[] = [];
  for (const [index, pass] of plan.passes.entries()) {
    if (pass.kind !== "loop" || pass.edge !== "begin") continue;
    let body = 0;
    for (let scan = index + 1; scan < plan.passes.length; scan += 1) {
      const next = plan.passes[scan];
      if (next === undefined) break;
      if (next.kind === "loop" && next.edge === "end" && next.loopId === pass.loopId) break;
      body += 1;
    }
    const count = pass.count ?? 1;
    rows.push({
      id: pass.loopId,
      ...(pass.nodeId === undefined ? {} : { nodeId: pass.nodeId }),
      text:
        `${pass.nodeId === undefined ? pass.loopId : nameOf(pass.nodeId)} — ${body} pass${body === 1 ? "" : "es"} encoded ` +
        `${count} time${count === 1 ? "" : "s"} inside one displayed frame (${body * count} encodes).`,
    });
  }
  return {
    kind: "substeps",
    title: "Substeps expanded",
    summary:
      rows.length === 0
        ? "Every pass runs once per displayed frame."
        : `${rows.length} loop${rows.length === 1 ? "" : "s"} run${rows.length === 1 ? "s" : ""} their body more than once per displayed frame.`,
    rows,
  };
}

function aliasFinding(plan: CompiledGraph, nameOf: (nodeId: NodeId) => string): PipelineFinding {
  const byResource = new Map<string, string[]>();
  for (const output of plan.outputs) {
    const list = byResource.get(output.resourceId);
    const entry = `${nameOf(output.nodeId)}:${output.portId}`;
    if (list === undefined) byResource.set(output.resourceId, [entry]);
    else list.push(entry);
  }
  const rows: PipelineFindingRow[] = [];
  for (const [resourceId, holders] of [...byResource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (holders.length < 2) continue;
    rows.push({
      id: resourceId,
      text: `${resourceId} backs ${holders.length} outputs: ${holders.join(", ")}.`,
    });
  }
  return {
    kind: "alias",
    title: "Aliased resources",
    summary:
      rows.length === 0
        ? "Every materialized output has a resource of its own."
        : `${rows.length} resource${rows.length === 1 ? "" : "s"} back more than one node output.`,
    rows,
  };
}

function passDetail(pass: PassDescriptor, byId: Map<string, ResourceDescriptor>): string {
  switch (pass.kind) {
    case "effect": {
      const target = sizedResource(byId.get(pass.target));
      const reads = (pass.textures ?? []).length;
      return `→ ${pass.target}${target === null ? "" : ` ${describeSize(target.size)} ${target.format}`}, reads ${reads}`;
    }
    case "draw": {
      const target = sizedResource(byId.get(pass.target));
      const instances = typeof pass.instances === "number" ? `${pass.instances}` : "indirect";
      return `${pass.topology} × ${instances} → ${pass.target}${target === null ? "" : ` ${describeSize(target.size)} ${target.format}`}`;
    }
    case "dispatch": {
      const groups = Array.isArray(pass.workgroups)
        ? pass.workgroups.join(" × ")
        : "indirect";
      return `${pass.entryPoint}, workgroups ${groups}`;
    }
    case "swap":
      return `swap ${pass.resourceId} — the previous frame becomes readable (§V22)`;
    case "counter":
      return `${pass.op} ${pass.resourceId}`;
    case "loop":
      return pass.edge === "begin" ? `begin ×${pass.count ?? 1}` : "end";
  }
}

function passRows(plan: CompiledGraph, nameOf: (nodeId: NodeId) => string): PipelinePassRow[] {
  const byId = new Map(plan.resources.map((resource) => [resource.id, resource] as const));
  const rows: PipelinePassRow[] = [];
  let depth = 0;
  for (const [index, pass] of plan.passes.entries()) {
    if (pass.kind === "loop" && pass.edge === "end") depth = Math.max(0, depth - 1);
    const nodeId = "nodeId" in pass && pass.nodeId !== undefined ? (pass.nodeId as NodeId) : null;
    rows.push({
      step: index + 1,
      id: pass.id,
      kind: pass.kind,
      nodeId,
      label: nodeId === null ? pass.id : nameOf(nodeId),
      depth,
      detail: passDetail(pass, byId),
    });
    if (pass.kind === "loop" && pass.edge === "begin") depth += 1;
  }
  return rows;
}

/**
 * Builds the pipeline inspector's model. Pure; hand it a fixture and it renders.
 */
export function buildPipelineView(request: PipelineRequest): PipelineView {
  const install = installState(request);
  const plan = request.installed;
  if (plan === null) return { install, stats: null, findings: [], passes: [] };

  const nameOf = nodeNamer(plan, request.graph);
  const moved = transitions(plan);

  return {
    install,
    stats: {
      passes: plan.passes.length,
      resources: plan.resources.length,
      nodes: plan.order.length,
      documentNodes: Object.keys(request.graph.nodes).length,
      estimatedBytes: plan.estimatedResourceBytes,
      signature: plan.signature,
    },
    findings: [
      reachabilityFinding(plan, request.graph, request.registry, nameOf),
      transitionFinding("format", moved.format, nameOf),
      transitionFinding("resolution", moved.resolution, nameOf),
      temporalFinding(plan, request.graph, nameOf),
      flattenedFinding(plan),
      substepFinding(plan, nameOf),
      aliasFinding(plan, nameOf),
    ],
    passes: passRows(plan, nameOf),
  };
}
