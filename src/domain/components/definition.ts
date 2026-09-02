import type { GraphComponentDefinition, ExposedPort, PublishedParameter } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterDefinition } from "../types/parameters.ts";
import type { PortDefinition } from "../types/ports.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { effectiveParameterSchema } from "../parameters/resolve.ts";
import { componentNodeType, isValidComponentId } from "./component-type.ts";

/**
 * A component definition seen as a node manifest (§V79).
 *
 * The rest of the editor already knows how to draw, wire, validate and inspect anything
 * that has a `NodeDefinition`. A component gets one synthesized from its exposed ports
 * and its published parameter page, so an instance is an ordinary node everywhere
 * except where it is deliberately not: entering it, upgrading it, detaching it.
 *
 * The synthesized manifest is derived, never stored. Re-authoring a definition therefore
 * changes what every linked instance resolves against on the very next lookup, with
 * nothing to re-register and nothing to invalidate — which is most of §V79 for free.
 */

/** Category the library pane files components under. */
export const COMPONENT_CATEGORY = "component";

function error(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "error", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

function warning(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "warning", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

/** The internal port an `ExposedPort` maps to, resolved through the node registry. */
export function internalPortOf(
  graph: GraphDocument,
  exposed: ExposedPort,
  direction: "input" | "output",
  nodes: NodeRegistryView,
): PortDefinition | undefined {
  const node = graph.nodes[exposed.nodeId];
  if (node === undefined) return undefined;
  return nodes.port(node.type, exposed.portId, direction);
}

/** The internal parameter a published target points at. */
export function internalParameterOf(
  graph: GraphDocument,
  target: { nodeId: string; key: string },
  nodes: NodeRegistryView,
): ParameterDefinition | undefined {
  const node = graph.nodes[target.nodeId];
  if (node === undefined) return undefined;
  // T903: through the funnel — publishing a REFLECTED knob (a customWgsl's `orbitSpeed`) is
  // exactly what §T880 built E46-as-a-component for, and a static read would make every one
  // of those targets unresolvable, so the published parameter would be dropped as invalid.
  return effectiveParameterSchema(nodes.get(node.type), node.parameters)[target.key];
}

function exposedPortDefinitions(
  definition: GraphComponentDefinition,
  exposed: readonly ExposedPort[],
  direction: "input" | "output",
  nodes: NodeRegistryView,
): PortDefinition[] {
  const ports: PortDefinition[] = [];
  for (const port of exposed) {
    const internal = internalPortOf(definition.graph, port, direction, nodes);
    // An exposed port whose internal port cannot be resolved is dropped rather than
    // guessed: a port with an invented type would let §V13 pass a connection the
    // compiler must then refuse. `validateComponentDefinition` reports it.
    if (internal === undefined) continue;
    ports.push({ id: port.externalId, label: port.label, type: internal.type });
  }
  return ports;
}

/**
 * The synthesized manifest for one component version.
 *
 * `compile` returns no passes on purpose: a component does not compile as a node, it is
 * FLATTENED into the parent logical graph before node compilation happens (§V82). The
 * diagnostic is what a compiler that forgot to flatten will see, instead of an instance
 * that silently renders nothing.
 */
export function componentNodeDefinition(
  definition: GraphComponentDefinition,
  nodes: NodeRegistryView,
): NodeDefinition {
  const parameters: Record<string, ParameterDefinition> = {};
  for (const published of definition.parameters) {
    parameters[published.key] = published.definition;
  }

  return {
    type: componentNodeType(definition.componentId, definition.version),
    version: definition.version,
    title: definition.name,
    category: COMPONENT_CATEGORY,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    inputs: exposedPortDefinitions(definition, definition.inputs, "input", nodes),
    outputs: exposedPortDefinitions(definition, definition.outputs, "output", nodes),
    parameters,
    ...(definition.capabilities === undefined ? {} : { capabilities: definition.capabilities }),
    compile: () => ({
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "component.notFlattened",
          message: `Component "${definition.name}" reached node compilation without being flattened.`,
          suggestion: "Flatten component instances into the parent logical graph first (§V82).",
        },
      ],
    }),
  };
}

/**
 * Drops exposures and published targets whose internal node or port no longer exists.
 *
 * Deleting an internal node that happened to be exposed must not make the whole component
 * un-saveable — the user deleted a node, they did not ask to break their file. The
 * exposure goes with it, and `validateComponentDefinition` then has nothing to complain
 * about. A published parameter that loses its last target is unpublished: a knob wired to
 * nothing is worse than no knob.
 */
export function pruneComponentDefinition(
  definition: GraphComponentDefinition,
  nodes: NodeRegistryView,
): GraphComponentDefinition {
  const keepPort = (direction: "input" | "output") => (port: ExposedPort) =>
    internalPortOf(definition.graph, port, direction, nodes) !== undefined;

  const parameters: PublishedParameter[] = [];
  for (const published of definition.parameters) {
    const targets = published.targets.filter(
      (target) => internalParameterOf(definition.graph, target, nodes) !== undefined,
    );
    if (targets.length > 0) parameters.push({ ...published, targets });
  }

  return {
    ...definition,
    inputs: definition.inputs.filter(keepPort("input")),
    outputs: definition.outputs.filter(keepPort("output")),
    parameters,
  };
}

