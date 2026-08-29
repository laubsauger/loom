import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { PortId } from "../../domain/types/ids.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";

/**
 * The compile-time boundary between a node definition and the compiler (track E, §P
 * wave 2 — not landed as of T15).
 *
 * `NodeCompileContext` (`src/domain/types/node-definition.ts`) is a frozen opaque index
 * signature — wave 0 deliberately left its real shape to whichever track assembles the
 * execution plan, so a node definition cannot see it yet. This is track I's ASSUMPTION
 * about the minimum the compiler will need to hand a node's `compile()`: the resource id
 * it assigned to each of this node's ports, this node's own already-validated parameter
 * values, and — only for a sink, which has no output port to carry a resource id — the
 * id of the render target it writes into.
 *
 * If track E lands a different shape, only this file needs to change to match it: every
 * `compile()` under `src/nodes/definitions/**` reads the context exclusively through
 * {@link readCompileInputs}, never by indexing `NodeCompileContext` directly.
 */
export interface NodeCompileInputs {
  readonly nodeId: string;
  /** Resource id the compiler assigned to each of this node's OUTPUT ports. */
  readonly outputs: Readonly<Record<PortId, string>>;
  /** Resource + sampler id the compiler assigned to each connected INPUT port. */
  readonly inputs: Readonly<Record<PortId, { readonly resource: string; readonly sampler: string }>>;
  /** This node's current parameter values, already validated against its own schema. */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /** Resource id of the final render target. Only meaningful for a sink (§V25, no outputs). */
  readonly target?: string;
  /** Present only when a node needs a raw frame value outside the shared uniform block. */
  readonly frame?: FrameEvaluationInput;
}

export function readCompileInputs(context: NodeCompileContext): NodeCompileInputs {
  return context as unknown as NodeCompileInputs;
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
