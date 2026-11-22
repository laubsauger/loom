import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { minimalGraphFor } from "../nodes/definitions/test-support.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { generatedTextCounts } from "../runtime/backend/wgsl.ts";
import { compileGraph, isDisplaySink } from "./index.ts";

/**
 * §V1029 / T1635b — GENERATED TEXT IS A FUNCTION OF WHAT A NODE IS, NEVER OF HOW MANY THE
 * DOCUMENT HAS.
 *
 * §B260 was one instance of a shape: the Render wrote one block of WGSL per Light and
 * summed them in one chain, and past about twenty lights Apple's Metal compiler kept every
 * block's values live at once (0.4 ms a frame became 18.7 at 64). The audit
 * (`docs/generated-text-growth-audit-2026-10-06.md`) found the same shape in the instances
 * generator, in the projector blocks and in a casting light's lookup, and a bounded one in
 * Composite. This gate is on that CAUSE, read off the text, and not on a clock.
 *
 * ## What is derived, and what is written down
 *
 * THE AXES ARE DERIVED from the node registry: every way a document can raise a count.
 * A variadic input port or a list reference (lights, layers, casters); a pointset input
 * (the attributes on the edge); a compile-time number, string or code parameter (a count
 * that reaches structure, a list in a string, a schema, the author's own struct). A new
 * port or parameter of one of those kinds is an axis the day it is declared.
 *
 * THE LAW OF EACH AXIS IS WRITTEN DOWN in `LEDGER`, and measured: the axis is compiled
 * through the real `compileGraph` at 1, 2, 4, 15 and 16 items (or up to its bound), and
 * the texts of every pass that is not one of the items themselves are compared.
 *
 *  - `flat`: every text is byte-identical at every count. This is the rule.
 *  - `branch`: one text for a single item and another for several, identical from 2 up.
 *  - `literal`: identical once numeric literals are set aside (a count written as text).
 *  - `declarations`: members, bindings and whole new functions; no function body grows.
 *  - `statements`: a function body grows per item and carries nothing from item to item.
 *  - `chain`: the text added per item reads AND writes a name declared outside it
 *    (`lit += …`, `acc = blendPixel(acc, …)`). That is §B260's shape.
 *
 * A row states its numbers per item, taken on the SECOND item and on the LAST (the
 * sixteenth light wears a guard and a two-digit index the second does not), and they must
 * match what is measured exactly: a number moves only by an edit that says why. A bound a
 * row names is compiled at the bound and one past it, and the refusal has to be the one
 * named.
 *
 * Two rows need no count. `no pass`: every output of the node is a value, so nothing it
 * holds reaches a shader (checked against the definition). `not a count`: one name, or text
 * that is the author's alone; that one is a claim a reviewer reads, and nothing checks it.
 *
 * ## The three lists
 *
 * `LEDGER` holds the lawful rows. A chain is in it only under §V1029's exception (d): a
 * refusal by name at 8 items or fewer, and a measurement on record that its cost is linear
 * up to there. `NOT_YET_DATA` holds the chains that have neither: each with the task that
 * turns its count into data, its exact length per item, and the largest count it reaches.
 * A row is in exactly one of them; an axis with no row fails by name, and so does a row
 * whose axis is gone. `FIXED_BY_DEFINITION` holds exception (a): a chain whose length the
 * generator fixes, found by compiling every node type and named with its exact length.
 *
 * What a row still owes (`measured: null`, `bound: null`) is printed on every run as OWED
 * and fails nothing: it is a debt somebody decided on in a diff.
 *
 * ## What it shares with `scene-light-guard.test.ts`, and what it does not
 *
 * That file (§B260's stopgap) scans a lit fragment function for a straight-line RUN of
 * more than eight sources adding into `lit`. Its scanner is keyed on `lit` and on the
 * Render's numbered uniform rows, and it answers "how long is the run". This one has to
 * answer "does the text of one item carry a value in from outside" for any generator and
 * any name (`acc` in Composite), so it reads the DIFFERENCE between two counts instead.
 * The two do not overlap: a guarded light block passes that file and is a chain here.
 *
 * ## What it cannot see
 *
 * Author text. A Custom WGSL, a kernel or a Material · WGSL is the author's, and the
 * document sources under `src/examples` and `src/projects` build such text with loops of
 * their own; this file reads neither. Cost: it asserts the form that caused §B260, never
 * a time. A value carried through a function's pointer argument or an array write that a
 * later item reads back by a different name. What one node's count does to ANOTHER node's
 * text beyond the passes of its own fixture (a producer's point count is a literal offset
 * in every kernel that reads it). A fixed chain that only a non-default mode emits.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
/* No device limits: every bound that fires is the WebGPU baseline's. */
const CAPABILITIES = { tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"], timestampQuery: false, limits: { maxTextureDimension2D: 8192 } };

/* ------------------------------------------------------------------------------------ */
/* graphs                                                                                */
/* ------------------------------------------------------------------------------------ */

interface NodeJson {
  id: string;
  type: string;
  definitionVersion: number;
  position: { x: number; y: number };
  parameters: Record<string, unknown>;
  label?: string;
}
interface EdgeJson {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  order?: number;
}
interface Doc {
  revision: number;
  nodes: Record<string, NodeJson>;
  edges: Record<string, EdgeJson>;
  groups: Record<string, unknown>;
}
interface Fixture {
  readonly graph: Doc;
  /** The node the axis belongs to: its passes are named without a prefix. */
  readonly subject: string;
  /** Nodes that ARE the items, or carry them: their own passes are not what is measured. */
  readonly drivers: readonly string[];
}
type Build = (count: number) => Fixture;

const mk = (id: string, type: string, parameters: Record<string, unknown> = {}): NodeJson => ({
  id,
  type,
  definitionVersion: registry.get(type)?.version ?? 1,
  position: { x: 0, y: 0 },
  parameters,
  label: id,
});
function wire(doc: Doc, from: string, fromPort: string, to: string, toPort: string, order?: number): void {
  const id = `wire${Object.keys(doc.edges).length}`;
  doc.edges[id] = { id, source: { nodeId: from, portId: fromPort }, target: { nodeId: to, portId: toPort }, ...(order === undefined ? {} : { order }) };
}
function graphOf(nodes: readonly NodeJson[], wires: ReadonlyArray<readonly [string, string, string, string]>): Doc {
  const doc: Doc = { revision: 1, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), edges: {}, groups: {} };
  wires.forEach(([from, fromPort, to, toPort], index) => wire(doc, from, fromPort, to, toPort, index));
  return doc;
}
const definitionOf = (type: string) => {
  const found = allNodeDefinitions.find((definition) => definition.type === type);
  if (found === undefined) throw new Error(`no node definition "${type}"`);
  return found;
};
/** The catalogue sweeps' minimal graph for a type: the node is `subject`, fed and observed as a user would. */
const minimal = (type: string): Doc => minimalGraphFor(definitionOf(type) as never, registry as never) as unknown as Doc;
const two = (index: number): string => String(index).padStart(2, "0");
const named = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}${two(index)}`);

/* ------------------------------------------------------------------------------------ */
/* the axes, derived                                                                     */
/* ------------------------------------------------------------------------------------ */

type AxisKind = "inputs" | "attributes" | "number" | "string" | "json" | "wgsl";
interface Axis {
  /** `<node type>.<port or parameter>`: the ledger's key. */
  readonly key: string;
  readonly type: string;
  readonly kinds: readonly AxisKind[];
  readonly port?: string;
  readonly portKind?: string;
  readonly parameter?: string;
  /** The list parameter that names what a reference-fed port takes. */
  readonly list?: string;
  readonly min?: number;
  readonly max?: number;
}

interface DefinitionShape {
  readonly type: string;
  readonly inputs?: ReadonlyArray<{ readonly id: string; readonly variadic?: boolean; readonly type?: { readonly kind?: string } }>;
  readonly outputs?: ReadonlyArray<{ readonly id: string; readonly type?: { readonly kind?: string } }>;
  readonly parameters?: Readonly<Record<string, { readonly type: string; readonly compileTime?: boolean; readonly language?: string; readonly min?: number; readonly max?: number }>>;
  readonly sourceReferences?: ReadonlyArray<{ readonly parameter: string; readonly input: string; readonly list?: boolean }>;
}

/**
 * Every way a document can raise a count, read off the definitions:
 *
 *  - `inputs`: a variadic input port, or a port a LIST parameter feeds by name;
 *  - `attributes`: a pointset input, whose edge carries as many attributes as the producer has;
 *  - `number`, `string`: a compile-time parameter (a count, or a list written in a string);
 *  - `json`, `wgsl`: a code parameter (a schema or a table; the author's own struct).
 *
 * A port and a parameter of one name on one node are one axis (the Render's `lights`).
 */
function deriveAxes(definitions: ReadonlyArray<DefinitionShape>): Axis[] {
  const byKey = new Map<string, Axis>();
  const add = (kind: AxisKind, axis: Omit<Axis, "kinds">): void => {
    const existing = byKey.get(axis.key);
    byKey.set(axis.key, existing === undefined ? { ...axis, kinds: [kind] } : { ...existing, ...axis, kinds: [...existing.kinds, kind] });
  };
  for (const definition of definitions) {
    for (const input of definition.inputs ?? []) {
      const key = `${definition.type}.${input.id}`;
      const list = (definition.sourceReferences ?? []).find((reference) => reference.input === input.id && reference.list === true);
      const portKind = input.type?.kind === undefined ? {} : { portKind: input.type.kind };
      if (input.variadic === true || list !== undefined) add("inputs", { key, type: definition.type, port: input.id, ...portKind, ...(list === undefined ? {} : { list: list.parameter }) });
      if (input.type?.kind === "pointset") add("attributes", { key, type: definition.type, port: input.id, ...portKind });
    }
    for (const [name, parameter] of Object.entries(definition.parameters ?? {})) {
      const key = `${definition.type}.${name}`;
      if (parameter.type === "code") add(parameter.language === "json" ? "json" : "wgsl", { key, type: definition.type, parameter: name });
      if (parameter.compileTime !== true) continue;
      if (parameter.type === "number") {
        add("number", { key, type: definition.type, parameter: name, ...(parameter.min === undefined ? {} : { min: parameter.min }), ...(parameter.max === undefined ? {} : { max: parameter.max }) });
      }
      if (parameter.type === "string") add("string", { key, type: definition.type, parameter: name });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const AXES = deriveAxes(allNodeDefinitions as unknown as ReadonlyArray<DefinitionShape>);

/* ------------------------------------------------------------------------------------ */
/* fixtures                                                                              */
/* ------------------------------------------------------------------------------------ */

const PASS_THROUGH = "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}\n";
/** `position` and count − 1 more attributes, every name the same width so an index never changes a length. */
const schema = (count: number, type = "vec4f", prefix = "a"): string =>
  JSON.stringify([
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    ...named(prefix, Math.max(0, count - 1)).map((name) => ({ name, type, default: type === "f32" ? [0] : [0, 0, 0, 0] })),
  ]);
/** `struct Params` with `count` fields the code below it reads one of. */
const paramsStruct = (count: number): string => `struct Params {\n${named("f", count).map((name) => `  ${name}: f32,`).join("\n")}\n};\n`;

/** The fixture an axis gets when its row names none: the minimal graph with the one count turned. */
function generic(axis: Axis): Build | undefined {
  if (axis.kinds.includes("number") && axis.parameter !== undefined) return numberOf(axis.type, axis.parameter);
  if (axis.kinds.includes("inputs") && axis.port !== undefined && axis.list === undefined && (axis.portKind === "texture2d" || axis.portKind === "value")) {
    return inputsOf(axis.type, axis.port, axis.portKind === "value" ? "slider" : "checker");
  }
  if (axis.kinds.includes("attributes") && axis.port !== undefined) return attributesInto(axis.type, axis.port);
  return undefined;
}
/** A compile-time number of the subject, set to the count. */
function numberOf(type: string, parameter: string): Build {
  return (count) => {
    const doc = minimal(type);
    const subject = doc.nodes["subject"] as NodeJson;
    subject.parameters = { ...subject.parameters, [parameter]: count };
    return { graph: doc, subject: "subject", drivers: [] };
  };
}
/** `count` wires into one variadic port, each from a node of its own. */
function inputsOf(type: string, port: string, feeder: string): Build {
  return (count) => {
    const doc = minimal(type);
    for (const [id, edge] of Object.entries(doc.edges)) {
      if (edge.target.nodeId !== "subject" || edge.target.portId !== port) continue;
      delete doc.edges[id];
      delete doc.nodes[edge.source.nodeId];
    }
    const items = named("checker_item", count);
    items.forEach((id, index) => {
      doc.nodes[id] = mk(id, feeder);
      wire(doc, id, "out", "subject", port, index);
    });
    return { graph: doc, subject: "subject", drivers: items };
  };
}
/** A kernel of `count` attributes put behind the grid that feeds one pointset port. */
function attributesInto(type: string, port: string): Build {
  return (count) => {
    const doc = minimal(type);
    const into = Object.values(doc.edges).find((edge) => edge.target.nodeId === "subject" && edge.target.portId === port);
    if (into === undefined) throw new Error(`the minimal graph of ${type} wires nothing into "${port}"`);
    const feed = into.source.nodeId;
    const root = doc.nodes[`${feed}src`] !== undefined ? `${feed}src` : feed;
    const grid = doc.nodes[root] as NodeJson;
    if (grid.type !== "pointGrid") throw new Error(`the minimal graph of ${type} feeds "${port}" from a ${grid.type}; this fixture puts its kernel behind a pointGrid`);
    const cols = typeof grid.parameters["cols"] === "number" ? grid.parameters["cols"] : 64;
    const rows = typeof grid.parameters["rows"] === "number" ? grid.parameters["rows"] : 64;
    doc.nodes["kernel_attributes"] = mk("kernel_attributes", "pointKernel", { capacity: cols * rows, attributes: schema(count), kernel: PASS_THROUGH });
    for (const edge of Object.values(doc.edges)) if (edge.source.nodeId === root) edge.source = { nodeId: "kernel_attributes", portId: "out" };
    wire(doc, root, "out", "kernel_attributes", "in");
    return { graph: doc, subject: "subject", drivers: [root, "kernel_attributes"] };
  };
}

/** A compile-time number of the subject, with three attributes arriving on one of its pointset ports. */
function numberOver(type: string, port: string, parameter: string): Build {
  return (count) => {
    const fixture = attributesInto(type, port)(3);
    (fixture.graph.nodes["subject"] as NodeJson).parameters[parameter] = count;
    return fixture;
  };
}

/** A pointset chain observed as a user observes points: `…last → renderPoints → output`. */
function observed(nodes: readonly NodeJson[], wires: ReadonlyArray<readonly [string, string, string, string]>, last: string, subject: string, drivers: readonly string[] = []): Fixture {
  return {
    graph: graphOf([...nodes, mk("points_probe", "renderPoints"), mk("output_main", "output")], [...wires, [last, "out", "points_probe", "points"], ["points_probe", "out", "output_main", "input"]]),
    subject,
    drivers,
  };
}

interface Scene {
  readonly lights?: number;
  readonly light?: (index: number) => Record<string, unknown>;
  readonly projectors?: number;
  readonly projector?: Record<string, unknown>;
  readonly cookies?: boolean;
  readonly geometries?: number;
  readonly geometry?: (index: number) => Record<string, unknown>;
  /** What every geometry's Points come from: the floor grid, a Mesh File In, or nodes of the fixture's own. */
  readonly points?: "grid" | "mesh" | { readonly nodes: readonly NodeJson[]; readonly wires: ReadonlyArray<readonly [string, string, string, string]>; readonly last: string; readonly drivers: readonly string[] };
  /** Wire a Mesh File In into every geometry's Shape Mesh. */
  readonly shape?: boolean;
  readonly material?: readonly [type: string, parameters?: Record<string, unknown>];
  readonly render?: Record<string, unknown>;
  readonly environment?: boolean;
}
/** A Mesh File In with nothing loaded publishes a degenerate mesh; these two numbers size it as a cube. */
const MESH = { vertices: 24, triangles: 12 };
/** Geometries through a camera under lights and projectors, into a Render: the subject is `render_shot`. */
function scene(spec: Scene): Fixture {
  const lights = named("light_l", spec.lights ?? 1);
  const projectors = named("projector_p", spec.projectors ?? 0);
  const geometries = named("geometry_g", spec.geometries ?? 1);
  const points = spec.points ?? "grid";
  const own = typeof points === "string" ? undefined : points;
  const source = own !== undefined ? own.last : points === "mesh" ? "mesh_part" : "grid_floor";
  const material = spec.material ?? ["materialPbr"];
  const doc = graphOf(
    [
      ...(own !== undefined ? own.nodes : [points === "mesh" ? mk("mesh_part", "meshFileIn", MESH) : mk("grid_floor", "pointGrid", { cols: 8, rows: 8 })]),
      ...(spec.shape === true ? [mk("mesh_shape", "meshFileIn", MESH)] : []),
      ...(spec.cookies === true ? [mk("checker_cookie", "checker")] : []),
      ...(spec.environment === true ? [mk("checker_sky", "checker")] : []),
      mk("camera_main", "camera"),
      mk("material_skin", material[0], material[1] ?? {}),
      ...geometries.map((id, index) => mk(id, "geometry", { mode: "surface", material: "material_skin", ...spec.geometry?.(index) })),
      ...lights.map((id, index) => mk(id, "light", spec.light?.(index) ?? { kind: "point" })),
      ...projectors.map((id) => mk(id, "projector", { occlusion: false, ...spec.projector })),
      mk("render_shot", "render", { scenes: geometries.join(" "), camera: "camera_main", lights: lights.join(" "), projectors: projectors.join(" "), ...spec.render }),
      mk("output_main", "output"),
    ],
    [
      ...(own?.wires ?? []),
      ...geometries.map((id) => [source, "out", id, "points"] as const),
      ...(spec.shape === true ? geometries.map((id) => ["mesh_shape", "out", id, "mesh"] as const) : []),
      ...(spec.cookies === true ? projectors.map((id) => ["checker_cookie", "out", id, "cookie"] as const) : []),
      ...(spec.environment === true ? [["checker_sky", "out", "render_shot", "environment"] as const] : []),
      ["render_shot", "out", "output_main", "input"],
    ],
  );
  return { graph: doc, subject: "render_shot", drivers: own?.drivers ?? [] };
}

interface LampSets {
  /** How many Lights in Points mode the Render lists, each over a kernel of its own. */
  readonly sets?: number;
  /** How many points each kernel holds. */
  readonly points?: number;
  /** How many attributes each kernel carries, `position` among them. */
  readonly attributes?: number;
  /** Parameters over each Light's (a map). */
  readonly light?: Record<string, unknown>;
  /** The Lights are items too: their own resolve passes are then not what is measured. */
  readonly lightsAreItems?: boolean;
}
/** T1589b: a Render lit by Lights in POINTS mode, each one light at every point of a kernel. The subject is `render_shot`. */
function lampSets(spec: LampSets): Fixture {
  const sets = spec.sets ?? 1;
  const fixture = scene({ lights: sets, light: () => ({ mode: "points", kind: "point", range: 4, ...spec.light }) });
  const kernels = named("kernel_lamps", sets);
  kernels.forEach((id, index) => {
    fixture.graph.nodes[id] = mk(id, "pointKernel", { capacity: spec.points ?? 16, attributes: schema(spec.attributes ?? 1), kernel: PASS_THROUGH });
    wire(fixture.graph, id, "out", `light_l${two(index)}`, "points");
  });
  return { ...fixture, drivers: [...fixture.drivers, ...kernels, ...(spec.lightsAreItems === true ? named("light_l", sets) : [])] };
}
/** A parameter in Map mode over an attribute. */
const mapOf = (attribute: string, retained: unknown): unknown => ({ mode: "map", bindings: { static: { kind: "static", value: retained }, map: { kind: "map", attribute } } });

/* ------------------------------------------------------------------------------------ */
/* compile, and read the text                                                            */
/* ------------------------------------------------------------------------------------ */

interface Measured {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  /** role → text, as written. A role is a pass id with its digits set aside. */
  readonly texts: ReadonlyMap<string, string>;
  /** Passes with a shader that are not a driver's. */
  readonly passes: number;
}

function measure(fixture: Fixture): Measured {
  const shown = Object.values(fixture.graph.nodes).filter((entry) => {
    const definition = registry.get(entry.type);
    return definition !== undefined && isDisplaySink(definition);
  });
  const compiled = compileGraph({
    graph: fixture.graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    ...(shown.length === 0 ? {} : { sinks: shown.map((entry) => ({ nodeId: entry.id, kind: "output" as const })) }),
  } as never) as unknown as {
    ok: boolean;
    passes?: ReadonlyArray<{ kind: string; id: string; nodeId?: string; shader?: string }>;
    diagnostics: ReadonlyArray<{ severity: string; code: string; message: string }>;
  };
  const drivers = new Set(fixture.drivers);
  /* role → its distinct texts, in pass order. Sixteen draws of one text are one entry. */
  const byRole = new Map<string, string[]>();
  let passes = 0;
  for (const pass of compiled.passes ?? []) {
    if (typeof pass.shader !== "string") continue;
    const cut = pass.id.indexOf("#");
    const owner = pass.nodeId ?? (cut < 0 ? "" : pass.id.slice(0, cut));
    if (drivers.has(owner)) continue;
    passes += 1;
    const local = (cut < 0 ? pass.id : pass.id.slice(cut + 1)).replace(new RegExp(`^${owner}:`), "").replace(/\d+/g, "#");
    const role = owner === fixture.subject ? local : `${owner}:${local}`;
    const known = byRole.get(role);
    if (known === undefined) byRole.set(role, [pass.shader]);
    else if (!known.includes(pass.shader)) known.push(pass.shader);
  }
  /* A role with several texts (the four levels of a prefilter) keeps them apart by their order. */
  const texts = new Map<string, string>();
  for (const [role, each] of byRole) each.forEach((text, index) => texts.set(each.length === 1 ? role : `${role}~${index}`, text));
  return {
    ok: compiled.ok,
    errors: compiled.diagnostics.filter((entry) => entry.severity === "error").map((entry) => ({ code: entry.code, message: entry.message })),
    texts,
    passes,
  };
}

/** Comments blanked in place: every other character stays where it was, so a length is the text's own. */
function commentsBlanked(text: string): string {
  const blank = (comment: string): string => comment.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}
/** Numeric literals set aside; a digit inside a name (`light10Meta`, `pk_1`) is not one. */
function withoutLiterals(text: string): string {
  return text.replace(/(?<![A-Za-z_\d.])(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fiu]?(?![A-Za-z_\d])/g, "#");
}
/** A function's body, braces included: as written (what a device compiles) and with its comments blanked (what is read). */
interface Body {
  readonly text: string;
  readonly code: string;
}
/** name → body of every function in a module. Braces are matched with comments blanked: prose has braces too. */
function functionBodies(text: string): Map<string, Body> {
  const code = commentsBlanked(text);
  const out = new Map<string, Body>();
  const head = /\bfn\s+([A-Za-z_]\w*)\s*\(/g;
  for (let match = head.exec(code); match !== null; match = head.exec(code)) {
    const open = code.indexOf("{", match.index);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (; end < code.length; end += 1) {
      if (code[end] === "{") depth += 1;
      else if (code[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.set(match[1] as string, { text: text.slice(open, end + 1), code: code.slice(open, end + 1) });
  }
  return out;
}
/** Members of the struct of every `var<uniform>`. */
function uniformMembers(text: string): number {
  const code = commentsBlanked(text);
  let members = 0;
  for (const block of code.matchAll(/var<uniform>\s+\w+\s*:\s*(\w+)\s*;/g)) {
    const struct = new RegExp(`struct\\s+${block[1]}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(code);
    if (struct !== null) members += (struct[1] ?? "").split(/[,;\n]/).filter((line) => /^\s*\w+\s*:/.test(line)).length;
  }
  return members;
}
const bindingCount = (text: string): number => (commentsBlanked(text).match(/@binding\(/g) ?? []).length;

function braceBalanced(lines: readonly string[]): boolean {
  let depth = 0;
  for (const line of lines) {
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth < 0) return false;
      }
    }
  }
  return depth === 0;
}

