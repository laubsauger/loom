import type { PortId } from "../../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { PortDefinition } from "../../domain/types/ports.ts";
import type { NodeDefinition, StatefulDeclaration } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { validateParameterValue } from "../../domain/parameters/validate.ts";

/**
 * Node registry (§I.registry, T12) and manifest validation (§V46, T66).
 *
 * The registry is the catalogue the compiler, the command bus and the library pane all
 * read from. It is headless by construction — a `NodeDefinition` may never import React
 * or @xyflow (§V11), and nothing in this file does.
 */

export type PortDirection = "input" | "output";

/** A node is stateful when it carries data across frames — that is what §V46 governs. */
export function isStatefulNode(definition: NodeDefinition): boolean {
  return definition.temporal !== undefined || definition.stateful !== undefined;
}

/**
 * §V46: a stateful node must declare how it behaves under reset, replay, checkpoint and
 * random access. Without the declaration, an offline render or a seek cannot know
 * whether the node can be reproduced, so we refuse the manifest rather than guess.
 */
export function validateNodeDefinition(definition: NodeDefinition): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const err = (code: string, message: string, suggestion?: string): void => {
    diagnostics.push({
      severity: "error",
      code,
      message,
      ...(suggestion === undefined ? {} : { suggestion }),
    });
  };

  if (definition.type.trim() === "") err("node.type", "Node definition has an empty type.");
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    err("node.version", `Node "${definition.type}" needs an integer version >= 1.`);
  }

  const seen = new Set<PortId>();
  for (const port of [...definition.inputs, ...definition.outputs]) {
    if (port.id.trim() === "") err("node.port", `Node "${definition.type}" has a port with an empty id.`);
    if (seen.has(port.id)) {
      err("node.port.duplicate", `Node "${definition.type}" declares port "${port.id}" more than once.`);
    }
    seen.add(port.id);
  }

  for (const [key, parameter] of Object.entries(definition.parameters)) {
    // Neither declares a default and neither can: an unset asset is genuinely absent,
    // and a pulse has no value at all — it fires (§V124).
    if (parameter.type === "asset") continue;
    if (parameter.type === "pulse") {
      if (parameter.fires.trim() === "") {
        err(
          "node.parameter.pulse",
          `Pulse "${key}" on "${definition.type}" names no command to fire (§V123).`,
        );
      }
      continue;
    }
    const value = "default" in parameter ? parameter.default : undefined;
    if (value === undefined) {
      err("node.parameter.default", `Parameter "${key}" on "${definition.type}" has no default.`);
      continue;
    }
    const diagnostic = validateParameterValue(key, parameter, value as ParameterValue);
    if (diagnostic !== null) {
      err(
        "node.parameter.default",
        `Default for parameter "${key}" on "${definition.type}" is invalid: ${diagnostic.message}`,
      );
    }
  }

  if (definition.temporal !== undefined) {
    const outputIds = new Set(definition.outputs.map((port) => port.id));
    for (const portId of definition.temporal.outputs) {
      if (!outputIds.has(portId)) {
        err(
          "node.temporal.port",
          `Node "${definition.type}" marks "${portId}" temporal but has no such output port.`,
        );
      }
    }
  }

  if (isStatefulNode(definition) && definition.stateful === undefined) {
    err(
      "node.stateful.undeclared",
      `Stateful node "${definition.type}" must declare {reset, deterministicReplay, checkpoint, randomAccess}.`,
      "Add a `stateful` block to the manifest (§V46).",
    );
  }

  const stateful = definition.stateful;
  if (stateful !== undefined && stateful.randomAccess && !stateful.deterministicReplay) {
    err(
      "node.stateful.inconsistent",
      `Node "${definition.type}" claims randomAccess without deterministicReplay; a frame cannot be jumped to if replaying it is not reproducible.`,
    );
  }

  return diagnostics;
}

export class NodeDefinitionError extends Error {
  readonly diagnostics: RuntimeDiagnostic[];

  constructor(message: string, diagnostics: RuntimeDiagnostic[]) {
    super(message);
    this.name = "NodeDefinitionError";
    this.diagnostics = diagnostics;
  }
}

/** Read-only face of the registry, which is all the bus and compiler need. */
export interface NodeRegistryView {
  has(type: string): boolean;
  get(type: string): NodeDefinition | undefined;
  /** Throws `NodeDefinitionError` when the type is unknown. */
  require(type: string): NodeDefinition;
  list(): readonly NodeDefinition[];
  categories(): readonly string[];
  port(type: string, portId: PortId, direction: PortDirection): PortDefinition | undefined;
  /** §V46 declaration, or undefined for a stateless node. */
  statefulDeclaration(type: string): StatefulDeclaration | undefined;
}

export interface NodeRegistry extends NodeRegistryView {
  register(definition: NodeDefinition): void;
  registerAll(definitions: Iterable<NodeDefinition>): void;
  /** Read-only projection to hand to consumers that must not mutate the catalogue. */
  view(): NodeRegistryView;
}

export function createNodeRegistry(definitions: Iterable<NodeDefinition> = []): NodeRegistry {
  const byType = new Map<string, NodeDefinition>();

  const registry: NodeRegistry = {
    register(definition: NodeDefinition): void {
      const diagnostics = validateNodeDefinition(definition);
      if (diagnostics.length > 0) {
        throw new NodeDefinitionError(
          `Invalid node definition "${definition.type}": ${diagnostics.map((d) => d.message).join(" ")}`,
          diagnostics,
        );
      }
      const existing = byType.get(definition.type);
      if (existing !== undefined) {
        throw new NodeDefinitionError(
          `Node type "${definition.type}" is already registered (version ${existing.version}).`,
          [
            {
              severity: "error",
              code: "node.type.duplicate",
              message: `Duplicate node type "${definition.type}".`,
            },
          ],
        );
      }
      byType.set(definition.type, definition);
    },
    registerAll(items: Iterable<NodeDefinition>): void {
      for (const item of items) registry.register(item);
    },
    has(type: string): boolean {
      return byType.has(type);
    },
    get(type: string): NodeDefinition | undefined {
      return byType.get(type);
    },
    require(type: string): NodeDefinition {
      const definition = byType.get(type);
      if (definition === undefined) {
        throw new NodeDefinitionError(`Unknown node type "${type}".`, [
          {
            severity: "error",
            code: "node.unknownType",
            message: `Unknown node type "${type}".`,
          },
        ]);
      }
      return definition;
    },
    list(): readonly NodeDefinition[] {
      // Sorted so the library pane and every agent listing are deterministic.
      return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
    },
    categories(): readonly string[] {
      return [...new Set(registry.list().map((definition) => definition.category))].sort();
    },
    port(type: string, portId: PortId, direction: PortDirection): PortDefinition | undefined {
      const definition = byType.get(type);
      if (definition === undefined) return undefined;
      const ports = direction === "input" ? definition.inputs : definition.outputs;
      return ports.find((port) => port.id === portId);
    },
    statefulDeclaration(type: string): StatefulDeclaration | undefined {
      return byType.get(type)?.stateful;
    },
    view(): NodeRegistryView {
      return {
        has: registry.has,
        get: registry.get,
        require: registry.require,
        list: registry.list,
        categories: registry.categories,
        port: registry.port,
        statefulDeclaration: registry.statefulDeclaration,
      };
    },
  };

  registry.registerAll(definitions);
  return registry;
}
