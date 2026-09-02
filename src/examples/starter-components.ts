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
import { channelExpression } from "../domain/parameters/slots.ts";
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
 * AudioLevel's host (T822/T821): the common audio analysis, wrapped.
 *
 * The owner's ask and §T821's ruling met in the same place — the affine auto-level chain
 * that E27 and E43 each rebuilt by hand belongs behind ONE boundary, reused. The seven
 * nodes are §T821's MEASURED chain, re-run at HEAD: a peak-follower (5 ms attack, 500 ms
 * release = valueLag ratio 100) and its mirror floor-follower (500 ms rise, 1 ms fall =
 * ratio 0.002), then `(raw − floor) / (peak − floor)` clamped to 0..1. It takes three
 * different source levels — amount 1, 0.5, 0.25 — all to 0.000..1.000, so a parameter
 * tuned against its output keeps its range whatever the track's level (the whole point of
 * an analyser). Every band the source publishes is normalised at once, per channel.
 *
 * It is a SOURCE component — the audioPattern is inside, so an adopter drops one node, not a
 * chain. `probe` stays outside: the cut `clamp → probe` value edge is what synthesizes the
 * component's value OUTPUT boundary (T822), and probe driving `glow.brightness` by its own
 * channel is the runnable demonstration — the normalised low band as a pulsing level.
 *
 * ratio 100 is why §T823 widened Release Ratio's drag travel to 100: `responsiveness` is a
 * PUBLISHED knob, and a published knob the user cannot drag to its useful setting is a
 * defect.
 */
