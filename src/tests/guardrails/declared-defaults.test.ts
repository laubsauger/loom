import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declaresUniformBlock,
  extractParamsStruct,
  paramForField,
  reflectParamsStruct,
  type ReflectedField,
} from "../../nodes/definitions/params-reflection.ts";
import {
  CUSTOM_WGSL_DEFAULT_SOURCE,
  CUSTOM_WGSL_UNIFORM_BINDING,
} from "../../nodes/shaders/custom-wgsl-default.wgsl.ts";
import { DEFAULT_POINT_KERNEL } from "../../nodes/shaders/points.wgsl.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §T1184 — EVERY SHIPPED REFLECTED KNOB DECLARES THE DEFAULT IT RESETS TO
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: *"reset to default for custom parameters and components, as well as any WGSL
 * shader kernel — auto-derived fields should reset to whatever is actually the default
 * instead of just defaulting to 0 or 1."*
 *
 * `params-reflection.ts` now reads `// @default <literal>` off a field's own line. THIS FILE
 * IS THE HALF THAT MATTERS: a declared-default mechanism with no declarations ships the same
 * bug with extra steps, and the first shader anybody opens is one of ours.
 *
 * ## WHY THE SUBJECTS ARE DERIVED AND NOT LISTED (§V453, §V316, §V855)
 *
 * An enumerated list of shaders goes stale at shader #18 — silently, because a list that
 * forgot a member still passes. So the subjects come out of the SHIPPED ARTEFACTS: every
 * `.loom.json` under `examples/`, walked for every node whose controls are reflected out of
 * its own WGSL, plus the two sources a user meets before opening any example at all (a fresh
 * `customWgsl`'s and a fresh point kernel's). Add an example, add a shader, add a field to a
 * shader anybody ships, and it is a subject the moment it is written — nothing to remember.
 *
 * The two claims are separate on purpose and one does not imply the other:
 *
 *  - **DECLARED** (below): every reflected field of every shipped source declares a default,
 *    or is in `TYPE_DEFAULTED` with a reason. This is the backfill's own gate.
 *  - **INERT** (below): every reflected field of every shipped DOCUMENT carries a stored
 *    value, or is in `UNSET_BY_DESIGN` with a reason. This is the MIGRATION gate — §V920's
 *    hazard read forwards. A field the document leaves unset resolves to its default, so
 *    declaring one CHANGES WHAT THAT DOCUMENT RENDERS. The claim "no shipped example moved"
 *    is only checkable if the unset set is pinned, and it is pinned here.
 */

const EXAMPLES = new URL("../../../examples/", import.meta.url).pathname;

/** A reflected field of something we ship, with enough address to name it in a failure. */
interface ShippedField {
  /** `E58-Alembic.loom.json:alembic` — or a name for a source that is not in a document. */
  readonly where: string;
  readonly field: ReflectedField;
}

/**
 * FIELD NAMES whose default is authored somewhere other than the shader source, with the
 * reason. §V453's shape: a ledger, not an allow-list — every entry has to say why.
 */
const TYPE_DEFAULTED: Readonly<Record<string, string>> = {
  amount:
    "`paramForField` gives `amount: f32` its own authored default of 1 and the historical " +
    "0..1 bounded slider that §V147 pins E43/E45's identity to. It is declared in code " +
    "rather than in the source because the SLIDER cannot be spelled in a comment. A shader " +
    "that wants a different number still declares one and wins — E46's lantern does " +
    "(`amount: f32, // @default 0.8`), which is what proves the override is live.",
};

/**
 * NODES a shipped document deliberately leaves unset, and exactly which of their fields.
 *
 * The set is asserted EXACTLY, not as a permission: a thirteenth unset field on this node
 * fails, and so does a twelfth that stopped being unset. An allow-list would let the first
 * of those through, which is the whole failure mode this gate exists for.
 */
