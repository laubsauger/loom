import type { CompiledGraph } from "@compiler/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { isValueSourceDefinition } from "@domain/graph/liveness.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { estimateResourceBytes } from "@runtime/backend/plan.ts";
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
  | "alias"
  | "synthesis";

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
  /**
   * Pass encodes per DISPLAYED frame, with substep loops multiplied in (T387). Equals
   * `passes` until a loop runs its body more than once, and then it is the number that
   * explains the frame time — which `passes` alone never does.
   */
  readonly encodes: number;
  readonly signature: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE FRAME TAPE (T1188)
 *
 * The diagram is a Gantt chart of one frame, and it is deliberately NOT a second
 * drawing of the node graph. The graph pane already draws the DAG — live, in the user's
 * own layout, with previews and parameters — so a smaller copy of it here would compete
 * with the original and say nothing new. What a DAG structurally CANNOT say is exactly
 * what this screen exists for:
 *
 *  - ENCODE ORDER. A DAG has no sequence; the plan is a strict list. "The swap happens
 *    at column 15, and the pass that reads it is at column 17" is the fact that explains
 *    a feedback delay, and there is nowhere in a graph to put it.
 *  - STORAGE. Two node outputs sharing one texture is one of the compiler's most
 *    surprising decisions (§V6, §V8) and it is invisible as an edge — there is no wire
 *    to draw. Here it is two segments in one lane.
 *  - THE SYNTHESIZED CLOSING EDGE. §V285's whole point is that the loop is NOT on the
 *    canvas. Drawing it as a wire would make it look like every other wire, which is the
 *    confusion the reference exists to remove. On a time axis it is what it actually is:
 *    a read that happens BEFORE the write it reads, i.e. a span reaching backwards past
 *    the start of the frame.
 *
 * So: time along the x axis (one column per pass, in encode order), storage down the y
 * axis (one lane per resource). Everything above falls out of that geometry rather than
 * being annotated onto it.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One touch of a resource by one pass. */
export interface PipelineTrackMark {
  /** Index into `PipelineView.passes` — the column. */
  readonly column: number;
  /**
   * `swap` is the ping-pong rotation: not a touch of the data, a change of which half is
   * which. `use` is a BUFFER binding, where the plan genuinely does not say the
   * direction — `BufferBindingDescriptor.half` names WHICH HALF a binding sees (§V231,
   * T322: an ordinary producer names its write half, a compacted one names its read
   * half), never whether the shader reads or writes it. Guessing there would have put a
   * confident arrow on a fact the plan does not carry, so the mark says "touched".
   */
  readonly kind: "write" | "read" | "use" | "swap";
}

/**
 * One continuous tenancy of a resource. A lane with more than one segment is a resource
 * the compiler REUSED for two different node outputs, which is the picture of aliasing.
 */
export interface PipelineTrackSegment {
  readonly id: string;
  /** Who owns the resource across this span. */
  readonly label: string;
  readonly nodeId: NodeId | null;
  /** First and last column this tenancy touches. Equal for a single-column tenancy. */
  readonly from: number;
  readonly to: number;
  readonly marks: readonly PipelineTrackMark[];
}

export interface PipelineTrackLane {
  readonly resourceId: string;
  readonly label: string;
  readonly kind: ResourceDescriptor["kind"];
  /** Size and format, or stride and capacity — whatever this kind of storage is. */
  readonly detail: string;
  readonly segments: readonly PipelineTrackSegment[];
  /** Two or more distinct nodes write this one resource (§V6, §V8). */
  readonly aliased: boolean;
  /**
   * Written, read by no later pass, and named by a `ResolvedOutput`: its contents LEAVE
   * the frame — presented, previewed, or read back. The end of the tape, not a defect.
   */
  readonly terminal: boolean;
  /**
   * Written, read by nothing, and named by no output either. §V25 prunes what no sink
   * reaches, so this should be empty in a healthy plan — which is exactly why it is
   * drawn: a lane here is work the frame paid for and nobody collected.
   */
  readonly stranded: boolean;
  /**
   * A read at or before the first write: the value came from the PREVIOUS frame, so the
   * span reaches backwards past the start of the tape. §V285's closing edge, as geometry.
   */
  readonly loopBack: { readonly readColumn: number; readonly writeColumn: number } | null;
}