const AUDIO_LEVEL_SETTINGS: ProjectSettings = {
  outputResolution: { width: 640, height: 360 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 30,
  limits: LIMITS,
};

/** The retained-static + channel-expression slot a parameter takes when a channel drives it (§T897). */
const drivenBy = (channel: string, retained: number) => ({
  mode: "expression" as const,
  bindings: {
    static: { kind: "static" as const, value: retained },
    expression: { kind: "expression" as const, source: channelExpression(channel) },
  },
});

export const audioLevelHost: ProjectDocument = {
  schemaVersion: SCHEMA_VERSION,
  projectId: "component-audio-level",
  name: "AudioLevel",
  settings: AUDIO_LEVEL_SETTINGS,
  assets: [],
  createdAt: STARTER_COMPONENT_TIMESTAMP,
  updatedAt: STARTER_COMPONENT_TIMESTAMP,
  graph: {
    revision: 1,
    nodes: {
      // The analyser (inside): source + the six-node auto-level chain.
      beat: { id: "beat", type: "audioPattern", definitionVersion: 1, position: { x: -720, y: 240 }, parameters: { bpm: 112, amount: 1 } },
      peak: { id: "peak", type: "valueLag", definitionVersion: 1, position: { x: -480, y: 120 }, parameters: { lag: 0.005, releaseRatio: 100 } },
      floor: { id: "floor", type: "valueLag", definitionVersion: 1, position: { x: -480, y: 360 }, parameters: { lag: 0.5, releaseRatio: 0.002 } },
      num: { id: "num", type: "valueMath", definitionVersion: 1, position: { x: -240, y: 200 }, parameters: { operation: "subtract" } },
      den: { id: "den", type: "valueMath", definitionVersion: 1, position: { x: -240, y: 360 }, parameters: { operation: "subtract" } },
      norm: { id: "norm", type: "valueMath", definitionVersion: 1, position: { x: 0, y: 280 }, parameters: { operation: "divide" } },
      clamp: { id: "clamp", type: "valueLimit", definitionVersion: 1, position: { x: 240, y: 280 }, parameters: { minimum: 0, maximum: 1 } },
      // Outside: the probe that reads the normalised value and drives the demo.
      probe: { id: "probe", type: "valueLimit", definitionVersion: 1, position: { x: 480, y: 280 }, parameters: { minimum: 0, maximum: 1 } },
      // The demonstration picture: a plate whose brightness rides the normalised low band.
      swatch: {
        id: "swatch",
        type: "checker",
        definitionVersion: 1,
        position: { x: -240, y: -120 },
        parameters: { size: [6, 4], offset: [0, 0], color1: [0.05, 0.07, 0.12, 1], color2: [0.85, 0.8, 0.62, 1] },
      },
      glow: {
        id: "glow",
        type: "level",
        definitionVersion: 1,
        position: { x: 240, y: -120 },
        parameters: {
          blacklevel: 0,
          whitelevel: 1,
          gamma1: 1,
          contrast: 1,
          brightness: drivenBy("probe:low", 1),
          opacity: 1,
        },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 480, y: -120 }, parameters: {} },
    },
    edges: {
      "e-beat-peak": { id: "e-beat-peak", source: { nodeId: "beat", portId: "out" }, target: { nodeId: "peak", portId: "in" } },
      "e-beat-floor": { id: "e-beat-floor", source: { nodeId: "beat", portId: "out" }, target: { nodeId: "floor", portId: "in" } },
      "e-beat-num": { id: "e-beat-num", source: { nodeId: "beat", portId: "out" }, target: { nodeId: "num", portId: "a" } },
      "e-floor-num": { id: "e-floor-num", source: { nodeId: "floor", portId: "out" }, target: { nodeId: "num", portId: "b" } },
      "e-peak-den": { id: "e-peak-den", source: { nodeId: "peak", portId: "out" }, target: { nodeId: "den", portId: "a" } },
      "e-floor-den": { id: "e-floor-den", source: { nodeId: "floor", portId: "out" }, target: { nodeId: "den", portId: "b" } },
      "e-num-norm": { id: "e-num-norm", source: { nodeId: "num", portId: "out" }, target: { nodeId: "norm", portId: "a" } },
      "e-den-norm": { id: "e-den-norm", source: { nodeId: "den", portId: "out" }, target: { nodeId: "norm", portId: "b" } },
      "e-norm-clamp": { id: "e-norm-clamp", source: { nodeId: "norm", portId: "out" }, target: { nodeId: "clamp", portId: "in" } },
      // The boundary-defining edge: source inside, target outside → one componentOutValue.
      "e-clamp-probe": { id: "e-clamp-probe", source: { nodeId: "clamp", portId: "out" }, target: { nodeId: "probe", portId: "in" } },
      "e-swatch-glow": { id: "e-swatch-glow", source: { nodeId: "swatch", portId: "out" }, target: { nodeId: "glow", portId: "input" } },
      "e-glow-out": { id: "e-glow-out", source: { nodeId: "glow", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  },
};

/**
 * The specs.
 *
 * Ordered the way the library reads them: the two most-reached-for first, then the two
 * that are chains rather than effects, the grade, then the audio analyser.
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
        definition: { type: "number", label: "Persistence", default: 0.997, min: 0, max: 1, step: 0.001 },
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
        definition: { type: "vector", size: 2, label: "Drift", default: [0, -0.0008], min: -1, max: 1, step: 0.0001 },
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
          step: 0.05,
          unit: "degrees",
        },
        targets: [{ nodeId: "drift", key: "r" }],
      },
      {
        key: "softness",
        definition: { type: "number", label: "Softness", default: 1.4, min: 0, max: 128, step: 0.1, unit: "px" },
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
        definition: { type: "number", label: "Radius", default: 40, min: 0, max: 128, step: 0.5, unit: "px" },
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
          step: 0.01,
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
          step: 0.05,
          unit: "degrees",
        },
        targets: [{ nodeId: "fold", key: "r" }],
      },
      {
        key: "zoom",
        definition: { type: "vector", size: 2, label: "Zoom", default: [0.5, 0.5], min: -8, max: 8, step: 0.01 },
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
          step: 0.05,
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
          step: 0.01,
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
          step: 0.05,
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
        definition: { type: "number", label: "Black Level", default: 0, min: -1, max: 2, step: 0.005 },
        targets: [{ nodeId: "range", key: "blacklevel" }],
      },
      {
        key: "whitelevel",
        definition: { type: "number", label: "White Level", default: 1, min: -1, max: 4 },
        targets: [{ nodeId: "range", key: "whitelevel" }],
      },
      {
        key: "gamma",
        definition: { type: "number", label: "Gamma", default: 1, min: 0.01, max: 8, step: 0.01 },
        targets: [{ nodeId: "range", key: "gamma1" }],
      },
      {
        key: "contrast",
        definition: { type: "number", label: "Contrast", default: 1, min: 0, max: 8, step: 0.01 },
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
  {
    componentId: "audioLevel",
    name: "AudioLevel",
    description: "The audio analyser, auto-levelled — every band normalised to 0..1 whatever the track's level.",
    host: audioLevelHost,
    // The source comes WITH it: this is the reusable ANALYSER, so an adopter drops one node
    // and reads its normalised channels, not a seven-node chain rebuilt by hand (T821). The
    // probe stays outside — the cut clamp→probe value edge synthesizes the value output.
    selection: ["beat", "peak", "floor", "num", "den", "norm", "clamp"],
    publish: [
      {
        key: "bpm",
        definition: { type: "number", label: "BPM", default: 112, min: 20, max: 300, range: "floor" },
        targets: [{ nodeId: "beat", key: "bpm" }],
      },
      {
        key: "amount",
        definition: {
          type: "number",
          label: "Amount",
          default: 1,
          min: 0,
          max: 1,
          range: "bounded",
          description: "Master gain on the source. The auto-level adapts, so this changes feel, not range.",
        },
        targets: [{ nodeId: "beat", key: "amount" }],
      },
      {
        key: "responsiveness",
        definition: {
          type: "number",
          label: "Responsiveness",
          default: 100,
          min: 1,
          max: 100,
          step: 0.5,
          description:
            "How slowly the peak-follower forgets a loud hit (its release ratio). 100 is a 500 ms tail; lower makes the normaliser chase level faster and sag harder between hits. T823 widened the travel to reach it.",
        },
        targets: [{ nodeId: "peak", key: "releaseRatio" }],
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
