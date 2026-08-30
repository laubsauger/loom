import type { ColorPolicy } from "../../domain/types/graph.ts";
import { DEFAULT_COLOR_POLICY } from "../../domain/types/graph.ts";
import type { NodeCompileContext, TextureFormat } from "../../domain/types/node-definition.ts";
import type { ColorSpace } from "../../domain/types/ports.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { PortId } from "../../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";

/**
 * The compile-time boundary between a node definition and the compiler.
 *
 * Track E has landed, so this file now ADAPTS the compiler's real `CompilerNodeContext`
 * into the flat shape the node definitions read. That was the point of routing every
 * `compile()` through {@link readCompileInputs}: reconciling the two shapes touched this
 * one function instead of every node.
 *
 * Two deltas from the original assumption, both deliberate on the compiler's side:
 *  - an input port carries an ARRAY of bindings, because a variadic port has more than
 *    one (§V14). `inputs` is the FIRST of them, which is what every single-arity node
 *    wants; `inputEdges` is the whole list, in the order the document declares (§V131),
 *    which is what a variadic node folds. Two views of one array rather than two arrays:
 *    a node that reads `inputs` on a variadic port gets the first layer, not a surprise.
 *  - an output carries a full binding (size, format, colour space), not a bare id.
 *
 * `NodeCompileContext` stays opaque in the frozen contract, so exactly one cast happens —
 * here — rather than one per node.
 */
export interface NodeCompileInputs {
  readonly nodeId: string;
  /** Resource id the compiler assigned to each of this node's OUTPUT ports. */
  readonly outputs: Readonly<Record<PortId, string>>;
  /** Resource + sampler id the compiler assigned to each connected INPUT port. */
  readonly inputs: Readonly<
    Record<
      PortId,
      {
        readonly resource: string;
        readonly sampler: string;
        /**
         * Producing node/port, when the compiler supplies it (T122). Pointset consumers
         * derive per-attribute buffer ids from the producer's node id — a pointset edge
         * carries a FAMILY of buffers, not one resource.
         */
        readonly source?: { readonly nodeId: string; readonly portId: PortId };
        /**
         * T296: the pointset edge payload — resolved attribute→pair map, capacity,
         * topology. Consumers bind THESE pair ids (which another node may own, §V197)
         * instead of deriving ids from a naming convention.
         */
        readonly pointset?: {
          /** §V231/T322: each pair names the HALF holding this frame's data. */
          readonly pairs: Readonly<Record<string, { readonly pair: string; readonly half: "read" | "write"; readonly type?: string }>>;
          readonly capacity: number;
          readonly topology?: string;
          /** T322: GPU-resident live count, when the producer kills points. */
          readonly count?: { readonly buffer: string };
        };
        /**
         * T447/T457: the scene payload on a reference-fed edge (camera, light,
         * geometry, material) — a CPU value, no GPU resource behind it.
         */
        readonly scene?: unknown;
      }
    >
  >;
  /**
   * EVERY binding on each connected input port, in the document's declared order (T225,
   * §V131). One entry per incoming edge, so a variadic port folds them in the order the
   * user arranged — for Over, that order IS the operation. Single-arity ports have exactly
   * one entry here, identical to `inputs`.
   */
  readonly inputEdges: Readonly<Record<PortId, ReadonlyArray<NodeCompileInputs["inputs"][PortId]>>>;
  /** This node's current parameter values, already validated against its own schema. */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /**
   * T286 (§V287): parameters whose active mode is `map`. The value in `parameters` is
   * the retained static; a point consumer compiles its shader interface from this.
   */
  readonly parameterMaps: Readonly<Record<string, { attribute: string; channel?: string; port?: string }>>;
  /** Resource id this node's passes render into. Undefined when nothing is materialized. */
  readonly target?: string;
  /**
   * Size this node's outputs resolved to, in pixels (§V21, §V50).
   *
   * Resolved at COMPILE time, never per frame, which is why it is safe for a node to fold
   * it into a uniform value: aspect correction, a blur radius in pixels and a per-texel
   * step all need it, and the shared frame block's `resolution` is the presentation
   * surface's, not this pass's target's. Falls back to 1x1 rather than 0x0 so a
   * `1.0 / resolution` in a shader can never divide by zero.
   */
  readonly resolution: readonly [number, number];
  /** Pixel format this node's outputs resolved to (§V21, §V51). */
  readonly format: TextureFormat;
  /** Colour space those outputs derive, before this node says anything (§V57). */
  readonly space: ColorSpace;
  /**
   * The project's colour commitments (T84, T375, §V56). Only the Output node acts on it —
   * §V56 puts the display transform at the sink and nowhere else — but it is read HERE so
   * there is one adapter, and so the next display node does not invent a second route.
   */
  readonly colorPolicy: ColorPolicy;
}