const UNSET_BY_DESIGN: Readonly<Record<string, { reason: string; fields: readonly string[] }>> = {
  "E55-Reactor.loom.json:haze": {
    reason:
      "T1150 runs `reactor.wgsl.ts` twice — `REACTOR_WGSL` (PASS 0, the geometry) and " +
      "`REACTOR_HAZE_WGSL` (PASS 1, the front haze at half resolution) — from ONE template, " +
      "so the haze node reflects the whole struct while its `fs` returns inside `if (PASS == " +
      "1)` before any of these fourteen is read. They are the optics, the palette and the " +
      "shutters' hold and pulse (T1264): used only under `trace`, `coreSegment` and the hue " +
      "helpers, none of which PASS 1 reaches. So a declared default cannot move a pixel of " +
      "E55, and pinning the values into the document would be fourteen numbers claiming to " +
      "matter that do not.",
    fields: [
      "coreColor",
      "dispersion",
      "edgeColor",
      "exposure",
      "facet",
      "frameColor",
      "glassColor",
      "hueDrift",
      "hueSwing",
      "ior",
      "shellHueStep",
      "shutDim",
      "shutPulse",
      "turbulence",
    ],
  },
};

/** Every graph in a project file: the document's own, plus each component definition's. */
function graphsOf(document: unknown): Array<Record<string, unknown>> {
  const graphs: Array<Record<string, unknown>> = [];
  const push = (value: unknown): void => {
    const graph = value as { nodes?: Record<string, unknown> } | undefined;
    if (graph?.nodes !== undefined) graphs.push(graph as Record<string, unknown>);
  };
  const file = document as {
    graph?: unknown;
    components?: Record<string, unknown>;
    definition?: { graph?: unknown };
  };
  push(file.graph);
  push(file.definition?.graph);
  for (const entry of Object.values(file.components ?? {})) {
    const versions = Array.isArray(entry) ? entry : [entry];
    for (const version of versions) push((version as { graph?: unknown } | undefined)?.graph);
  }
  return graphs;
}

/**
 * The fields a node reflects, through THE SAME readers the compile path uses — never a
 * second parse. A node that reflects nothing (every ordinary node) answers with nothing.
 */
function reflectedFieldsOf(type: unknown, parameters: Record<string, unknown>): ReflectedField[] {
  if (type === "customWgsl") {
    const source = parameters["source"];
    if (typeof source !== "string") return [];
    if (!declaresUniformBlock(source, CUSTOM_WGSL_UNIFORM_BINDING)) return [];
    return [...reflectParamsStruct(source)];
  }
  if (type === "pointKernel" || type === "pointKernelAdvanced") {
    const kernel = parameters["kernel"];
    if (typeof kernel !== "string") return [];
    const { declaration } = extractParamsStruct(kernel);
    return declaration === "" ? [] : [...reflectParamsStruct(declaration)];
  }
  return [];
}

/** Only the fields that become a CONTROL — a matrix or an array reflects to nothing. */
const controls = (fields: readonly ReflectedField[]): ReflectedField[] =>
  fields.filter((field) => paramForField(field) !== undefined);

interface ShippedNode {
  readonly where: string;
  readonly parameters: Record<string, unknown>;
  readonly fields: readonly ReflectedField[];
}

/** Every reflecting node of every shipped project file, addressed `<file>:<nodeId>`. */
function shippedNodes(): ShippedNode[] {
  const files = [
    ...readdirSync(EXAMPLES)
      .filter((name) => name.endsWith(".loom.json"))
      .sort()
      .map((name) => ({ name, path: `${EXAMPLES}${name}` })),
    ...readdirSync(`${EXAMPLES}components/`)
      .filter((name) => name.endsWith(".loom.json"))
      .sort()
      .map((name) => ({ name: `components/${name}`, path: `${EXAMPLES}components/${name}` })),
  ];
  const nodes: ShippedNode[] = [];
  for (const file of files) {
    const document: unknown = JSON.parse(readFileSync(file.path, "utf8"));
    for (const graph of graphsOf(document)) {
      const entries = graph["nodes"] as Record<string, { type?: unknown; parameters?: unknown }>;
      for (const [nodeId, node] of Object.entries(entries)) {
        const parameters = (node.parameters ?? {}) as Record<string, unknown>;
        const fields = controls(reflectedFieldsOf(node.type, parameters));
        if (fields.length === 0) continue;
        nodes.push({ where: `${file.name}:${nodeId}`, parameters, fields });
      }
    }
  }
  return nodes;
}

/**
 * The shipped sources, as fields to check: every reflecting node of every example, plus the
 * two a user meets with no example open at all. A source used by five documents is checked
 * five times, which costs nothing and means the failure names the file you have to look at.
 */
