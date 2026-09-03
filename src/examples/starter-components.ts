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
import { DEPTH_CARVE_KERNEL, DEPTH_PAINT_KERNEL } from "./shaders/depth-points.wgsl.ts";
import { TIME_GRID_BREAK_WGSL, TIME_GRID_MAP_WGSL, TIME_GRID_SWEEP_WGSL } from "./shaders/time-grid.wgsl.ts";
import { SHARED_UNIFORMS_WGSL } from "../runtime/backend/shared-uniforms.ts";
import { SHADER_SOURCE_PARAMETER } from "../domain/commands/apply-patch.ts";

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
  actor: { kind: "system", id: "loom-starter-set", label: "Loom" },
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
      probe: { id: "probe", type: "valueLimit", definitionVersion: 1, position: { x: 480, y: 280 }, parameters: { minimum: 0, maximum: 1 }, label: "probe" },
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
 * DepthPoints' host (T958): a depth map from ANYWHERE — here a hand-authored radial
 * gradient, which is the point (the component takes a depth TEXTURE, not "the depth
 * node", so our ML `depth`, a depth camera, a rendered depth buffer and this gradient
 * are all the same to it) — carved into a real 3D point cloud and retextured from a
 * second map. The chain inside the selection is grid → carve → paint; the sources, the
 * styling and the camera stay OUTSIDE, because what makes this reusable is the
 * unprojection, not any particular picture.
 */
const DEPTH_POINTS_SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 30,
  limits: LIMITS,
};

const DEPTH_POINT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  /* T973: decoded depth (0 near, 1 far), carved once, read by the paint's heatmap. */
  { name: "depthN", type: "f32", default: [0] },
]);

const depthPointsHost: ProjectDocument = {
  schemaVersion: SCHEMA_VERSION,
  projectId: "component-depth-points",
  name: "DepthPoints",
  settings: DEPTH_POINTS_SETTINGS,
  assets: [],
  createdAt: STARTER_COMPONENT_TIMESTAMP,
  updatedAt: STARTER_COMPONENT_TIMESTAMP,
  graph: {
    revision: 1,
    nodes: {
      depthsrc: {
        id: "depthsrc",
        type: "circle",
        definitionVersion: 1,
        position: { x: -780, y: -120 },
        // A soft radial gradient reads as an inverse depth map: bright centre = close.
        parameters: { mode: "fill", center: [0.5, 0.5], radius: [0.42, 0.42], softness: 0.42, fillcolor: [1, 1, 1, 1] },
        label: "depthsrc1",
      },
      colorsrc: {
        id: "colorsrc",
        type: "ramp",
        definitionVersion: 2,
        position: { x: -780, y: 140 },
        parameters: { type: "horizontal", interp: "smooth", phase: 0, period: 1 },
        label: "colorsrc1",
      },
      grid: {
        id: "grid",
        type: "pointGrid",
        definitionVersion: 1,
        position: { x: -520, y: 0 },
        // Count pinned at the 192x192 ceiling so the published resolution knob can move
        // cols/rows underneath it; the carve kernel parks every index past the grid.
        parameters: { count: 36864, cols: 128, rows: 128, sizeX: 2, sizeY: 2 },
        label: "grid1",
      },
      carve: {
        id: "carve",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: -260, y: 0 },
        parameters: {
          capacity: 36864,
          seed: 7,
          attributes: DEPTH_POINT_ATTRIBUTES,
          kernel: DEPTH_CARVE_KERNEL,
          unproject: 1,
          fov: 60,
          inverseDepth: 1,
          near: 0.5,
          far: 4,
          displace: 1,
        },
        label: "carve1",
      },
      paint: {
        id: "paint",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {
          capacity: 36864,
          seed: 7,
          attributes: DEPTH_POINT_ATTRIBUTES,
          kernel: DEPTH_PAINT_KERNEL,
          gain: 1,
          heat: 0,
        },
        label: "paint1",
      },
      dots: {
        id: "dots",
        type: "geometry",
        definitionVersion: 1,
        position: { x: 260, y: 0 },
        parameters: { mode: "points", scale: 0.008, soft: 1, blend: "additive", material: "glowm1", tint: [1, 1, 1, 1] },
        label: "dots1",
      },
      glowm: {
        id: "glowm",
        type: "materialUnlit",
        definitionVersion: 1,
        position: { x: 260, y: -180 },
        parameters: { color: [1, 1, 1, 1] },
        label: "glowm1",
      },
      eye: {
        id: "eye",
        type: "camera",
        definitionVersion: 1,
        position: { x: 260, y: 180 },
        parameters: { eye: [0.9, 0.5, 3.4], lookAt: [0, 0, 0], fov: 45, near: 0.1, far: 40, ortho: false },
        label: "eye1",
      },
      shot: {
        id: "shot",
        type: "render",
        definitionVersion: 1,
        position: { x: 520, y: 0 },
        parameters: {
          scenes: "dots1",
          camera: "eye1",
          lights: "",
          ambientColor: [0, 0, 0, 1],
          ambientIntensity: 0,
          background: [0.01, 0.012, 0.02, 1],
        },
        label: "shot1",
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 780, y: 0 }, parameters: {}, label: "out1" },
    },
    edges: {
      "e-depth-carve": { id: "e-depth-carve", source: { nodeId: "depthsrc", portId: "out" }, target: { nodeId: "carve", portId: "field" } },
      "e-color-paint": { id: "e-color-paint", source: { nodeId: "colorsrc", portId: "out" }, target: { nodeId: "paint", portId: "field" } },
      "e-grid-carve": { id: "e-grid-carve", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "carve", portId: "in" } },
      "e-carve-paint": { id: "e-carve-paint", source: { nodeId: "carve", portId: "out" }, target: { nodeId: "paint", portId: "in" } },
      "e-paint-dots": { id: "e-paint-dots", source: { nodeId: "paint", portId: "out" }, target: { nodeId: "dots", portId: "points" } },
      "e-shot-out": { id: "e-shot-out", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  },
};

/**
 * DepthCut's host (T977): the MODEL-FREE background cut. A depth map thresholds into a
 * soft matte and the compositing `mask` applies it to the picture — no download, no
 * inference, works on any depth source including the fourth fallback cell (webcam
 * understudy). The copy is honest about what it is: it removes things FURTHER AWAY,
 * not "not-the-person" — a real matte (§T957) knows the difference; this never has to.
 */
