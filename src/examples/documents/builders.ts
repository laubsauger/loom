import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  ProjectDocument,
  ProjectSettings,
} from "../../domain/types/graph.ts";
import type { ParameterSlot, ParameterValue } from "../../domain/types/parameters.ts";
import { channelExpression } from "../../domain/parameters/slots.ts";
import { parseComponentNodeType } from "../../domain/components/component-type.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";


/**
 * The six example projects, as documents (§C "example projects", T153-T156).
 *
 * These are NOT the examples. The examples are the `.loom.json` files in `examples/`, and
 * §V88 is explicit that a hand-built in-memory graph cannot stand in for one: an example
 * that only exists as code proves the compiler works and proves nothing at all about the
 * file format. What lives here is the SOURCE the files are generated from, so the shipped
 * bytes are byte-identical to what `buildProjectFile` — the app's own save path — writes,
 * instead of hand-written JSON the app would silently rewrite differently on first save.
 *
 * `build-examples.ts` writes them; `sync.test.ts` fails if a shipped file and its source
 * here have drifted; `runner.test.ts` — the actual CI gate — never imports this module at
 * all. It reads the directory.
 *
 * Every parameter key below is taken from the node's manifest under
 * `src/nodes/definitions/`. A key that does not exist there is a compiler WARNING, not an
 * error, so the runner asserts zero diagnostics of any severity rather than zero errors:
 * a typo'd parameter renders silently wrong, which is exactly the class of mistake an
 * executable spec is for.
 */

/** Stamped into `createdAt`/`updatedAt` so a regenerated file is byte-stable. */
export const EXAMPLE_TIMESTAMP = "2026-08-29T00:00:00.000Z";

/** Shared caps. Well inside `HARD_LIMITS`, so the loader clamps nothing (§V24). */
export const LIMITS: ProjectSettings["limits"] = {
  maxResolution: 4096,
  maxDispatch: 65_535,
  maxBufferBytes: 268_435_456,
  memoryBudgetBytes: 1_073_741_824,
};

export function settings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    outputResolution: { width: 1280, height: 720 },
    workingFormat: "rgba16float",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 30,
    limits: LIMITS,
    ...overrides,
  };
}

/**
 * What a node of this type is CURRENTLY at — the number the loader will not migrate (T1068).
 *
 * `node()` used to write `definitionVersion: 1` for everything, so authoring a
 * current-schema node shipped a file the loader immediately migrated. §T1037 hit it on
 * Ramp, whose schema moved to 2: without `definitionVersion: 2` in `extra` the loader
 * REWROTE the stops on load, and the only thing that noticed was the runner's
 * `changed: false` gate — the author's own feedback was migration diagnostics, a whole
 * pipeline stage away from the call site that lied.
 *
 * The registry is right there and the builder was not asking it. It asks now, so the
 * builder's default is TRUE BY CONSTRUCTION for every type and stays true the next time a
 * node's version advances — the trap generalises to any such node, and this is the only
 * place that can close it for all of them at once (§V316: the category, not a member).
 *
 * A COMPONENT INSTANCE mirrors the version already in its own type (§V79/§V84 —
 * `component:<id>@<version>`, and `definitionVersion` carries the same number, which is
 * exactly what `saveAsComponent` writes). So it is read off the type rather than looked
 * up: there is no built-in definition to ask.
 *
 * An UNKNOWN type throws rather than defaulting. A document naming a type the registry
 * does not have is a typo that would otherwise compile to a severed graph with a
 * diagnostic nobody reads at authoring time (§V883's "a degraded compile is not a failed
 * one"), and it is the same mistake this docblock's own warning about parameter keys
 * describes — caught here, at the call site, with the name in the message.
 */
function currentDefinitionVersion(type: string): number {
  const component = parseComponentNodeType(type);
  if (component !== null) return component.version;
  const version = DEFINITION_VERSIONS.get(type);
  if (version === undefined) {
    throw new Error(
      `node("${type}"): no node type "${type}" is registered. An example may only place types the ` +
        "registry has — check the spelling against src/nodes/definitions/.",
    );
  }
  return version;
}

const DEFINITION_VERSIONS: ReadonlyMap<string, number> = new Map(
  allNodeDefinitions.map((definition) => [definition.type, definition.version]),
);

export function node(
  id: string,
  type: string,
  position: readonly [number, number],
  parameters: Record<string, ParameterValue> = {},
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type,
    /* T1068: the registry's number, not 1. An explicit `definitionVersion` in `extra` still
       wins, because a MIGRATION fixture legitimately wants to be old — the spread below is
       what keeps that available. */
    definitionVersion: currentDefinitionVersion(type),
    position: { x: position[0], y: position[1] },
    ...extra,
    // T348: MERGED, never last-writer-wins — an example that passes base parameters
    // AND a slot in `extra.parameters` (E10's rotate.y) must keep both. The plain
    // spread silently dropped every base parameter, which renders as a node quietly
    // on its defaults: plausible-wrong, the worst kind.
    parameters: { ...parameters, ...(extra.parameters ?? {}) },
  };
}

export function edge(
  id: string,
  from: readonly [string, string],
  to: readonly [string, string],
  /**
   * §V131/T225: which slot this edge takes on a VARIADIC port. Absent sorts last and ties
   * break by id, which is fine for the single-edge ports every other example uses and is
   * NOT fine for a Switch — there the index is the picture, and leaving it to id order
   * means the branch that plays on open is decided by a spelling.
   */
  order?: number,
): GraphEdge {
  return {
    id,
    source: { nodeId: from[0] as string, portId: from[1] as string },
    target: { nodeId: to[0] as string, portId: to[1] as string },
    ...(order === undefined ? {} : { order }),
  };
}

/**
 * A channel-driven slot (§T897, formerly `driven` mode §V107): the channel is in effect,
 * `retained` is what §V108 keeps and what every host without that channel attached resolves
 * to — the compiler in the example gate included, which is why a retained value has to be a
 * sane picture on its own.
 *
 * T897 (owner's ruling): there is no separate `driven` mode any more — TD's model. A channel
 * read is an EXPRESSION term (`op('gd1').chan.high`), so inline maths over the live signal is
 * one edit away instead of a mode change. `name` maps to `.chan.value` and `name:c` to
 * `.chan.c`, which resolve identically to the old bare/suffixed driven addresses.
 */
export function drivenSlot(channel: string, retained: number): ParameterSlot {
  return {
    mode: "expression",
    bindings: {
      static: { kind: "static", value: retained },
      expression: { kind: "expression", source: channelExpression(channel) },
    },
  };
}

/** An `expression` slot (§V71): our own grammar, arithmetic over the frame's variables. */
export function expressionSlot(source: string, retained: number): ParameterSlot {
  return {
    mode: "expression",
    bindings: {
      static: { kind: "static", value: retained },
      expression: { kind: "expression", source },
    },
  };
}

export function graph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
    groups: {},
  };
}

export function document(
  slug: string,
  name: string,
  projectSettings: ProjectSettings,
  projectGraph: GraphDocument,
): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: `example-${slug}`,
    name,
    graph: projectGraph,
    settings: projectSettings,
    assets: [],
    createdAt: EXAMPLE_TIMESTAMP,
    updatedAt: EXAMPLE_TIMESTAMP,
  };
}
