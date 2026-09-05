import { describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import {
  componentNodeType,
  createComponentSystem,
  parseComponentDefinition,
} from "../domain/components/index.ts";
import { buildProjectFile } from "../domain/project/index.ts";
import { loadProject } from "../domain/project/load.ts";
import type { ExposedPort, GraphComponentDefinition } from "../domain/types/components.ts";
import type {
  GraphDocument,
  GraphNode,
  ProjectDocument,
  ProjectSettings,
} from "../domain/types/graph.ts";
import { SCHEMA_VERSION } from "../domain/types/schemas.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listStarterComponentFiles } from "./catalogue.ts";
import { TIER_B_CAPABILITIES, errorsOf } from "./runner.ts";

/**
 * T1194 — WHAT THE NINE SHIPPED COMPONENTS PUBLISH, AND WHAT OLD SAVES KEEP.
 *
 * Two halves of one change, gated together because the second is the price of the first.
 *
 * ## The published surface says what the signal IS
 *
 * A boundary socket is named after the boundary node, and the boundary node was named
 * after THE PORT IT HAPPENED TO FEED — so `DepthPoints` shipped `field` and `field_2`
 * (both consumers are `pointKernel`, both call the input `field`) when one is the colour
 * map the paint kernel tints from and the other the depth map the carve kernel unprojects.
 * The target port says what a signal is plugged INTO, never what it IS, and the owner has
 * asked for the difference repeatedly. `SaveSelectionInput.portNames` is where the author
 * says it now, and the first assertion below is the list of what they said — plus a refusal
 * of the generic names, so the habit cannot come back one component at a time.
 *
 * ## RENAMING A SHIPPED COMPONENT'S PORTS MUST NOT CUT A SAVED DOCUMENT'S WIRES.
 *
 * `DepthCut` shipped its sockets as `input` and `input_2` (the port each happened to feed,
 * auto-suffixed) and now ships them as `depth` and `picture`. `externalId` is the ADDRESS a
 * parent's edges are wired by, so on the face of it that is exactly the change that dangles
 * every edge in every project saved against the old names.
 *
 * It does not, and the reason is a rule that already existed and is worth holding: THE
 * DOCUMENT'S OWN COPY OF A COMPONENT WINS. A save embeds the whole definition under
 * `componentLibrary` (§V94), `installStarterComponents` skips any id+version the catalogue
 * already holds, and `loadProject` registers the file's library — replacing the shipped
 * definition at that id and version. So an old project opens against the definition its own
 * instances were pinned to, old socket names and all, and renders what it rendered. Neither
 * a migration nor a rejection is needed; what IS needed is a gate, because the rule is a
 * load-order property that nothing else asserts and a plausible "shipped wins" refactor
 * would silently shred saved work.
 *
 * The fixture is derived from the SHIPPED BYTES rather than hand-written, so it cannot rot
 * into agreeing with itself: the pre-rename definition is today's `DepthCut` with its two
 * exposed rows re-addressed to the names it used to publish.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 640, height: 360 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const nodes = createNodeRegistry(allNodeDefinitions).view();

function shippedComponents(): readonly GraphComponentDefinition[] {
  return listStarterComponentFiles().map((file) => {
    const library = (JSON.parse(file.text) as { componentLibrary?: { components?: unknown[] } })
      .componentLibrary;
    const parsed = parseComponentDefinition(library?.components?.[0]);
    if (!parsed.ok) throw new Error(`${file.fileName} did not parse: ${parsed.issues.join(", ")}`);
    return parsed.definition;
  });
}

function shippedDepthCut(): GraphComponentDefinition {
  const found = shippedComponents().find((definition) => definition.componentId === "depthCut");
  if (found === undefined) throw new Error("DepthCut is not shipped");
  return found;
}

/** Today's definition, re-addressed to the socket names it published before T1194. */
function preRename(definition: GraphComponentDefinition): GraphComponentDefinition {
  const wasCalled: Record<string, string> = { depth: "input", picture: "input_2" };
  const rename = (port: ExposedPort): ExposedPort => {
    const old = wasCalled[port.externalId];
    return old === undefined ? port : { ...port, externalId: old, label: old };
  };
  return { ...definition, inputs: definition.inputs.map(rename) };
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as GraphNode;

/**
 * plate + depth map -> DepthCut -> output, wired by whatever the sockets are called.
 *
 * The two sources are DIFFERENT node types on purpose: swapping the two edges, or losing
 * one, changes the compiled program, so "the wires survived" is a fact the plan can state.
 */
function document(ports: { depth: string; picture: string }): ProjectDocument {
  const instance = node("cut1", componentNodeType("depthCut", 1));
  const graph: GraphDocument = {
    revision: 1,
    nodes: {
      depthsrc: node("depthsrc", "circle", { softness: 0.9 }),
      picture: node("picture", "checker", {}),
      cut1: instance,
      out: node("out", "output"),
    },
    edges: {
      eDepth: {
        id: "eDepth",
        source: { nodeId: "depthsrc", portId: "out" },
        target: { nodeId: "cut1", portId: ports.depth },
      },
      ePicture: {
        id: "ePicture",
        source: { nodeId: "picture", portId: "out" },
        target: { nodeId: "cut1", portId: ports.picture },
      },
      eOut: {
        id: "eOut",
        source: { nodeId: "cut1", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
    groups: {},
  } as GraphDocument;
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "legacy-depth-cut",
    name: "Legacy DepthCut",
    graph,
    settings,
    assets: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

/** Boot order: the shipped set first, then the file's own library — as the app does. */
function openWithStarterSetInstalled(text: string, shipped: GraphComponentDefinition) {
  const system = createComponentSystem(nodes, [shipped]);
  const loaded = loadProject(text, { nodes, components: system.components });
  if (!loaded.ok) throw new Error(`the project did not load: ${loaded.reason}`);
  return { loaded, system };
}

const compile = (graph: GraphDocument, system: ReturnType<typeof createComponentSystem>) =>
  compileGraph({
    graph,
    settings,
    registry: system.nodes,
    capabilities: TIER_B_CAPABILITIES,
    components: system.components.view(),
  });

/**
 * The names the generic default would have produced, and the shape it produces them in.
 *
 * `input`/`in1`/`field`/`source` are the ids the catalogue's own node definitions use for
 * "whatever you plug in here", and `_2` is the collision suffix. None of them is a fact
 * about the component, so none of them may be published by one.
 */
const GENERIC = /^(?:in|input|in\d+|source|field|value|signal)(?:_\d+)?$/;

/** What each shipped component publishes, in canvas order (§V109). */
const PUBLISHED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  audioLevel: [],
  bloom: ["picture"],
  depthCut: ["depth", "picture"],
  depthPoints: ["colour", "depth"],
  displacementStack: ["picture"],
  feedbackEcho: ["picture"],
  kaleidoscope: ["picture"],
  mediaGrade: ["picture"],
  timeGrid: ["matte", "picture"],
};

describe("the nine shipped components publish speaking input names (T1194)", () => {
  const shipped = shippedComponents();

  it("names every input for what the signal IS", () => {
    const surface = Object.fromEntries(
      shipped.map((definition) => [
        definition.componentId,
        definition.inputs.map((port) => port.externalId),
      ]),
    );
    expect(surface).toEqual(PUBLISHED_INPUTS);
  });

  it("publishes no generic socket name, on any component, ever again", () => {
    // The recurrence guard. A tenth component saved with the default names lands here,
    // not in a review — which is the half of T1194 that was asked for repeatedly.
    const generic = shipped.flatMap((definition) =>
      definition.inputs
        .filter((port) => GENERIC.test(port.externalId))
        .map((port) => `${definition.name}.${port.externalId}`),
    );
    expect(generic).toEqual([]);
  });

  it("says the same thing on both sides of the boundary", () => {
    // §V109/T1046: the socket's label IS the boundary node's name. A published surface that
    // reads well outside and `field_2` inside is only half the ask.
    for (const definition of shipped) {
      for (const port of definition.inputs) {
        expect(port.label, `${definition.name}.${port.externalId}`).toBe(port.externalId);
        expect(definition.graph.nodes[port.nodeId]?.label).toBe(port.externalId);
      }
    }
  });

  it("is not vacuous: the generic pattern matches what these ports used to be called", () => {
    for (const was of ["input", "input_2", "field", "field_2", "in1", "in2", "source"]) {
      expect(GENERIC.test(was), was).toBe(true);
    }
    for (const now of ["picture", "depth", "colour", "matte"]) {
      expect(GENERIC.test(now), now).toBe(false);
    }
  });
});

describe("a project saved before the port rename (T1194)", () => {
  const shipped = shippedDepthCut();
  const legacy = preRename(shipped);

  it("still publishes the renamed sockets on the shipped definition", () => {
    // The premise. Without this the rest of the file could pass while nothing was renamed.
    expect(shipped.inputs.map((port) => port.externalId)).toEqual(["depth", "picture"]);
    expect(legacy.inputs.map((port) => port.externalId)).toEqual(["input", "input_2"]);
  });

  it("opens against its OWN definition, not the shipped one", () => {
    const file = buildProjectFile({
      document: document({ depth: "input", picture: "input_2" }),
      components: [legacy],
      now: () => "2024-01-01T00:00:00.000Z",
    });
    const { system } = openWithStarterSetInstalled(file.text, shipped);

    // The registry held the renamed definition at depthCut@1 a moment ago; the file's copy
    // replaced it, which is what keeps the file's edges addressable.
    expect(system.components.get("depthCut", 1)?.inputs.map((port) => port.externalId)).toEqual([
      "input",
      "input_2",
    ]);
  });

  it("keeps both wires, and compiles to the same program as the renamed document", () => {
    const file = buildProjectFile({
      document: document({ depth: "input", picture: "input_2" }),
      components: [legacy],
      now: () => "2024-01-01T00:00:00.000Z",
    });
    const { loaded, system } = openWithStarterSetInstalled(file.text, shipped);
    const legacyPlan = compile(loaded.document.graph, system);

    expect(errorsOf(legacyPlan.diagnostics)).toEqual([]);
    expect(legacyPlan.ok).toBe(true);

    // The same graph an author would build TODAY, against the renamed sockets.
    const modern = createComponentSystem(nodes, [shipped]);
    const modernPlan = compile(document({ depth: "depth", picture: "picture" }).graph, modern);

    expect(errorsOf(modernPlan.diagnostics)).toEqual([]);
    // Byte-for-byte the same render program: same passes, same targets, same texture
    // bindings, same order. A lost or swapped edge cannot survive this comparison.
    expect(legacyPlan.order).toEqual(modernPlan.order);
    expect(legacyPlan.passes).toEqual(modernPlan.passes);
  });

  it("is not vacuous: the old names address nothing on the renamed definition", () => {
    // The legitimate case the rule could swallow, exercised the other way round — if the
    // rename had been a no-op, this graph would compile and the gate above would prove
    // nothing. A project WITHOUT its own library really does lose these edges, which is
    // why the embedded library is the compatibility story.
    const orphaned = createComponentSystem(nodes, [shipped]);
    const plan = compile(document({ depth: "input", picture: "input_2" }).graph, orphaned);

    expect(errorsOf(plan.diagnostics).length).toBeGreaterThan(0);
  });
});
