import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  ProjectDocument,
  ProjectSettings,
} from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";

/**
 * The proof-of-concept graph from doc §27, as a project document.
 *
 * ```text
 * Noise ──→ Displace ──→ Level ──→ Composite ──→ Output
 *   │          ↑                       ↑
 *   │          └──── Feedback ←────────┘
 *   └────────→ Colorize ───────────────┘
 * ```
 *
 * Every claim doc §27 makes about this shape is a structural fact about THIS document, so
 * the document is written once and every Phase 1 gate reads it from here:
 *
 *  - `noise` has two consumers (`warp.source` and `tint.input`) — the fan-out.
 *  - `mix` has two consumers (`echo.in` and `out.input`) — a second fan-out, and the one
 *    that closes the loop.
 *  - the ONLY edge that closes the cycle leaves `echo.out`, which the Feedback manifest
 *    declares temporal, so the current-frame graph is still a DAG (§V4).
 *  - `mix` is a two-input composite, fed from both branches.
 *
 * Sizes are deliberately small (64×64) and `rgba8unorm` deliberately chosen: an 8-bit
 * unorm readback is exactly the bytes the target holds, so a pixel assertion is about the
 * picture and not about two half-float decoders agreeing. The seed is pinned because §V45
 * makes it part of the output identity.
 *
 * This is a GATE fixture, not a shipped example, so it lives here rather than in
 * `examples/`. It is still round-tripped through `serializeProjectDocument` →
 * `loadProject` by the Phase 1 gate, because doc §27 lists "save and reload" as one of the
 * things the shape must demonstrate.
 */

export const POC_SIZE = 64;
export const POC_SEED = 7;

/** Ids, exported so a gate names a node once and the fixture stays the single source. */
export const POC = {
  noise: "noise",
  displace: "warp",
  level: "grade",
  composite: "mix",
  output: "out",
  feedback: "echo",
  colorize: "tint",
} as const;

function node(
  id: string,
  type: string,
  position: readonly [number, number],
  parameters: Record<string, ParameterValue> = {},
): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: position[0], y: position[1] },
    parameters,
  };
}

function edge(id: string, from: readonly [string, string], to: readonly [string, string]): GraphEdge {
  return {
    id,
    source: { nodeId: from[0] as string, portId: from[1] as string },
    target: { nodeId: to[0] as string, portId: to[1] as string },
  };
}

export function pocSettings(size = POC_SIZE): ProjectSettings {
  return {
    outputResolution: { width: size, height: size },
    workingFormat: "rgba8unorm",
    randomSeed: POC_SEED,
    previewLongEdge: 192,
    previewFps: 20,
    limits: {
      maxResolution: 4096,
      maxDispatch: 65_535,
      maxBufferBytes: 268_435_456,
      memoryBudgetBytes: 1_073_741_824,
    },
  };
}

export function pocGraph(): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node(POC.noise, "noise", [-520, 0], {
          type: "simplex2d",
          seed: 3,
          period: 0.35,
          harmon: 2,
          gain: 0.5,
          mono: true,
          aspectcorrect: true,
        }),
        node(POC.displace, "displace", [-260, -80], {
          weight: [0.06, 0.06],
          offset: [0.5, 0.5],
          sourcex: "red",
          sourcey: "green",
          extend: "mirror",
        }),
        node(POC.level, "level", [0, -80], {
          blacklevel: 0.05,
          whitelevel: 0.95,
          gamma1: 1.1,
          contrast: 1.05,
        }),
        node(POC.colorize, "hsv", [-260, 180], {
          hueoffset: 40,
          saturation: 1.4,
          value: 1,
        }),
        node(POC.composite, "over", [260, 0], { opacity: 0.6 }),
        node(POC.feedback, "feedback", [260, 220], {
          persistence: 0.9,
          clearColor: [0, 0, 0, 0],
        }),
        node(POC.output, "output", [520, 0]),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: Object.fromEntries(
      [
        // Fan-out from Noise: two consumers of ONE output (§V6).
        edge("e-noise-warp", [POC.noise, "out"], [POC.displace, "source"]),
        edge("e-noise-tint", [POC.noise, "out"], [POC.colorize, "input"]),
        // The temporal edge. This is the only edge that closes the cycle (§V4).
        edge("e-echo-warp", [POC.feedback, "out"], [POC.displace, "disp"]),
        edge("e-warp-grade", [POC.displace, "out"], [POC.level, "input"]),
        // Multi-input composite, one input per branch.
        edge("e-grade-mix", [POC.level, "out"], [POC.composite, "in1"]),
        edge("e-tint-mix", [POC.colorize, "out"], [POC.composite, "in2"]),
        // Second fan-out: the composite feeds both the loop and the output.
        edge("e-mix-echo", [POC.composite, "out"], [POC.feedback, "in"]),
        edge("e-mix-out", [POC.composite, "out"], [POC.output, "input"]),
      ].map((entry) => [entry.id, entry]),
    ),
    groups: {},
  };
}

const TIMESTAMP = "2026-08-29T00:00:00.000Z";

export function pocDocument(size = POC_SIZE): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "acceptance-poc",
    name: "PoC acceptance graph",
    graph: pocGraph(),
    settings: pocSettings(size),
    assets: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}