/**
 * The lines one more item ADDED to a function body.
 *
 * A generator that appends a block makes a pure insertion, and where exactly it sits is
 * ambiguous by the lines the new block shares with its neighbours (two light blocks end in
 * the same `}`): the window is slid to the first position where the inserted lines open and
 * close their own braces, which is the block as the generator wrote it. Anything else (two
 * insertions, a line that changed) is aligned by its longest common subsequence.
 */
function addedLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const end = b.length - tail;
  if (a.length - tail - head === 0) {
    for (let slide = 0; slide <= head; slide += 1) {
      if (slide > 0 && b[head - slide] !== b[end - slide]) break;
      const window = b.slice(head - slide, end - slide);
      if (braceBalanced(window)) return window;
    }
    return b.slice(head, end);
  }
  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, end);
  const longest: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      (longest[i] as number[])[j] = left[i] === right[j] ? ((longest[i + 1] as number[])[j + 1] as number) + 1 : Math.max((longest[i + 1] as number[])[j] as number, (longest[i] as number[])[j + 1] as number);
    }
  }
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (j < right.length) {
    if (i < left.length && left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (i < left.length && ((longest[i + 1] as number[])[j] as number) >= ((longest[i] as number[])[j + 1] as number)) {
      i += 1;
    } else {
      added.push(right[j] as string);
      j += 1;
    }
  }
  return added;
}

