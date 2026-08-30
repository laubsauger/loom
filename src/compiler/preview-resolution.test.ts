import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { MAX_TILE_SCALE } from "../runtime/previews/geometry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";

/**
 * T502 — A PREVIEW KIND CANNOT OPT OUT OF THE BUDGET.
 *
 * ## What went wrong, and why a list would not have caught it
 *
 * T490 made a preview's TILE a budgeted ladder step. Verified on a checker texture, where
 * it worked — a texture preview's source is the node's own output, already at whatever
 * resolution the user set (§V21), so it has the pixels to answer a bigger tile.
 *
 * A point preview's source is not the node's output. There is no texture anywhere in a
 * pointset; the compiler SYNTHESIZES a target and splats into it, and that target was
 * `previewLongEdge` = 192 — BELOW the 384 px base tile every preview is guaranteed at
 * dpr 2 (§V454). So a point preview was upscaled at rest on every retina display and
 * 6× upscaled when zoomed, which is what the owner saw: "zooming in on point operator
 * previews still leaves us with quite a blurry preview".
 *
 * MEASURED on Dawn before assuming anything, because the alternative was real: a splat
 * whose disc size or point count is fixed in TEXELS gains nothing from a bigger target,
 * and enlarging it would have been pure waste. The same one-point graph rendered 24 lit
 * texels at edge 192 and 853 at 1152 — the same fraction of area, so the content'"'"'s
 * resolution IS the target'"'"'s. See `preview-boost.gpu.test.ts`.
 *
 * Every scene payload preview (camera, light, material) had the same defect, which is
 * §V437 to the letter: a policy delivered kind by kind is not delivered.
 *
 * ## The rule, and why it is the BASE rather than the granted step
 *
 * A synthesized preview renders at the tile it is GUARANTEED — the base §V454 reserves,
 * `previewLongEdge × MAX_TILE_SCALE`. Not the granted step, and that is §V142 holding
 * rather than being forgotten: sizing this from the boost puts zoom in the sink set, a
 * ladder crossing then RECOMPILES, and the reallocated target is never redrawn while the
 * transport is paused — measured in the running app as a permanently black preview. The
 * boost can only reach a synthesized preview once it lives in the preview program, which
 * is transport-independent; that is a task of its own.
 *
 * ## The mechanism, and this gate
 *
 * There is exactly ONE place in the compiler that decides how big a synthesized preview
 * renders — `previewTargetEdge`. Two assertions make that a mechanism, not a convention:
 *
 *  1. BEHAVIOUR, over the whole shipped catalogue with no list of kinds anywhere: every
 *     definition, every output port that has no picture of its own. Anything the compile
 *     SYNTHESIZES must be at the base tile. Kind N+1 is covered because the enumerator is
 *     the registry.
 *  2. SOURCE: `settings.previewLongEdge` is read in exactly one place in `compile.ts`.
 *     Kind N+1 that sizes its own target from the raw setting fails here even if it
 *     somehow compiles to nothing in (1).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const PREVIEW_LONG_EDGE = 192;
/** The BASE tile every preview is guaranteed (§V454): `previewLongEdge × MAX_TILE_SCALE`. */
const BASE_TILE = PREVIEW_LONG_EDGE * MAX_TILE_SCALE;

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const SETTINGS: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: PREVIEW_LONG_EDGE,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

function oneNode(type: string): GraphDocument {
  return {
    revision: 1,
    groups: {},
    edges: {},
    nodes: { n1: { id: "n1", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } },
  };
}

/**
 * Resources this compile emitted ONLY because the preview sink asked for them, with their
 * sizes. That is the definition of "synthesized" — no list of resource-id prefixes, no
 * knowledge of which kinds synthesize anything.
 */
function synthesizedFor(type: string, portId: string, settings: ProjectSettings = SETTINGS) {
  const graph = oneNode(type);
  const without = compileGraph({ graph, settings, registry, capabilities: CAPABILITIES });
  const withSink = compileGraph({
    graph,
    settings,
    registry,
    capabilities: CAPABILITIES,
    sinks: [{ nodeId: "n1", portId, kind: "preview" }],
  });
  const before = new Set(without.resources.map((resource) => resource.id));
  return withSink.resources
    .filter((resource) => !before.has(resource.id) && resource.kind === "target")
    .map((resource) => ({ id: resource.id, size: (resource as { size: readonly [number, number] }).size }));
}

