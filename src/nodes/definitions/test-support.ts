import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { PortId } from "../../domain/types/ids.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import type { PlanReadResult } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";

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
        pairs: Readonly<Record<string, { pair: string; half: "read" | "write"; type?: string }>>;
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
        pairs: Readonly<Record<string, { pair: string; half: "read" | "write"; type?: string }>>;
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
