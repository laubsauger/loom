import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { previewCameraAbsenceSentence } from "./preview-orbit.ts";
import type { ResolvedOutput } from "./types.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";

/**
 * T1655b — A 3D NODE TYPE CANNOT LAND WITHOUT A CAMERA CONTROL OR A REASON.
 *
 * The owner asked twice: "certain nodes are missing a way to control their freeview camera.
 * like the camera node and some other stuff that actually handles geometry". T675 answered
 * the first time with a table by PAYLOAD KIND, which is complete for kinds and says nothing
 * about node TYPES: a camera with one Render borrows a row that has no kind on it, a Render
 * is a picture and not a payload, and a geometry that draws only its backdrop carried an
 * orbit that moved nothing. Each was a type the table could not see.
 *
 * So this walks the REGISTRY. Every node type that outputs something 3D, or draws a picture
 * of something 3D, is compiled in the smallest document that makes it draw, with a preview
 * sink on it, and its row must carry one of the three answers (`ResolvedOutput.previewCamera`):
 *
 *  - `orbit`, with a basis that names a pass the tile really draws and that takes a matrix;
 *  - `pose`, on a node that declares the Eye and Look At the gesture writes;
 *  - `none`, with a sentence.
 *
 * What makes it a gate and not a list (§V461): the subjects are DERIVED from port kinds, and
 * every port kind in the registry must be classified below as 3D or not, so a new node type
 * is a subject the day it is registered and a new port kind is a failure until someone says
 * which side it is on. A type that needs more than a default input to draw needs a recipe
 * here, and has none by default: it fails until one is written.
 *
 * The other half is `src/tests/e2e/preview-camera.spec.ts`, which drives the real gestures
 * on the real GPU: this file proves the compiler SAYS it, that one that the app DOES it.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

/** Port kinds whose data is 3D: a preview of one is a view of a scene, so it has a camera question. */
const THREE_D_KINDS = new Set(["pointset", "scene", "material", "camera", "light", "projector"]);
/** Port kinds with no camera question: a picture, a number, a signal. */
const FLAT_KINDS = new Set(["texture2d", "buffer", "scalar", "vector", "matrix", "transform3d", "event", "audioFeatures", "value"]);

/** What a subject's inputs are fed by default: the simplest producer of each kind. */
const PROVIDER: Readonly<Record<string, string>> = {
  pointset: "pointGrid",
  texture2d: "solid",
  material: "materialPbr",
  scene: "geometry",
  camera: "camera",
  light: "light",
  projector: "projector",
};

type Wire = readonly [from: string, to: string, port: string];
interface Recipe {
  readonly nodes: readonly (readonly [id: string, type: string, parameters?: Record<string, unknown>])[];
  /** Wires between recipe nodes, and into the subject (`$`). */
  readonly wires: readonly Wire[];
  readonly why: string;
}

/**
 * Types that need more than "one default producer per required input" to draw. Each says
 * why; a recipe for a type that draws without it is stale and the test says so.
 */
const RECIPES: Readonly<Record<string, Recipe>> = {
  // T1822b: a Null's input is optional, so the default producers leave it unwired, and an
  // unwired Null has nothing to show. Wired, its row is a splat of its producer's points.
  pointNull: {
    nodes: [["grid", "pointGrid"]],
    wires: [["grid", "$", "in"]],
    why: "a Null's input is optional, and a Null with nothing wired produces nothing",
  },
  pointSweep: {
    nodes: [
      ["line", "pointLine"],
      ["strip", "pointTopology", { connectivity: "strips", cols: 64, rows: 1 }],
      ["frames", "pointCurveFrames"],
    ],
    wires: [
      ["line", "strip", "points"],
      ["strip", "frames", "points"],
      ["frames", "$", "points"],
    ],
    why: "a sweep needs a curve that carries frames, which a bare grid does not",
  },
  pointGather: {
    nodes: [
      ["grid", "pointGrid"],
      ["links", "pointProximity"],
    ],
    wires: [
      ["grid", "links", "points"],
      ["links", "$", "links"],
      ["grid", "$", "points"],
    ],
    why: "its links input is a Proximity's adjacency, not any pointset",
  },
  render: {
    nodes: [
      ["grid", "pointGrid"],
      ["geo", "geometry", { mode: "instances" }],
      ["cam", "camera"],
      ["sun", "light"],
    ],
    wires: [
      ["grid", "geo", "points"],
      ["geo", "$", "scenes"],
      ["cam", "$", "camera"],
      ["sun", "$", "lights"],
    ],
    why: "a Render with no camera named is refused by name, and one with no scene draws nothing",
  },
};