/** The compiler-side shape this adapter reads. Kept local so src/nodes stays headless. */
interface CompilerContextShape {
  readonly nodeId: string;
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  readonly parameterMaps?: Readonly<Record<string, { attribute: string; channel?: string; port?: string }>>;
  readonly target?: string | undefined;
  readonly sampler?: string;
  readonly resolution?: readonly [number, number];
  readonly inputs?: Readonly<
    Record<
      PortId,
      ReadonlyArray<{
        resourceId: string;
        sampler: string;
        sourceNodeId?: string;
        sourcePortId?: string;
        pointset?: { pairs: Readonly<Record<string, { pair: string; half: "read" | "write"; type?: string }>>; capacity: number; topology?: string; count?: { buffer: string } };
        scene?: unknown;
      }>
    >
  >;
  readonly outputs?: Readonly<Record<PortId, { resourceId: string }>>;
  readonly format?: TextureFormat;
  readonly space?: ColorSpace;
  readonly colorPolicy?: ColorPolicy;
}

export function readCompileInputs(context: NodeCompileContext): NodeCompileInputs {
  const raw = context as unknown as CompilerContextShape;

  const outputs: Record<PortId, string> = {};
  for (const [portId, binding] of Object.entries(raw.outputs ?? {})) {
    outputs[portId] = binding.resourceId;
  }

  const inputs: Record<PortId, NodeCompileInputs["inputs"][PortId]> = {};
  const inputEdges: Record<PortId, ReadonlyArray<NodeCompileInputs["inputs"][PortId]>> = {};
  for (const [portId, bindings] of Object.entries(raw.inputs ?? {})) {
    const adapted = bindings.map((binding) => ({
      resource: binding.resourceId,
      sampler: binding.sampler ?? raw.sampler ?? "",
      ...(binding.sourceNodeId === undefined
        ? {}
        : { source: { nodeId: binding.sourceNodeId, portId: binding.sourcePortId ?? "out" } }),
      ...(binding.pointset === undefined ? {} : { pointset: binding.pointset }),
      ...(binding.scene === undefined ? {} : { scene: binding.scene }),
    }));
    const first = adapted[0];
    // An unconnected optional port simply has no binding; compile() reports that itself
    // through missingCompileResource rather than the adapter inventing an empty id.
    if (first === undefined) continue;
    inputs[portId] = first;
    inputEdges[portId] = adapted;
  }

  const size = raw.resolution;
  const resolution: readonly [number, number] =
    size !== undefined && size[0] > 0 && size[1] > 0 ? [size[0], size[1]] : [1, 1];

  return {
    nodeId: raw.nodeId,
    outputs,
    inputs,
    inputEdges,
    parameters: raw.parameters,
    parameterMaps: raw.parameterMaps ?? {},
    resolution,
    format: raw.format ?? "rgba8unorm",
    space: raw.space ?? "linear",
    colorPolicy: raw.colorPolicy ?? DEFAULT_COLOR_POLICY,
    ...(raw.target === undefined ? {} : { target: raw.target }),
  };
}

/**
 * Reported instead of emitting an unusable pass when the compiler has not (yet) assigned
 * a resource this node's `compile()` needs — see module doc. Matches `plan.ts`'s own
 * preference for a structured diagnostic over throwing on malformed input.
 */
export function missingCompileResource(nodeId: string, what: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code: "node.compile.missingResource",
    message: `Node "${nodeId}" was compiled without a resource for ${what}.`,
    nodeId,
    suggestion: "The compiler must assign every connected port a resource id before calling compile().",
  };
}