/**
 * THE CAUSE, READ OFF ONE ITEM'S TEXT: the names it both reads and writes that it does not
 * declare. `lit += …` on a `lit` declared before the block is one; so is
 * `acc = blendPixel(acc, …)`. An assignment to a name the item's own text declares in an
 * enclosing scope is the item's own business (`attenuation = attenuation * window`), and
 * so is a store that reads nothing back (`matte.x = 1.0 - shadow`, `out[k] = in[k]`).
 *
 * Scopes are followed by brace, because a light's point shadow counts its taps in a `lit`
 * of its OWN one scope further in, and the block's `lit +=` after that scope has closed is
 * the outer one again.
 */
function carriedNames(added: readonly string[]): string[] {
  const scopes: Array<Set<string>> = [new Set()];
  const carried = new Set<string>();
  const declared = (name: string): boolean => scopes.some((scope) => scope.has(name));
  const statement = (text: string): void => {
    const declaration = /^(?:let|var|const)\b(?:<[^>]*>)?\s*([A-Za-z_]\w*)/.exec(text);
    if (declaration !== null) {
      (scopes[scopes.length - 1] as Set<string>).add(declaration[1] as string);
      return;
    }
    const name = readAndWritten(text);
    if (name !== undefined && !declared(name)) carried.add(name);
  };
  walkStatements(added.join("\n"), {
    statement,
    open(head) {
      /* A `for` declares in its header and steps there: both belong to the loop's own scope. */
      const loop = /^for\s*\(([\s\S]*)\)$/.exec(head);
      scopes.push(new Set());
      if (loop !== null) for (const part of (loop[1] ?? "").split(";")) statement(part.trim());
    },
    close() {
      if (scopes.length > 1) scopes.pop();
    },
  });
  return [...carried].sort();
}

/** The name a statement both reads and writes: `x += …`, `x++`, `x = f(x, …)`. A plain store (`x.y = z`) has none. */
function readAndWritten(statement: string): string | undefined {
  const stepped = /^([A-Za-z_]\w*)\s*(?:\+\+|--)$/.exec(statement);
  if (stepped !== null) return stepped[1];
  const assignment = /^([A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*|\s*\[[^\]]*\])*)\s*(<<=|>>=|[-+*/%&|^]=|=)(?!=)([\s\S]*)$/.exec(statement);
  if (assignment === null) return undefined;
  const root = assignment[1] as string;
  if (root === "_" || /^(?:let|var|const|return)$/.test(root)) return undefined;
  return assignment[3] !== "=" || new RegExp(`(?<![\\w.])${root}\\b`).test(assignment[4] ?? "") ? root : undefined;
}

/**
 * The statements and scopes of a piece of WGSL, in order: `;` ends a statement (trimmed, a
 * `case` label dropped), `{` opens a scope under the head in front of it. A `for` header's
 * own semicolons sit in its parentheses and are left to whoever reads the head.
 */
function walkStatements(code: string, visit: { statement(text: string): void; open(head: string): void; close(): void }): void {
  const statement = (raw: string): void => {
    const text = raw.trim().replace(/^(?:case\b[^:]*:|default\s*:)\s*/, "");
    if (text !== "") visit.statement(text);
  };
  let segment = "";
  let parens = 0;
  for (const char of code) {
    if (char === "(") parens += 1;
    if (char === ")") parens -= 1;
    if (parens > 0 || (char !== "{" && char !== "}" && char !== ";")) {
      segment += char;
      continue;
    }
    if (char === ";") statement(segment);
    else if (char === "{") visit.open(segment.trim());
    else {
      statement(segment);
      visit.close();
    }
    segment = "";
  }
  statement(segment);
}

/**
 * §V1029 (a), read off a whole module: how many times each function WRITES OUT one
 * accumulation, outside any loop. Sixteen statements `acc = acc + …` that differ in nothing
 * but a number are one accumulation written sixteen times: a list unrolled into a chain,
 * whoever decided its length. A value passed through different stages (`q = scale(q)`,
 * `q = rotate(q)`) is not: each stage is written once.
 */