/**
 * 3D-output types that are deliberately NOT subjects, each with the reason and what the
 * walk must still find true of it (checked: an exemption that stops describing its type
 * fails here).
 */
const NOT_A_SUBJECT: Readonly<Record<string, string>> = {
  componentInPoints:
    "a component's socket: at the root it produces nothing, and inside a component its row is the pointset wired through it",
  componentOutPoints:
    "a component's socket: at the root it produces nothing, and inside a component its row is the pointset wired through it",
};

const outputsThreeD = (definition: NodeDefinition): boolean =>
  definition.outputs.some((port) => THREE_D_KINDS.has(port.type.kind));
const picturesThreeD = (definition: NodeDefinition): boolean =>
  definition.outputs.some((port) => port.type.kind === "texture2d") &&
  definition.inputs.some((port) => port.type.kind === "pointset" || port.type.kind === "scene");

const subjects = registry.list().filter((definition) => outputsThreeD(definition) || picturesThreeD(definition));

function documentFor(definition: NodeDefinition, options: { ignoreRecipe?: boolean } = {}): GraphDocument {
  const nodes: GraphNode[] = [];
  const edges: Record<string, unknown> = {};
  const add = (id: string, type: string, parameters: Record<string, unknown> = {}): void => {
    nodes.push({
      id,
      type,
      definitionVersion: registry.get(type)?.version ?? 1,
      position: { x: 0, y: 0 },
      parameters,
    } as never);
  };
  const wire = (from: string, to: string, port: string): void => {
    const id = `e${String(Object.keys(edges).length)}`;
    edges[id] = { id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } };
  };
  /** One default producer per REQUIRED input, recursively (a geometry needs its points). */
  const feed = (id: string, type: string, depth: number): void => {
    for (const port of registry.get(type)?.inputs ?? []) {
      if (port.optional === true || depth > 3) continue;
      const provider = PROVIDER[port.type.kind];
      if (provider === undefined) continue;
      const source = `${id}_${port.id}`;
      add(source, provider);
      wire(source, id, port.id);
      feed(source, provider, depth + 1);
    }
  };

  add("subject", definition.type);
  const recipe = options.ignoreRecipe === true ? undefined : RECIPES[definition.type];
  if (recipe === undefined) {
    feed("subject", definition.type, 0);
  } else {
    for (const [id, type, parameters] of recipe.nodes) add(id, type, parameters);
    for (const [from, to, port] of recipe.wires) wire(from, to === "$" ? "subject" : to, port);
    for (const [id, type] of recipe.nodes) {
      // A recipe states what is special; what it leaves unwired on its own nodes is still fed.
      const wired = new Set(recipe.wires.filter(([, to]) => to === id).map(([, , port]) => port));
      for (const port of registry.get(type)?.inputs ?? []) {
        if (port.optional === true || wired.has(port.id)) continue;
        const provider = PROVIDER[port.type.kind];
        if (provider === undefined) continue;
        add(`${id}_${port.id}`, provider);
        wire(`${id}_${port.id}`, id, port.id);
      }
    }
  }
  return { revision: 1, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), edges, groups: {} } as never;
}

function compileSubject(definition: NodeDefinition, options: { ignoreRecipe?: boolean } = {}) {
  const graph = documentFor(definition, options);
  const compiled = compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: definition.outputs.map((port) => ({ nodeId: "subject", portId: port.id, kind: "preview" as const })),
  } as never);
  return { graph, compiled };
}

