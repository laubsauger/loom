import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { PortId } from "../../domain/types/ids.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import type { PlanReadResult } from "../../runtime/backend/plan.ts";

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
  /** Input port ids to give a bound resource. */
  readonly inputs?: ReadonlyArray<PortId>;
  /** Output port ids to materialize. Defaults to `["out"]`. */
  readonly outputs?: ReadonlyArray<PortId>;
  readonly parameters?: Readonly<Record<string, ParameterValue>>;
  readonly resolution?: readonly [number, number];
}

export const TEST_SAMPLER_ID = "sampler:linear";

/** Resource id this fixture assigns to an input port, matching the compiler's shape. */
export function inputResourceId(portId: PortId): string {
  return `resource:${portId}`;
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
  const inputs: Record<string, ReadonlyArray<{ resourceId: string; sampler: string }>> = {};
  for (const portId of options.inputs ?? []) {
    inputs[portId] = [{ resourceId: inputResourceId(portId), sampler: TEST_SAMPLER_ID }];
  }
  const outputs: Record<string, { portId: string; resourceId: string }> = {};
  for (const portId of outputPorts) {
    outputs[portId] = { portId, resourceId: outputResourceId(portId) };
  }
  const firstOutput = outputPorts[0];

  return {
    nodeId: options.nodeId ?? "n1",
    parameters: options.parameters ?? {},
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
      ...(options.inputs ?? []).map((portId) => ({
        kind: "target" as const,
        id: inputResourceId(portId),
        size: options.resolution ?? ([640, 480] as const),
        format: "rgba16float" as const,
      })),
    ],
    diagnostics: [],
  };
  return readExecutionPlan(plan);
}
