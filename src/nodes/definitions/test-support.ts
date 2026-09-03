import type { NodeCompileContext, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { PortId } from "../../domain/types/ids.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import type { PlanReadResult } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { COMPONENT_COUNTS, type PointAttributeType } from "../../points/attributes.ts";
import { packAttributes } from "../../points/packing.ts";
import { pointStorageId } from "./point-storage.ts";
import { parseAttributes } from "./points.ts";

/**
 * Fixtures for the catalogue's unit tests (T70, T40).
 *
 * A fixture is an assumption written twice, so this file's job is to keep the assumption
 * in ONE place: it builds the compiler-shaped context that `readCompileInputs` adapts, and
 * it runs a node's emitted passes back through the BACKEND's own `readExecutionPlan`. A
 * node whose passes the backend refuses is a broken node even if every field looks right,
 * and that is precisely the disagreement a per-track fixture cannot catch —
 * `catalogue-chain.test.ts` closes the loop with the real compiler on top.
 */

export interface ContextOptions {
  readonly nodeId?: string;
  /**
   * Input port ids to give a bound resource. Naming a port MORE THAN ONCE gives it that
   * many bindings, in the order listed — which is how a variadic port is exercised (T225,
   * T226). The first binding on a port keeps the plain `resource:<port>` id so the
   * single-arity tests read unchanged.
   */
  readonly inputs?: ReadonlyArray<PortId>;
  /** Producer node id per input port, for pointset consumers (T122). */
  readonly sources?: Readonly<Record<PortId, string>>;
  /** T296 edge payload per input port, for consumers that read pairs/capacity/topology. */
  readonly pointsets?: Readonly<
    Record<
      PortId,
      {
        pairs: Readonly<Record<string, PointsetAttributeRef>>;
        capacity: number;
        topology?: string;
        count?: { buffer: string };
      }
    >
  >;
  /** Output port ids to materialize. Defaults to `["out"]`. */
  readonly outputs?: ReadonlyArray<PortId>;
  readonly parameters?: Readonly<Record<string, ParameterValue>>;
  /** T286: map-mode bindings, as the resolver would have collected them. */
  readonly parameterMaps?: Readonly<Record<string, { attribute: string; channel?: string; port?: string }>>;
  readonly resolution?: readonly [number, number];
  /**
   * Scratch keys the node declares (T147). The compiler materializes one target per key at
   * `scratchResourceId(nodeId, key)`; `readNodePlan` declares the same resources so a
   * multi-pass node's plan can be read back the way the real compiler's would be.
   */
  readonly scratch?: ReadonlyArray<string>;
}

export const TEST_SAMPLER_ID = "sampler:linear";

/**
 * Resource id this fixture assigns to an input port, matching the compiler's shape.
 *
 * `index` is the position on a VARIADIC port (T225). Position 0 keeps the unsuffixed id so
 * every single-arity expectation in the suite stays literal.
 */
export function inputResourceId(portId: PortId, index = 0): string {
  return index === 0 ? `resource:${portId}` : `resource:${portId}:${index}`;
}

/** Resource id this fixture assigns to an output port. */
export function outputResourceId(portId: PortId): string {
  return `target:${portId}`;
}

/**
 * A context shaped like the compiler's `CompilerNodeContext` — inputs as ARRAYS of
 * bindings (a variadic port has more than one, §V14) and outputs as full bindings.
 */
export function compileContext(options: ContextOptions = {}): NodeCompileContext {
  const outputPorts = options.outputs ?? ["out"];
  const inputs: Record<
    string,
    ReadonlyArray<{
      resourceId: string;
      sampler: string;
      sourceNodeId?: string;
      sourcePortId?: string;
      pointset?: {
        pairs: Readonly<Record<string, PointsetAttributeRef>>;
        capacity: number;
        topology?: string;
        count?: { buffer: string };
      };
    }>
  > = {};
  for (const portId of options.inputs ?? []) {
    const sourceNodeId = options.sources?.[portId];
    const pointset = options.pointsets?.[portId];
    const existing = inputs[portId] ?? [];
    inputs[portId] = [
      ...existing,
      {
        resourceId: inputResourceId(portId, existing.length),
        sampler: TEST_SAMPLER_ID,
        ...(sourceNodeId === undefined ? {} : { sourceNodeId, sourcePortId: "out" }),
        ...(pointset === undefined ? {} : { pointset }),
      },
    ];
  }
  const outputs: Record<string, { portId: string; resourceId: string }> = {};
  for (const portId of outputPorts) {
    outputs[portId] = { portId, resourceId: outputResourceId(portId) };
  }
  const firstOutput = outputPorts[0];

  return {
    nodeId: options.nodeId ?? "n1",
    parameters: options.parameters ?? {},
    parameterMaps: options.parameterMaps ?? {},
    resolution: options.resolution ?? [640, 480],
    inputs,
    outputs,
    sampler: TEST_SAMPLER_ID,
    ...(firstOutput === undefined ? {} : { target: outputResourceId(firstOutput) }),
  };
}

/**
 * Runs a node's emitted passes through the backend's plan reader, with a resource list
 * that declares everything the fixture handed the node. `ok === false` means the backend
 * would refuse the plan.
 */
/** One resource id per BINDING: a port listed twice has two (T226). */
function declaredInputResourceIds(portIds: ReadonlyArray<PortId>): string[] {
  const seen = new Map<PortId, number>();
  return portIds.map((portId) => {
    const index = seen.get(portId) ?? 0;
    seen.set(portId, index + 1);
    return inputResourceId(portId, index);
  });
}

export function readNodePlan(
  passes: ReadonlyArray<unknown>,
  options: ContextOptions = {},
): PlanReadResult {
  const outputPorts = options.outputs ?? ["out"];
  const plan: LogicalExecutionPlan = {
    passes,
    resources: [
      { kind: "sampler", id: TEST_SAMPLER_ID, filter: "linear" },
      ...outputPorts.map((portId) => ({
        kind: "target" as const,
        id: outputResourceId(portId),
        size: options.resolution ?? ([640, 480] as const),
        format: "rgba16float" as const,
      })),
      ...declaredInputResourceIds(options.inputs ?? []).map((id) => ({
        kind: "target" as const,
        id,
        size: options.resolution ?? ([640, 480] as const),
        format: "rgba16float" as const,
      })),
      ...(options.scratch ?? []).map((key) => ({
        kind: "target" as const,
        id: scratchResourceId(options.nodeId ?? "n1", key),
        size: options.resolution ?? ([640, 480] as const),
        format: "rgba16float" as const,
      })),
    ],
    diagnostics: [],
  };
  return readExecutionPlan(plan);
}

/**
 * T751 — THE MINIMAL GRAPH PER NODE TYPE, shared by the headless catalogue sweep
 * (catalogue-chain.test.ts) and the Dawn one (catalogue-dawn.gpu.test.ts).
 *
 * Extracted because coverage-by-example is coverage BY ACCIDENT: a node type reaches a
 * real shader compiler only if some example happens to want it, and §B146 (mirror had
 * never compiled on any device — vec2f(bool) — while every suite stayed green) is the
 * third §B39-shaped instance of that hole. Feeders match the port FAMILY (texture from
 * a checker, pointset from a grid), reference parameters name kind-matched feeders, and
 * the first output is observed the way a user would observe it.
 */
export function minimalGraphFor(
  definition: {
    readonly type: string;
    readonly inputs: ReadonlyArray<{
      id: string;
      type: { kind: string; requires?: ReadonlyArray<{ name: string }> };
    }>;
    readonly outputs: ReadonlyArray<{ id: string; type: { kind: string } }>;
    readonly sourceReferences?: ReadonlyArray<{ parameter: string; input: string }>;
  },
  registry: { get(type: string): { version: number } | undefined },
): {
  revision: number;
  nodes: Record<string, unknown>;
  edges: Record<string, unknown>;
  groups: Record<string, unknown>;
} {
  const mk = (id: string, type: string, parameters: Record<string, unknown> = {}) => ({
    id,
    type,
    definitionVersion: registry.get(type)?.version ?? 1,
    position: { x: 0, y: 0 },
    parameters,
  });
  const mkEdge = (id: string, from: [string, string], to: [string, string]) => ({
    id,
    source: { nodeId: from[0], portId: from[1] },
    target: { nodeId: to[0], portId: to[1] },
  });
  const nodes: Record<string, Record<string, unknown>> = {
    subject: { ...mk("subject", definition.type), label: "subject1" },
  };
  if (definition.outputs.length > 0) nodes["sink"] = mk("sink", "output");
  const edges: Record<string, unknown> = {};
  const referenceInputs = new Set((definition.sourceReferences ?? []).map((spec) => spec.input));
  definition.inputs.forEach((port, index) => {
    if (referenceInputs.has(port.id)) return;
    const feedId = `feed${index}`;
    /* T1071: the stand-in has to satisfy what the port ASKS FOR, not merely its kind. A
       pointset port requiring `neighbor` is asking for an ADJACENCY, which a bare grid does
       not carry — feeding one anyway made the port-compat refusal look like a broken node
       (§V886: one stand-in serving several node types is how a sweep stops sweeping). The
       catalogue's producer of an adjacency is Proximity, over a grid. */
    const wantsAdjacency =
      port.type.kind === "pointset" && (port.type.requires ?? []).some((entry) => entry.name === "neighbor");
    if (wantsAdjacency) {
      nodes[`${feedId}src`] = mk(`${feedId}src`, "pointGrid");
      nodes[feedId] = mk(feedId, "pointProximity", { neighbors: 2, radius: 1 });
      edges[`${feedId}link`] = mkEdge(`${feedId}link`, [`${feedId}src`, "out"], [feedId, "points"]);
    } else {
      nodes[feedId] = mk(feedId, port.type.kind === "pointset" ? "pointGrid" : "checker");
    }
    edges[`in${index}`] = mkEdge(`in${index}`, [feedId, "out"], ["subject", port.id]);
  });
  for (const spec of definition.sourceReferences ?? []) {
    const port = definition.inputs.find((candidate) => candidate.id === spec.input);
    if (port === undefined) continue;
    const subject = nodes["subject"]!;
    const withReference = (name: string): void => {
      subject["parameters"] = { ...(subject["parameters"] as object), [spec.parameter]: name };
    };
    if (port.type.kind === "texture2d") {
      nodes["refsrc"] = { ...mk("refsrc", "checker"), label: "refsrc1" };
      withReference("refsrc1");
    } else if (port.type.kind === "camera") {
      nodes["refcam"] = { ...mk("refcam", "camera"), label: "refcam1" };
      withReference("refcam1");
    } else if (port.type.kind === "light") {
      nodes["reflight"] = { ...mk("reflight", "light"), label: "reflight1" };
      withReference("reflight1");
    } else if (port.type.kind === "scene") {
      nodes["refgrid"] = mk("refgrid", "pointGrid");
      nodes["refgeo"] = { ...mk("refgeo", "geometry"), label: "refgeo1" };
      edges["refgeo-in"] = mkEdge("refgeo-in", ["refgrid", "out"], ["refgeo", "points"]);
      withReference("refgeo1");
    }
    // material references stay empty: the parameter is optional and the default
    // material is the documented fallback.
  }
  const firstOutput = definition.outputs[0];
  if (firstOutput !== undefined) {
    if (firstOutput.type.kind === "pointset") {
      nodes["observe"] = mk("observe", "renderPoints");
      edges["observe-in"] = mkEdge("observe-in", ["subject", firstOutput.id], ["observe", "points"]);
      edges["sink"] = mkEdge("sink", ["observe", "out"], ["sink", "input"]);
    } else if (
      firstOutput.type.kind === "camera" ||
      firstOutput.type.kind === "light" ||
      firstOutput.type.kind === "projector" ||
      firstOutput.type.kind === "scene" ||
      firstOutput.type.kind === "material"
    ) {
      // T447: a scene THING is observed by rendering with it — assembled by NAME (V372).
      nodes["obsgrid"] = mk("obsgrid", "pointGrid");
      nodes["obsgeo"] = { ...mk("obsgeo", "geometry"), label: "obsgeo1" };
      edges["obsgeo-in"] = mkEdge("obsgeo-in", ["obsgrid", "out"], ["obsgeo", "points"]);
      nodes["obscam"] = { ...mk("obscam", "camera"), label: "obscam1" };
      nodes["obslight"] = { ...mk("obslight", "light"), label: "obslight1" };
      if (firstOutput.type.kind === "material") {
        nodes["obsgeo"] = { ...nodes["obsgeo"], parameters: { material: "subject1" } };
      }
      nodes["observe"] = mk("observe", "render", {
        scenes: firstOutput.type.kind === "scene" ? "subject1" : "obsgeo1",
        camera: firstOutput.type.kind === "camera" ? "subject1" : "obscam1",
        lights: firstOutput.type.kind === "light" ? "subject1" : "obslight1",
        ...(firstOutput.type.kind === "projector" ? { projectors: "subject1" } : {}),
      });
      edges["sink"] = mkEdge("sink", ["observe", "out"], ["sink", "input"]);
    } else if ((firstOutput.type as { space?: string }).space === "data") {
      // T768/§V57c: a DATA output (uv, render.depth) refuses to wire into the sink's
      // colour input — §V13 working as designed. A user observes a data field through a
      // data consumer, so the harness does too: subject drives a Displace's field over a
      // checker, and the displaced picture is what reaches the sink.
      nodes["obssrc"] = mk("obssrc", "checker");
      nodes["observe"] = mk("observe", "displace");
      edges["observe-src"] = mkEdge("observe-src", ["obssrc", "out"], ["observe", "source"]);
      edges["observe-in"] = mkEdge("observe-in", ["subject", firstOutput.id], ["observe", "disp"]);
      edges["sink"] = mkEdge("sink", ["observe", "out"], ["sink", "input"]);
    } else {
      edges["sink"] = mkEdge("sink", ["subject", firstOutput.id], ["sink", "input"]);
    }
  }
  return { revision: 1, nodes, edges, groups: {} };
}

/**
 * T1076: an edge-payload fixture — attributes as REGIONS of one packed buffer, laid out by
 * the same `packAttributes` a producer allocates with.
 *
 * Written once here rather than spelled out per test: a fixture with a hand-typed offset
 * is a second layout answer, and the thing most likely to be quietly wrong is exactly an
 * offset. `half` defaults to "write" (an ordinary producer's this-frame half, §V168) and
 * is overridable per attribute for the compacted case (§V231).
 */
export function fixturePairs(
  nodeId: string,
  attributes: ReadonlyArray<{
    readonly name: string;
    readonly type: PointAttributeType;
    readonly half?: "read" | "write";
  }>,
  capacity: number,
): Record<string, PointsetAttributeRef> {
  const layout = packAttributes(
    attributes.map((attribute) => ({
      name: attribute.name,
      type: attribute.type,
      default: Array<number>(COMPONENT_COUNTS[attribute.type]).fill(0),
    })),
    capacity,
  );
  if (!layout.ok) throw new Error(layout.errors.join("; "));
  const pairs: Record<string, PointsetAttributeRef> = {};
  for (const attribute of attributes) {
    const region = layout.byName.get(attribute.name);
    if (region === undefined) throw new Error(`no packed region for "${attribute.name}"`);
    pairs[attribute.name] = {
      buffer: pointStorageId(nodeId),
      half: attribute.half ?? "write",
      offset: region.offset,
      bytes: region.bytes,
      type: attribute.type,
    };
  }
  return pairs;
}

/**
 * T1076: one attribute's REGION inside a node's packed point buffer, for a readback.
 *
 * `readBuffer` hands back the whole buffer (it has no range yet, T173), so a test that
 * wants one attribute slices it here — off the same `packAttributes` the producer
 * allocated with, never a hand-typed offset.
 */
export function pointRegionSlice(
  raw: ArrayBuffer,
  attributes: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }>,
  capacity: number,
  attribute: string,
): { readonly floats: Float32Array; readonly words: Uint32Array } {
  const layout = packAttributes(
    attributes.map((entry) => ({
      name: entry.name,
      type: entry.type,
      default: Array<number>(COMPONENT_COUNTS[entry.type]).fill(0),
    })),
    capacity,
  );
  if (!layout.ok) throw new Error(layout.errors.join("; "));
  const region = layout.byName.get(attribute);
  if (region === undefined) throw new Error(`no packed region for "${attribute}"`);
  return {
    floats: new Float32Array(raw, region.offset, region.bytes / 4),
    words: new Uint32Array(raw, region.offset, region.bytes / 4),
  };
}