function writtenOut(text: string): Array<{ readonly function: string; readonly name: string; readonly times: number }> {
  const out: Array<{ function: string; name: string; times: number }> = [];
  for (const [name, body] of functionBodies(text)) {
    const shapes = new Map<string, number>();
    const loops: boolean[] = [];
    walkStatements(body.code, {
      statement(statement) {
        const carried = readAndWritten(statement);
        if (carried === undefined || loops.some(Boolean)) return;
        const shape = `${carried}\u0000${statement.replace(/\d+/g, "#").replace(/\s+/g, " ")}`;
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      },
      open(head) {
        loops.push(/^(?:for|while|loop)\b/.test(head));
      },
      close() {
        loops.pop();
      },
    });
    const most = new Map<string, number>();
    for (const [shape, times] of shapes) {
      const carried = shape.slice(0, shape.indexOf("\u0000"));
      most.set(carried, Math.max(most.get(carried) ?? 0, times));
    }
    for (const [carried, times] of most) out.push({ function: name, name: carried, times });
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* the law of one axis, measured                                                         */
/* ------------------------------------------------------------------------------------ */

type MeasuredLaw = "flat" | "branch" | "literal" | "declarations" | "statements" | "chain" | "a new text per item";
/** What one more item added, between two compiled counts. */
interface Step {
  /** `<role>/<function>` → bytes its body gained. */
  readonly grows: Readonly<Record<string, number>>;
  readonly functions: number;
  readonly members: number;
  readonly bindings: number;
  readonly passes: number;
  /** Texts that were in no pass before. */
  readonly texts: number;
  readonly carries: readonly string[];
}
/** A figure per item: one number, or the second item's and the last one's when they differ. */
type PerItem = number | readonly [second: number, last: number];
interface Observed {
  readonly law: MeasuredLaw;
  readonly passes: PerItem;
  readonly members: PerItem;
  readonly bindings: PerItem;
  readonly functions: PerItem;
  readonly grows: Readonly<Record<string, PerItem>>;
  readonly carries: readonly string[];
}
interface Finding {
  readonly observed: Observed;
  readonly refused: ReadonlyArray<{ readonly count: number; readonly codes: readonly string[] }>;
}

const distinctTexts = (measured: Measured): Set<string> => new Set(measured.texts.values());
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((entry) => b.has(entry));

function stepBetween(low: Measured, high: Measured): Step {
  const grows: Record<string, number> = {};
  let functions = 0;
  let members = 0;
  let bindings = 0;
  let texts = 0;
  const carries = new Set<string>();
  const before = distinctTexts(low);
  for (const [role, text] of high.texts) {
    const was = low.texts.get(role);
    if (was === undefined) {
      if (!before.has(text)) texts += 1;
      continue;
    }
    if (was === text) continue;
    const old = functionBodies(was);
    for (const [name, body] of functionBodies(text)) {
      const previous = old.get(name);
      if (previous === undefined) {
        functions += 1;
        continue;
      }
      if (previous.text === body.text) continue;
      for (const carried of carriedNames(addedLines(previous.code, body.code))) carries.add(carried);
      if (body.text.length !== previous.text.length) grows[`${role}/${name}`] = body.text.length - previous.text.length;
    }
    members += uniformMembers(text) - uniformMembers(was);
    bindings += bindingCount(text) - bindingCount(was);
  }
  return { grows, functions, members, bindings, passes: high.passes - low.passes, texts, carries: [...carries].sort() };
}

const perItem = (second: number, last: number): PerItem => (second === last ? second : [second, last]);

/** Compile the axis at each count and say what law its texts keep. `counts` holds at least two. */
function find(build: Build, counts: readonly number[]): Finding {
  const compiled = new Map<number, Measured>();
  const at = (count: number): Measured => {
    let found = compiled.get(count);
    if (found === undefined) {
      found = measure(build(count));
      compiled.set(count, found);
    }
    return found;
  };
  const refused = counts.filter((count) => !at(count).ok).map((count) => ({ count, codes: [...new Set(at(count).errors.map((entry) => entry.code))] }));
  const sets = counts.map((count) => distinctTexts(at(count)));
  const first = sets[0] as Set<string>;
  const second = stepBetween(at(counts[0] as number), at(counts[1] as number));
  const last = stepBetween(at(counts[counts.length - 2] as number), at(counts[counts.length - 1] as number));
  const literal = (set: ReadonlySet<string>): Set<string> => new Set([...set].map(withoutLiterals));
  let law: MeasuredLaw;
  if (sets.every((set) => sameSet(set, first))) law = "flat";
  else if (sets.length > 2 && sets.slice(1).every((set) => sameSet(set, sets[1] as Set<string>))) law = "branch";
  /* As many texts at every count, the same once their numbers are set aside: sixteen texts that differ by a number are not this. */
  else if (sets.every((set) => set.size === first.size && sameSet(literal(set), literal(first)))) law = "literal";
  else if (second.texts > 0 || last.texts > 0) law = "a new text per item";
  else if (second.carries.length > 0 || last.carries.length > 0) law = "chain";
  else if (Object.keys(second.grows).length > 0 || Object.keys(last.grows).length > 0) law = "statements";
  else law = "declarations";
  const growing = law === "declarations" || law === "statements" || law === "chain";
  const grows: Record<string, PerItem> = {};
  if (growing) for (const key of new Set([...Object.keys(second.grows), ...Object.keys(last.grows)])) grows[key] = perItem(second.grows[key] ?? 0, last.grows[key] ?? 0);
  return {
    refused,
    observed: {
      law,
      passes: perItem(second.passes, last.passes),
      members: growing ? perItem(second.members, last.members) : 0,
      bindings: growing ? perItem(second.bindings, last.bindings) : 0,
      functions: growing ? perItem(second.functions, last.functions) : 0,
      grows,
      carries: [...new Set([...second.carries, ...last.carries])].sort(),
    },
  };
}

/* ------------------------------------------------------------------------------------ */
/* the ledger                                                                            */
/* ------------------------------------------------------------------------------------ */

/** Refused by name above `count` items: compiled at `count` and at `count + 1`. */
interface Bound {
  readonly count: number;
  readonly code: string;
  /** The fixture the bound is reached in, when it is not the one the law is measured in. */
  readonly build?: Build;
}
/** The count is another axis's, and so is its refusal (the attributes a consumer is handed are its producer's). */
interface BoundElsewhere {
  readonly via: string;
}

interface Row {
  /**
   * The law, or one of two claims that need no count: `no pass` (every output of the node is
   * a value, so nothing it holds reaches a shader: checked against the definition) and
   * `not a count` (one name, or the author's own text: a claim a reviewer reads).
   */
  readonly law: Exclude<MeasuredLaw, "a new text per item"> | "no pass" | "not a count";
  readonly why: string;
  readonly build?: Build;
  /** Ascending, at least two; the first two and the last two are the steps the numbers are taken on. */
  readonly counts?: readonly number[];
  readonly passes?: PerItem;
  readonly members?: PerItem;
  readonly bindings?: PerItem;
  readonly functions?: PerItem;
  readonly grows?: Readonly<Record<string, PerItem>>;
  readonly carries?: readonly string[];
  /**
   * §V1029 (b) and (d) want a refusal by name at a stated count. `null` says there is none
   * yet: the gate reports the row as OWED and does not fail.
   */
  readonly bound?: Bound | BoundElsewhere | null;
  /** §V1029 (d): where a measurement that the chain's cost is linear up to its bound is on record. `null`: OWED. */
  readonly measured?: string | null;
  /** What grows is the AUTHOR'S OWN TEXT, measured in a fixture that makes it longer: counted, and nobody's to bound. */
  readonly author?: true;
}
interface Debt extends Row {
  readonly law: "chain";
  /** The task that turns this count into data. */
  readonly task: string;
  /** The largest count the axis reaches: its refusal, or none. */
  readonly largest: Bound | "unbounded";
}

const flat = (why: string, more: Partial<Row> = {}): Row => ({ law: "flat", why, ...more });
const literal = (why: string, more: Partial<Row> = {}): Row => ({ law: "literal", why, ...more });
const noPass = (why: string): Row => ({ law: "no pass", why });
const notACount = (why: string): Row => ({ law: "not a count", why });

/** The task under which what the ledger still owes is tracked. */
const OWED_UNDER = "T1635b";
/** §V1029 (d): the most items a lawful chain may carry a value through. */
const CHAIN_BOUND = 8;
/** An axis with no refusal is compiled this far to see that there is none. */
const UNBOUNDED_PROBE = 64;

/* ---- the fixtures the rows name ---- */

/** A kernel with no input, observed: its own schema and capacity are the whole story. */
const kernelAlone = (type: "pointKernel" | "pointKernelAdvanced", parameters: (count: number) => Record<string, unknown>): Build =>
  (count) => observed([mk("kernel_subject", type, parameters(count))], [], "kernel_subject", "kernel_subject");
/** The advanced kernel's schema: an id beside the position (its flags word is injected). */
const livingSchema = (count: number): string =>
  JSON.stringify([
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    { name: "id", type: "u32", semantic: "id", default: [0] },
    ...named("a", Math.max(0, count - 1)).map((name) => ({ name, type: "vec4f", default: [0, 0, 0, 0] })),
  ]);
/** A kernel whose `struct Params` has `count` fields, and whose `process` reads the first. */
const kernelOfParams = (count: number): string =>
  `${paramsStruct(count)}fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position.x = q.position.x + ctx.params.f00;\n  return q;\n}\n`;
/** A Group predicate naming `count` attributes. */
const predicate = (count: number): string => named("a", count).map((name) => `p.${name}.x >= 0.0`).join(" && ");
/** Sixteen attributes beside `position`, for a predicate or a binding list to name some of. */
const SIXTEEN = schema(17);
/** At the largest capacity a kernel may ask for, every 16-byte attribute is 16 MB of the 128 MiB a binding holds. */
const AT_FULL_CAPACITY = 1_000_000;

/** A Custom WGSL whose own `struct Params` has `count` fields. */
const customOfParams = (count: number): string =>
  `${paramsStruct(count)}@group(0) @binding(0) var inputSampler: sampler;\n@group(0) @binding(1) var inputTexture: texture_2d<f32>;\n@group(0) @binding(3) var<uniform> params: Params;\n` +
  "@fragment\nfn fs(@location(0) uv: vec2f) -> @location(0) vec4f {\n  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0) * params.f00;\n}\n";
/** A Custom WGSL · Multi that reads all three of its extra inputs. */
const CUSTOM_OF_THREE =
  "@group(0) @binding(0) var inputSampler: sampler;\n@group(0) @binding(1) var inputTexture: texture_2d<f32>;\n" +
  "@group(0) @binding(4) var inputTexture1: texture_2d<f32>;\n@group(0) @binding(5) var inputTexture2: texture_2d<f32>;\n@group(0) @binding(6) var inputTexture3: texture_2d<f32>;\n" +
  "@fragment\nfn fs(@location(0) uv: vec2f) -> @location(0) vec4f {\n  let more = textureLoad(inputTexture1, vec2i(0), 0) + textureLoad(inputTexture2, vec2i(0), 0) + textureLoad(inputTexture3, vec2i(0), 0);\n" +
  "  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0) + more;\n}\n";
const SURFACE = "fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {\n  return surfaceDefaults(s);\n}\n";
/** A Material · WGSL whose `struct Params` has `count` fields. */
const materialOfParams = (count: number): string => `${paramsStruct(count)}${SURFACE}`;
/** A Material · WGSL whose `struct Instance` has `count` fields, each with a default. */
const materialOfInstance = (count: number): string => `struct Instance {\n${named("f", count).map((name) => `  ${name}: vec4f, // @default [0, 0, 0, 0]`).join("\n")}\n};\n${SURFACE}`;

/** Sixteen points with attributes of the names given, for a Geometry to draw a mesh at each. */
const instancePoints = (prefix: string) => ({
  nodes: [mk("kernel_places", "pointKernel", { capacity: 16, attributes: schema(17, "vec4f", prefix), kernel: PASS_THROUGH })],
  wires: [],
  last: "kernel_places",
  drivers: ["kernel_places"],
});
const meshInstances = (more: Record<string, unknown> = {}) => () => ({ mode: "instances", shape: "mesh", ...more });
const casting = (kind: "directional" | "point") => () => ({ kind, shadows: true });

/* ---- the rows ---- */

const fold = (type: string): Row => ({
  law: "chain",
  why: "the fold: `acc = blendPixel(acc, sample)` once per layer behind the front one, each layer a texture of its own. A shader cannot index its texture bindings, so the loop form needs a texture array; the form without a chain is one pass per layer, which a stack of Layers is.",
  grows: { [`${type}:#/fs`]: 82 },
  bindings: 1,
  carries: ["acc"],
  bound: { count: 8, code: "node.compile.tooManyInputs" },
  measured: null,
});
const POINT_COUNT = "how many points: uniforms and a buffer's size. A producer's own text does not read its offsets as literals.";
const A_NAME = "one attribute's name, not a list of them.";
const FROM_THE_FILE = "measured from the file by the loader: a fact about one mesh, written by the app.";
const VALUE_NODE = "CPU state of a value node.";
const PACKED_OFFSETS =
  "the byte offset of every packed region is a literal computed from the point count (`regionAccessorWgsl`), so the text is the same size and a different text. The data form is a uniform; a change of count already reallocates the buffers.";
const CARRIED = "one copy statement per component of every attribute the edge carries (`out[k] = blend(in[k], …)`): independent stores. A plain table of regions walked by a loop would do it; the count is the producer's.";
const BY_REFERENCE = "the attributes it does not write are forwarded by reference: its text names only its own.";

const LEDGER: Readonly<Record<string, Row>> = {
  /* compositing */
  "add.in2": fold("add"),
  "composite.in2": fold("over"),
  "difference.in2": fold("difference"),
  "multiply.in2": fold("multiply"),
  "over.in2": fold("over"),
  "screen.in2": fold("screen"),
  "switch.inputs": {
    law: "statements",
    why: "one `switch` arm and one texture binding per input; one arm runs and nothing is carried between them.",
    grows: { "switch:#/sampleInput": [81, 82] },
    bindings: 1,
    bound: { count: 8, code: "node.compile.tooManyInputs" },
  },
  "customWgslMulti.more": flat("at most three extra inputs bind, and only those the author's source declares.", {
    counts: [3, 4, 15, 16],
    build: (count) => {
      const fixture = inputsOf("customWgslMulti", "more", "checker")(count);
      (fixture.graph.nodes["subject"] as NodeJson).parameters["source"] = CUSTOM_OF_THREE;
      return fixture;
    },
  }),
  "customWgsl.source": {
    law: "declarations",
    why: "AUTHOR TEXT: the shader is the author's, its uniform block included. The generator adds nothing per field.",
    members: 1,
    author: true,
    build: (count) => {
      const doc = minimal("customWgsl");
      (doc.nodes["subject"] as NodeJson).parameters["source"] = customOfParams(count);
      return { graph: doc, subject: "subject", drivers: [] };
    },
  },
  "customWgslMulti.source": {
    law: "declarations",
    why: "AUTHOR TEXT: as Custom WGSL.",
    members: 1,
    author: true,
    build: (count) => {
      const doc = minimal("customWgslMulti");
      (doc.nodes["subject"] as NodeJson).parameters["source"] = customOfParams(count);
      return { graph: doc, subject: "subject", drivers: [] };
    },
  },

  /* history: a ring is one texture array and a number */
  "cache.frames": flat("the history is one `texture_2d_array` and the frame count a uniform (T425)."),
  "cache.scale": flat("a size ratio of the ring's textures, not a count.", { counts: [0.125, 0.25, 0.5, 1] }),
  "echo.frames": flat("Cache's ring."),
  "slitScan.frames": flat("Cache's ring, read per pixel."),
  "slitScan.scale": flat("a size ratio of the ring's textures, not a count.", { counts: [0.125, 0.25, 0.5, 1] }),

  /* point producers */
  ...Object.fromEntries(["pointGenerator", "pointGrid", "pointLine", "pointCircle", "pointSphere", "pointTube", "pointTorus", "pointBox"].flatMap((type) => ["count", "cols", "rows"].map((parameter) => [`${type}.${parameter}`, flat(POINT_COUNT)]))),
  "pointsFromTexture.cols": flat(POINT_COUNT),
  "pointsFromTexture.rows": flat(POINT_COUNT),
  "textureToAttribute.count": flat(POINT_COUNT),
  "textureToAttribute.points": flat(BY_REFERENCE),
  "renderPoints.count": flat("how many points are drawn: a draw's instance count."),
  "renderPoints.points": flat("it binds the attributes it draws by, each a region of the producer's buffer; the rest are not its business."),
  "renderPoints.group": {
    law: "statements",
    why: "one storage binding, one member and one load per attribute the predicate names, and the predicate itself (the author's). Each is a region bound on its own, so the stage's eight storage buffers bound it.",
    grows: { "sprites/groupMatch": 18, "sprites/vs": 31 },
    bindings: 1,
    build: (count) => ({
      graph: graphOf(
        [mk("kernel_marks", "pointKernel", { capacity: 16, attributes: SIXTEEN, kernel: PASS_THROUGH }), mk("points_subject", "renderPoints", { group: predicate(count) }), mk("output_main", "output")],
        [
          ["kernel_marks", "out", "points_subject", "points"],
          ["points_subject", "out", "output_main", "input"],
        ],
      ),
      subject: "points_subject",
      drivers: ["kernel_marks"],
    }),
    bound: { count: 7, code: "compiler/binding-budget" },
  },
  "renderInstances.count": flat("how many instances are drawn: a draw's instance count."),
  "renderInstances.points": flat("as Render Points."),
  "renderInstances.group": {
    law: "statements",
    why: "as Render Points' Group.",
    grows: { "instances/groupMatch": 18, "instances/vs": 32 },
    bindings: 1,
    build: (count) => ({
      graph: graphOf(
        [mk("kernel_marks", "pointKernel", { capacity: 16, attributes: SIXTEEN, kernel: PASS_THROUGH }), mk("instances_subject", "renderInstances", { group: predicate(count) }), mk("output_main", "output")],
        [
          ["kernel_marks", "out", "instances_subject", "points"],
          ["instances_subject", "out", "output_main", "input"],
        ],
      ),
      subject: "instances_subject",
      drivers: ["kernel_marks"],
    }),
    bound: { count: 7, code: "compiler/binding-budget" },
  },
  "renderSurface.points": flat("as Render Points."),
  "componentInPoints.in": flat("a component's socket: it forwards the edge."),
  "componentOutPoints.in": flat("a component's socket: it forwards the edge."),
  // T1822b: a Null is spliced out; its consumers read the producer's edge.
  "pointNull.in": flat("a Null: it forwards the edge."),

  /* kernels */
  "pointKernel.in": flat("it reads, by reference, the incoming attributes its own schema shares; the rest of the edge is not in its text."),
  "pointKernel.capacity": literal(PACKED_OFFSETS, { counts: [64, 65, 256, 1023, 1024], build: kernelAlone("pointKernel", (count) => ({ capacity: count, attributes: schema(3), kernel: PASS_THROUGH })) }),
  "pointKernel.attributes": {
    law: "statements",
    why: "the schema is the kernel's type: the author's code names the fields, so each attribute is a `Point` member, a load and a store function, and one load and one store statement in `main`. Nothing is carried between them.",
    grows: { "kernel/main": 64 },
    functions: 2,
    build: kernelAlone("pointKernel", (count) => ({ capacity: 16, attributes: schema(count), kernel: PASS_THROUGH })),
    bound: { count: 8, code: "node.points.capacity", build: kernelAlone("pointKernel", (count) => ({ capacity: AT_FULL_CAPACITY, attributes: schema(count), kernel: PASS_THROUGH })) },
  },
  "pointKernel.kernel": {
    law: "statements",
    why: "the author's `struct Params`: each field is a member of the kernel's uniform block and one argument of the `Params(…)` the generator builds in `main`.",
    grows: { "kernel/main": 19 },
    members: 1,
    build: kernelAlone("pointKernel", (count) => ({ capacity: 16, attributes: schema(2), kernel: kernelOfParams(count) })),
    bound: null,
  },
  "pointKernel.group": {
    law: "statements",
    why: "AUTHOR TEXT: the predicate is pasted into `groupMatch`. The attributes it names are the schema's, already loaded.",
    grows: { "kernel/groupMatch": 18 },
    build: kernelAlone("pointKernel", (count) => ({ capacity: 16, attributes: SIXTEEN, kernel: PASS_THROUGH, group: predicate(count) })),
    author: true,
  },
  "pointKernelAdvanced.capacity": literal(PACKED_OFFSETS, { counts: [64, 65, 256, 1023, 1024], build: kernelAlone("pointKernelAdvanced", (count) => ({ capacity: count, attributes: livingSchema(3), kernel: PASS_THROUGH })) }),
  "pointKernelAdvanced.attributes": {
    law: "statements",
    why: "as the Point Kernel's schema, and one copy statement per component in the compaction's scatter and in the spawn's copy: independent stores.",
    grows: { "kernel/main": 64, "scatter/main": 310, "spawnCopy/main": 326 },
    functions: 2,
    build: kernelAlone("pointKernelAdvanced", (count) => ({ capacity: 16, attributes: livingSchema(count), kernel: PASS_THROUGH })),
    bound: { count: 7, code: "node.points.capacity", build: kernelAlone("pointKernelAdvanced", (count) => ({ capacity: AT_FULL_CAPACITY, attributes: livingSchema(count), kernel: PASS_THROUGH })) },
  },
  "pointKernelAdvanced.attributes/with a spawn hook": {
    law: "statements",
    why: "the hook is a second kernel module over the same schema.",
    grows: { "kernel/main": 64, "scatter/main": [310, 318], "spawnCopy/main": [326, 334], "spawnHook/main": 64 },
    functions: 4,
    build: kernelAlone("pointKernelAdvanced", (count) => ({ capacity: 16, attributes: livingSchema(count), kernel: PASS_THROUGH, spawn: "fn spawn(child: Point, ctx: PointCtx) -> Point {\n  return child;\n}\n" })),
    bound: { via: "pointKernelAdvanced.attributes" },
  },
  "pointKernelAdvanced.kernel": {
    law: "statements",
    why: "as the Point Kernel's `struct Params`.",
    grows: { "kernel/main": 19 },
    members: 1,
    build: kernelAlone("pointKernelAdvanced", (count) => ({ capacity: 16, attributes: livingSchema(2), kernel: kernelOfParams(count) })),
    bound: null,
  },
  "pointKernelAdvanced.group": {
    law: "statements",
    why: "AUTHOR TEXT: as the Point Kernel's Group.",
    grows: { "kernel/groupMatch": 18 },
    build: kernelAlone("pointKernelAdvanced", (count) => ({ capacity: 16, attributes: livingSchema(17), kernel: PASS_THROUGH, group: predicate(count) })),
    author: true,
  },
  "pointKernelAdvanced.spawn": notACount("AUTHOR TEXT: the hook's own source. What is generated round it grows with the schema, and that is the row above."),

  /* the curve family */
  "pointCurve.in": { law: "statements", why: CARRIED, grows: { "curve:catmullRom:wired:#x#/main": [528, 541] }, bound: { via: "pointKernel.attributes" } },
  "pointCurve.segments": literal(PACKED_OFFSETS, {
    build: (count) => observed([mk("curve_subject", "pointCurve", { segments: count })], [], "curve_subject", "curve_subject"),
  }),
  "pointCurve.points": {
    law: "statements",
    why: "the authored table: a uniform member and a `switch` arm per control point, because a uniform value cannot carry an array of rows (§T1640b). One arm runs.",
    grows: { "curve:catmullRom:table:#x#/tableRow": [35, 37] },
    members: 1,
    counts: [2, 3, 4, 15, 16],
    build: (count) => observed([mk("curve_subject", "pointCurve", { segments: 4, points: JSON.stringify(Array.from({ length: count }, (_, index) => [index, 0, 0])) })], [], "curve_subject", "curve_subject"),
    bound: { count: 64, code: "node.points.curve" },
  },
  "pointCurve.startOrient": notACount(A_NAME),
  "pointCurveFrames.points": flat(BY_REFERENCE),
  "pointCurveFrames.seedOrient": notACount(A_NAME),
  "pointResample.points": { law: "statements", why: CARRIED, grows: { "resample:emit:count:length:start:#x#/main": [621, 633] }, bound: { via: "pointKernel.attributes" } },
  "pointResample.count": literal(PACKED_OFFSETS, { build: numberOver("pointResample", "points", "count") }),
  "pointResample.maxPoints": flat("a buffer's size.", { build: numberOver("pointResample", "points", "maxPoints") }),
  "pointResample.curvatureAttribute": notACount(A_NAME),
  "pointSweep.points": { law: "statements", why: CARRIED, grows: { "sweep:ring:stretch:#x#/main": [262, 266] }, bound: { via: "pointKernel.attributes" } },
  "pointSweep.profile": flat("the profile's positions are read by name."),
  "pointSweep.sides": literal(PACKED_OFFSETS),
  "pointRope.in": flat(BY_REFERENCE),
  "pointRope.pinAttribute": notACount(A_NAME),
  "pointTransform.points": flat(BY_REFERENCE),
  "pointRange.points": flat("it reads the one attribute it is told to."),
  "pointRange.attribute": notACount(A_NAME),
  "pointRay.points": flat(BY_REFERENCE),
  "pointRay.steps": literal("the march's step count is a loop bound and a divisor, both literals."),
  "pointProximity.points": flat("it reads positions."),
  "pointProximity.neighbors": literal("K is a constant and the size of two local arrays: a WGSL array's length is part of its type."),
  "pointGather.links": flat("the adjacency's schema is fixed."),
  "pointGather.points": flat("it reads the one attribute it gathers."),
  "pointGather.attribute": notACount(A_NAME),
  "pointGather.output": notACount(A_NAME),
  "laserPath.points": flat("it reads positions and colours by name."),
  "laserPath.slots": literal("slots per point is a constant of the text."),
  "laserOut.points": flat("a sink: it reads the plan the Laser Path wrote."),

  /* topology and meshes */
  "pointTopology.points": flat("a claim about the edge: no pass."),
  "pointTopology.cols": flat("a claim about the edge: no pass."),
  "pointTopology.rows": flat("a claim about the edge: no pass."),
  "pointTopology.sheets": {
    law: "branch",
    why: "a grid of several sheets is drawn by a variant of the grid chunks that reads the sheet off the vertex index; one sheet keeps the program it always had (T1587b slice 2). How many sheets is a uniform.",
    build: (count) =>
      scene({
        points: {
          nodes: [mk("kernel_sheets", "pointKernel", { capacity: 12 * count, attributes: schema(1), kernel: PASS_THROUGH }), mk("topology_sheets", "pointTopology", { connectivity: "grid", cols: 4, rows: 3, sheets: count })],
          wires: [["kernel_sheets", "out", "topology_sheets", "points"]],
          last: "topology_sheets",
          drivers: ["kernel_sheets"],
        },
        light: casting("directional"),
      }),
  },
  "meshFileIn.vertices": flat(FROM_THE_FILE),
  "meshFileIn.triangles": flat(FROM_THE_FILE),
  "meshFileIn.clipFrames": flat(FROM_THE_FILE),
  "meshFileIn.clipRate": flat("a rate: a uniform."),
  "meshFileIn.select": notACount("a selection over the file's names; what it selects is measured by the loader."),
  "meshFileIn.parts": notACount(FROM_THE_FILE),
  "meshFileIn.bounds": notACount(FROM_THE_FILE),
  "meshFileIn.clip": notACount("one clip's name."),
  "meshFileIn.clips": notACount(FROM_THE_FILE),
  "meshFileIn.joints": notACount(`${FROM_THE_FILE} The clip pass's text is a constant: joints are rows of a fed buffer and their count a uniform.`),
  "meshFileIn.lamps": flat("up to eight lamp groups: eight gain slots in a constant text, and the group of each vertex in a fed buffer.", {
    counts: [1, 2, 4, 7, 8],
    build: (count) => {
      const doc = minimal("meshFileIn");
      (doc.nodes["subject"] as NodeJson).parameters = { ...MESH, lamps: named("lamp", count).join(", ") };
      return { graph: doc, subject: "subject", drivers: [] };
    },
    bound: { count: 8, code: "node.mesh.lamps" },
  }),

  /* the scene */
  "light.shadowSoftness": literal("the PCF radius is the bound of two loops and a divisor.", { build: (count) => scene({ light: () => ({ kind: "directional", shadows: true, shadowSoftness: count }) }) }),
  "light.shadowBias": literal("a distance, not a count: written into the lookup as a literal.", { counts: [0.01, 0.02, 0.04, 0.08], build: (count) => scene({ light: () => ({ kind: "directional", shadows: true, shadowBias: count }) }) }),
  "light.shadowCasters": flat("which geometries a light's sweep draws.", {
    passes: 1,
    build: (count) => scene({ geometries: 16, light: () => ({ kind: "directional", shadows: true, shadowCasters: named("geometry_g", count).join(" ") }) }),
  }),
  "light.shadowExclude": flat("which geometries a light's sweep leaves out.", {
    passes: -1,
    /* Fifteen of sixteen at most: with every geometry left out the sweep draws nothing, and its text leaves the plan. */
    counts: [1, 2, 4, 14, 15],
    build: (count) => scene({ geometries: 16, light: () => ({ kind: "directional", shadows: true, shadowExclude: named("geometry_g", count).join(" ") }) }),
  }),
  /* T1589b: a Light in Points mode, and the Render's light table. Every light of the app becomes a row of that table (T1623b), so these rows are what the path must keep. */
  "light.points": flat("a Light in Points mode reads the attributes it maps, by name; the others on the edge reach no text of the Light's or of the Render's.", {
    build: (count) => lampSets({ attributes: count }),
  }),
  "light.points/how many points": flat(
    "the count of LIGHTS. The Render's gather, its grid build and its lit draw take every bound from the table's header (rows, words a cell, where the cells start), and the Light's resolve from a uniform: one text each at 64, 128, 256, 960 and 1,024 lights.",
    { build: (count) => lampSets({ points: count * 32, attributes: 3 }) },
  ),
  "light.points/how many points, under a map": literal(
    "the Light's own resolve reads a mapped attribute through the packed accessor, whose byte offset is a literal computed from the point count (`packedAccessorWgsl`): the same size, a different text. The Render's three texts stay one.",
    { build: (count) => lampSets({ points: count * 32, attributes: 3, light: { color: mapOf("a01", [1, 1, 1, 1]) } }) },
  ),
  "geometry.points": flat("a draw binds the attributes it draws by; the Render's text names none of the others."),
  "geometry.mesh": flat("as Points."),
  "geometry.shadowMesh": flat("as Points: a shadow sweep binds the position and the normal of the mesh it draws, whatever else that mesh carries (T1689b)."),
  "geometry.endpoint": notACount(A_NAME),
  "geometry.group": {
    law: "statements",
    why: "primitive instances, points and beams: one storage binding, one member and one load per attribute the predicate names, and the predicate itself (the author's).",
    grows: { "scene:#/groupMatch": 18, "scene:#/vs": 32 },
    bindings: 1,
    build: (count) => scene({ points: { nodes: [mk("kernel_marks", "pointKernel", { capacity: 16, attributes: SIXTEEN, kernel: PASS_THROUGH })], wires: [], last: "kernel_marks", drivers: ["kernel_marks"] }, geometry: () => ({ mode: "instances", group: predicate(count) }) }),
    bound: { count: 7, code: "compiler/binding-budget" },
  },
  "geometry.instanceAttributes": {
    law: "statements",
    why: "a bound field of the material's `struct Instance` is an accessor and a copy in the resolve pass, and an accessor in the lit draw.",
    grows: { "geometry_g00:instances:resolve/resolve": [37, 39], "scene:#/fs": 4 },
    functions: 3,
    build: (count) =>
      scene({
        points: instancePoints("a"),
        shape: true,
        material: ["materialWgsl", { source: materialOfInstance(16) }],
        geometry: meshInstances({ instanceAttributes: Array.from({ length: count }, (_, index) => `f${two(index)} = a${two(index)}`).join("\n") }),
      }),
    bound: null,
  },
  "materialWgsl.source": {
    law: "statements",
    why: "the author's `struct Params`: each field is a member of the lit draw's uniform block and one argument of the `Params(…)` the generator hands `surface`.",
    grows: { "scene:#/fs": 14 },
    members: 1,
    build: (count) => scene({ material: ["materialWgsl", { source: materialOfParams(count) }] }),
    bound: null,
  },
  "materialWgsl.source/Instance fields on mesh instances": {
    law: "statements",
    why: "the author's `struct Instance`: as Instance Attributes, each field bound by its name.",
    grows: { "geometry_g00:instances:resolve/resolve": [37, 39], "scene:#/fs": 31 },
    functions: 3,
    build: (count) => scene({ points: instancePoints("f"), shape: true, material: ["materialWgsl", { source: materialOfInstance(count) }], geometry: meshInstances() }),
    bound: null,
  },
  "render.scenes": flat("a draw per geometry in every sweep, all of one text: the text is keyed by what a geometry is, not by which one.", { passes: 1, build: (count) => scene({ geometries: count }) }),
  "render.scenes/under a casting light": flat("and one draw in the light's sweep.", { passes: 2, build: (count) => scene({ geometries: count, light: casting("directional") }) }),
  "render.scenes/primitive instances under a casting light": flat("the instances generator and its depth sweep.", { passes: 2, build: (count) => scene({ geometries: count, light: casting("directional"), geometry: () => ({ mode: "instances" }) }) }),
  "render.scenes/file meshes under a casting point light": flat("an indexed mesh: six sweeps of the cube.", { passes: 7, build: (count) => scene({ geometries: count, points: "mesh", light: casting("point") }) }),
  "render.scenes/mesh instances": flat("a mesh at every point: a resolve dispatch per geometry.", { passes: 2, build: (count) => scene({ geometries: count, points: instancePoints("a"), shape: true, geometry: meshInstances() }) }),
  "render.scenes/glass": flat("transmissive surfaces draw after the pyramid.", { passes: 1, build: (count) => scene({ geometries: count, material: ["materialGlass"] }) }),
  "render.scenes/glass on a file mesh": flat("as glass.", { passes: 1, build: (count) => scene({ geometries: count, points: "mesh", material: ["materialGlass"] }) }),
  "render.scenes/glass on primitive instances": flat("as glass.", { passes: 1, build: (count) => scene({ geometries: count, material: ["materialGlass"], geometry: () => ({ mode: "instances" }) }) }),
  "render.lights": flat(
    "T1623b slice 3: a Light in Single mode that does not cast is one ROW of the Render's light table, written as values (the buffer-values seam) and walked by loops whose bounds are read from the table's header. The lit text, the gather's and the grid build's are each one string at every count and every mix of kinds; a Light more is a write. Was §B260's chain: one block of 1,885 bytes a Light, each adding into `lit`.",
    { build: (count) => scene({ lights: count }) },
  ),
  "render.lights/Lights in Points mode": flat(
    "T1589b, T1628b: each such Light resolves its records into a buffer of its own (two Renders that list one Light resolve it once), and the Render gathers each set by a PASS of its own, all of one text (§V1029 c): the set is a binding and where its rows go is a value. So a Light is two passes, its resolve and its gather, and no text. The lit draw and the grid build are one text whatever the Lights. Was one gather that bound every set: a binding, a uniform row, four accessors and a copy block of 357 bytes a Light, refused past seven.",
    { passes: 2, build: (count) => lampSets({ sets: count }) },
  ),
  "render.environmentTaps": literal("the specular cone's tap count is a loop bound and a divisor.", { build: (count) => scene({ environment: true, render: { environmentTaps: count } }) }),
  "render.environmentTaps/prefiltered": flat("the prefiltered environment takes no taps.", { build: (count) => scene({ environment: true, render: { environmentFilter: "prefiltered", environmentTaps: count } }) }),
  "feedback.source": notACount("one node's name."),

  /* value nodes */
  "panel.controls": noPass(VALUE_NODE),
  "panel.board": noPass(VALUE_NODE),
  "presets.presets": noPass(VALUE_NODE),
  "presets.morphs": noPass(VALUE_NODE),
  "cueList.cues": noPass(VALUE_NODE),
  "automation.lanes": noPass(VALUE_NODE),
  "midiIn.mapping": noPass(VALUE_NODE),
  "valueExpression.in": noPass(VALUE_NODE),
};

const lightBlocks = (more: Partial<Debt>): Debt => ({
  law: "chain",
  task: "T1623b",
  why: "one block of text per Light, each adding into the one `lit` of the fragment function: §B260 itself. A block's work sits under a test of its own light (the stopgap: above eight lights in a text with no light table, at every count beside the table's walk), and it still adds into `lit`.",
  carries: ["lit"],
  largest: "unbounded",
  ...more,
});

const NOT_YET_DATA: Readonly<Record<string, Debt>> = {
  /* R1 of the audit, the surface generator's block for a Light that does not cast (1,885 bytes
     for the second light), is PAID: T1623b slice 3 made it a row, and `render.lights` is in
     LEDGER, flat. What is left of R1 is the two casting rows below. */
  /* R2: the instances generator's own copy of the block. 1,823 bytes for the second light; the sixteenth wears its guard (36) and a longer index. */
  "render.lights/primitive instances": lightBlocks({ grows: { "scene:#/fs": [1823, 1862] }, members: 3, build: (count) => scene({ lights: count, geometry: () => ({ mode: "instances" }) }) }),
  /* R4: a casting light's lookup sits inside its block, with a shadow map and a sweep of its own.
     T1623b slice 3: beside the light table's walk every block wears its guard from the first
     (36 bytes), so the second light adds what the sixteenth did less its longer index: the
     smaller of the two numbers rose from 3,860 (3,835 for a point light) and the larger did
     not move. The guard is what keeps the chain from forming (§B260); the text per light is
     the debt, and it goes with slices 4 and 5. */
  "render.lights/casting": lightBlocks({
    grows: { "scene:#/fs": [3896, 3902] },
    members: 4,
    bindings: 1,
    passes: 2,
    build: (count) => scene({ lights: count, light: casting("directional") }),
    largest: { count: 16, code: "compiler/binding-budget" },
  }),
  "render.lights/casting point lights": lightBlocks({
    grows: { "scene:#/fs": [3871, 3885] },
    members: 10,
    bindings: 1,
    passes: 7,
    build: (count) => scene({ lights: count, light: casting("point") }),
    largest: { count: 16, code: "compiler/binding-budget" },
  }),
  "render.projectors": {
    law: "chain",
    task: "T1623b",
    why: "R3: one block of text per Projector, appended to the lights' and adding into the same `lit`. Its addition sits under two tests of the fragment's own place, which §B260 measured as keeping it out of the cliff; it is still text per item.",
    grows: { "scene:#/fs": [971, 977] },
    members: 4,
    carries: ["lit"],
    largest: "unbounded",
    build: (count) => scene({ projectors: count }),
  },
  "render.projectors/with a cookie and occlusion": {
    law: "chain",
    task: "T1623b",
    why: "R3 with its textures: two bindings and a depth sweep each, so sixteen sampled textures a stage bound it.",
    grows: { "scene:#/fs": 1359 }, // VNB11: the occlusion compare is one shared function, each projector a call,
    members: 4,
    bindings: 2,
    passes: 2,
    carries: ["lit"],
    largest: { count: 8, code: "compiler/binding-budget" },
    build: (count) => scene({ projectors: count, cookies: true, projector: { occlusion: true } }),
  },
};

/* ------------------------------------------------------------------------------------ */
/* the audit of a ledger against the registry                                            */
/* ------------------------------------------------------------------------------------ */

interface Audit {
  readonly problems: string[];
  readonly owed: string[];
  readonly table: string[];
}

const HOW =
  "Rows are in src/compiler/generated-text-growth.test.ts. A count the author raises is data (§V1029): rows in a buffer walked by a loop, a count in a uniform, a loop region in the plan. " +
  "If the text must depend on it, the row states the law and its exact numbers per item, and why.";

function defaultCounts(axis: Axis | undefined, limit: number): number[] {
  const low = Math.max(1, Math.ceil(axis?.min ?? 1));
  const high = Math.min(16, limit, axis?.max ?? Number.POSITIVE_INFINITY);
  return [...new Set([low, low + 1, 4, high - 1, high])].filter((count) => count >= low && count <= high).sort((a, b) => a - b);
}
const show = (observed: Observed): string => {
  const parts = [`law: "${observed.law}"`];
  const figure = (value: PerItem): string => (typeof value === "number" ? String(value) : `[${value[0]}, ${value[1]}]`);
  for (const key of ["passes", "members", "bindings", "functions"] as const) if (observed[key] !== 0) parts.push(`${key}: ${figure(observed[key])}`);
  if (Object.keys(observed.grows).length > 0) parts.push(`grows: { ${Object.entries(observed.grows).map(([key, value]) => `"${key}": ${figure(value)}`).join(", ")} }`);
  if (observed.carries.length > 0) parts.push(`carries: [${observed.carries.map((name) => `"${name}"`).join(", ")}]`);
  return `{ ${parts.join(", ")} }`;
};
const sameFigure = (a: PerItem, b: PerItem): boolean => JSON.stringify(a) === JSON.stringify(b);

function audit(axes: readonly Axis[], ledger: Readonly<Record<string, Row>>, debts: Readonly<Record<string, Debt>>): Audit {
  const problems: string[] = [];
  const owed: string[] = [];
  const table: string[] = [];
  const axisOf = new Map(axes.map((axis) => [axis.key, axis]));
  const baseOf = (key: string): string => key.split("/")[0] as string;
  const rows: Array<[string, Row | Debt]> = [...Object.entries(ledger), ...Object.entries(debts)];
  const keys = new Set(rows.map(([key]) => key));

  for (const key of Object.keys(ledger)) if (Object.hasOwn(debts, key)) problems.push(`${key} is in LEDGER and in NOT_YET_DATA. A row is in one of them.`);
  for (const axis of axes) {
    if (keys.has(axis.key)) continue;
    /* Say what it measures where that can be found without a fixture of its own, so the row can be written from the failure. */
    let measures = "It has no generic fixture: its row needs a `build`.";
    const build = generic(axis);
    const counts = defaultCounts(axis, Number.POSITIVE_INFINITY);
    if (build !== undefined && counts.length >= 2) {
      try {
        const found = find(build, counts);
        measures = found.refused.length > 0 ? `Its generic fixture does not compile at ${found.refused.map((refusal) => refusal.count).join(", ")}: its row needs a \`build\`.` : `With the generic fixture it measures ${show(found.observed)} at ${counts.join(", ")} items.`;
      } catch (error) {
        measures = `Its generic fixture fails (${error instanceof Error ? error.message : String(error)}): its row needs a \`build\`.`;
      }
    }
    problems.push(`${axis.key} is an axis a document can raise a count along (${axis.kinds.join(", ")}) and has no row. ${HOW} Add \`"${axis.key}": …\` to LEDGER. ${measures}`);
  }
  for (const [key] of rows) {
    if (!axisOf.has(baseOf(key))) problems.push(`The row "${key}" names no axis the registry has: the port or parameter is gone, or renamed. Remove the row, or rename it.`);
  }

  for (const [key, row] of rows) {
    const axis = axisOf.get(baseOf(key));
    if (axis === undefined) continue;
    const debt = Object.hasOwn(debts, key) ? (row as Debt) : undefined;
    const limit = debt !== undefined ? (debt.largest === "unbounded" ? Number.POSITIVE_INFINITY : debt.largest.count) : row.bound !== undefined && row.bound !== null && "count" in row.bound ? row.bound.count : Number.POSITIVE_INFINITY;
    const boundText = debt !== undefined ? (debt.largest === "unbounded" ? "unbounded" : `${debt.largest.count} (${debt.largest.code})`) : row.bound === undefined ? (axis.max !== undefined && axis.kinds.includes("number") ? `${axis.max} (the parameter's maximum)` : "-") : row.bound === null ? "none: OWED" : "via" in row.bound ? `that of ${row.bound.via}` : `${row.bound.count} (${row.bound.code})`;

    if (row.law === "no pass") {
      const outputs = (definitionOf(axis.type) as unknown as DefinitionShape).outputs ?? [];
      const reaches = outputs.filter((output) => output.type?.kind !== "value").map((output) => output.id);
      if (reaches.length > 0) problems.push(`${key} is ledgered "no pass", and ${axis.type} has an output that is not a value (${reaches.join(", ")}): what it holds can reach a shader. Give the row a law and a fixture.`);
      table.push(`${key} | no pass | - | none: nothing reaches a shader`);
      continue;
    }
    if (row.law === "not a count") {
      table.push(`${key} | not a count | - | none: ${row.why}`);
      continue;
    }

    const build = row.build ?? (key === axis.key ? generic(axis) : undefined);
    if (build === undefined) {
      problems.push(`${key} (${axis.kinds.join(", ")}) has no generic fixture: its row needs a \`build\` that makes a graph with that many items, or the law "not a count" with the reason.`);
      continue;
    }
    const counts = row.counts ?? defaultCounts(axis, limit);
    if (counts.length < 2) {
      problems.push(`${key} is compiled at ${counts.join(", ")}: one count shows no law. Give the row \`counts\`.`);
      continue;
    }
    let finding: Finding;
    try {
      finding = find(build, counts);
    } catch (error) {
      problems.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const refusal of finding.refused) {
      problems.push(`${key} does not compile at ${refusal.count} (${refusal.codes.join(", ")}): a row is measured where its graph compiles. Fix the fixture, or state the bound.`);
    }
    if (finding.refused.length > 0) continue;
    const observed = finding.observed;
    const stated: Observed = {
      law: row.law,
      passes: row.passes ?? 0,
      members: row.members ?? 0,
      bindings: row.bindings ?? 0,
      functions: row.functions ?? 0,
      grows: row.grows ?? {},
      carries: row.carries ?? [],
    };
    const differs =
      observed.law !== stated.law ||
      !(["passes", "members", "bindings", "functions"] as const).every((name) => sameFigure(observed[name], stated[name])) ||
      JSON.stringify(Object.entries(observed.grows).sort()) !== JSON.stringify(Object.entries(stated.grows).sort()) ||
      JSON.stringify(observed.carries) !== JSON.stringify([...stated.carries].sort());
    if (differs) {
      const worse = observed.law === "chain" && stated.law !== "chain";
      const longest = (grows: Readonly<Record<string, PerItem>>): number => Object.values(grows).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : Math.max(value[0], value[1])), 0);
      const grew = debt !== undefined && observed.law === "chain" && longest(observed.grows) > longest(stated.grows);
      problems.push(
        `${key} measures ${show(observed)} at ${counts.join(", ")} items, and its row says ${show(stated)}. ` +
          (worse
            ? `THE TEXT OF ONE ITEM NOW CARRIES ${observed.carries.join(", ")} ACROSS ITEMS: that is §B260's shape. Walk the items in a loop with a run-time count instead. `
            : grew
              ? "THIS DEBT GREW: the text one item adds is longer than NOT_YET_DATA allows, and a debt only goes down. "
              : observed.law === "a new text per item"
                ? "Every item brings a shader text of its own; items share one text and differ by data. "
                : "") +
          `${HOW} If the change is meant, the row becomes the measured one, in the commit that says why.`,
      );
    }

    /* §V1029's exceptions, by the measured law. */
    let exception = "none: flat";
    if (observed.law === "chain") {
      if (debt !== undefined) {
        exception = `NOT YET DATA (${debt.task})`;
      } else {
        exception = "(d) a bounded chain";
        const bound = row.bound;
        if (bound === undefined || bound === null || !("count" in bound) || bound.count > CHAIN_BOUND) {
          problems.push(
            `${key} is a chain (it carries ${observed.carries.join(", ")} across items) and is in LEDGER without a refusal by name at ${CHAIN_BOUND} items or fewer. ` +
              `§V1029 (d) allows a chain only under such a bound; otherwise it belongs in NOT_YET_DATA with the task that turns its count into data.`,
          );
        }
        if (row.measured === undefined) problems.push(`${key} is a chain under §V1029 (d) and its row has no \`measured\`: name where its cost was measured linear up to the bound, or write \`measured: null\` to say it is owed.`);
        else if (row.measured === null) owed.push(`OWED (${OWED_UNDER}): ${key} is a chain bounded at ${bound !== undefined && bound !== null && "count" in bound ? bound.count : "?"}, with no measurement on record that its cost is linear up to the bound.`);
      }
    } else if (debt !== undefined) {
      problems.push(`${key} is in NOT_YET_DATA and no longer measures as a chain (${show(observed)}): the debt is paid. Move the row to LEDGER with the law it has now.`);
    } else if ((observed.law === "statements" || observed.law === "declarations") && row.author === true) {
      exception = "none: the author's own text";
    } else if (observed.law === "statements" || observed.law === "declarations") {
      exception = "(b) a declaration per item";
      if (row.bound === undefined) problems.push(`${key} grows per item (${observed.law}) and its row states no \`bound\`. §V1029 (b) wants a refusal by name at a stated count: give \`bound\`, \`{ via: "<the axis whose count this is>" }\`, or \`null\` to say none exists yet.`);
      else if (row.bound === null) owed.push(`OWED (${OWED_UNDER}): ${key} grows per item (${observed.law}) with no refusal by name at a stated count.`);
      else if ("via" in row.bound) {
        const other = ledger[row.bound.via];
        if (other === undefined || other.bound === undefined || other.bound === null || !("count" in other.bound)) problems.push(`${key} says its bound is that of "${row.bound.via}", and that row states no tested bound.`);
      }
    } else if (observed.law === "literal") {
      exception = "none in §V1029: a count written as a literal";
    } else if (observed.law === "branch") {
      exception = "none: two texts, one item or several";
    } else if (observed.passes !== 0) {
      exception = "(c) a pass per item, one text";
    }

    /* The bound is tested, not trusted. */
    const tested = debt !== undefined ? (debt.largest === "unbounded" ? undefined : debt.largest) : row.bound !== undefined && row.bound !== null && "count" in row.bound ? row.bound : undefined;
    try {
      if (tested !== undefined) {
        const reach = tested.build ?? build;
        const within = measure(reach(tested.count));
        const beyond = measure(reach(tested.count + 1));
        if (!within.ok) problems.push(`${key} states a bound of ${tested.count} and does not compile at ${tested.count}: ${within.errors.map((entry) => entry.code).join(", ")}.`);
        if (!beyond.errors.some((entry) => entry.code === tested.code)) {
          problems.push(`${key} states that ${tested.count + 1} items are refused as "${tested.code}", and compiling ${tested.count + 1} gives ${beyond.ok ? "no refusal" : beyond.errors.map((entry) => entry.code).join(", ")}. A bound nobody enforces is not one.`);
        }
      } else if (debt !== undefined) {
        const far = measure(build(UNBOUNDED_PROBE));
        if (!far.ok) problems.push(`${key} is ledgered "unbounded" and ${UNBOUNDED_PROBE} items are refused (${far.errors.map((entry) => entry.code).join(", ")}): it has a bound now. State it as \`largest\`.`);
      }
    } catch (error) {
      problems.push(`${key}, at its bound: ${error instanceof Error ? error.message : String(error)}`);
    }
    table.push(`${key} | ${observed.law}${Object.keys(observed.grows).length > 0 ? ` ${Object.entries(observed.grows).map(([name, bytes]) => `${name} +${typeof bytes === "number" ? bytes : bytes.join("/")}`).join(", ")}` : ""}${observed.passes !== 0 ? `, passes ${typeof observed.passes === "number" ? observed.passes : observed.passes.join("/")}` : ""} | ${boundText} | ${exception}`);
  }
  return { problems, owed, table: table.sort() };
}