function shippedFields(): ShippedField[] {
  const fields: ShippedField[] = shippedNodes().flatMap((node) =>
    node.fields.map((field) => ({ where: node.where, field })),
  );
  const fresh: Array<[string, ReflectedField[]]> = [
    [
      "custom-wgsl-default.wgsl.ts (a fresh Custom WGSL node)",
      controls(reflectedFieldsOf("customWgsl", { source: CUSTOM_WGSL_DEFAULT_SOURCE })),
    ],
    [
      "points.wgsl.ts (a fresh point kernel)",
      controls(reflectedFieldsOf("pointKernel", { kernel: DEFAULT_POINT_KERNEL })),
    ],
  ];
  for (const [where, own] of fresh) for (const field of own) fields.push({ where, field });
  return fields;
}

describe("§T1184 — every shipped reflected field declares its default", () => {
  const fields = shippedFields();

  /*
   * §V854: the claims below are all "every X …", and every one of them is vacuously true of
   * an empty list. This is the precondition — if the walk stops finding shipped shaders (a
   * renamed directory, a reflector that stopped reflecting), the gate fails HERE rather than
   * passing green with nothing in it.
   */
  it("finds the shipped reflected surface at all", () => {
    expect(fields.length).toBeGreaterThan(200);
    expect(new Set(fields.map((entry) => entry.where)).size).toBeGreaterThan(15);
  });

  it("declares a default on every field, or names the field in the ledger with a reason", () => {
    const undeclared = fields
      .filter((entry) => entry.field.declaredDefault === undefined)
      .filter((entry) => TYPE_DEFAULTED[entry.field.name] === undefined)
      .map((entry) => `${entry.where}.${entry.field.name}: ${entry.field.wgsl}`);
    expect(undeclared).toEqual([]);
  });

  it("keeps the ledger honest — every reason names a field something still ships", () => {
    const shipped = new Set(fields.map((entry) => entry.field.name));
    expect(Object.keys(TYPE_DEFAULTED).filter((name) => !shipped.has(name))).toEqual([]);
  });

  /*
   * The declaration has to SURVIVE INTO THE CONTROL, which is the only thing "reset to
   * default" ever reads. A `@default` the parser accepted and the shaper then dropped —
   * `[1, 0]` on a `vec3f`, say — would pass the claim above and reset to 0 anyway, which is
   * the original bug wearing an annotation.
   */
  it("lands every declared default on the parameter definition itself", () => {
    const dropped = fields
      .filter((entry) => entry.field.declaredDefault !== undefined)
      .filter((entry) => {
        const declared = entry.field.declaredDefault;
        const parameter = paramForField(entry.field);
        if (parameter === undefined || declared === undefined) return true;
        const landed = (parameter as { default?: unknown }).default;
        if (typeof declared === "number") {
          return Array.isArray(landed)
            ? landed.some((value) => value !== declared)
            : landed !== declared;
        }
        return !Array.isArray(landed) || declared.some((value, index) => landed[index] !== value);
      })
      .map((entry) => `${entry.where}.${entry.field.name}`);
    expect(dropped).toEqual([]);
  });
});

describe("§T1184 — a declared default cannot move a shipped example (§V920)", () => {
  const nodes = shippedNodes();

  it("finds the shipped reflecting nodes at all", () => {
    expect(nodes.length).toBeGreaterThan(15);
  });

  /*
   * A stored value shadows the default, so declaring one is INERT for it. This is the whole
   * migration argument, mechanised: if every reflected field of every shipped document is
   * stored, then nothing this task did can change what any of them renders — and the twelve
   * that are not stored are named above with the reason they still cannot.
   */
  it("stores every reflected value, or names the node and its exact unset set", () => {
    const unexpected: string[] = [];
    for (const node of nodes) {
      const unset = node.fields
        .filter((field) => node.parameters[field.name] === undefined)
        .map((field) => field.name)
        .sort();
      const ledgered = UNSET_BY_DESIGN[node.where];
      if (ledgered === undefined) {
        for (const name of unset) unexpected.push(`${node.where}.${name}`);
        continue;
      }
      expect(unset).toEqual([...ledgered.fields]);
    }
    expect(unexpected).toEqual([]);
  });

  it("keeps the unset ledger honest — every entry names a node something still ships", () => {
    const shipped = new Set(nodes.map((node) => node.where));
    expect(Object.keys(UNSET_BY_DESIGN).filter((where) => !shipped.has(where))).toEqual([]);
  });
});