const DEPTH_CUT_MATTE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  threshold: f32,
  feather: f32,
  invert: f32,
}

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let s = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  /* Single-channel depth (r32float, T959) reads .r; colour maps read luma (T974's rule). */
  let d = select(dot(s.rgb, vec3f(0.2126, 0.7152, 0.0722)), s.r, s.g + s.b < 1e-6);
  var matte = smoothstep(params.threshold - params.feather, params.threshold + params.feather, d);
  matte = select(matte, 1.0 - matte, params.invert > 0.5);
  return vec4f(matte, matte, matte, matte);
}`;

const depthCutHost: ProjectDocument = {
  schemaVersion: SCHEMA_VERSION,
  projectId: "component-depth-cut",
  name: "DepthCut",
  settings: DEPTH_POINTS_SETTINGS,
  assets: [],
  createdAt: STARTER_COMPONENT_TIMESTAMP,
  updatedAt: STARTER_COMPONENT_TIMESTAMP,
  graph: {
    revision: 1,
    nodes: {
      depthsrc: {
        id: "depthsrc",
        type: "circle",
        definitionVersion: 1,
        position: { x: -520, y: -140 },
        // The same hand-authored inverse-depth stand-in DepthPoints demos with: bright
        // centre = close. Any depth texture serves — that is the point.
        parameters: { mode: "fill", center: [0.5, 0.5], radius: [0.42, 0.42], softness: 0.42, fillcolor: [1, 1, 1, 1] },
        label: "depthsrc1",
      },
      picture: {
        id: "picture",
        type: "checker",
        definitionVersion: 1,
        position: { x: -520, y: 140 },
        parameters: { size: [8, 5], offset: [0, 0], color1: [0.1, 0.14, 0.25, 1], color2: [0.85, 0.7, 0.4, 1] },
        label: "picture1",
      },
      matte: {
        id: "matte",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: -260, y: -140 },
        parameters: { [SHADER_SOURCE_PARAMETER]: DEPTH_CUT_MATTE_WGSL, threshold: 0.5, feather: 0.12, invert: 0 },
        label: "matte1",
      },
      cut: {
        id: "cut",
        type: "mask",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { channel: "red" },
        label: "cut1",
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 260, y: 0 }, parameters: {}, label: "out1" },
    },
    edges: {
      "e-depth-matte": { id: "e-depth-matte", source: { nodeId: "depthsrc", portId: "out" }, target: { nodeId: "matte", portId: "input" } },
      "e-picture-cut": { id: "e-picture-cut", source: { nodeId: "picture", portId: "out" }, target: { nodeId: "cut", portId: "input" } },
      "e-matte-cut": { id: "e-matte-cut", source: { nodeId: "matte", portId: "out" }, target: { nodeId: "cut", portId: "mask" } },
      "e-cut-out": { id: "e-cut-out", source: { nodeId: "cut", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  },
};

/**
 * TimeGrid's host: a moving subject, the wall, an Output.
 *
 * ## The whole component is stock nodes, and that is the finding
 *
 * `tile` repeats the picture into a grid; `slitScan` reads a different moment PER PIXEL
 * out of its own ring, steered by a displacement map. Feed that map a value that is FLAT
 * WITHIN A CELL and the two compose into a video wall where every tile plays a different
 * moment of the same stream. Nothing else was needed — no node was written for this.
 *
 * ORDER IS LOAD-BEARING: `tile` FIRST. The ring then records the already-tiled frame, so
 * each cell region has its own layers to pick from. Scan first and the grid repeats one
 * warped picture — every cell identical, which is the failure that looks like it works.
 *
 * ## THE COST, where it is chosen (§V228)
 *
 * SlitScan's ring is `width x height x bytesPerPixel x (frames + 1)`, and it inherits its
 * size from its input — which, unpinned, is whatever the parent feeds in. At 1080p a
 * 61-frame ring is 1.9 GiB, so `grid` carries a FIXED 512x288 override and every node
 * after it inherits that:
 *
 *     512 x 288 x 8 B x 62 layers = 69.75 MiB, and 61 frames = 1.02 s at 60 fps.
 *
 * The span is what sets the depth, not the cell count: a ring holds a contiguous run of
 * frames, so covering one second costs one second of frames however few cells read them.
 * What the cell count decides is how many of those 61 moments are USED — 61 is enough for
 * every cell of an 8x8 wall to hold a moment of its own.
 *
 * 512x288 is also honest about what a cell can show: at the shipped 3x3 a cell is
 * 170x96 and is stretched to a third of the frame, so history kept at full resolution
 * would be paying 14x the memory for detail the wall cannot display.
 *
 * ## Why 61 and not 60
 *
 * SlitScan spends `frames - 1` steps on a displacement of 1.0. 61 frames means 60 steps,
 * one per rendered frame at 60 fps — which is what makes SWEEP's Rate 1.0 an exact
 * FREEZE (a cell looks one frame further back every frame, so it holds still) instead of
 * a slow drift. At 30 fps the freeze rate is 0.5; the knob's description says so.
 */
const TIME_GRID_SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 30,
  limits: LIMITS,
};

/**
 * The internal working size, and the ceiling every memory line here is computed from.
 *
 * `fit`, not `fixed`, and for the same reason the cell fit exists: a hard 512x288 forces
 * 16:9 on whatever arrives, so a 4:3 camera or a portrait phone clip would be stretched
 * before the wall had done anything at all. TD's "Fit Resolution" preserves the input's
 * aspect and fits it inside the box, so 16:9 gets 512x288, 4:3 gets 384x288, and the ring
 * can only ever be smaller than the number the Span knob quotes.
 */
const TIME_GRID_INTERNAL = { mode: "fit", width: 512, height: 288 } as const;

/**
 * The effective grid, read by all four consumers so they cannot disagree about where a
 * cell starts.
 *
 * The floor is TWO, not one, and it was measured rather than chosen: at `max(1, ...)` a
 * sample-and-hold swinging below its offset parked the wall at 1x1 for a whole hold — a
 * video wall with one cell in it, for sixteen seconds. Two is the smallest count that is
 * still a wall. (One is also what Tile does at repeat 0.5: half an image, not a grid.)
 */
const churnedAxis = (channel: string) => ({
  mode: "expression" as const,
  bindings: {
    static: { kind: "static" as const, value: 3 },
    expression: { kind: "expression" as const, source: `max(1, op('${channel}').chan.value)` },
  },
});
const CHURNED_COLUMNS = churnedAxis("churnx1");
const CHURNED_ROWS = churnedAxis("churny1");

/**
 * ── THE CELL FIT, and it is a correctness fix rather than a look ───────────────────────
 *
 * Tile repeats the source into the SAME frame, so a cell measures W/cols by H/rows and its
 * aspect is (W/H) x (rows/cols). That equals the source's aspect if and ONLY IF rows equals
 * cols — so a square grid is perfect and every other grid stretches the picture to fill a
 * slot of the wrong shape. Measured on a true screen circle through this component:
 *
 *     3x3   -> 1.000   (correct)
 *     4x2   -> 0.500      2x4  -> 2.000
 *     8x12  -> 1.333      4x5  -> 1.200   <- what E51 was shipping
 *
 * The rendered aspect IS rows/cols, exactly. It went unseen because the wall was square
 * for its whole first life, and it was about to get much worse: Churn drives the grid
 * through its most non-square states on purpose.
 *
 * THE FIX IS A FIT INSIDE THE CELL, not a change to the grid (§V118: "letterbox the output
 * inside the surface, centred — NEVER stretched"). It is a PRE-SCALE of the source, and
 * that works because the distortion factor depends only on cols/rows and is therefore the
 * SAME for every cell: scale the picture by (sx, sy) before Tile and a feature lands on
 * screen at (sx/sy) x (rows/cols) — so sx/sy = cols/rows restores it exactly.
 *
 * CROP, NOT LETTERBOX, and the choice is deliberate twice over. Bars between every cell
 * would fragment the grid and eat the density the whole effect lives on — a wall of faces
 * wants faces, not mattes. And crop keeps BOTH scale factors at or above 1, so no fragment
 * ever samples outside the source: there are no bar regions, which means the delay map's
 * cell identity still matches the visible content everywhere and §V849 has nothing to
 * catch. A letterbox would have introduced pixels belonging to no picture, inside cells the
 * map is addressing by index.
 */
const cellFit = (numerator: string, denominator: string) => ({
  mode: "expression" as const,
  bindings: {
    static: { kind: "static" as const, value: 1 },
    expression: {
      kind: "expression" as const,
      source: `max(1, max(1, op('${numerator}').chan.value) / max(1, op('${denominator}').chan.value))`,
    },
  },
});
const CELL_FIT_X = cellFit("churnx1", "churny1");
const CELL_FIT_Y = cellFit("churny1", "churnx1");

export const timeGridHost: ProjectDocument = {
  schemaVersion: SCHEMA_VERSION,
  projectId: "component-time-grid",
  name: "TimeGrid",
  settings: TIME_GRID_SETTINGS,
  assets: [],
  createdAt: STARTER_COMPONENT_TIMESTAMP,
  updatedAt: STARTER_COMPONENT_TIMESTAMP,
  graph: {
    revision: 1,
    nodes: {
      // ---- outside the boundary: a stand-in stream --------------------------------
      /* The component takes a TEXTURE, so a webcam, a movie file or a synthetic
         generator all feed it identically — which is the reason the source is not
         inside. This one is a disc on two incommensurate LFOs: something with IDENTITY,
         because a wall of delayed noise is a wall of noise (§V427). */
      swingx: {
        id: "swingx",
        type: "lfo",
        definitionVersion: 1,
        position: { x: -1420, y: -300 },
        parameters: { shape: "sine", frequency: 0.37, amplitude: 0.34, offset: 0.5, phase: 0 },
        label: "swingx1",
      },
      swingy: {
        id: "swingy",
        type: "lfo",
        definitionVersion: 1,
        position: { x: -1420, y: -60 },
        parameters: { shape: "sine", frequency: 0.23, amplitude: 0.3, offset: 0.5, phase: 0.25 },
        label: "swingy1",
      },
      feed: {
        id: "feed",
        type: "circle",
        definitionVersion: 1,
        position: { x: -1140, y: -180 },
        parameters: {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.16, 0.16],
          softness: 0.08,
          fillcolor: [1, 0.78, 0.4, 1],
          bgcolor: [0.04, 0.05, 0.11, 1],
          aspectcorrect: true,
          "center.x": drivenBy("swingx1", 0.5),
          "center.y": drivenBy("swingy1", 0.5),
        },
        label: "feed1",
      },
      /* The matte the wall isolates subjects with. Inside the demo host it is a luma key,
         which is the honest answer for a bright subject on a dark bed and is
         DETERMINISTIC — every gate and the gallery card see the dropout event actually
         happen. E51 puts the ML `matte` node on the other side of a switch, which is the
         same understudy shape E47 uses for `depth` (§V363/§V411). */
      key: {
        id: "key",
        type: "threshold",
        definitionVersion: 1,
        position: { x: -1140, y: 160 },
        parameters: { threshold: 0.24, softness: 0.3, channel: "luminance", compare: "greater" },
        label: "key1",
      },
      // ---- inside the boundary ----------------------------------------------------
      /*
       * PACK, and it is the reason the dropout costs no second ring.
       *
       * The wall needs TWO pictures per cell — the frame, and the frame with its
       * background removed — and both have to be delayed by that cell's own number of
       * frames. Two rings would be 139.5 MiB. Instead `reorder` puts the matte's luminance
       * into ALPHA (E41's trick: one texture answering two questions), and the single ring
       * carries colour and coverage together. A cell holding a moment from a second ago
       * therefore drops the background OF THAT MOMENT, which is the only version of this
       * that is not subtly wrong.
       *
       * It also carries the resolution pin: everything downstream inherits 512x288 from
       * here, so the ring's cost is decided at the head of the chain rather than in the
       * middle of it.
       */
      /*
       * ── THE CHURN: the grid count is a SIGNAL, not a setting ────────────────────────
       *
       * Sweeping rows and columns is not a layout change on this instrument — every cell
       * holds a different moment, so changing the count REDISTRIBUTES which moments are on
       * screen. It is a re-cut of the whole wall, and it is cheap: `tile.repeat` is a plain
       * uniform (no `compileTime` anywhere in `transforms.ts`) and so is every shader's
       * grid, so a sweep recompiles nothing and reallocates nothing.
       *
       * SAMPLE-AND-HOLD, not a sine, and that is the owner's note three times over — "it
       * shouldn't be a constant element", "occasionally", "rather than constant wobbling".
       * S&H holds one value for a whole period and then jumps, so the wall RESTS and then
       * STRIKES. `repeat`'s `range: "floor"` lands every value on an integer, so the jump
       * is a hard re-cut rather than a smear; that snap IS the effect and is not smoothed.
       *
       * Two oscillators at unrelated slow rates (16 s and 24 s), so rows and columns move
       * INDEPENDENTLY and the wall goes non-square — 8 x 12 and back, which is what the
       * owner asked for and what a single knob could never give.
       *
       * They live INSIDE the component because a published parameter cannot animate at all
       * today (§T1017). B41 makes each instance's internal labels unique and rewrites that
       * instance's own references, so two walls in one document churn independently.
       */
      churnx: {
        id: "churnx",
        type: "lfo",
        definitionVersion: 1,
        position: { x: -1420, y: -420 },
        parameters: { shape: "noise", frequency: 0.062, amplitude: 0, offset: 3, phase: 0 },
        label: "churnx1",
      },
      churny: {
        id: "churny",
        type: "lfo",
        definitionVersion: 1,
        position: { x: -1420, y: -180 },
        parameters: { shape: "noise", frequency: 0.041, amplitude: 0, offset: 3, phase: 0.37 },
        label: "churny1",
      },
      pack: {
        id: "pack",
        type: "reorder",
        definitionVersion: 1,
        position: { x: -860, y: -180 },
        parameters: { outr: "in1r", outg: "in1g", outb: "in1b", outa: "in2lum" },
        resolution: TIME_GRID_INTERNAL,
        label: "pack1",
      },
      /* Aspect, restored before anything is tiled or recorded — see CELL_FIT_X above for
         the arithmetic and the measurements. Scale only: no translate, no rotate, and the
         pivot is the frame centre, so this crops symmetrically and cannot move the
         picture. Both factors are >= 1, so `extend` is never reached. */
      fit: {
        id: "fit",
        type: "transform",
        definitionVersion: 1,
        position: { x: -580, y: -180 },
        parameters: {
          t: [0, 0],
          r: 0,
          s: [1, 1],
          "s.x": CELL_FIT_X,
          "s.y": CELL_FIT_Y,
          p: [0, 0],
          xord: "srt",
          extend: "hold",
          aspectcorrect: false,
        },
        label: "fit1",
      },
      /* The grid, and the resolution pin the ring's whole cost depends on. `repeat` is
         ONE vec2 and the published Grid knob drives it whole: a component publishes onto a
         node's schema keys, and `repeat.y` is not one of them (§V113 components exist for
         slots, not for publish targets). Its two fields are Columns and Rows. */
      grid: {
        id: "grid",
        type: "tile",
        definitionVersion: 1,
        position: { x: -860, y: -180 },
        parameters: {
          repeat: [3, 3],
          "repeat.x": CHURNED_COLUMNS,
          "repeat.y": CHURNED_ROWS,
          offset: [0, 0],
          mirrorx: false,
          mirrory: false,
        },
        resolution: TIME_GRID_INTERNAL,
        label: "grid1",
      },
      /* The delay map. Its controls ARE its shader's `struct Params` (T880/§V805), which
         is what lets Rows, Columns, Mode, Rate and Seed be published without a node
         being written for them. Every one is a per-frame UNIFORM, so changing the wall
         mid-show rebuilds nothing. */
      map: {
        id: "map",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: -860, y: 120 },
        parameters: {
          [SHADER_SOURCE_PARAMETER]: TIME_GRID_MAP_WGSL,
          grid: [3, 3],
          "grid.x": CHURNED_COLUMNS,
          "grid.y": CHURNED_ROWS,
          mode: 1,
          rate: 1,
          seed: 7,
        },
        label: "map1",
      },
      scan: {
        id: "scan",
        type: "slitScan",
        definitionVersion: 1,
        position: { x: -580, y: -180 },
        /*
         * SCALE 0.5, AND IT IS THE BEST TRADE IN THIS COMPONENT (T1019a).
         *
         * Halving the ring's resolution QUARTERS its memory, so the same budget reaches
         * four times further back — and a wall displays each cell at a FRACTION of the
         * frame anyway, so full-resolution history was buying precision nobody can see.
         * At the shipped 3x3 a cell is 170 px wide and its history is 85: a 2x upsample of
         * something already being watched as one ninth of a picture.
         *
         *   512 x 288 x 0.5 = 256 x 144 texels, x 8 B x (Span + 1)
         *     Span  61 -> 62 layers  -> 17.44 MiB   (1.02 s at 60 fps)
         *     Span 120 -> 121 layers -> 34.03 MiB   (2.00 s, the node's own ceiling)
         *
         * The displacement map stays a textureLoad (§V849) — the history DEPICTS and may
         * be filtered, the map ADDRESSES and must not be.
         */
        parameters: { frames: 61, depth: 1, scale: 0.5 },
        label: "scan1",
      },
      /* THE VOCABULARY. Three kinds of damage on three clocks that share no measure, at
         most one per cell per frame — the answer to "all the same all the time". The
         shader's docblock carries the composition; the audio gate is a cell's own
         brightness, so the wall breaks where the music is loudest. */
      break: {
        id: "break",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: -300, y: -180 },
        parameters: {
          [SHADER_SOURCE_PARAMETER]: TIME_GRID_BREAK_WGSL,
          grid: [3, 3],
          "grid.x": CHURNED_COLUMNS,
          "grid.y": CHURNED_ROWS,
          amount: 0.35,
          rate: 1,
          seed: 7,
        },
        label: "break1",
      },
      /* THE SWEEP — a chromatic front that travels across the wall and passes. Separate
         from the vocabulary because it is the one GLOBAL degradation, and because a
         separate knob is the only way either of them can be tested alone. */
      sweep: {
        id: "sweep",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: -20, y: -180 },
        parameters: {
          [SHADER_SOURCE_PARAMETER]: TIME_GRID_SWEEP_WGSL,
          grid: [3, 3],
          "grid.x": CHURNED_COLUMNS,
          "grid.y": CHURNED_ROWS,
          amount: 0.5,
          rate: 1,
        },
        label: "sweep1",
      },
      /*
       * THE CRUSH — the owner's "thresholding, to crush the image a little bit more".
       *
       * Placed BEFORE the lookup on purpose: the palette is indexed by luminance, so
       * crushing first changes WHICH COLOURS the wall can reach, not merely how hard it
       * looks. `contrast` is the published knob; `gamma1` breathes on the free-running
       * clock at a period that shares nothing with the palette's — one is the hand on the
       * knob, the other is the room the knob is in.
       */
      crush: {
        id: "crush",
        type: "level",
        definitionVersion: 1,
        position: { x: 260, y: -180 },
        parameters: {
          blacklevel: 0.03,
          whitelevel: 1,
          contrast: 1.35,
          brightness: 1,
          invert: 0,
          opacity: 1,
          /* PINNED. This breathed on the free-running clock for one build, and it was a
             permanent low-amplitude wobble across the whole wall — the exact thing the
             owner rejected twice ("I don't love the permanent wobble either"). The
             instrument's motion is now events: bursts, re-cuts and the sweep. It also
             made Blend 0 time-varying, which cost the gate an exact claim for nothing. */
          gamma1: 1,
        },
        label: "crush1",
      },
      /*
       * THE RECOLORIZER — Ramp into Lookup, which is the standard way to put a whole wall
       * on one palette (E11's pairing). Luminance is the index, so every cell's brightness
       * becomes a hue and nine independently-lit moments land in one colour world.
       *
       * The phase is an EXPRESSION on the free-running clock, and that works where the
       * published page does not: an internal node is flattened into the parent graph and
       * then resolved like any other node, WITH the frame — only the instance's published
       * values are frozen at flatten time. Measured: with the world held still, the frame
       * changes across 40/55/70 from this one expression.
       *
       * 256x16 rather than the project resolution: a gradient is one dimensional and
       * `lookup` reads a single row of it, so a full-frame palette texture would be
       * megabytes spent on 256 useful texels.
       */
      palette: {
        id: "palette",
        type: "ramp",
        definitionVersion: 2,
        position: { x: -300, y: 300 },
        parameters: {
          type: "horizontal",
          interp: "smooth",
          period: 1,
          phase: {
            mode: "expression",
            bindings: {
              static: { kind: "static", value: 0 },
              expression: { kind: "expression", source: "abstime * 0.043 % 1" },
            },
          },
          /*
           * BLUES, PURPLES AND REDS. NO YELLOWS — the owner's ruling, and the whole
           * warm band is REMOVED rather than compressed: the previous palette ran
           * ... red -> orange -> warm white, and the frame came back cream and tan
           * whatever the index did, because the top third of the gradient was yellow.
           * Dodging part of a palette is not the same as not having it.
           *
           * CYCLIC — first stop and last are the same colour — because `phase` wraps the
           * gradient's axis, and a palette that did not close would sweep a hard seam
           * across the wall once a cycle.
           *
           * NO CHANNEL REACHES 1.0. The hottest stop is 0.94, so the recolorizer's output
           * has headroom left before the transfer clamps and "sometimes it blows out the
           * colour" cannot come from here (§V833). A Lookup's output IS its palette, so
           * bounding the palette bounds the grade.
           */
          stops: [
            { position: 0, color: [0.02, 0.02, 0.09, 1] },
            { position: 0.16, color: [0.07, 0.12, 0.46, 1] },
            { position: 0.36, color: [0.33, 0.13, 0.66, 1] },
            { position: 0.56, color: [0.72, 0.14, 0.52, 1] },
            { position: 0.74, color: [0.97, 0.3, 0.36, 1] },
            /* THE PALE STOP, and it is here because a blues-purples-reds palette is
               intrinsically DARK: those hues top out around 0.35 luma, and a wall graded
               entirely inside them measured 0.277 of luma range against the catalogue's
               0.30 contrast floor — a picture you cannot read. A pale PINK buys the
               brightness a yellow would have bought without being one. */
            { position: 0.88, color: [0.96, 0.72, 0.86, 1] },
            { position: 1, color: [0.02, 0.02, 0.09, 1] },
          ],
        },
        resolution: { mode: "fixed", width: 256, height: 16 },
        label: "palette1",
      },
      /*
       * THE GUARD — one node, and it is §V833 made structural rather than hoped for.
       *
       * Everything upstream can exceed 1: the parent lights the source (E51's audio-driven
       * flare), `crush` multiplies contrast, and a hot cell arrives at the recolorizer
       * carrying headroom. A Lookup INDEXES by luminance, so an over-1 pixel walks off the
       * end of the palette and lands on its cyclic closing stop — the brightest thing in
       * the frame renders as the DARKEST colour, which is where the teal cores and the
       * rainbow rings in the owner's frames came from. The dry side of the dissolve had the
       * same problem one step later, at the display transfer, where it simply clipped.
       *
       * Clamping here fixes both at once, and it fixes them for every source rather than
       * for the one that was measured. It is deliberately AFTER the crush — the crush is
       * allowed to push into headroom, this is where the headroom ends.
       */
      guard: {
        id: "guard",
        type: "limit",
        definitionVersion: 1,
        position: { x: 540, y: -180 },
        parameters: { mode: "clamp", low: 0, high: 1, steps: 4 },
        label: "guard1",
      },
      /*
       * E11's lesson, and its inverse. E11 had to STRETCH its index because a noise field's
       * luminance never left the middle third of the gradient. A wall's histogram is the
       * opposite problem: it reaches black and it reaches white, and an index that reaches
       * 1.0 lands on the cyclic palette's dark closing stop — so the brightest thing in the
       * frame renders DARK and every hot core reads as a ring. Measured on the first build:
       * the bodies came back as orange rings with dark centres.
       *
       * So the index is COMPRESSED into 0.08..0.86: black lands in the deep blue rather
       * than the near-black, white lands on the magenta, and nothing crosses the wrap.
       * The narrower span is also what stops a soft body being painted as concentric
       * rainbow rings — a smooth radial gradient walking a whole palette is E11's effect,
       * and it is the wrong one here.
       */
      tone: {
        id: "tone",
        type: "lookup",
        definitionVersion: 1,
        position: { x: -20, y: 120 },
        parameters: { channel: "luminance", row: 0.5, offset: 0.08, scale: 0.78 },
        label: "tone1",
      },
      /* Colour is a MASTER TINT over the palette, and its default is white — a true
         identity, so the shipped look is the palette unmodified and the knob has its whole
         range to move in rather than a band around a value that already means something. */
      paint: {
        id: "paint",
        type: "solid",
        definitionVersion: 1,
        position: { x: -20, y: 380 },
        parameters: { color: [1, 1, 1, 1] },
        resolution: { mode: "fixed", width: 512, height: 288 },
        label: "paint1",
      },
      tint: {
        id: "tint",
        type: "multiply",
        definitionVersion: 1,
        position: { x: 260, y: 240 },
        parameters: { opacity: 1 },
        label: "tint1",
      },
      /* `mix` at 0 is `mix(a, b, 0)`, exactly the untinted wall, so Blend has a true
         no-op end (§V147) and the whole recolorizer can be dissolved away live. */
      mix: {
        id: "mix",
        type: "cross",
        definitionVersion: 1,
        position: { x: 540, y: -60 },
        parameters: { cross: 0.55 },
        label: "mix1",
      },
      // ---- outside again ------------------------------------------------------------
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 540, y: -60 },
        parameters: {},
        label: "out1",
      },
    },
    edges: {
      "e-feed-key": { id: "e-feed-key", source: { nodeId: "feed", portId: "out" }, target: { nodeId: "key", portId: "input" } },
      // The two boundary-crossing edges: the picture, and the matte that isolates it.
      "e-feed-pack": { id: "e-feed-pack", source: { nodeId: "feed", portId: "out" }, target: { nodeId: "pack", portId: "in1" } },
      "e-key-pack": { id: "e-key-pack", source: { nodeId: "key", portId: "out" }, target: { nodeId: "pack", portId: "in2" } },
      "e-pack-fit": { id: "e-pack-fit", source: { nodeId: "pack", portId: "out" }, target: { nodeId: "fit", portId: "input" } },
      "e-fit-grid": { id: "e-fit-grid", source: { nodeId: "fit", portId: "out" }, target: { nodeId: "grid", portId: "input" } },
      // ONE tiling, TWO consumers (§V6): the map only wants the size, the ring wants the pixels.
      "e-grid-map": { id: "e-grid-map", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "map", portId: "input" } },
      "e-grid-scan": { id: "e-grid-scan", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "scan", portId: "input" } },
      "e-map-scan": { id: "e-map-scan", source: { nodeId: "map", portId: "out" }, target: { nodeId: "scan", portId: "map" } },
      "e-scan-break": { id: "e-scan-break", source: { nodeId: "scan", portId: "out" }, target: { nodeId: "break", portId: "input" } },
      "e-break-sweep": { id: "e-break-sweep", source: { nodeId: "break", portId: "out" }, target: { nodeId: "sweep", portId: "input" } },
      "e-sweep-crush": { id: "e-sweep-crush", source: { nodeId: "sweep", portId: "out" }, target: { nodeId: "crush", portId: "input" } },
      "e-crush-guard": { id: "e-crush-guard", source: { nodeId: "crush", portId: "out" }, target: { nodeId: "guard", portId: "input" } },
      "e-guard-tone": { id: "e-guard-tone", source: { nodeId: "guard", portId: "out" }, target: { nodeId: "tone", portId: "source" } },
      "e-palette-tone": { id: "e-palette-tone", source: { nodeId: "palette", portId: "out" }, target: { nodeId: "tone", portId: "lookup" } },
      "e-tone-tint": { id: "e-tone-tint", source: { nodeId: "tone", portId: "out" }, target: { nodeId: "tint", portId: "in1" } },
      "e-paint-tint": { id: "e-paint-tint", source: { nodeId: "paint", portId: "out" }, target: { nodeId: "tint", portId: "in2" } },
      // The DRY side of the dissolve is the broken, crushed wall — ungraded. So Blend
      // dissolves COLOUR without dissolving damage, which is what makes them independent.
      "e-guard-mix": { id: "e-guard-mix", source: { nodeId: "guard", portId: "out" }, target: { nodeId: "mix", portId: "in1" } },
      "e-tint-mix": { id: "e-tint-mix", source: { nodeId: "tint", portId: "out" }, target: { nodeId: "mix", portId: "in2" } },
      "e-mix-out": { id: "e-mix-out", source: { nodeId: "mix", portId: "out" }, target: { nodeId: "out", portId: "input" } },
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
        definition: { type: "number", label: "BPM", default: 112, min: 20, max: 300, step: 1, range: "floor" },
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
  {
    componentId: "depthPoints",
    name: "DepthPoints",
    description:
      "Depth map in, retextured 3D point cloud out — perspective unprojection with a declared depth encoding, heightfield as the cheap mode.",
    host: depthPointsHost,
    // The sources stay OUTSIDE: the component takes a depth TEXTURE and a colour
    // TEXTURE, which is what lets the ML depth node, a depth camera, a rendered depth
    // buffer or a hand-drawn gradient all feed the same unit (T958).
    selection: ["grid", "carve", "paint"],
    publish: [
      {
        key: "resolution",
        definition: {
          type: "number",
          label: "Resolution",
          default: 128,
          min: 16,
          max: 192,
          step: 1,
          description: "Grid cells per side. The generator's capacity is pinned at the ceiling; the carve kernel parks the surplus.",
        },
        targets: [
          { nodeId: "grid", key: "cols" },
          { nodeId: "grid", key: "rows" },
        ],
      },
      {
        key: "unproject",
        definition: {
          type: "number",
          label: "Unproject",
          default: 1,
          min: 0,
          max: 1,
          step: 1,
          description: "1: perspective unprojection — a ray through each pixel scaled by depth, real 3D. 0: heightfield relief on a plane (the cheap mode).",
        },
        targets: [{ nodeId: "carve", key: "unproject" }],
      },
      {
        key: "fov",
        definition: {
          type: "number",
          label: "FOV",
          default: 60,
          min: 20,
          max: 120,
          unit: "degrees",
          description: "Vertical field of view the depth map was captured with. A depth map alone is geometrically ambiguous — this is the missing half.",
        },
        targets: [{ nodeId: "carve", key: "fov" }],
      },
      {
        key: "inverseDepth",
        definition: {
          type: "number",
          label: "Inverse Depth",
          default: 1,
          min: 0,
          max: 1,
          step: 1,
          description: "1: the map is inverse/disparity-like (monocular ML depth — bright is CLOSE). 0: linear (a depth camera or rendered depth buffer). Wrong setting = a scene turned inside out.",
        },
        targets: [{ nodeId: "carve", key: "inverseDepth" }],
      },
      {
        key: "near",
        definition: { type: "number", label: "Near", default: 0.5, min: 0.01, max: 10, description: "Metres the map's closest value maps to." },
        targets: [{ nodeId: "carve", key: "near" }],
      },
      {
        key: "far",
        definition: { type: "number", label: "Far", default: 4, min: 0.1, max: 20, description: "Metres the map's farthest value maps to." },
        targets: [{ nodeId: "carve", key: "far" }],
      },
      {
        key: "displace",
        definition: { type: "number", label: "Displace", default: 1, min: 0, max: 5, description: "Overall scale — relief height in heightfield mode, world scale of the unprojected cloud." },
        targets: [{ nodeId: "carve", key: "displace" }],
      },
      {
        key: "gain",
        definition: { type: "number", label: "Tint Gain", default: 1, min: 0, max: 4, description: "Brightness of the sampled colour." },
        targets: [{ nodeId: "paint", key: "gain" }],
      },
      {
        key: "heat",
        definition: {
          type: "number",
          label: "Heat",
          default: 0,
          min: 0,
          max: 1,
          description: "T973: blends the photographic tint toward a thermal readout of DEPTH — near burns hot, far cools blue. The middle keeps the picture with depth bleeding through.",
        },
        targets: [{ nodeId: "paint", key: "heat" }],
      },
    ],
  },
  {
    componentId: "depthCut",
    name: "DepthCut",
    description:
      "Model-free background cut: a depth map thresholds into a soft matte and masks the picture. Removes things further away — a real matte knows who the person is; this never needs to.",
    host: depthCutHost,
    selection: ["matte", "cut"],
    publish: [
      {
        key: "threshold",
        definition: {
          type: "number",
          label: "Threshold",
          default: 0.5,
          min: 0,
          max: 1,
          description: "The depth value the cut happens at. With inverse maps (bright = close), higher keeps less.",
        },
        targets: [{ nodeId: "matte", key: "threshold" }],
      },
      {
        key: "feather",
        definition: {
          type: "number",
          label: "Feather",
          default: 0.12,
          min: 0,
          max: 0.5,
          description: "Softness of the cut edge, in depth units.",
        },
        targets: [{ nodeId: "matte", key: "feather" }],
      },
      {
        key: "invert",
        definition: {
          type: "number",
          label: "Invert",
          default: 0,
          min: 0,
          max: 1,
          step: 1,
          description: "1 keeps the far side instead — cut the subject out rather than the background.",
        },
        targets: [{ nodeId: "matte", key: "invert" }],
      },
    ],
  },
  {
    componentId: "timeGrid",
    name: "TimeGrid",
    description:
      "A VJ video wall: Tile makes the grid, SlitScan gives every cell its own moment, a seeded per-cell tear breaks the loud ones, and an evolving Ramp-into-Lookup palette ties them all together. 69.75 MiB of history at 512x288 x 61 frames.",
    host: timeGridHost,
    /* The SOURCE stays outside. A webcam, a movie file and a synthetic generator are all
       just a texture at this boundary, which is the whole reason this is a component and
       not a document (T956's lesson, DepthPoints' precedent). */
    selection: ["churnx", "churny", "pack", "fit", "grid", "map", "scan", "break", "sweep", "crush", "guard", "palette", "tone", "paint", "tint", "mix"],
    publish: [
      /*
       * THE PERFORMANCE PAGE. Eight knobs, and the ones that decide the LAYOUT are
       * plain uniforms on purpose: Rows and Columns drive `tile.repeat` and the map's
       * cell count together, so the wall re-partitions on a uniform write and the ring
       * keeps its layers. That is the "change the grid mid-show" property, and it is the
       * one a future edit is most likely to break by reaching for a compileTime knob.
       */
      {
        key: "columns",
        definition: {
          type: "number",
          label: "Columns",
          default: 3,
          min: 1,
          max: 16,
          step: 1,
          description: "Cells across, and the CENTRE the Churn swings about. 1 is a real setting, not a floor to avoid: a 1x1 wall is the whole frame at a single delay, which is the grid collapsing to one image. Uniform-only, so re-partitioning touches no resource and is safe mid-show. Past 61 cells they start sharing moments — that is all the ring holds.",
        },
        targets: [{ nodeId: "churnx", key: "offset" }],
      },
      {
        key: "rows",
        definition: {
          type: "number",
          label: "Rows",
          default: 3,
          min: 1,
          max: 16,
          step: 1,
          description: "Cells down, and the centre the Churn swings about. Same range and the same 1: the two axes hold independently, so the wall goes non-square, and since T1038 that no longer stretches the picture.",
        },
        targets: [{ nodeId: "churny", key: "offset" }],
      },
      {
        key: "churn",
        definition: {
          type: "number",
          label: "Churn",
          default: 0,
          min: 0,
          max: 8,
          range: "bounded",
          description: "How far the wall re-cuts itself. Two sample-and-hold oscillators at unrelated slow rates (16 s and 24 s) hold a grid, then JUMP to another one — so the wall rests and then strikes rather than wobbling, and rows and columns move independently, so it goes non-square. Changing the count redistributes WHICH MOMENTS are on screen, which is why this reads as a re-cut and not as a resize. Turn it up rather than turning Rate up: the range is what makes this dynamic, the clock is what makes it hectic. 0 pins the wall at Columns x Rows.",
        },
        targets: [
          { nodeId: "churnx", key: "amplitude" },
          { nodeId: "churny", key: "amplitude" },
        ],
      },
      {
        key: "span",
        definition: {
          type: "number",
          label: "Span",
          default: 61,
          min: 16,
          max: 120,
          step: 1,
          description:
            "How long a snapshot the wall distributes, in FRAMES. 61 is 1.02 s at 60 fps; 120 is 2.00 s, which is SlitScan's own ceiling rather than a memory one. COST, before you drag it: the ring runs at HALF the internal resolution (T1019a), so it is 256 x 144 x 8 B x (Span + 1) — 17.44 MiB at 61 frames and 34.03 MiB at 120. Full resolution would be four times that for a picture no cell is big enough to show. The SPAN sets the depth, not the cell count: a ring holds a CONTIGUOUS run, so two seconds costs two seconds of frames however few cells actually read them. Structural — changing it rebuilds the ring, which empties it; the wall refills over the next Span frames.",
        },
        targets: [{ nodeId: "scan", key: "frames" }],
      },
      {
        key: "spread",
        definition: {
          type: "number",
          label: "Spread",
          default: 1,
          min: 0,
          max: 1,
          range: "bounded",
          description: "How much of the held Span the wall distributes across its cells. 1 = the whole ring, 0 = every cell on the live frame.",
        },
        targets: [{ nodeId: "scan", key: "depth" }],
      },
      {
        key: "mode",
        definition: {
          type: "number",
          label: "Mode",
          default: 1,
          min: 0,
          max: 4,
          step: 1,
          description: "0 Uniform (one moment everywhere), 1 Ordered (cascade in reading order), 2 Random (seeded, held), 3 Sweep (delays travel — Rate 1.0 freezes each cell until it snaps), 4 Shots (four angles, re-cut on Rate).",
        },
        targets: [{ nodeId: "map", key: "mode" }],
      },
      {
        key: "rate",
        definition: {
          type: "number",
          label: "Rate",
          default: 1,
          min: 0,
          max: 8,
          range: "bounded",
          unit: "hz",
          description: "The wall's clock \u2014 it stretches every schedule together. In Sweep, 1.0 is an exact freeze at 60 fps with Span 61 (the ring spends Span-1 steps on a full displacement, so 60 steps is one per rendered frame); below is slow motion, above runs backwards. In Shots it is cuts per second. It also scales the glitch's burst periods, so the whole wall speeds up as one instrument.",
        },
        targets: [
          { nodeId: "map", key: "rate" },
          { nodeId: "break", key: "rate" },
          { nodeId: "sweep", key: "rate" },
        ],
      },
      {
        key: "seed",
        definition: {
          type: "number",
          label: "Seed",
          default: 7,
          min: 0,
          max: 999,
          step: 1,
          description: "Deals the cells — which moment each holds in Random and Shots, and which of them tear. Integer hash, no clock (§V44): the same seed is the same wall on every device and every replay.",
        },
        targets: [
          { nodeId: "map", key: "seed" },
          { nodeId: "break", key: "seed" },
        ],
      },
      {
        key: "glitch",
        definition: {
          type: "number",
          label: "Glitch",
          default: 0.35,
          min: 0,
          max: 1,
          range: "bounded",
          description: "How much damage the wall takes. THREE kinds on three clocks that share no measure — a band TEAR, monochrome SNOW over a crushed silhouette, and a DROPOUT that multiplies the cell by its matte so the background falls away — at most one per cell per frame. Sparse by construction: a cell is dealt in by a seeded hash, and the brighter a cell is the likelier it is dealt, so with a source that responds to the music the damage chases the beat across the wall. 0 is the fragment's own texel, unchanged.",
        },
        targets: [{ nodeId: "break", key: "amount" }],
      },
      {
        key: "chroma",
        definition: {
          type: "number",
          label: "Chroma",
          default: 0.5,
          min: 0,
          max: 1,
          range: "bounded",
          description: "A chromatic aberration front that TRAVELS across the wall and passes, once every ~7.7 s at Rate 1, wrapping at the edge so it never stops. Global where every other degradation is per-cell, so it is the thing that ties the cells together rather than separating them. Its fringe is displaced cell-locally, so it never smears one moment into its neighbour. 0 is the fragment's own texel.",
        },
        targets: [{ nodeId: "sweep", key: "amount" }],
      },
      {
        key: "crush",
        definition: {
          type: "number",
          label: "Crush",
          default: 1.35,
          min: 1,
          max: 5,
          description: "Contrast, applied BEFORE the palette — so it does not merely harden the picture, it changes which colours the wall can reach. Its gamma breathes on its own slow clock underneath this knob.",
        },
        targets: [{ nodeId: "crush", key: "contrast" }],
      },
      {
        key: "colour",
        definition: {
          type: "color",
          label: "Colour",
          default: [1, 1, 1, 1],
          space: "display",
          description: "A master tint over the palette. WHITE is a true identity, so the shipped look is the palette itself and this knob has its whole range to swing the wall warm or cold.",
        },
        targets: [{ nodeId: "paint", key: "color" }],
      },
      {
        key: "blend",
        definition: {
          type: "number",
          label: "Blend",
          default: 0.55,
          min: 0,
          max: 1,
          range: "bounded",
          description: "Master dissolve for the recolorizer. 0 is the raw wall exactly — tear and all — and 1 is the palette. The tear is on the dry side, so this dissolves colour without dissolving glitch.",
        },
        targets: [{ nodeId: "mix", key: "cross" }],
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
 * Whether the authoring pass tidies the component's internals before publishing.
 *
 * ALWAYS TRUE IN THE SHIPPED SET. The knob exists for one caller — §T969's byte-identity
 * gate in `layout.test.ts`, which builds the set both ways and compares everything except
 * node positions, so a reordered edge or a dropped parameter cannot ride along inside a
 * "layout only" regeneration (§T886's lesson).
 */
export interface StarterComponentOptions {
  readonly tidy?: boolean;
}

/**
 * Authors one starter component the way a user does, and returns what a save would hold.
 *
 * Each call gets its own registry and store, so the five are independent and the
 * sequential id factory starts from the same place every time.
 */
async function authorComponent(
  spec: StarterComponentSpec,
  options: StarterComponentOptions = {},
): Promise<StarterComponent> {
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
    /*
     * T969 — THE TIDY, AND IT IS A GESTURE, NOT A POST-PROCESS.
     *
     * `component.saveSelection` carries the selected nodes across at the positions they
     * held in the host and then ADDS boundary nodes for the ports it exposed — which have
     * nowhere to go but on top of what is already there. Measured before this line
     * existed: `depthPoints` had `in_field` overlapping `carve` by 158x148px and
     * `in_field_2` overlapping `grid` by 158x140, `audioLevel` had `den` and `num` stacked
     * on one point, `feedbackEcho` had `decay` under `in_in1`. That is the "bunched up
     * mess" the owner found by digging into `holo1`, and it is what §V389's gate never saw
     * because `layout.test.ts` iterated `EXAMPLE_DOCUMENTS` only.
     *
     * It runs INSIDE the session, as `graph.layoutAll` — the same bus command as the
     * canvas "Layout" row, the `L` key and the agent's `layout_graph` (§V191, §V78). So
     * this is literally "enter the component and press L", which keeps §V94 true: the
     * shipped component is still exactly what the authoring path produces, with no second
     * layout algorithm and no hand-placed coordinates to drift.
     *
     * BEFORE the publish loop, because publishing writes the parameter PAGE and moving
     * nodes writes the GRAPH: keeping them in that order means the page is authored
     * against final positions and a future publish that did care about geometry would see
     * the geometry it ships with.
     *
     * `layout.alreadyTidy` is a SUCCESS here (§V288 makes an idempotent tidy a refusal so
     * a keypress does not burn an undo entry) — it means the component was already where
     * the layout would put it, which is the state this line exists to reach.
     */
    if (options.tidy !== false) {
      const laid = await session.bus.execute("graph.layoutAll", {}, AUTHORING_CONTEXT);
      const alreadyTidy = laid.diagnostics.some((diagnostic) => diagnostic.code === "layout.alreadyTidy");
      if (laid.status !== "applied" && !alreadyTidy) {
        throw new StarterComponentError(
          spec,
          "graph.layoutAll",
          laid.diagnostics.map((diagnostic) => diagnostic.message).join(" ") || "rejected",
        );
      }
    }

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
export async function buildStarterComponents(
  options: StarterComponentOptions = {},
): Promise<readonly StarterComponent[]> {
  const built: StarterComponent[] = [];
  for (const spec of STARTER_COMPONENT_SPECS) built.push(await authorComponent(spec, options));
  return built;
}