/**
 * §V1029 (a) — A COUNT THE DEFINITION FIXES, where it is written out as a chain.
 *
 * No axis reaches such a count (the document cannot raise it), so it is found another way:
 * every node type's minimal graph is compiled, and a function that writes ONE accumulation
 * out more than `CHAIN_BOUND` times outside a loop has to be named here, `<function>: <name>`,
 * with exactly how many times and why it is not a loop. A new one fails by name; so does a
 * row for one that is gone, or one whose length changed.
 */
const FIXED_BY_DEFINITION: Readonly<Record<string, { readonly times: number; readonly why: string }>> = {
  "perlin4: acc": {
    times: 16,
    why: "the sixteen corners of 4D Perlin noise (`PERLIN_4_CORNERS`, noise.wgsl.ts), unrolled on purpose: measured about 40 % lower GPU time on Metal than the loop it replaced, and no parameter reaches the sixteen.",
  },
};

/* Compiled once, when the file loads: the rows, and then which generators they made run. */
const RESULT = audit(AXES, LEDGER, NOT_YET_DATA);
const GENERATORS_RUN = generatedTextCounts().byGenerator;

const FIVE: readonly number[] = [1, 2, 4, 15, 16];
const only = (...keys: string[]): Axis[] => AXES.filter((axis) => keys.includes(axis.key));