/** A substep loop: the tape rewinds over these columns `count` times (T387). */
export interface PipelineTrackLoop {
  readonly loopId: string;
  readonly label: string;
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export interface PipelineTrack {
  readonly lanes: readonly PipelineTrackLane[];
  readonly loops: readonly PipelineTrackLoop[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * WILL THE DEVICE TAKE IT (T1188, §T1153)
 *
 * The performance pane answers "why is it slow". This answers "what did the compiler
 * decide, and will the machine accept it" — and a limit breach is a compiler decision
 * that failed, not a cost. §T1153 is the case that earned the section: a ring whose
 * `frames` exceeds the device's `maxTextureArrayLayers` fails at `createTexture` ON THE
 * UNCAPTURED-ERROR PATH — silently, with no diagnostic anywhere — and the user sees a
 * blank frame with nothing to read. One row ends that.
 *
 * `grants` is null when the device did not report the limit. Null is rendered as "not
 * reported" and never compared: a fabricated ceiling would be worse than no row.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PipelineLimit {
  readonly id: string;
  readonly label: string;
  /** What this plan asks for. */
  readonly asks: number;
  /** What the device grants, or null when it reported no such limit. */
  readonly grants: number | null;
  /** False only when both numbers exist and the ask exceeds the grant. */
  readonly ok: boolean;
  /** What in the plan asks for it — the thing to go and change. */
  readonly note: string;
}

/** One `label: value` line in the detail rail. */
export interface PipelineDetailField {
  readonly label: string;
  readonly value: string;
  /**
   * True when the value is a WORD standing in for a fact the plan does not carry.
   * Rendered dimmed, never as data (§V86's rule, applied past timing).
   */
  readonly absent?: boolean;
}

export interface PipelineDetailGroup {
  readonly title: string;
  readonly rows: readonly PipelineDetailField[];
}

export interface PipelineDetail {
  readonly kind: "pass" | "resource";
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly groups: readonly PipelineDetailGroup[];
}

/** What the reader clicked. Ids are the installed plan's own. */
export interface PipelineSelection {
  readonly kind: "pass" | "resource";
  readonly id: string;
}

export interface PipelineView {
  readonly install: PipelineInstallState;
  /** Null when nothing is installed: there is no pipeline to describe, and it says so. */
  readonly stats: PipelineStats | null;
  readonly findings: readonly PipelineFinding[];
  readonly passes: readonly PipelinePassRow[];
  /** The diagram. Columns are `passes` by index; lanes are the plan's resources. */
  readonly track: PipelineTrack;
  /**
   * What this plan asks of the device against what the device grants. Empty when no
   * device is attached — the surface says so rather than showing an empty table.
   */
  readonly limits: readonly PipelineLimit[];
  /** False when no `capabilities` was supplied, so "no rows" is not read as "all clear". */
  readonly limitsMeasured: boolean;
  /** The limits section's one-line verdict. */
  readonly limitsSummary: string;
  /**
   * What to say when there is no device. Copy lives here with every other sentence on
   * this screen — `install.headline`, the finding summaries, the detail rows — rather
   * than inline in a component, which is also what keeps §V90's copy guard green.
   */
  readonly limitsNote: string | null;
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
  /**
   * The DEVICE, for the limits section. Omitted — no GPU attached — the section says so
   * rather than comparing the plan against numbers nobody measured.
   */
  readonly capabilities?: BackendCapabilities | undefined;
}

/**
 * §V944 — THE STALENESS KEY IS DERIVED FROM WHAT *THIS* SCREEN READS, never borrowed.
 *
 * §B188 is the reason this function exists instead of a `signature !== signature`
 * comparison. `planStructureSignature` is built for ONE consumer — the vgpu backend
 * deciding when to rebuild its GPU program — so it names resources and passes and
 * nothing else. That is correct for the backend and §V5 requires it to stay blind to
 * uniform values. But a SYNTHESIZED PREVIEW (`ResolvedOutput.synthesis`, T563) mints
 * neither a resource nor a pass, so two plans differing only in `outputs[].synthesis`
 * have byte-identical signatures — measured on E47, 30 resources and 37 passes with and
 * without preview sinks. `use-frame-loop` borrowed that key to decide "is this plan worth
 * announcing" and never announced the second one; every pointset tile read "no signal".
 *
 * ⚑ And the same borrowing put the bug INSIDE the screen built to catch it: this module
 * compared the two signatures and would have reported "in sync" for the whole defect. A
 * banner that says "running" while the app is a compile behind is worse than no banner,
 * because it is trusted.
 *
 * So the key below is a projection of exactly the fields the sections of this screen
 * read, and `plan.signature` is ONE component of it rather than the whole test. Adding a
 * section that reads a new field means adding it here. What it deliberately ignores:
 * uniform VALUES (§V5 — they are pushed per frame and this screen never renders them) and
 * shader TEXT (folded in already, via `passSignatures`).
 *
 * It is NOT folded back into `planStructureSignature`: that key must stay exactly what
 * the backend needs, which is §V944's whole point.
 */
function viewIdentity(plan: CompiledGraph): string {
  const outputs = plan.outputs
    .map((output) => {
      const synthesis =
        output.synthesis === undefined
          ? "-"
          : [
              output.synthesis.kind ?? "?",
              output.synthesis.passes.map((pass) => pass.id).join(","),
              output.synthesis.depth ? "depth" : "",
              output.synthesis.orbit === undefined ? "" : "orbit",
            ].join("/");
      return [
        output.nodeId,
        output.portId,
        output.resourceId,
        output.resourceKind,
        output.size.join("x"),
        output.format,
        output.space,
        output.temporal ? "t" : "",
        output.depth === true ? "d" : "",
        output.msaa === true ? "m" : "",
        synthesis,
      ].join(":");
    })
    .join("|");

  return [
    plan.signature,
    plan.ok ? "ok" : "errors",
    outputs,
    plan.order.join(","),
    plan.pruned.join(","),
    plan.feedback.map((pair) => `${pair.resourceId}@${pair.resetSignature}`).join(","),
    plan.sources.map((source) => `${source.nodeId}=${source.sourcePath}`).join(","),
    `${plan.estimatedResourceBytes}`,
  ].join("\n");
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
  if (compiled !== null && viewIdentity(compiled) !== viewIdentity(installed)) {
    return {
      kind: "waiting",
      headline: "Waiting to install",
      detail:
        "A newer plan compiled cleanly. What is described below is the last plan this app saw installed — " +
        "either it has not landed on the device yet, or nothing announced that it had.",
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

/**
 * §B188's row — the synthesized previews the INSTALLED plan carries (T563, §V944).
 *
 * A preview of a pointset or a scene is not drawn by the main plan: the compiler
 * publishes `ResolvedOutput.synthesis`, a set of draw passes the PREVIEW PROGRAM owns and
 * runs on its own cadence. That makes it invisible to `planStructureSignature` — it mints
 * neither a resource nor a pass — which is exactly how a whole document's pointset tiles
 * came to read "no signal" with every other surface reporting health. Nothing else in the
 * product says whether the running plan carries them, so this does.
 */
function synthesisFinding(
  plan: CompiledGraph,
  nameOf: (nodeId: NodeId) => string,
): PipelineFinding {
  const rows: PipelineFindingRow[] = [];
  for (const output of plan.outputs) {
    if (output.synthesis === undefined) continue;
    const synthesis = output.synthesis;
    rows.push({
      id: `${output.nodeId}:${output.portId}`,
      nodeId: output.nodeId,
      text:
        `${nameOf(output.nodeId)}:${output.portId} — ${synthesis.kind ?? "preview"} drawn by ` +
        `${synthesis.passes.length} synthesized pass${synthesis.passes.length === 1 ? "" : "es"}` +
        `${synthesis.orbit === undefined ? "" : ", orbitable"}. The main plan carries neither ` +
        `those passes nor their target.`,
    });
  }
  const pointsets = plan.outputs.filter((output) => output.resourceKind === "pointset").length;
  return {
    kind: "synthesis",
    title: "Previews synthesized",
    summary:
      rows.length === 0
        ? pointsets === 0
          ? "No output in this plan needs a synthesized preview."
          : `No output carries a synthesized preview, and ${pointsets} pointset output${pointsets === 1 ? "" : "s"} would need one to show a picture.`
        : `${rows.length} of ${plan.outputs.length} outputs carry a preview program the main plan does not draw.`,
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

interface TrackEvent {
  readonly column: number;
  readonly kind: PipelineTrackMark["kind"];
  readonly nodeId: NodeId | null;
}

/** What each pass touches, and how. Samplers are excluded: they hold nothing over time. */
function trackEvents(plan: CompiledGraph): Map<string, TrackEvent[]> {
  const events = new Map<string, TrackEvent[]>();
  const push = (resourceId: string, event: TrackEvent): void => {
    const list = events.get(resourceId);
    if (list === undefined) events.set(resourceId, [event]);
    else list.push(event);
  };

  for (const [column, pass] of plan.passes.entries()) {
    const nodeId = "nodeId" in pass && pass.nodeId !== undefined ? (pass.nodeId as NodeId) : null;
    if (pass.kind === "swap") {
      push(pass.resourceId, { column, kind: "swap", nodeId });
      continue;
    }
    if (pass.kind === "loop") continue;
    if (pass.kind === "counter") {
      push(pass.resourceId, { column, kind: pass.op === "scan" ? "read" : "write", nodeId });
      if (pass.outputResourceId !== undefined) {
        push(pass.outputResourceId, { column, kind: "write", nodeId });
      }
      continue;
    }
    if ("target" in pass) push(pass.target, { column, kind: "write", nodeId });
    for (const binding of "textures" in pass ? (pass.textures ?? []) : []) {
      push(binding.resourceId, { column, kind: "read", nodeId });
    }
    for (const binding of "buffers" in pass ? (pass.buffers ?? []) : []) {
      push(binding.resourceId, { column, kind: "use", nodeId });
    }
  }
  return events;
}

/**
 * Cuts one resource's events into TENANCIES.
 *
 * A tenancy ends where a DIFFERENT node writes the resource — that is the moment the
 * storage stops holding one thing and starts holding another, and two tenancies in one
 * lane is the whole picture of reuse. Passes of the same node (a separable blur's two
 * halves, say) are one tenancy, because the storage is holding one node's work
 * throughout.
 */
function segmentsOf(
  resourceId: string,
  events: readonly TrackEvent[],
  nameOf: (nodeId: NodeId) => string,
): PipelineTrackSegment[] {
  const ordered = [...events].sort((a, b) => a.column - b.column);
  const segments: PipelineTrackSegment[] = [];
  let owner: NodeId | null = null;
  let from = ordered[0]?.column ?? 0;
  let to = from;
  let marks: PipelineTrackMark[] = [];

  const close = (): void => {
    if (marks.length === 0) return;
    segments.push({
      id: `${resourceId}#${segments.length}`,
      label: owner === null ? resourceId : nameOf(owner),
      nodeId: owner,
      from,
      to,
      marks,
    });
  };

  for (const event of ordered) {
    // A READ never transfers tenancy — a consumer looking at a texture does not take it
    // over — and neither does a swap. A write, or a point kernel's copy-on-write `use`
    // (T1076/§V197: the next node in the chain takes over the regions it publishes),
    // does.
    const takesOver = event.kind === "write" || event.kind === "use";
    if (takesOver && owner !== null && event.nodeId !== null && event.nodeId !== owner) {
      close();
      owner = event.nodeId;
      from = event.column;
      marks = [];
    }
    if (takesOver && owner === null) owner = event.nodeId;
    to = event.column;
    marks.push({ column: event.column, kind: event.kind });
  }
  close();
  return segments;
}

function laneDetail(resource: ResourceDescriptor): string {
  const sized = sizedResource(resource);
  if (sized !== null) {
    const frames = "frames" in resource ? ` ×${resource.frames}` : "";
    return `${describeSize(sized.size)} ${sized.format}${frames}`;
  }
  if ("capacity" in resource) return `${resource.capacity} × ${resource.stride} B`;
  return resource.kind;
}

function buildTrack(plan: CompiledGraph, nameOf: (nodeId: NodeId) => string): PipelineTrack {
  const events = trackEvents(plan);
  const outputResources = new Set(plan.outputs.map((output) => output.resourceId));
  const lanes: PipelineTrackLane[] = [];

  for (const resource of plan.resources) {
    if (resource.kind === "sampler") continue;
    const touched = events.get(resource.id) ?? [];
    if (touched.length === 0) continue;
    const writes = touched.filter((event) => event.kind === "write");
    const reads = touched.filter((event) => event.kind === "read");
    const holders = new Set(
      touched
        .filter((event) => event.kind === "write" || event.kind === "use")
        .map((event) => event.nodeId)
        .filter((id) => id !== null),
    );
    const firstWrite = writes[0]?.column ?? null;
    const firstRead = reads[0]?.column ?? null;
    /*
     * Directional flags need a directional lane. A buffer lane carries only `use` marks
     * (see `PipelineTrackMark`), so "written and never read" would be true of every one
     * of them and would mean nothing — the flag is withheld rather than guessed.
     */
    const unread = firstWrite !== null && reads.length === 0;
    lanes.push({
      resourceId: resource.id,
      label: resource.label ?? resource.id,
      kind: resource.kind,
      detail: laneDetail(resource),
      segments: segmentsOf(resource.id, touched, nameOf),
      aliased: holders.size > 1,
      terminal: unread && outputResources.has(resource.id),
      stranded: unread && !outputResources.has(resource.id),
      /*
       * STRICTLY earlier. A pass that reads and writes one resource in its own column is
       * an in-frame ping-pong, not a frame boundary; only a reader that runs BEFORE the
       * writer is looking at last frame's contents.
       */
      loopBack:
        firstWrite !== null && firstRead !== null && firstRead < firstWrite
          ? { readColumn: firstRead, writeColumn: firstWrite }
          : null,
    });
  }

  const loops: PipelineTrackLoop[] = [];
  for (const [column, pass] of plan.passes.entries()) {
    if (pass.kind !== "loop" || pass.edge !== "begin") continue;
    const end = plan.passes.findIndex(
      (other, index) =>
        index > column && other.kind === "loop" && other.edge === "end" && other.loopId === pass.loopId,
    );
    loops.push({
      loopId: pass.loopId,
      label: pass.nodeId === undefined ? pass.loopId : nameOf(pass.nodeId),
      from: column,
      to: end === -1 ? plan.passes.length - 1 : end,
      count: pass.count ?? 1,
    });
  }

  return { lanes, loops };
}

/** Pass encodes per displayed frame, with each substep loop's body counted `count` times. */
function encodeCount(plan: CompiledGraph, loops: readonly PipelineTrackLoop[]): number {
  let total = 0;
  for (const [column, pass] of plan.passes.entries()) {
    if (pass.kind === "loop") continue;
    const enclosing = loops.filter((loop) => column > loop.from && column < loop.to);
    total += enclosing.reduce((factor, loop) => factor * loop.count, 1);
  }
  return total;
}

/** What the rail says when the thing you selected has left the installed plan. */
export function missingSelectionNote(selection: PipelineSelection): string {
  const what = selection.kind === "pass" ? "That pass" : "That resource";
  return `${what} is no longer in the running pipeline. It was here when you selected it, and the installed plan has since changed.`;
}

const NO_DEVICE_NOTE =
  "No GPU is attached to this session, so the plan has nothing to be measured against. This is not a clean bill of health.";

function limitsSummary(measured: boolean, limits: readonly PipelineLimit[]): string {
  if (!measured) return "no device attached, so nothing here is compared";
  const breaches = limits.filter((limit) => !limit.ok).length;
  if (breaches === 0) return "every ask is inside what this device grants";
  return `${breaches} ask${breaches === 1 ? "" : "s"} exceed what this device grants`;
}

/** The largest thing of one shape the plan asks for, and what asks for it. */
interface Ask {
  readonly asks: number;
  readonly note: string;
}

function largest(entries: ReadonlyArray<Ask>): Ask | null {
  let best: Ask | null = null;
  for (const entry of entries) {
    if (best === null || entry.asks > best.asks) best = entry;
  }
  return best;
}

function buildLimits(plan: CompiledGraph, capabilities: BackendCapabilities): PipelineLimit[] {
  const grantOf = (name: string): number | null => {
    const value = capabilities.limits[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const dimensions: Ask[] = [];
  const layers: Ask[] = [];
  const bytes: Ask[] = [];
  for (const resource of plan.resources) {
    const sized = sizedResource(resource);
    if (sized !== null) {
      dimensions.push({
        asks: Math.max(sized.size[0], sized.size[1]),
        note: `${resource.id} is ${describeSize(sized.size)}`,
      });
    }
    if ("frames" in resource) {
      layers.push({ asks: resource.frames, note: `${resource.id} holds ${resource.frames} frames` });
    }
    if ("capacity" in resource) {
      bytes.push({
        asks: resource.stride * resource.capacity,
        note: `${resource.id} is ${resource.capacity} × ${resource.stride} B`,
      });
    }
  }

  const textures: Ask[] = [];
  const buffers: Ask[] = [];
  const workgroups: Ask[] = [];
  for (const pass of plan.passes) {
    if ("textures" in pass && (pass.textures ?? []).length > 0) {
      textures.push({ asks: (pass.textures ?? []).length, note: `${pass.id} binds ${(pass.textures ?? []).length}` });
    }
    if ("buffers" in pass && (pass.buffers ?? []).length > 0) {
      buffers.push({ asks: (pass.buffers ?? []).length, note: `${pass.id} binds ${(pass.buffers ?? []).length}` });
    }
    if (pass.kind === "dispatch" && Array.isArray(pass.workgroups)) {
      workgroups.push({
        asks: Math.max(...pass.workgroups),
        note: `${pass.id} dispatches ${pass.workgroups.join(" × ")}`,
      });
    }
  }

  const rows: PipelineLimit[] = [];
  const add = (id: string, label: string, limit: string, entries: ReadonlyArray<Ask>): void => {
    const ask = largest(entries);
    if (ask === null) return;
    const grants = grantOf(limit);
    rows.push({
      id,
      label,
      asks: ask.asks,
      grants,
      ok: grants === null || ask.asks <= grants,
      note: ask.note,
    });
  };

  add("dimension", "largest texture edge", "maxTextureDimension2D", dimensions);
  // §T1153: the one that fails on the uncaptured-error path with no diagnostic at all.
  add("layers", "deepest ring", "maxTextureArrayLayers", layers);
  add("buffer", "largest buffer", "maxStorageBufferBindingSize", bytes);
  add("textures", "textures bound by one pass", "maxSampledTexturesPerShaderStage", textures);
  add("buffers", "storage buffers bound by one pass", "maxStorageBuffersPerShaderStage", buffers);
  add("workgroups", "largest dispatch dimension", "maxComputeWorkgroupsPerDimension", workgroups);
  return rows;
}

const NOT_STATED = "not stated by the plan";

function field(label: string, value: string): PipelineDetailField {
  return { label, value };
}

function absentField(label: string, value: string): PipelineDetailField {
  return { label, value, absent: true };
}

function describeBindingTarget(resourceId: string, byId: Map<string, ResourceDescriptor>): string {
  const resource = byId.get(resourceId);
  if (resource === undefined) return `${resourceId} (no such resource in this plan)`;
  return `${resourceId} — ${laneDetail(resource)}`;
}

function passGroups(
  pass: PassDescriptor,
  byId: Map<string, ResourceDescriptor>,
): PipelineDetailGroup[] {
  const groups: PipelineDetailGroup[] = [];
  const what: PipelineDetailField[] = [];

  if ("target" in pass) what.push(field("writes", describeBindingTarget(pass.target, byId)));
  if (pass.kind === "swap") {
    what.push(field("rotates", describeBindingTarget(pass.resourceId, byId)));
    what.push(field("effect", "the half written this frame becomes the half read next frame (§V22)"));
  }
  if (pass.kind === "counter") {
    what.push(field("operation", pass.op));
    what.push(field("counter", describeBindingTarget(pass.resourceId, byId)));
    if (pass.outputResourceId !== undefined) {
      what.push(field("writes", describeBindingTarget(pass.outputResourceId, byId)));
    }
  }
  if (pass.kind === "loop") {
    what.push(field("edge", pass.edge));
    if (pass.count !== undefined) what.push(field("iterations", `${pass.count}`));
  }
  if (pass.kind === "dispatch") {
    what.push(field("entry point", pass.entryPoint));
    what.push(
      field(
        "workgroups",
        Array.isArray(pass.workgroups)
          ? pass.workgroups.join(" × ")
          : `indirect from ${(pass.workgroups as { readonly indirect: string }).indirect}`,
      ),
    );
  }
  if (pass.kind === "draw") {
    what.push(field("topology", pass.topology));
    what.push(
      field(
        "instances",
        typeof pass.instances === "number" ? `${pass.instances}` : `indirect from ${pass.instances.indirect}`,
      ),
    );
    if (pass.vertexCount !== undefined) what.push(field("vertices", `${pass.vertexCount}`));
    what.push(field("blend", pass.blend ?? "none"));
    what.push(field("depth write", pass.depthWrite === false ? "off" : "on"));
  }
  if ("clear" in pass) what.push(field("clears first", pass.clear === false ? "no — accumulates" : "yes"));
  if (what.length > 0) groups.push({ title: "What it does", rows: what });

  const reads: PipelineDetailField[] = [];
  for (const binding of "textures" in pass ? (pass.textures ?? []) : []) {
    const how = binding.live === true
      ? "the frame being written now (B160)"
      : binding.array === true
        ? "the whole history as an array (T321)"
        : binding.tap !== undefined
          ? `${binding.tap} frame(s) back (T237)`
          : "current";
    reads.push(
      field(binding.binding, `${describeBindingTarget(binding.resourceId, byId)} · ${binding.sampled ?? "filtered"} · ${how}`),
    );
  }
  if (reads.length > 0) groups.push({ title: "Texture bindings", rows: reads });

  const buffers: PipelineDetailField[] = [];
  for (const binding of "buffers" in pass ? (pass.buffers ?? []) : []) {
    const region =
      binding.offset === undefined
        ? "whole buffer"
        : `bytes ${binding.offset}–${binding.offset + (binding.bytes ?? 0)} (T1076)`;
    buffers.push(
      field(binding.binding, `${describeBindingTarget(binding.resourceId, byId)} · ${binding.half ?? "read"} half · ${region}`),
    );
  }
  if (buffers.length > 0) {
    buffers.push(
      absentField(
        "access direction",
        `${NOT_STATED} — \`half\` names WHICH half a binding sees, never whether the shader reads or writes it (§V231, T322)`,
      ),
    );
    groups.push({ title: "Buffer bindings", rows: buffers });
  }

  const identity: PipelineDetailField[] = [];
  if ("shader" in pass) identity.push(field("shader", `${pass.shader.length} chars of WGSL`));
  if ("uniformBinding" in pass && pass.uniformBinding !== undefined) {
    const names = "uniforms" in pass && pass.uniforms !== undefined ? Object.keys(pass.uniforms).sort() : [];
    identity.push(field("uniform block", pass.uniformBinding));
    identity.push(
      names.length === 0
        ? absentField("uniform members", "none declared")
        : field("uniform members", names.join(", ")),
    );
    // §V5: values are pushed with `updateUniforms` and never reach the compile key, so what
    // the installed plan carries is the value at INSTALL time. Rendering it as live would
    // be a fresh lie inside the screen built to avoid exactly that.
    identity.push(absentField("uniform values", "pushed every frame — not read here"));
  }
  if ("sharedBinding" in pass && pass.sharedBinding !== undefined) {
    identity.push(field("frame block", pass.sharedBinding));
  }
  /*
   * No signature row. `passSignatures` embeds the whole WGSL, so it renders as a wall of
   * shader text — and the question it answers ("did this pass change between two plans")
   * cannot be asked with one plan on screen. The shader size and the uniform block are
   * the identity a reader can actually use here.
   */
  if (identity.length > 0) groups.push({ title: "Identity", rows: identity });

  return groups;
}

function resourceGroups(
  resource: ResourceDescriptor,
  plan: CompiledGraph,
  lane: PipelineTrackLane | undefined,
  passes: readonly PipelinePassRow[],
  nameOf: (nodeId: NodeId) => string,
): PipelineDetailGroup[] {
  const groups: PipelineDetailGroup[] = [];
  const storage: PipelineDetailField[] = [field("kind", resource.kind), field("shape", laneDetail(resource))];
  if ("depth" in resource && resource.depth === true) storage.push(field("depth attachment", "yes"));
  if ("msaa" in resource && resource.msaa === true) storage.push(field("multisampled", "4×"));
  if ("sourceId" in resource) storage.push(field("supplied by", resource.sourceId));
  if ("usage" in resource) storage.push(field("usage", resource.usage));
  storage.push(field("estimated memory", `${estimateResourceBytes([resource])} B`));
  groups.push({ title: "Storage", rows: storage });

  const outputs = plan.outputs.filter((output) => output.resourceId === resource.id);
  if (outputs.length > 0) {
    groups.push({
      title: outputs.length > 1 ? "Node outputs sharing it" : "Node output",
      rows: outputs.map((output) =>
        field(`${nameOf(output.nodeId)}:${output.portId}`, `${output.format} · ${output.space}${output.temporal ? " · temporal" : ""}`),
      ),
    });
  }

  if (lane !== undefined) {
    const at = (column: number): string => `pass ${column + 1} · ${passes[column]?.id ?? "?"}`;
    const timeline: PipelineDetailField[] = [];
    for (const segment of lane.segments) {
      const marks = segment.marks.map((mark) => `${mark.kind} at ${mark.column + 1}`).join(", ");
      timeline.push(field(segment.label, `passes ${segment.from + 1}–${segment.to + 1} · ${marks}`));
    }
    if (lane.aliased) {
      timeline.push(
        field("reuse", `${lane.segments.length} nodes hold this one resource in turn (§V6, §V8)`),
      );
    }
    if (lane.loopBack !== null) {
      timeline.push(
        field(
          "crosses the frame",
          `read at ${at(lane.loopBack.readColumn)} before it is written at ${at(lane.loopBack.writeColumn)} — that read is LAST frame's value (§V22, §V285)`,
        ),
      );
    }
    if (lane.terminal) timeline.push(field("ends", "nothing downstream reads it: its contents leave the frame"));
    if (lane.stranded) timeline.push(field("stranded", "written, and read by nothing — work nobody collects"));
    if (lane.segments.every((segment) => segment.marks.every((mark) => mark.kind === "use" || mark.kind === "swap"))) {
      timeline.push(absentField("read / write", `${NOT_STATED} for buffer bindings (§V231, T322)`));
    }
    groups.push({ title: "Through the frame", rows: timeline });
  }

  return groups;
}

/**
 * The detail rail's content for one selection, or null when the installed plan no longer
 * has it.
 *
 * Null is a REPORTED state, not a cleared one: an edit can land while the rail is open,
 * and silently blanking would be the same dishonesty the install banner exists to
 * prevent. The surface says the thing is gone.
 */
export function buildPipelineDetail(
  request: PipelineRequest,
  selection: PipelineSelection,
): PipelineDetail | null {
  const plan = request.installed;
  if (plan === null) return null;
  const nameOf = nodeNamer(plan, request.graph);
  const byId = new Map(plan.resources.map((resource) => [resource.id, resource] as const));

  if (selection.kind === "pass") {
    const column = plan.passes.findIndex((pass) => pass.id === selection.id);
    const pass = plan.passes[column];
    if (pass === undefined) return null;
    const nodeId = "nodeId" in pass && pass.nodeId !== undefined ? (pass.nodeId as NodeId) : null;
    return {
      kind: "pass",
      id: pass.id,
      title: pass.id,
      subtitle: `pass ${column + 1} of ${plan.passes.length} · ${pass.kind}${nodeId === null ? "" : ` · ${nameOf(nodeId)}`}`,
      groups: passGroups(pass, byId),
    };
  }

  const resource = byId.get(selection.id);
  if (resource === undefined) return null;
  const track = buildTrack(plan, nameOf);
  const lane = track.lanes.find((entry) => entry.resourceId === selection.id);
  return {
    kind: "resource",
    id: resource.id,
    title: resource.id,
    subtitle: `${resource.kind} · ${laneDetail(resource)}`,
    groups: resourceGroups(resource, plan, lane, passRows(plan, nameOf), nameOf),
  };
}

/**
 * Builds the pipeline inspector's model. Pure; hand it a fixture and it renders.
 */
export function buildPipelineView(request: PipelineRequest): PipelineView {
  const install = installState(request);
  const plan = request.installed;
  const limitsMeasured = request.capabilities !== undefined;
  if (plan === null) {
    return {
      install,
      stats: null,
      findings: [],
      passes: [],
      track: { lanes: [], loops: [] },
      limits: [],
      limitsMeasured,
      limitsSummary: limitsSummary(limitsMeasured, []),
      limitsNote: limitsMeasured ? null : NO_DEVICE_NOTE,
    };
  }

  const nameOf = nodeNamer(plan, request.graph);
  const moved = transitions(plan);
  const track = buildTrack(plan, nameOf);
  const limits = request.capabilities === undefined ? [] : buildLimits(plan, request.capabilities);

  return {
    install,
    stats: {
      passes: plan.passes.length,
      resources: plan.resources.length,
      nodes: plan.order.length,
      documentNodes: Object.keys(request.graph.nodes).length,
      estimatedBytes: plan.estimatedResourceBytes,
      encodes: encodeCount(plan, track.loops),
      signature: plan.signature,
    },
    findings: [
      reachabilityFinding(plan, request.graph, request.registry, nameOf),
      transitionFinding("format", moved.format, nameOf),
      transitionFinding("resolution", moved.resolution, nameOf),
      temporalFinding(plan, request.graph, nameOf),
      synthesisFinding(plan, nameOf),
      flattenedFinding(plan),
      substepFinding(plan, nameOf),
      aliasFinding(plan, nameOf),
    ],
    passes: passRows(plan, nameOf),
    track,
    limits,
    limitsMeasured,
    limitsSummary: limitsSummary(limitsMeasured, limits),
    limitsNote: limitsMeasured ? null : NO_DEVICE_NOTE,
  };
}
