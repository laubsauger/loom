import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { SelectableColorFormat } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";

/**
 * The canonical parity corpus (T47, T69).
 *
 * These graphs are the *contract* between the browser path and the headless path: the
 * claim §V47 makes is that the SAME domain graph, through the SAME compiler, produces the
 * same pixels with and without a surface. That claim is only checkable if both sides are
 * handed a byte-identical document, so the documents live here rather than being rebuilt
 * inline on either side.
 *
 * Everything is fixed on purpose:
 *  - resolution is small (64x64 by default) so a readback is 32 KB, not 7 MB;
 *  - `randomSeed` is pinned, because §V45 makes the seed part of the output identity;
 *  - every parameter that has a default is written out explicitly, so a change to a
 *    node definition's default cannot silently move a reference snapshot.
 */

export const PARITY_SIZE = 64;

export function parityLimits(): ProjectSettings["limits"] {
  return {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  };
}

export interface ParitySettingsOptions {
  readonly size?: number;
  readonly seed?: number;
  readonly workingFormat?: SelectableColorFormat;
}

export function paritySettings(options: ParitySettingsOptions = {}): ProjectSettings {
  const size = options.size ?? PARITY_SIZE;
  return {
    outputResolution: { width: size, height: size },
    // rgba8unorm, not the rgba16float the app defaults to: an 8-bit unorm readback is
    // exactly the bytes the target holds, with no half-float decode between the GPU and
    // the assertion. A parity failure then means the pixels differ, not that two decoders
    // disagree. The rgba16float path gets its own case in the Dawn suite.
    workingFormat: options.workingFormat ?? "rgba8unorm",
    // T375 (§V56): these fixtures assert SHADER MATHS against CPU oracles written in the
    // linear working space, so the Output node must not put a display transform on top of
    // the numbers being measured. Saying so explicitly is also a live check that the
    // policy is READ — before T375 nothing read it, and this line would have been inert.
    colorPolicy: { workingSpace: "linear", displayTransform: "none" },
    randomSeed: options.seed ?? 7,
    previewLongEdge: 192,
    previewFps: 20,
    limits: parityLimits(),
  };
}

/**
 * Capabilities describing a conforming Tier-B device.
 *
 * Used only where a compile must be reproducible WITHOUT a GPU (the plan-level parity
 * assertions). Anything that actually renders compiles against the real device's report
 * instead — assuming capabilities is exactly what §V12 forbids.
 */
export function nominalCapabilities(): BackendCapabilities {
  return {
    tier: "B",
    features: [],
    formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "depth24plus"],
    timestampQuery: false,
    limits: { maxTextureDimension2D: 8192 },
  };
}

interface NodeSpec {
  readonly id: string;
  readonly type: string;
  readonly parameters: Record<string, ParameterValue>;
}

function document(nodes: ReadonlyArray<NodeSpec>, links: ReadonlyArray<readonly [string, string, string]>): GraphDocument {
  const doc: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };
  nodes.forEach((spec, index) => {
    doc.nodes[spec.id] = {
      id: spec.id,
      type: spec.type,
      definitionVersion: 1,
      position: { x: index * 200, y: 0 },
      parameters: spec.parameters,
    };
  });
  links.forEach(([source, target, portId], index) => {
    const id = `e${index + 1}`;
    doc.edges[id] = {
      id,
      source: { nodeId: source, portId: "out" },
      target: { nodeId: target, portId },
    };
  });
  return doc;
}

/** Every parity graph presents through this node, so readback always has one name. */
export const OUTPUT_NODE_ID = "out";

/**
 * Graph 1 — gradient -> levels -> output.
 *
 * The smallest chain with a real generator and a real per-pixel transform. A horizontal
 * ramp makes a parity failure legible: a whole-image shift, a channel swap and an
 * off-by-one-texel sampling difference all look different in the dumped row.
 */
export function gradientLevelsGraph(): GraphDocument {
  return document(
    [
      {
        id: "ramp",
        type: "ramp",
        parameters: {
          type: "horizontal",
          color1: [0, 0, 0, 1],
          color2: [1, 1, 1, 1],
          interp: "linear",
          phase: 0,
          period: 1,
        },
      },
      {
        id: "levels",
        type: "level",
        parameters: {
          blacklevel: 0.25,
          whitelevel: 0.75,
          invert: 0,
          gamma1: 2,
          contrast: 1,
          brightness: 1,
          opacity: 1,
        },
      },
      { id: OUTPUT_NODE_ID, type: "output", parameters: {} },
    ],
    [
      ["ramp", "levels", "input"],
      ["levels", OUTPUT_NODE_ID, "input"],
    ],
  );
}

/**
 * Graph 2 — checker -> blur -> blur -> output.
 *
 * Two chained blurs, not one: a chain forces an INTERMEDIATE target that is written by one
 * pass and sampled by the next. That is the resource whose lifecycle `vgpu/mock` cannot
 * observe at all (no createTexture instrumentation, opaque bind-group views), so it is
 * precisely the thing only a real device can check — and the thing T94's resize bug lived
 * in. A checker gives the blur hard edges to actually move.
 */
export function blurChainGraph(): GraphDocument {
  return document(
    [
      {
        id: "checker",
        type: "checker",
        parameters: {
          size: [8, 8],
          offset: [0, 0],
          color1: [0, 0, 0, 1],
          color2: [1, 1, 1, 1],
        },
      },
      { id: "blur1", type: "blur", parameters: { size: 4, filter: "gaussian", extend: "hold" } },
      { id: "blur2", type: "blur", parameters: { size: 2, filter: "gaussian", extend: "hold" } },
      { id: OUTPUT_NODE_ID, type: "output", parameters: {} },
    ],
    [
      ["checker", "blur1", "input"],
      ["blur1", "blur2", "input"],
      ["blur2", OUTPUT_NODE_ID, "input"],
    ],
  );
}

/**
 * Graph 3 — a solid colour straight to output.
 *
 * The control case. Every pixel must be the same known value, so a failure here is a
 * plumbing failure (wrong target read back, readback rows padded, format mismatch) and
 * never a shading difference. When graph 1 and 2 fail but this passes, the harness is fine
 * and the shaders disagree; when this fails too, stop reading the shaders.
 */
export function solidGraph(): GraphDocument {
  return document(
    [
      { id: "solid", type: "solid", parameters: { color: [0.25, 0.5, 0.75, 1] } },
      { id: OUTPUT_NODE_ID, type: "output", parameters: {} },
    ],
    [["solid", OUTPUT_NODE_ID, "input"]],
  );
}

export interface ParityCase {
  readonly name: string;
  readonly graph: () => GraphDocument;
}

/** Iterated by both the Dawn snapshot suite and the parity suite, so neither can drift. */
export const PARITY_CASES: ReadonlyArray<ParityCase> = [
  { name: "solid", graph: solidGraph },
  { name: "gradient->levels", graph: gradientLevelsGraph },
  { name: "blur chain", graph: blurChainGraph },
];