describe("§V1029: what one more item adds is read for what it carries", () => {
  const block = (index: number, guarded: boolean): string[] => [
    "  {",
    `    let lightMeta = params.light${index}Meta;`,
    ...(guarded ? ["    if (lightMeta.y != 0.0) {"] : []),
    "    var toLight: vec3f;",
    "    var attenuation = 1.0;",
    "    if (lightMeta.x < 0.5) {",
    "      toLight = normalize(-lightVector.xyz);",
    "    } else {",
    "      attenuation = attenuation * 0.5;",
    "    }",
    "    lit += radiance * attenuation;",
    ...(guarded ? ["    }"] : []),
    "  }",
  ];

  it("a block that adds into a `lit` it did not declare carries it, under a test of its own or not", () => {
    expect(carriedNames(block(1, false))).toEqual(["lit"]);
    /* §B260's stopgap puts the work under `if (lightMeta.y != 0.0)`: the run is ended, the text per light is not. */
    expect(carriedNames(block(1, true))).toEqual(["lit"]);
    expect(carriedNames(["  acc = blendPixel(acc, textureSampleLevel(backTexture1, inputSampler, uv, 0.0));"])).toEqual(["acc"]);
    expect(carriedNames(["  total = total + sample;", "  count++;"])).toEqual(["count", "total"]);
  });

  it("a block that writes what it declared, or stores without reading back, carries nothing", () => {
    expect(carriedNames(["  p.a01 = pointLoad_a01(index);", "  pointStore_a01(index, q.a01);"])).toEqual([]);
    expect(carriedNames(["  {", "    var shadow = 1.0;", "    shadow = shadow * 0.5;", "    matte.x = 1.0 - shadow;", "  }"])).toEqual([]);
    expect(carriedNames(["  out_points[320u + slot * 4u] = in_points[320u + index * 4u];"])).toEqual([]);
    expect(carriedNames(["    case 1u: { return textureSampleLevel(inputTexture1, inputSampler, uv, 0.0); }"])).toEqual([]);
    expect(carriedNames(["  for (var i = 0; i < 4; i = i + 1) {", "    let x = f32(i);", "  }"])).toEqual([]);
  });

  it("follows scopes: a tap count named `lit` one scope in is the block's own, and the `lit +=` after it is not", () => {
    const taps = ["    {", "      var lit = 0.0;", "      for (var ox = -1; ox <= 1; ox = ox + 1) {", "        lit = lit + 1.0;", "      }", "      shadow = lit / 3.0;", "    }"];
    expect(carriedNames(["  {", "    var shadow = 1.0;", ...taps, "    matte.x = 1.0 - shadow;", "  }"])).toEqual([]);
    expect(carriedNames(["  {", "    var shadow = 1.0;", ...taps, "    lit += radiance * shadow;", "  }"])).toEqual(["lit"]);
  });

  it("finds the block one more item appended, whole, though it shares its first and last lines with its neighbours", () => {
    const body = (blocks: number): string => ["{", "  var lit = vec3f(0.0);", ...Array.from({ length: blocks }, (_, index) => block(index, false)).flat(), "  {", "    lit += environment;", "  }", "  return lit;", "}"].join("\n");
    expect(addedLines(body(1), body(2))).toEqual(block(1, false));
    expect(addedLines(body(2), body(3))).toEqual(block(2, false));
  });

  it("finds the lines added in two places of one function", () => {
    const main = (attributes: number): string =>
      ["{", "  var p: Point;", ...named("a", attributes).map((name) => `  p.${name} = load_${name}(index);`), "  let q = process(p, ctx);", ...named("a", attributes).map((name) => `  store_${name}(index, q.${name});`), "}"].join("\n");
    expect(addedLines(main(2), main(3))).toEqual(["  p.a02 = load_a02(index);", "  store_a02(index, q.a02);"]);
  });

  it("counts how many times a function writes one accumulation out, and not the stages a value passes through", () => {
    const module = (body: string[]): string => ["fn noise(p: vec4f) -> f32 {", "  var acc = 0.0;", ...body, "  return acc;", "}"].join("\n");
    const corner = (k: number): string[] => ["  {", `    let k = ${k}u;`, "    acc = acc + weight(k) * dot(gradient(k), p);", "  }"];
    expect(writtenOut(module([0, 1, 2].flatMap(corner)))).toEqual([{ function: "noise", name: "acc", times: 3 }]);
    /* A loop is the data form: its body is written once however often it runs. */
    expect(writtenOut(module(["  for (var k = 0u; k < 16u; k = k + 1u) {", "    acc = acc + weight(k) * dot(gradient(k), p);", "  }"]))).toEqual([]);
    /* Three different stages of one value are each written once. */
    expect(writtenOut(module(["  acc = scale(acc);", "  acc = rotate(acc);", "  acc = acc - offset;"]))).toEqual([{ function: "noise", name: "acc", times: 1 }]);
  });

  it("reads a function's length as written and its code with comments blanked", () => {
    const module = "fn fs() -> vec4f {\n  /* a brace in prose: } */\n  return vec4f(0.0); // and one more }\n}\nfn other() {}";
    const bodies = functionBodies(module);
    expect([...bodies.keys()]).toEqual(["fs", "other"]);
    expect(bodies.get("fs")?.text).toBe("{\n  /* a brace in prose: } */\n  return vec4f(0.0); // and one more }\n}");
    expect(bodies.get("fs")?.code).not.toContain("prose");
    expect(withoutLiterals("light10Meta + pk_1[256u + slot * 4u] * 1.5e3")).toBe("light10Meta + pk_1[# + slot * #] * #");
  });
});