describe("T1655b — the registry has no port kind this gate has not been told about", () => {
  it("every port kind is classified as 3D or not", () => {
    const kinds = new Set<string>();
    for (const definition of registry.list()) {
      for (const port of [...definition.inputs, ...definition.outputs]) kinds.add(port.type.kind);
    }
    const unclassified = [...kinds].filter((kind) => !THREE_D_KINDS.has(kind) && !FLAT_KINDS.has(kind));
    // A new kind of thing a node can output: is a preview of it a view of a scene? Say so above.
    expect(unclassified).toEqual([]);
  });

  it("finds the types the owner named, so the derivation is not vacuous", () => {
    const types = new Set(subjects.map((definition) => definition.type));
    for (const named of ["camera", "render", "light", "geometry", "pointTopology", "pointCurveFrames", "pointSweep", "pointRope", "materialWgsl", "meshFileIn"]) {
      expect([named, types.has(named)]).toEqual([named, true]);
    }
    // And does not sweep in a filter that merely reads a camera, or a 2D generator.
    expect(types.has("cameraBlur")).toBe(false);
    expect(types.has("noise")).toBe(false);
  });

  it("every recipe and every exemption names a type that still needs it", () => {
    const types = new Set(subjects.map((definition) => definition.type));
    for (const type of [...Object.keys(RECIPES), ...Object.keys(NOT_A_SUBJECT)]) {
      expect([type, types.has(type)]).toEqual([type, true]);
    }
    for (const type of Object.keys(RECIPES)) {
      // The claim a recipe makes: default producers alone do not make this type draw.
      const { compiled } = compileSubject(registry.get(type)!, { ignoreRecipe: true });
      const drew = compiled.outputs.some((output) => output.nodeId === "subject" && output.previewCamera !== undefined);
      const refused = compiled.diagnostics.some((entry) => entry.severity === "error");
      expect([type, drew && !refused]).toEqual([type, false]);
    }
    for (const type of Object.keys(NOT_A_SUBJECT)) {
      // The claim the exemption makes: nothing is drawn for it at the root, so no row can be 3D.
      const { compiled } = compileSubject(registry.get(type)!);
      const rows = compiled.outputs.filter((output) => output.nodeId === "subject" && output.resourceKind !== "pointset");
      expect([type, rows]).toEqual([type, []]);
    }
  });
});

