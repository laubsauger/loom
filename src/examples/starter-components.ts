import { createComponentSystem } from "../domain/components/registry.ts";
import { registerComponentCommands } from "../domain/components/commands.ts";
import { openComponentSession } from "../domain/components/session.ts";
import { createDomainBus } from "../domain/commands/index.ts";
import { createGraphStore } from "../domain/graph/store.ts";
import { createSequentialIdFactory } from "../domain/graph/ids.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphComponentDefinition, PublishedParameter } from "../domain/types/components.ts";
import type { InvocationContext } from "../domain/types/commands.ts";
import type { GraphDocument, ProjectDocument, ProjectSettings } from "../domain/types/graph.ts";
import type { ComponentId, NodeId } from "../domain/types/ids.ts";
import { SCHEMA_VERSION } from "../domain/types/schemas.ts";
import {
  EXAMPLE_TIMESTAMP,
  bloomDocument,
  displacementStackDocument,
  feedbackEchoDocument,
  kaleidoscopeDocument,
} from "./documents.ts";

/**
 * The starter component set (T190, §V94, §V79).
 *
 * §V94 says a shipped component is the SAME `GraphComponentDefinition` a user saves, and
 * that a privileged format would stop the shipped set being a worked example of the thing
 * users make. `example-files.ts` honours the sibling invariant (§V88) by generating the
 * example files through `buildProjectFile` — the real save path — so a shipped file cannot
 * drift into a shape a save would never produce.
 *
 * This module takes that one step further, because a component has a step the examples do
 * not: it is AUTHORED before it is saved. So nothing here constructs a definition. Each
 * starter component is produced by driving the same commands a user drives —
 * `component.saveSelection` over a selection in a real document, then
 * `component.publishParameter` inside a `ComponentSession` — against the real node
 * catalogue. Whatever the authoring path produces IS the shipped component. If the path
 * changes, the bytes change and `component-sync.test.ts` fails, which is the point.
 *
 * The four graph-shaped ones REUSE the example documents rather than re-deriving the same
 * chains: E1's echo loop, E4's threshold-blur-add, E5's fold-tile-spin, E6's shape-place
 * -displace stack are already worked, already gated by `runner.test.ts`, and already the
 * structures these components are meant to be. Selecting a subset of an example and saving
 * it is also exactly how a user arrives at a component, so the host document each one
 * leaves behind — source, instance, output — is a working demonstration of it for free.
 *
 * `MediaGrade` has no example to draw on and gets a minimal host of its own.
 *
 * Ids are sequential and the timestamp is pinned, so regenerating changes nothing unless
 * a spec here or the authoring path itself changed.
 */

/** Stamped into `createdAt`/`updatedAt`, matching the examples so both regenerate stably. */
export const STARTER_COMPONENT_TIMESTAMP = EXAMPLE_TIMESTAMP;

const AUTHORING_CONTEXT: InvocationContext = {
  actor: { kind: "system", id: "shaderloom-starter-set", label: "Shaderloom" },
  projectId: "starter-components",
  capabilities: [],
};

export interface StarterComponentSpec {
  /** Stable id an instance pins (§V84). Also the file's project id. */
  readonly componentId: ComponentId;
  /** Component name, document name and — through `projectFileName` — the file name. */
  readonly name: string;
  readonly description: string;
  /** The document the component is authored out of. */
  readonly host: ProjectDocument;
  /** What the author selected before hitting "save selection as component". */
  readonly selection: readonly NodeId[];
  /**
   * The parameter page, re-authored rather than copied (§V80).
   *
   * Every `definition.default` MUST equal the value the internal target already holds. A
   * published knob writes its resolved value onto its targets on every flatten, so a
   * default that disagrees with the authored internals would silently re-grade the
   * component the first time it is instantiated.
   */
  readonly publish: readonly PublishedParameter[];
}

export interface StarterComponent {
  readonly spec: StarterComponentSpec;
  readonly definition: GraphComponentDefinition;
  /** The host after the selection became an instance — a runnable demonstration. */
  readonly document: ProjectDocument;
}

const LIMITS: ProjectSettings["limits"] = {
  maxResolution: 4096,
  maxDispatch: 65_535,
  maxBufferBytes: 268_435_456,
  memoryBudgetBytes: 1_073_741_824,
};

const GRADE_SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 30,
  limits: LIMITS,
};

