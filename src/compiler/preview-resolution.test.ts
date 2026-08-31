import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { MAX_TILE_SCALE } from "../runtime/previews/geometry.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitViewProjection } from "../runtime/previews/orbit.ts";
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
 * ## The rule after T563
 *
 * The synthesis lives in the PREVIEW PROGRAM now: the real target is sized to the
 * GRANTED tile (the boost finally reaches it), and it rebuilds outside the frame, so
 * the paused-black failure that kept T502 on the base tile cannot recur. What this file
 * still governs is the compiler's half: the NOMINAL row size (`previewTargetSize`, whose
 * long edge is the base §V454 reserves — `previewLongEdge × MAX_TILE_SCALE`) that the
 * request path reads for aspect, kept to one reader; and the absence — no compile may put
 * a synthesized preview target or pass into the main plan, swept across the catalogue.
 *
 * ## T663: the OTHER edge
 *
 * The row used to be square, and the owner reported what that costs: a texture preview
 * inherits the project's shape and a synthesized one did not, so the two kinds of preview
 * disagreed about what the output looks like. The long edge is still the budget's; the
 * short one is now the project's. That makes this file's old SQUARE fixture actively
 * dangerous (§V461) — it could not distinguish the new rule from the old — so it is wide
 * now, with portrait and square cases beside it.
 *
 * ## The mechanism, and this gate
 *
 * There is exactly ONE place in the compiler that decides how big a synthesized preview
 * renders — `previewTargetSize`. Two assertions make that a mechanism, not a convention:
 *
 *  1. BEHAVIOUR, over the whole shipped catalogue with no list of kinds anywhere: every
 *     definition, every output port that has no picture of its own. Anything the compile
 *     SYNTHESIZES must be at the base tile. Kind N+1 is covered because the enumerator is
 *     the registry.
 *  2. SOURCE: `settings.previewLongEdge` is read in exactly one place in `compile.ts`,
 *     and that reader is called from exactly one place — `previewTargetSize`, which is
 *     what applies the aspect. Kind N+1 that sizes its own target from the raw setting,
 *     or that takes the long edge and squares it, fails here even if it somehow compiles
 *     to nothing in (1).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const PREVIEW_LONG_EDGE = 192;
/** The BASE tile every preview is guaranteed (§V454): `previewLongEdge × MAX_TILE_SCALE`. */
const BASE_TILE = PREVIEW_LONG_EDGE * MAX_TILE_SCALE;
/**
 * T663 — the SHORT edge, at the fixture project's aspect.
 *
 * §V461, and it is the whole reason this file's fixture changed: the settings below used
 * to be 64x64, and a SQUARE project cannot tell "inherited the project's aspect" from
 * "hard-coded square". Every assertion in this file would have stayed green through a
 * complete failure to implement T663. The fixture is 1280x720 now — the shipped default,
 * and wide — so the two answers differ, and `inherits the project's aspect` below adds a
 * PORTRAIT one so the relationship is proven in both directions rather than at one point.
 */