describe("§V1029: the positive control, before anything is trusted green (§V968)", () => {
  /* The Surface generator's blocks for Lights that do not cast were the control here until
     T1623b slice 3 made them rows. The instances generator still unrolls one a Light. */
  const instancesUnder: Build = (count) => scene({ lights: count, geometry: () => ({ mode: "instances" }) });

  it("classes a Render of primitive instances as a chain through `lit`, at 1,823 bytes for the second light", () => {
    const found = find(instancesUnder, FIVE);
    expect(found.refused).toEqual([]);
    expect(found.observed.law).toBe("chain");
    expect(found.observed.carries).toEqual(["lit"]);
    expect(found.observed.grows).toEqual({ "scene:#/fs": [1823, 1862] });
    expect(found.observed.members).toBe(3);
  });

  it("classes the guarded blocks above eight lights as a chain too: the stopgap ends the run, not the text per light", () => {
    const lit = (count: number): string => measure(instancesUnder(count)).texts.get("scene:#") ?? "";
    expect(lit(2)).not.toContain("if (lightMeta.y != 0.0)");
    expect(lit(16)).toContain("if (lightMeta.y != 0.0)");
    const found = find(instancesUnder, [15, 16]);
    expect(found.observed.law).toBe("chain");
    expect(found.observed.carries).toEqual(["lit"]);
  });

  it("classes the Lights of a lit Surface as flat: rows of the Render's table, no pass and no byte a Light (T1623b)", () => {
    const build: Build = (count) => scene({ lights: count });
    const found = find(build, FIVE);
    expect(found.refused).toEqual([]);
    expect(found.observed).toEqual({ law: "flat", passes: 0, members: 0, bindings: 0, functions: 0, grows: {}, carries: [] });
    /* And the text is the walk's, not an empty function: it reads the table. */
    expect(measure(build(16)).texts.get("scene:#") ?? "").toContain("lightTable");
  });

  it("classes a list whose items share one text as flat, with a pass per item", () => {
    const found = find((count) => scene({ geometries: count }), FIVE);
    expect(found.observed).toEqual({ law: "flat", passes: 1, members: 0, bindings: 0, functions: 0, grows: {}, carries: [] });
  });
});