describe("T1655b — every node type that shows something 3D says what its camera is, or why it has none", () => {
  const cases = subjects.filter((definition) => NOT_A_SUBJECT[definition.type] === undefined);

  it.each(cases.map((definition) => [definition.type, definition] as const))("%s", (type, definition) => {
    const { graph, compiled } = compileSubject(definition);
    // The fixture's own premise: the type draws. A type that cannot be made to draw with a
    // default producer per required input needs a recipe above; without one it fails HERE,
    // which is what stops a new 3D type landing unexamined.
    const errors = compiled.diagnostics.filter((entry) => entry.severity === "error").map((entry) => `${entry.code}: ${entry.message}`);
    expect([type, errors]).toEqual([type, []]);

    const rows: ResolvedOutput[] = compiled.outputs.filter(
      (output) => output.nodeId === "subject" && output.resourceKind !== "pointset",
    );
    // A row the preview system can bind exists for it at all (§V437: absent is not covered).
    expect([type, rows.length > 0]).toEqual([type, true]);

    for (const row of rows) {
      const control = row.previewCamera;
      if (control === undefined) throw new Error(`${type}:${row.portId} shows something 3D and says nothing about its camera`);
      if (control.kind === "orbit") {
        // The basis moves a pass the tile really draws, and that pass takes the matrix.
        const drawn = new Map((row.synthesis?.passes ?? []).map((pass) => [pass.id, pass]));
        const passIds = row.synthesis?.orbit?.passIds ?? [];
        expect([type, passIds.length > 0]).toEqual([type, true]);
        for (const passId of passIds) {
          expect([type, passId, drawn.get(passId)?.uniforms?.["viewProjection"] !== undefined]).toEqual([type, passId, true]);
        }
      } else if (control.kind === "pose") {
        // The gesture writes this node's own Eye and Look At, so it must have them (asked of
        // the node's effective schema, the one way to a node's parameters, §T903).
        const schema = effectiveParameterSchema(definition, graph.nodes["subject"]?.parameters ?? {});
        expect([type, schema["eye"]?.type, schema["lookAt"]?.type]).toEqual([type, "vector", "vector"]);
        // And nothing else may claim the picture's camera: no orbit basis beside a pose.
        expect([type, row.synthesis?.orbit]).toEqual([type, undefined]);
      } else {
        const sentence = previewCameraAbsenceSentence(control.reason, (id) => id);
        expect([type, sentence.length > 0]).toEqual([type, true]);
        if (control.reason.because === "through-camera") {
          // It points at a camera that is in the document, by the id a reader can resolve.
          expect([type, graph.nodes[control.reason.camera]?.type]).toEqual([type, "camera"]);
        }
        expect([type, row.synthesis?.orbit]).toEqual([type, undefined]);
      }
    }
  });

  it("a camera with exactly ONE Render borrows that Render's row, and the row still says pose", () => {
    /*
     * The hole the walk found, as its literal case. T546 gives such a camera its Render's own
     * picture by aliasing the row, and that row has no `synthesis`; the camera gizmo asked
     * `synthesis.kind === "camera"`, so it was offered only on a camera NOTHING rendered
     * through, which is the one case nobody frames a shot in. The sweep above cannot see
     * this: its camera stands alone.
     */
    const { compiled } = (() => {
      const graph = documentFor(registry.get("render")!);
      return {
        compiled: compileGraph({
          graph,
          settings: SETTINGS,
          registry,
          capabilities: CAPABILITIES,
          sinks: [
            { nodeId: "subject", portId: "out", kind: "preview" as const },
            { nodeId: "cam", portId: "out", kind: "preview" as const },
          ],
        } as never),
      };
    })();
    const camera = compiled.outputs.find((output) => output.nodeId === "cam");
    const render = compiled.outputs.find((output) => output.nodeId === "subject" && output.portId === "out");
    // The premise: this IS the borrowed row, not a stock scene.
    expect(camera?.synthesis).toBeUndefined();
    expect(camera?.resourceId).toBe(render?.resourceId);
    expect(camera?.previewCamera).toEqual({ kind: "pose" });
    // And the Render it borrows from still points at the camera: one picture, two rows, two answers.
    expect(render?.previewCamera).toEqual({ kind: "none", reason: { because: "through-camera", camera: "cam" } });
  });

  it("answers by what a type IS: payloads orbit or pose, pictures point at their camera", () => {
    // Not a list to maintain (the sweep above is the gate): the readable summary of today's
    // answers, so a change of answer for a whole class is seen as one and decided as one.
    const answers = new Map<string, string>();
    for (const definition of cases) {
      const { compiled } = compileSubject(definition);
      const row = compiled.outputs.find((output) => output.nodeId === "subject" && output.resourceKind !== "pointset");
      const control = row?.previewCamera;
      answers.set(definition.type, control === undefined ? "?" : control.kind === "none" ? `none:${control.reason.because}` : control.kind);
    }
    const byAnswer = (answer: string): string[] => [...answers].filter(([, value]) => value === answer).map(([type]) => type).sort();
    expect(byAnswer("pose")).toEqual(["camera", "projector", "renderInstances", "renderSurface"]);
    expect(byAnswer("none:through-camera")).toEqual(["render"]);
    expect(byAnswer("none:no-camera")).toEqual(["renderPoints"]);
    expect(byAnswer("none:nothing-drawn")).toEqual([]);
    expect(byAnswer("?")).toEqual([]);
    // Everything else is a pointset, a geometry, a light or a material: an inspection orbit.
    expect(byAnswer("orbit").length).toBe(cases.length - 6);
  });
});