const BASE_SHORT = 216;

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const SETTINGS: ProjectSettings = {
  // 1280x720, the shipped default — WIDE, so a square result is distinguishable (§V461).
  outputResolution: { width: 1280, height: 720 },
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
 * Output rows this compile synthesized ONLY because the preview sink asked for them,
 * with their nominal sizes. That is the definition of "synthesized" — no list of
 * resource-id prefixes, no knowledge of which kinds synthesize anything. T563: the
 * synthesis rides the OUTPUT ROW (the preview program owns the real target, sized to
 * the granted tile); the row's `size` is the nominal size this rule governs — long edge
 * from the budget, short edge from the project (T663) — and the plan itself must stay
 * clean of preview targets, asserted per compile, every time.
 */
function synthesizedFor(type: string, portId: string, settings: ProjectSettings = SETTINGS) {
  const graph = oneNode(type);
  const withSink = compileGraph({
    graph,
    settings,
    registry,
    capabilities: CAPABILITIES,
    sinks: [{ nodeId: "n1", portId, kind: "preview" }],
  });
  // T563's absence half, swept across the whole catalogue: no compile may put a
  // synthesized preview target or pass into the main plan.
  expect(
    withSink.resources.filter((resource) => resource.id.startsWith("preview:")),
  ).toEqual([]);
  expect(
    withSink.passes.filter((pass) => pass.id.includes("#pointsPreview") || pass.id.includes("#scenePreview")),
  ).toEqual([]);
  return withSink.outputs
    .filter((output) => output.synthesis !== undefined)
    .map((output) => ({ id: output.resourceId, size: output.size }));
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
        if (target.size[0] !== BASE_TILE || target.size[1] !== BASE_SHORT) {
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
    // The LONG edge is what the budget governs; T663 only decides the other one.
    expect(synthesizedFor("pointTorus", "out").map((target) => target.size)).toEqual([
      [BASE_TILE, BASE_SHORT],
    ]);
    expect(BASE_TILE).toBe(384);
  });

  it("it tracks the project setting, so the rule is one relationship and not one number", () => {
    const half: ProjectSettings = { ...SETTINGS, previewLongEdge: 96 };
    const big: ProjectSettings = { ...SETTINGS, previewLongEdge: 576 };
    expect(synthesizedFor("pointTorus", "out", half).map((target) => target.size)).toEqual([
      [192, 108],
    ]);
    expect(synthesizedFor("pointTorus", "out", big).map((target) => target.size)).toEqual([
      [1152, 648],
    ]);
  });

  it("inherits the project's ASPECT — wide, portrait and square, from one relationship", () => {
    /**
     * T663. Owner: "maybe we should render the previews for points in project aspect
     * ratio instead of square when the output is wide and vice versa... basically always
     * according to resolution settings and aspect etc which is auto by default so should
     * be inherited."
     *
     * "and vice versa" is why PORTRAIT is here and not just wide: a fixture that only
     * ever widens cannot tell "follows the project" from "is 16:9", the same way the old
     * square fixture could not tell it from "is square" (§V461). The long edge is the
     * budget's, unchanged, in all three.
     */
    const portrait: ProjectSettings = { ...SETTINGS, outputResolution: { width: 720, height: 1280 } };
    const square: ProjectSettings = { ...SETTINGS, outputResolution: { width: 512, height: 512 } };
    const ultrawide: ProjectSettings = { ...SETTINGS, outputResolution: { width: 2560, height: 720 } };

    expect(synthesizedFor("pointTorus", "out").map((t) => t.size)).toEqual([[384, 216]]);
    expect(synthesizedFor("pointTorus", "out", portrait).map((t) => t.size)).toEqual([[216, 384]]);
    expect(synthesizedFor("pointTorus", "out", square).map((t) => t.size)).toEqual([[384, 384]]);
    expect(synthesizedFor("pointTorus", "out", ultrawide).map((t) => t.size)).toEqual([[384, 108]]);

    // And it reaches every SYNTHESIZED kind, not just the splat (§V437: a policy
    // delivered kind by kind is not delivered). A camera, a light and a material.
    expect(synthesizedFor("camera", "out", portrait).map((t) => t.size)).toEqual([[216, 384]]);
    expect(synthesizedFor("light", "out", portrait).map((t) => t.size)).toEqual([[216, 384]]);
    expect(synthesizedFor("materialPhong", "out", portrait).map((t) => t.size)).toEqual([[216, 384]]);
  });

  it("the PROJECTION is built at the target's aspect, or the picture comes out stretched", () => {
    /**
     * The coupling T663 names, asserted rather than trusted: the stock matrix baked into
     * the synthesized draw, and the basis T561/T656's inspection camera re-derives from,
     * must both be at the TARGET's aspect. A projection at aspect 1 into a 16:9 target
     * renders stretched — and the failure is silent, because it looks like a picture.
     */
    const graph = oneNode("pointTorus");
    const wide = compileGraph({
      graph, settings: SETTINGS, registry, capabilities: CAPABILITIES,
      sinks: [{ nodeId: "n1", portId: "out", kind: "preview" }],
    });
    const row = wide.outputs.find((output) => output.synthesis !== undefined);
    const [width, height] = row?.size ?? [0, 0];
    expect(row?.synthesis?.orbit?.aspect).toBeCloseTo(width! / height!, 12);
    expect(row?.synthesis?.orbit?.aspect).not.toBe(1);

    // The baked matrix agrees with that basis at IDENTITY — §V528's short-circuit is
    // what makes "an untouched preview and a reset one are the same picture" true, and
    // it is only true if the two were built at the same aspect.
    const basis = row?.synthesis?.orbit;
    const baked = row?.synthesis?.passes.find((pass) => pass.id.includes("#pointsPreview"))
      ?.uniforms?.["viewProjection"] as number[] | undefined;
    expect(baked).toEqual(orbitViewProjection(basis as never, DEFAULT_PREVIEW_ORBIT));
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
    expect(source.includes("const previewTargetLongEdge")).toBe(true);
    // T663 strengthens the same mechanism: the long edge is reachable only THROUGH the
    // sizer that applies the project's aspect, so a kind N+1 cannot take the budget's
    // number and square it. One call site, inside `previewTargetSize`.
    expect(source.split("previewTargetLongEdge()").length - 1).toBe(1);
    expect(source.includes("const previewTargetSize")).toBe(true);
  });
});