describe("§V1029: every count a document can raise keeps the law its row states (T1635b)", () => {
  it("derives the axes from the registry, of every kind", () => {
    const kinds = new Set(AXES.flatMap((axis) => axis.kinds));
    expect([...kinds].sort()).toEqual(["attributes", "inputs", "json", "number", "string", "wgsl"]);
    /* If the derivation came back thin every case below would pass for want of subjects. */
    for (const key of ["render.lights", "render.projectors", "render.scenes", "composite.in2", "switch.inputs", "pointKernel.attributes", "pointKernel.in", "pointTopology.sheets", "geometry.group"]) {
      expect(AXES.map((axis) => axis.key)).toContain(key);
    }
    expect(only("render.lights")[0]).toMatchObject({ kinds: ["inputs"], port: "lights", list: "lights", portKind: "light" });
  });

  it("holds a row for every axis, no row for an axis that is gone, and every row at the law and the numbers it states", () => {
    expect(RESULT.problems, RESULT.problems.join("\n\n")).toEqual([]);
  });

  it("keeps an unbounded chain out of LEDGER: a chain there is bounded at eight or fewer, by name", () => {
    const chains = Object.entries(LEDGER).filter(([, row]) => row.law === "chain");
    expect(chains.map(([key]) => key).sort()).toEqual(["add.in2", "composite.in2", "difference.in2", "multiply.in2", "over.in2", "screen.in2"]);
    for (const [key, row] of chains) {
      expect(row.bound, key).toMatchObject({ code: "node.compile.tooManyInputs" });
      expect((row.bound as Bound).count, key).toBeLessThanOrEqual(CHAIN_BOUND);
    }
    for (const [key, debt] of Object.entries(NOT_YET_DATA)) expect(debt.task, key).toMatch(/^T\d+b?$/);
  });

  it("names every accumulation a definition writes out more than eight times, with its exact length (exception (a))", () => {
    const found: Record<string, number> = {};
    const where: Record<string, string> = {};
    for (const definition of allNodeDefinitions) {
      const compiled = measure({ graph: minimal(definition.type), subject: "subject", drivers: [] });
      for (const text of new Set(compiled.texts.values())) {
        for (const entry of writtenOut(text)) {
          if (entry.times <= CHAIN_BOUND) continue;
          const key = `${entry.function}: ${entry.name}`;
          found[key] = Math.max(found[key] ?? 0, entry.times);
          where[key] = definition.type;
        }
      }
    }
    expect(
      found,
      `Found: ${Object.entries(found).map(([key, times]) => `"${key}" ${times} times (${where[key] ?? "?"})`).join("; ")}. ` +
        `A function that writes one accumulation out more than ${CHAIN_BOUND} times is an unrolled chain (§B260's form at a fixed length). ` +
        "Walk it in a loop, or name it in FIXED_BY_DEFINITION with its exact length and the measurement that says the loop is worse.",
    ).toEqual(Object.fromEntries(Object.entries(FIXED_BY_DEFINITION).map(([key, row]) => [key, row.times])));
    for (const [key, row] of Object.entries(FIXED_BY_DEFINITION)) expect(row.why.length, key).toBeGreaterThan(40);
  });

  it("runs every `generatedOnce` generator under some row", () => {
    const idle = Object.entries(GENERATORS_RUN)
      .filter(([, counts]) => counts.generated === 0)
      .map(([name]) => name);
    expect(Object.keys(GENERATORS_RUN).length).toBeGreaterThan(10);
    expect(
      idle,
      `No row of the ledger made these generators run: ${idle.join(", ")}. A generator nothing here compiles is outside the gate: ` +
        "give the axis that reaches it a case (`\"<axis>/<what it is>\"`) whose fixture draws through it.",
    ).toEqual([]);
  });

  it("says what the ledger still owes, without failing", () => {
    /* A row with `measured: null` or `bound: null` is a debt somebody decided on in a diff. It is said on every run. */
    for (const line of RESULT.owed) console.info(line);
    if (process.env["LOOM_GROWTH_TABLE"] !== undefined) console.info(["axis | law | bound | exception", ...RESULT.table].join("\n"));
    expect(RESULT.owed.every((line) => line.startsWith(`OWED (${OWED_UNDER})`))).toBe(true);
  });
});

/**
 * A gate that has only ever been seen green has not been seen to work (§V245). `audit` is a
 * function of (axes, ledger, debts), so each way the ledger can lie is handed to it here.
 */
describe("§V1029: the gate fails when the ledger lies", () => {
  /* A chain that is still owed, handed to the audit under the `render.lights` axis: the instances generator's blocks. */
  const lights = NOT_YET_DATA["render.lights/primitive instances"] as Debt;
  const switchRow = LEDGER["switch.inputs"] as Row;

  it("an axis with no row", () => {
    expect(audit(only("render.lights"), {}, {}).problems.join("\n")).toContain("render.lights is an axis a document can raise a count along (inputs) and has no row");
  });

  it("a row whose axis is gone", () => {
    expect(audit(only("switch.inputs"), { "switch.inputs": switchRow, "switch.sources": flat("renamed away") }, {}).problems.join("\n")).toContain('The row "switch.sources" names no axis the registry has');
  });

  it("a chain's length that is not the one measured", () => {
    const problems = audit(only("render.lights"), {}, { "render.lights": { ...lights, grows: { "scene:#/fs": [1823, 1863] } } }).problems.join("\n");
    expect(problems).toContain('render.lights measures { law: "chain", members: 3, grows: { "scene:#/fs": [1823, 1862] }, carries: ["lit"] }');
  });

  it("a chain written down as flat", () => {
    const problems = audit(only("render.lights"), { "render.lights": flat("a lie", { build: lights.build as Build }) }, {}).problems.join("\n");
    expect(problems).toContain("THE TEXT OF ONE ITEM NOW CARRIES lit ACROSS ITEMS");
  });

  it("an unbounded chain moved into LEDGER", () => {
    const { task: _task, largest: _largest, ...row } = lights;
    const problems = audit(only("render.lights"), { "render.lights": { ...row, measured: null } }, {}).problems.join("\n");
    expect(problems).toContain("is a chain (it carries lit across items) and is in LEDGER without a refusal by name at 8 items or fewer");
  });

  it("a bound nobody enforces", () => {
    const problems = audit(only("switch.inputs"), { "switch.inputs": { ...switchRow, bound: { count: 4, code: "node.compile.tooManyInputs" } } }, {}).problems.join("\n");
    expect(problems).toContain('switch.inputs states that 5 items are refused as "node.compile.tooManyInputs", and compiling 5 gives no refusal');
  });

  it("a row measured where its graph does not compile", () => {
    const problems = audit(only("switch.inputs"), { "switch.inputs": { ...switchRow, counts: [1, 2, 8, 9] } }, {}).problems.join("\n");
    expect(problems).toContain("switch.inputs does not compile at 9 (node.compile.tooManyInputs)");
  });

  it("a debt that is paid and still listed", () => {
    const problems = audit(only("render.scenes"), {}, { "render.scenes": { ...lights, passes: 1, build: (count) => scene({ geometries: count }) } }).problems.join("\n");
    expect(problems).toContain("render.scenes is in NOT_YET_DATA and no longer measures as a chain");
  });

  it("a list whose every item brings a shader text of its own", () => {
    const each: Build = (count) =>
      scene({
        geometries: count,
        geometry: (index) => ({ material: `material_m${two(index)}` }),
        points: {
          nodes: [mk("grid_floor", "pointGrid", { cols: 8, rows: 8 }), ...named("material_m", count).map((id, index) => mk(id, "materialWgsl", { source: `${SURFACE}// ${index}\n`.replace("surfaceDefaults(s)", `SurfaceOut(s.albedo * ${index + 1}.0, s.roughness, s.metallic, s.normal, s.emissive)`) }))],
          wires: [],
          last: "grid_floor",
          drivers: [],
        },
      });
    const problems = audit(only("render.scenes"), { "render.scenes": flat("a lie", { passes: 1, build: each }) }, {}).problems.join("\n");
    expect(problems).toContain('render.scenes measures { law: "a new text per item"');
    expect(problems).toContain("Every item brings a shader text of its own");
  });

  it("a node ledgered as no pass whose output is a picture", () => {
    expect(audit(only("switch.inputs"), { "switch.inputs": noPass("a lie") }, {}).problems.join("\n")).toContain('switch.inputs is ledgered "no pass", and switch has an output that is not a value (out)');
  });
});
