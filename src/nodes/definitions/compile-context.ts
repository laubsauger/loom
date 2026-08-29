import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
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
 *    one (§V14). Nodes here are all single-arity, so the adapter takes the first.
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
  readonly inputs: Readonly<Record<PortId, { readonly resource: string; readonly sampler: string }>>;
  /** This node's current parameter values, already validated against its own schema. */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /** Resource id this node's passes render into. Undefined when nothing is materialized. */
  readonly target?: string;
}

/** The compiler-side shape this adapter reads. Kept local so src/nodes stays headless. */
interface CompilerContextShape {
  readonly nodeId: string;
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  readonly target?: string | undefined;
  readonly sampler?: string;
  readonly inputs?: Readonly<Record<PortId, ReadonlyArray<{ resourceId: string; sampler: string }>>>;
  readonly outputs?: Readonly<Record<PortId, { resourceId: string }>>;
}

export function readCompileInputs(context: NodeCompileContext): NodeCompileInputs {
  const raw = context as unknown as CompilerContextShape;

  const outputs: Record<PortId, string> = {};
  for (const [portId, binding] of Object.entries(raw.outputs ?? {})) {
    outputs[portId] = binding.resourceId;
  }

  const inputs: Record<PortId, { resource: string; sampler: string }> = {};
  for (const [portId, bindings] of Object.entries(raw.inputs ?? {})) {
    const first = bindings[0];
    // An unconnected optional port simply has no binding; compile() reports that itself
    // through missingCompileResource rather than the adapter inventing an empty id.
    if (first === undefined) continue;
    inputs[portId] = { resource: first.resourceId, sampler: first.sampler ?? raw.sampler ?? "" };
  }

  return {
    nodeId: raw.nodeId,
    outputs,
    inputs,
    parameters: raw.parameters,
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