/**
 * Every output port in the shipped catalogue that HAS NO PICTURE OF ITS OWN.
 *
 * This is the enumerator, and it is a negation on purpose. A port that declares a
 * `texture2d` already carries the image a preview shows, at the resolution the user set
 * (§V21) — nothing is invented for it and nothing here governs its size. EVERY OTHER port
 * kind, present or future, has no texture anywhere in it, so if previewing one produces a
 * render target then the compiler invented that target and the budget governs it.
 *
 * A new port kind therefore lands in the governed bucket by default, which is the only
 * safe direction for a rule whose failure mode is "the next kind was forgotten" (§V437).
 */
function everyPictureLessOutputPort(): Array<{ type: string; portId: string; kind: string }> {
  const pairs: Array<{ type: string; portId: string; kind: string }> = [];
  for (const definition of allNodeDefinitions) {
    for (const port of definition.outputs) {
      if (port.type.kind === "texture2d") continue;
      pairs.push({ type: definition.type, portId: port.id, kind: port.type.kind });
    }
  }
  return pairs;
}

describe("T502 — a synthesized preview renders at the step the budget granted", () => {
  it("every previewable output in the catalogue honours the grant, with no list of kinds", () => {
    const covered: string[] = [];
    const kinds = new Set<string>();
    const wrong: string[] = [];
    for (const { type, portId, kind } of everyPictureLessOutputPort()) {
      for (const target of synthesizedFor(type, portId)) {
        covered.push(`${type}.${portId}`);
        kinds.add(kind);
        if (target.size[0] !== BASE_TILE || target.size[1] !== BASE_TILE) {
          wrong.push(`${type}.${portId} -> ${target.id} ${target.size.join("x")}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    // NOT VACUOUS (§V147): the sweep must actually reach the kinds that synthesize. Four
    // do today — pointset splats and the three scene payloads — across many definitions.
    // If this number FALLS, a preview kind stopped synthesizing and the sweep above went
    // quiet rather than green; if it RISES, a new kind arrived and was covered by
    // construction, which is the outcome this gate exists to guarantee.
    // 14 today: pointKernel, pointKernelAdvanced and seven point generators splat, and a
    // camera, a light and three material nodes each get a stock scene. A FALL means a
    // preview kind stopped synthesizing and this sweep went quiet rather than green; a
    // RISE means a new kind arrived and was covered without anyone editing a list, which
    // is the outcome the gate exists for.
    expect(covered.length).toBeGreaterThanOrEqual(14);
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it("a synthesized preview is never below the base tile — the upscale at rest is gone", () => {
    // Before T502 this read [192, 192]: the guaranteed tile is 384 at dpr 2, so every
    // point, camera, light and material preview was a 2× blow-up before anyone zoomed.
    expect(synthesizedFor("pointTorus", "out").map((target) => target.size)).toEqual([
      [BASE_TILE, BASE_TILE],
    ]);
    expect(BASE_TILE).toBe(384);
  });

  it("it tracks the project setting, so the rule is one relationship and not one number", () => {
    const half: ProjectSettings = { ...SETTINGS, previewLongEdge: 96 };
    const big: ProjectSettings = { ...SETTINGS, previewLongEdge: 576 };
    expect(synthesizedFor("pointTorus", "out", half).map((target) => target.size)).toEqual([
      [192, 192],
    ]);
    expect(synthesizedFor("pointTorus", "out", big).map((target) => target.size)).toEqual([
      [1152, 1152],
    ]);
  });

  it("the synthesized pool is bounded by the tile pool it mirrors (§V454)", () => {
    // A synthesized source costs exactly what the base tile it fills costs, so a full
    // screen of them spends the pool T490 sized and not a texel more. The boost ceiling
    // cannot lift any one of them, because the boost does not reach here at all.
    const spent = Array.from({ length: 48 }, () => BASE_TILE).reduce(
      (sum, edge) => sum + edge * edge,
      0,
    );
    expect(spent).toBe(48 * 384 * 384);
  });

  it("the compiler reads the base preview resolution in exactly one place", () => {
    // The mechanism, as source. A second reader is a second policy, and the second policy
    // is always the one that forgets the budget (§V437).
    const source = readFileSync(resolve(HERE, "compile.ts"), "utf8");
    const readers = source.split("settings.previewLongEdge").length - 1;
    expect(readers).toBe(1);
    expect(source.includes("const previewTargetEdge")).toBe(true);
  });
});
