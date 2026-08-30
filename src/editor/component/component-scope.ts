import type { ComponentPath, ParentScope } from "@domain/types/components.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { parentScopeDrivers } from "@domain/components/parent-scope.ts";
import type { ParentScopeDriver } from "@domain/components/parent-scope.ts";
import { resolveComponentPath } from "@domain/components/navigation.ts";
import type { ResolvedComponentPath } from "@domain/components/navigation.ts";
import type { ComponentRegistryView } from "@domain/components/registry.ts";
import { storedValues } from "@domain/parameters/stored-values.ts";
import { resolveParameters } from "@editor/inspector/parameter-resolver.ts";
import type { ParameterDriver, ResolvedParameters } from "@editor/inspector/parameter-resolver.ts";

/**
 * Parent scope, wired into THE parameter read path (T133, §V81, §V61).
 *
 * `resolveParameters` is the only code allowed to turn a stored value into an effective
 * one, and it already declares a driver seam for "expression, curve, audio, MIDI, LINK".
 * `parent.<key>` is a link, so it arrives as drivers and there is no second read path —
 * which is the whole reason the seam was built before anything needed it.
 *
 * Everything scope-related that can be computed without React lives in
 * `src/domain/components/**`. This module is the thin join between it and the resolver.
 */

/**
 * Compile-time proof that the headless driver type and the resolver's are the same
 * shape. `src/domain/**` may not import the editor, so `ParentScopeDriver` is declared
 * separately; this alias is what turns a future divergence into a build error instead of
 * a driver that is quietly never called.
 */
export type AssertDriverShape = ParentScopeDriver extends ParameterDriver
  ? ParameterDriver extends ParentScopeDriver
    ? true
    : never
  : never;
const _driverShapesMatch: AssertDriverShape = true;
void _driverShapesMatch;

export interface ResolveInComponentOptions {
  frame?: FrameEvaluationInput | undefined;
  /** Extra drivers (keyframes, audio...). Parent bindings win on a shared key. */
  drivers?: Readonly<Record<string, ParameterDriver>> | undefined;
}

export interface ComponentResolvedParameters {
  resolved: ResolvedParameters;
  /** Bindings that did not resolve, reported rather than silently ignored (§V81). */
  diagnostics: readonly RuntimeDiagnostic[];
}

/**
 * Effective parameters of a node that lives inside a component.
 *
 * `scope` is the lexical chain from `resolveComponentPath`; `undefined` means the root
 * graph, where a `parent.<key>` binding is itself the error and is reported as one.
 */
export function resolveComponentParameters(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  scope: ParentScope | undefined,
  options: ResolveInComponentOptions = {},
): ComponentResolvedParameters {
  const diagnostics: RuntimeDiagnostic[] = [];
  const drivers: Record<string, ParameterDriver> = {
    ...(options.drivers ?? {}),
    ...parentScopeDrivers(node, scope, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
  };
  const resolved = resolveParameters(node, definition, {
    drivers,
    ...(options.frame === undefined ? {} : { frame: options.frame }),
  });
  return { resolved, diagnostics };
}

/**
 * Effective PUBLISHED values of a component instance — the values its children see as
 * `parent.<key>`. Goes through the resolver like every other read (§V61).
 *
 * In STORED space: `ResolvedParameter.value`, never `ResolvedParameters.values` (T187,
 * §V56, B8).
 *
 * A scope entry is not an evaluation result. It is an intermediate that the CHILD's own
 * `resolveParameters` re-reads — the driver feeds it in, and the child's `values` applies
 * the display→linear decode on the way out. `values` here is already decoded, so
 * publishing it decodes twice: a picked mid-grey (0.5) leaves the instance at 0.214 and
 * reaches the shader as 0.0376, less than a fifth of the light the user asked for.
 *
 * B8's lesson is why this had to be a test and not an eyeball: a colour that is merely
 * too dark reads as an art-direction choice, so nobody files it. The compile path makes
 * the same call for the same reason, which is why the projection itself now lives in
 * `src/domain/parameters/stored-values.ts` and not in two places (T307).
 */
export function resolveInstanceValues(
  node: GraphNode,
  definition: NodeDefinition,
): Readonly<Record<string, ParameterValue>> {
  return storedValues(resolveParameters(node, definition));
}

export interface ComponentNavigationInput {
  root: GraphDocument;
  path: ComponentPath;
  components: ComponentRegistryView;
  nodes: NodeRegistryView;
}

/**
 * `resolveComponentPath` with the §V61 resolver already supplied — what the editor calls.
 */
export function resolveComponentNavigation(
  input: ComponentNavigationInput,
): ResolvedComponentPath {
  return resolveComponentPath({ ...input, resolveValues: resolveInstanceValues });
}