/**
 * T1076: read ONE attribute out of a node's packed point buffer, through the backend's
 * own readback path.
 *
 * The convenience that replaces `readBuffer(scratch:<node>:<attribute>)`. That id named a
 * per-attribute buffer, which packing retired — the buffer is the node's, the attribute is
 * a region of it, and the offset comes from the same layout the producer allocated with.
 */
export async function readPointAttribute(
  readBuffer: (resourceId: string) => Promise<ArrayBuffer>,
  nodeId: string,
  attributes: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }>,
  capacity: number,
  attribute: string,
): Promise<{ readonly floats: Float32Array; readonly words: Uint32Array }> {
  return pointRegionSlice(await readBuffer(pointStorageId(nodeId)), attributes, capacity, attribute);
}

/**
 * T1076: read one attribute of a point KERNEL node, with the packed layout resolved from
 * the node's own parameters — the schema it declares, plus the injected lifecycle word for
 * the advanced kernel, at the capacity it asked for.
 *
 * The test-side twin of what the producer does at compile: the region has to come off the
 * same arithmetic, or a readback silently lands on a neighbouring attribute.
 */
export async function readKernelAttribute(
  readBuffer: (resourceId: string) => Promise<ArrayBuffer>,
  node: { readonly type: string; readonly parameters: Readonly<Record<string, unknown>> },
  nodeId: string,
  attribute: string,
): Promise<{ readonly floats: Float32Array; readonly words: Uint32Array }> {
  return kernelRegionSlice(node, await readBuffer(pointStorageId(nodeId)), attribute);
}