/**
 * MediaGrade's host: a plate to grade, the grade, and an output.
 *
 * The chain is Level then HSV then Limit, in that order and not another. Level moves the
 * range, HSV rotates what is left, and Limit is the tail that keeps the result legal —
 * a grade that clips before it rotates hue loses the highlights it was about to steer.
 */
const mediaGradeHost: ProjectDocument = {
  schemaVersion: SCHEMA_VERSION,
  projectId: "component-media-grade",
  name: "MediaGrade",
  settings: GRADE_SETTINGS,
  assets: [],
  createdAt: STARTER_COMPONENT_TIMESTAMP,
  updatedAt: STARTER_COMPONENT_TIMESTAMP,
  graph: {
    revision: 1,
    nodes: {
      plate: {
        id: "plate",
        type: "checker",
        definitionVersion: 1,
        position: { x: -520, y: 0 },
        parameters: {
          size: [8, 5],
          offset: [0, 0],
          color1: [0.05, 0.07, 0.12, 1],
          color2: [0.9, 0.82, 0.6, 1],
        },
      },
      range: {
        id: "range",
        type: "level",
        definitionVersion: 1,
        position: { x: -260, y: 0 },
        parameters: {
          blacklevel: 0,
          whitelevel: 1,
          gamma1: 1,
          contrast: 1,
          brightness: 1,
          opacity: 1,
        },
      },
      tone: {
        id: "tone",
        type: "hsv",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { hueoffset: 0, saturation: 1, value: 1 },
      },
      legal: {
        id: "legal",
        type: "limit",
        definitionVersion: 1,
        position: { x: 260, y: 0 },
        parameters: { mode: "clamp", low: 0, high: 1, steps: 4 },
      },
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 520, y: 0 },
        parameters: {},
      },
    },
    edges: {
      "e-plate-range": {
        id: "e-plate-range",
        source: { nodeId: "plate", portId: "out" },
        target: { nodeId: "range", portId: "input" },
      },
      "e-range-tone": {
        id: "e-range-tone",
        source: { nodeId: "range", portId: "out" },
        target: { nodeId: "tone", portId: "input" },
      },
      "e-tone-legal": {
        id: "e-tone-legal",
        source: { nodeId: "tone", portId: "out" },
        target: { nodeId: "legal", portId: "input" },
      },
      "e-legal-out": {
        id: "e-legal-out",
        source: { nodeId: "legal", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
    groups: {},
  },
};

/**
 * The five specs.
 *
 * Ordered the way the library reads them: the two most-reached-for first, then the two
 * that are chains rather than effects, then the grade.
 */
export const STARTER_COMPONENT_SPECS: readonly StarterComponentSpec[] = [
  {
    componentId: "feedbackEcho",
    name: "FeedbackEcho",
    description:
      "Trailing echo: a feedback loop that drifts, softens and decays what it is given.",
    host: feedbackEchoDocument,
    // The circle stays outside. What makes this reusable is the LOOP, not the thing
    // being echoed — a component that shipped its own source could only echo that.
    selection: ["over", "echo", "drift", "soften", "decay"],
    publish: [
      {
        key: "persistence",
        definition: { type: "number", label: "Persistence", default: 0.997, min: 0, max: 1 },
        targets: [{ nodeId: "echo", key: "persistence" }],
      },
      {
        key: "fadeTo",
        definition: {
          type: "color",
          label: "Fade To",
          default: [0, 0, 0, 0],
          space: "display",
          description: "What the trail fades toward. Transparent black leaves no floor.",
        },
        targets: [{ nodeId: "echo", key: "clearColor" }],
      },
      {
        key: "drift",
        definition: { type: "vector", size: 2, label: "Drift", default: [0, -0.0008], min: -1, max: 1 },
        targets: [{ nodeId: "drift", key: "t" }],
      },
      {
        key: "spin",
        definition: {
          type: "number",
          label: "Spin",
          default: 0.25,
          min: -360,
          max: 360,
          unit: "degrees",
        },
        targets: [{ nodeId: "drift", key: "r" }],
      },
      {
        key: "softness",
        definition: { type: "number", label: "Softness", default: 1.4, min: 0, max: 128, unit: "px" },
        targets: [{ nodeId: "soften", key: "size" }],
      },
    ],
  },
  {
    componentId: "bloom",
    name: "Bloom",
    description: "Threshold, blur and add back — highlight glow with the range to carry it.",
    host: bloomDocument,
    // Every node carries E4's rgba16float overrides with it, which is the whole reason
    // the glow survives the threshold instead of clipping at the first target. T518 added
    // three: `floor` (without which the composite SUBTRACTS the glow — a Level's black
    // point is a subtraction, and a float target keeps the negatives an 8-bit one clamps),
    // and `palette`/`tint`, which give the halo its chromatic falloff. The selection has
    // to stay CONTIGUOUS or the carved component is a chain with holes in it.
    selection: ["hot", "floor", "bright", "glow", "palette", "tint", "combine"],
    publish: [
      {
        key: "threshold",
        definition: { type: "number", label: "Threshold", default: 1.1, min: -1, max: 2 },
        targets: [{ nodeId: "bright", key: "threshold" }],
      },
      {
        key: "knee",
        definition: {
          type: "number",
          label: "Knee",
          default: 0.22,
          min: 0,
          max: 1,
          description: "Width of the threshold transition. 0 gives a hard, aliased edge.",
        },
        targets: [{ nodeId: "bright", key: "softness" }],
      },
      {
        key: "radius",
        definition: { type: "number", label: "Radius", default: 40, min: 0, max: 128, unit: "px" },
        targets: [{ nodeId: "glow", key: "size" }],
      },
      {
        key: "intensity",
        definition: { type: "number", label: "Intensity", default: 1, min: 0, max: 1 },
        targets: [{ nodeId: "combine", key: "opacity" }],
      },
    ],
  },
  {
    componentId: "kaleidoscope",
    name: "Kaleidoscope",
    description: "Fold, mirror-tile and spin — three extend modes doing one job.",
    host: kaleidoscopeDocument,
    selection: ["fold", "facets", "spin"],
    publish: [
      {
        key: "segments",
        definition: {
          type: "vector",
          size: 2,
          label: "Segments",
          default: [2, 2],
          min: 0.01,
          max: 64,
        },
        targets: [{ nodeId: "facets", key: "repeat" }],
      },
      {
        key: "fold",
        definition: {
          type: "number",
          label: "Fold Angle",
          default: 30,
          min: -360,
          max: 360,
          unit: "degrees",
        },
        targets: [{ nodeId: "fold", key: "r" }],
      },
      {
        key: "zoom",
        definition: { type: "vector", size: 2, label: "Zoom", default: [0.5, 0.5], min: -8, max: 8 },
        targets: [{ nodeId: "fold", key: "s" }],
      },
      {
        key: "spin",
        definition: {
          type: "number",
          label: "Spin",
          default: -15,
          min: -360,
          max: 360,
          unit: "degrees",
        },
        targets: [{ nodeId: "spin", key: "r" }],
      },
    ],
  },
  {
    componentId: "displacementStack",
    name: "DisplacementStack",
    description: "A shaped, placed noise field driving a displacement — field included.",
    host: displacementStackDocument,
    // The field comes WITH the component. E6's point is that a displacement is a stack —
    // shape it, place it, then displace — and a component that took the field as an input
    // would hand the user back the two nodes the stack is about.
    selection: ["field", "shape", "place", "warp"],
    publish: [
      {
        key: "amount",
        definition: {
          type: "vector",
          size: 2,
          label: "Amount",
          default: [0.18, 0.13],
          min: -2,
          max: 2,
        },
        targets: [{ nodeId: "warp", key: "weight" }],
      },
      {
        key: "scale",
        definition: {
          type: "number",
          label: "Field Scale",
          default: 0.3,
          min: 0.001,
          max: 100,
          scale: "log",
        },
        targets: [{ nodeId: "field", key: "period" }],
      },
      {
        key: "rotate",
        definition: {
          type: "number",
          label: "Field Rotate",
          default: 12,
          min: -360,
          max: 360,
          unit: "degrees",
        },
        targets: [{ nodeId: "place", key: "r" }],
      },
      {
        key: "seed",
        definition: {
          type: "number",
          label: "Seed",
          default: 5,
          step: 1,
          description: "Same seed, same field, on any GPU (§V45).",
        },
        targets: [{ nodeId: "field", key: "seed" }],
      },
    ],
  },
  {
    componentId: "mediaGrade",
    name: "MediaGrade",
    description: "Range, tone and a legal-range tail — the grade you reach for on any input.",
    host: mediaGradeHost,
    selection: ["range", "tone", "legal"],
    publish: [
      {
        key: "blacklevel",
        definition: { type: "number", label: "Black Level", default: 0, min: -1, max: 2 },
        targets: [{ nodeId: "range", key: "blacklevel" }],
      },
      {
        key: "whitelevel",
        definition: { type: "number", label: "White Level", default: 1, min: -1, max: 4 },
        targets: [{ nodeId: "range", key: "whitelevel" }],
      },
      {
        key: "gamma",
        definition: { type: "number", label: "Gamma", default: 1, min: 0.01, max: 8 },
        targets: [{ nodeId: "range", key: "gamma1" }],
      },
      {
        key: "contrast",
        definition: { type: "number", label: "Contrast", default: 1, min: 0, max: 8 },
        targets: [{ nodeId: "range", key: "contrast" }],
      },
      {
        key: "saturation",
        definition: { type: "number", label: "Saturation", default: 1, min: 0, max: 4 },
        targets: [{ nodeId: "tone", key: "saturation" }],
      },
      {
        key: "hue",
        definition: {
          type: "number",
          label: "Hue Offset",
          default: 0,
          min: -180,
          max: 180,
          unit: "degrees",
        },
        targets: [{ nodeId: "tone", key: "hueoffset" }],
      },
    ],
  },
];

/** Everything a failed authoring step needs to say, without a half-built component. */
export class StarterComponentError extends Error {
  constructor(spec: StarterComponentSpec, step: string, detail: string) {
    super(`Starter component "${spec.name}" failed at ${step}: ${detail}`);
    this.name = "StarterComponentError";
  }
}

/**
 * Authors one starter component the way a user does, and returns what a save would hold.
 *
 * Each call gets its own registry and store, so the five are independent and the
 * sequential id factory starts from the same place every time.
 */
async function authorComponent(spec: StarterComponentSpec): Promise<StarterComponent> {
  const nodeRegistry = createNodeRegistry(allNodeDefinitions).view();
  const { components, nodes } = createComponentSystem(nodeRegistry);
  const store = createGraphStore({
    initialGraph: spec.host.graph,
    ids: createSequentialIdFactory(spec.componentId),
    now: () => STARTER_COMPONENT_TIMESTAMP,
  });
  const { bus } = createDomainBus({ store, registry: nodes });
  registerComponentCommands(bus, { components });

  const saved = await bus.execute(
    "component.saveSelection",
    {
      nodeIds: [...spec.selection],
      name: spec.name,
      componentId: spec.componentId,
      description: spec.description,
    },
    AUTHORING_CONTEXT,
  );
  if (saved.status !== "applied" || !saved.output.ok || saved.output.version === null) {
    throw new StarterComponentError(
      spec,
      "component.saveSelection",
      saved.diagnostics.map((diagnostic) => diagnostic.message).join(" ") || "rejected",
    );
  }
  const version = saved.output.version;

  // Publishing happens INSIDE the component, which is the only place the command works
  // (§V80) — the same session the editor opens when the user enters one.
  const session = openComponentSession({
    components,
    nodes,
    componentId: spec.componentId,
    version,
    ids: createSequentialIdFactory(`${spec.componentId}-inside`),
  });
  try {
    for (const published of spec.publish) {
      const result = await session.bus.execute(
        "component.publishParameter",
        { key: published.key, definition: published.definition, targets: published.targets },
        AUTHORING_CONTEXT,
      );
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) {
        throw new StarterComponentError(
          spec,
          `component.publishParameter("${published.key}")`,
          errors.map((diagnostic) => diagnostic.message).join(" "),
        );
      }
    }
  } finally {
    session.dispose();
  }

  const definition = components.get(spec.componentId, version);
  if (definition === undefined) {
    throw new StarterComponentError(spec, "registry lookup", "the definition was not registered");
  }

  const graph: GraphDocument = store.view.getGraph();
  return {
    spec,
    definition,
    document: {
      schemaVersion: SCHEMA_VERSION,
      projectId: `component-${spec.componentId}`,
      name: spec.name,
      graph,
      settings: spec.host.settings,
      assets: [],
      createdAt: STARTER_COMPONENT_TIMESTAMP,
      updatedAt: STARTER_COMPONENT_TIMESTAMP,
    },
  };
}

/** The whole starter set, authored. Order follows `STARTER_COMPONENT_SPECS`. */
export async function buildStarterComponents(): Promise<readonly StarterComponent[]> {
  const built: StarterComponent[] = [];
  for (const spec of STARTER_COMPONENT_SPECS) built.push(await authorComponent(spec));
  return built;
}