function checkPublishedParameter(
  definition: GraphComponentDefinition,
  published: PublishedParameter,
  nodes: NodeRegistryView,
  diagnostics: RuntimeDiagnostic[],
): void {
  if (published.key.trim() === "") {
    diagnostics.push(error("component.parameter.key", "A published parameter has an empty key."));
  }
  if (published.targets.length === 0) {
    // A warning, not an error: a published parameter with no targets is still useful as
    // pure lexical scope, read by descendants as `parent.<key>` (§V81). Refusing it would
    // make the two halves of the component model contradict each other.
    diagnostics.push(
      warning(
        "component.parameter.noTargets",
        `Published parameter "${published.key}" drives no internal parameter directly.`,
        "That is fine if descendants read it as parent." + published.key + " (§V81); otherwise it does nothing.",
      ),
    );
  }
  for (const target of published.targets) {
    const internal = internalParameterOf(definition.graph, target, nodes);
    if (internal === undefined) {
      diagnostics.push(
        error(
          "component.parameter.missingTarget",
          `Published parameter "${published.key}" targets "${target.nodeId}.${target.key}", which does not exist inside "${definition.name}".`,
        ),
      );
      continue;
    }
    // The published definition is RE-AUTHORED, not copied — a different label, unit or
    // range is the point. A different TYPE is not: the value has to be writable to every
    // target, and `validateParameters` would reject it at the moment of the edit.
    if (internal.type !== published.definition.type) {
      diagnostics.push(
        error(
          "component.parameter.typeMismatch",
          `Published parameter "${published.key}" is a ${published.definition.type}, but "${target.nodeId}.${target.key}" is a ${internal.type}.`,
          "Re-author the label, range and unit freely; the type has to match every target.",
        ),
      );
      continue;
    }
    if (published.definition.type === "number" && internal.type === "number") {
      const below = internal.min !== undefined && (published.definition.min ?? -Infinity) < internal.min;
      const above = internal.max !== undefined && (published.definition.max ?? Infinity) > internal.max;
      if (below || above) {
        diagnostics.push(
          warning(
            "component.parameter.rangeWiderThanTarget",
            `Published range for "${published.key}" reaches outside the range of "${target.nodeId}.${target.key}".`,
            "Values outside the internal range will be refused when the knob is turned.",
          ),
        );
      }
    }
  }
}

/**
 * Everything that must hold before a definition is registered — and therefore before it
 * can be saved or loaded. Recursion is checked separately, by `detectComponentRecursion`,
 * because it needs the whole catalogue and not just this one definition (§V83).
 */
export function validateComponentDefinition(
  definition: GraphComponentDefinition,
  nodes: NodeRegistryView,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];

  if (!isValidComponentId(definition.componentId)) {
    diagnostics.push(
      error(
        "component.id",
        `"${definition.componentId}" is not a usable component id.`,
        'A component id must be non-empty, untrimmed-free, and may not contain "@" — the version separator in the node type.',
      ),
    );
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    diagnostics.push(
      error("component.version", `Component "${definition.name}" needs an integer version >= 1.`),
    );
  }
  if (definition.name.trim() === "") {
    diagnostics.push(error("component.name", `Component "${definition.componentId}" has no name.`));
  }

  const externalIds = new Set<string>();
  for (const [direction, ports] of [
    ["input", definition.inputs],
    ["output", definition.outputs],
  ] as const) {
    for (const port of ports) {
      if (externalIds.has(port.externalId)) {
        diagnostics.push(
          error(
            "component.port.duplicate",
            `Component "${definition.name}" exposes "${port.externalId}" more than once.`,
          ),
        );
      }
      externalIds.add(port.externalId);
      if (definition.graph.nodes[port.nodeId] === undefined) {
        diagnostics.push(
          error(
            "component.port.missingNode",
            `Exposed port "${port.externalId}" maps to internal node "${port.nodeId}", which is not in the component.`,
          ),
        );
        continue;
      }
      if (internalPortOf(definition.graph, port, direction, nodes) === undefined) {
        diagnostics.push(
          error(
            "component.port.missingPort",
            `Exposed port "${port.externalId}" maps to "${port.nodeId}.${port.portId}", which is not an ${direction} port.`,
          ),
        );
      }
    }
  }

  const keys = new Set<string>();
  for (const published of definition.parameters) {
    if (keys.has(published.key)) {
      diagnostics.push(
        error(
          "component.parameter.duplicate",
          `Component "${definition.name}" publishes "${published.key}" more than once.`,
        ),
      );
    }
    keys.add(published.key);
    checkPublishedParameter(definition, published, nodes, diagnostics);
  }

  return diagnostics;
}