/**
 * The synchronous half of `readKernelAttribute`, for a buffer already in hand — the render
 * harness's `probeBuffers` hands back raw ArrayBuffers, and packing turned N per-attribute
 * probes into ONE probe of the node's buffer plus N slices.
 */
export function kernelRegionSlice(
  node: { readonly type: string; readonly parameters: Readonly<Record<string, unknown>> },
  raw: ArrayBuffer,
  attribute: string,
): { readonly floats: Float32Array; readonly words: Uint32Array } {
  const { attributes, error } = parseAttributes(node.parameters["attributes"]);
  if (attributes === undefined) throw new Error(String(error));
  const declared = node.parameters["capacity"];
  const capacity =
    typeof declared === "number" && Number.isFinite(declared) ? Math.max(1, Math.round(declared)) : 4096;
  const schema =
    node.type === "pointKernelAdvanced"
      ? [...attributes, { name: "flags", type: "u32" as const, default: [1] }]
      : attributes;
  return pointRegionSlice(raw, schema, capacity, attribute);
}

/**
 * T1076: the REGION a named pass binding covers, read off the plan itself.
 *
 * The exact answer wherever the producer's pass names its attributes (`out_tint`,
 * `out_position`, …): no schema, no capacity, no second copy of the layout arithmetic —
 * the plan already says which buffer, at what offset, for how many bytes. Generated point
 * KERNELS bind whole packed buffers under opaque group names, so those need
 * `kernelRegionSlice` instead.
 */
export function planRegion(
  passes: ReadonlyArray<unknown>,
  nodeId: string,
  binding: string,
): { readonly resourceId: string; readonly offset: number; readonly bytes: number } {
  for (const pass of passes) {
    const entry = pass as {
      nodeId?: string;
      buffers?: ReadonlyArray<{ binding: string; resourceId: string; offset?: number; bytes?: number }>;
    };
    if (entry.nodeId !== nodeId) continue;
    const found = entry.buffers?.find((candidate) => candidate.binding === binding);
    if (found === undefined || found.offset === undefined || found.bytes === undefined) continue;
    return { resourceId: found.resourceId, offset: found.offset, bytes: found.bytes };
  }
  throw new Error(`no region binding "${binding}" on node "${nodeId}" in this plan`);
}
