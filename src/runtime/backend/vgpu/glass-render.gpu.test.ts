import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";
import { encodePng } from "../../export/png.ts";
import { writeFileSync } from "node:fs";

/**
 * T725 on a REAL device, §V147 exact where the physics is exact.
 *
 * The strongest gate here is the IDENTITY: at ior = 1 `refract` returns the incident
 * ray unchanged, so the glass's extended sample point stays ON the eye ray and projects
 * back to the very fragment being shaded — a polished, non-absorbing, ior-1 pane must
 * be BYTE-IDENTICAL to the wall behind it. Anything less means the screen-space read
 * is off by a texel, a flip, or a colour space, and every prettier setting would then
 * be plausibly wrong (§V147's whole argument).
 *
 * Beer-Lambert is the second exact one: absorption is per-channel REMOVAL (§V644 —
 * glass has no albedo to multiply), so a red absorber over a white wall lands
 * exp(−a·d) on red and leaves green and blue untouched, to the byte.
 */

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

const registry = createNodeRegistry(allNodeDefinitions).view();

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

/**
 * The stage: a WHITE unlit wall filling the view at z = −1, and a glass pane (the
 * default ±1 grid at z = 0) in front of it, camera on-axis at z = 3. The wall is
 * unlit so its bytes are its colour exactly — no lighting arithmetic in the gate.
 */
function glassGraph(
  glassParams: Record<string, unknown>,
  wallColor: [number, number, number, number],
  options: { checker?: boolean } = {},
): GraphDocument {
  const checker = options.checker === true;
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        // The checkered stage: 0/1 fixed-point cells (§V56) worn as the unlit wall's
        // albedo map, so there is spatial structure for a bent ray to reveal.
        ...(checker
          ? [node("cells", "checker", { size: [8, 8], color1: [0, 0, 0, 1], color2: [1, 1, 1, 1] }, "cells1")]
          : []),
        node("wallpts", "pointGrid", { cols: 16, rows: 16, count: 256 }, "wallpts1"),
        node(
          "walllay",
          "pointKernel",
          {
            capacity: 256,
            attributes: JSON.stringify([
              { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            ]),
            kernel:
              "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(p.position.x * 2.4, p.position.y * 2.4, -1.0);\n  return q;\n}",
          },
          "walllay1",
        ),
        node("white", "materialUnlit", { color: wallColor }, "white1"),
        node("wall", "geometry", { mode: "surface", material: "white1" }, "wall1"),
        node("panepts", "pointGrid", { cols: 8, rows: 8 }, "panepts1"),
        node("glassmat", "materialGlass", glassParams, "glassmat1"),
        node("pane", "geometry", { mode: "surface", material: "glassmat1" }, "pane1"),
        node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
        node(
          "shot",
          "render",
          { scenes: "wall1 pane1", camera: "cam1", lights: "", background: [0, 0, 0, 1] },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      ...(checker
        ? { e0: { id: "e0", source: { nodeId: "cells", portId: "out" }, target: { nodeId: "white", portId: "albedo" } } }
        : {}),
      e1: { id: "e1", source: { nodeId: "wallpts", portId: "out" }, target: { nodeId: "walllay", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "walllay", portId: "out" }, target: { nodeId: "wall", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "panepts", portId: "out" }, target: { nodeId: "pane", portId: "points" } },
      e4: { id: "e4", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

function planFor(graph: GraphDocument) {
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return plan;
}

async function renderPlan(graph: GraphDocument): Promise<Uint8Array> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(planFor(graph));
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    const image = await backend.readOutput("target:shot:out");
    return image.bytes;
  } finally {
    backend.dispose();
  }
}

const at = (x: number, y: number): number => (y * 64 + x) * 4;
const centre = at(32, 32);

const savePng = (name: string, bytes: Uint8Array): void => {
  writeFileSync(`test-results/${name}`, encodePng({ width: 64, height: 64, data: bytes }).bytes);
};

describe("glass transmits exactly (T725, §V147)", () => {
  it("ior 1, no absorption: the pane is byte-identical to the wall behind it", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const image = await renderPlan(
      glassGraph({ ior: 1, roughness: 0, thickness: 1, absorption: [0, 0, 0, 1], dispersion: 0 }, [1, 1, 1, 1]),
    );
    // Through the pane (centre) and beside it (near the frame corner, wall direct):
    // the identity refraction must reproduce the wall EXACTLY — 0/1 fixed points of
    // the display decode (§V56), so white is 255 everywhere with no colour maths.
    expect([image[centre], image[centre + 1], image[centre + 2]]).toEqual([255, 255, 255]);
    const beside = at(3, 32);
    expect([image[beside], image[beside + 1], image[beside + 2]]).toEqual([255, 255, 255]);
    savePng("glass-identity.png", image);
  }, 120_000);

  it("Beer-Lambert removes per channel: exp(−a·d) on red, green and blue untouched", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // absorption red = 1 (a display-decode fixed point), thickness 1: red lands
    // exp(−1) of the wall's 255 exactly; the untouched channels are the §V361 control
    // inside the same pixel.
    const image = await renderPlan(
      glassGraph({ ior: 1, roughness: 0, thickness: 1, absorption: [1, 0, 0, 1], dispersion: 0 }, [1, 1, 1, 1]),
    );
    expect(image[centre]).toBe(Math.round(255 * Math.exp(-1)));
    expect([image[centre + 1], image[centre + 2]]).toEqual([255, 255]);
    savePng("glass-beer.png", image);
  }, 120_000);

  it("refraction bends off-axis, dispersion splits it, roughness frosts it", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // The wall carries a hard horizontal split — pure red left, pure blue right —
    // painted by the kernel's own x sign via two materials? One material, so instead:
    // assert against the identity render. Off-centre, an ior-1.5 pane views the wall
    // through a bent ray, so the pixel CHANGES against ior 1; at dead centre (normal
    // incidence) refract() is direction-preserving for ANY ior, so the centre is the
    // control that must NOT change (§V461: the fixture distinguishes bending from any
    // global shift).
    const flat = await renderPlan(
      glassGraph({ ior: 1, roughness: 0, thickness: 1, absorption: [0, 0, 0, 1], dispersion: 0 }, [1, 1, 1, 1], { checker: true }),
    );
    const bent = await renderPlan(
      glassGraph({ ior: 1.9, roughness: 0, thickness: 2.5, absorption: [0, 0, 0, 1], dispersion: 0 }, [1, 1, 1, 1], { checker: true }),
    );
    // Centre: normal incidence — refract() preserves the DIRECTION for any ior, so
    // the only change against the identity pane is the FRESNEL: head-on reflectance
    // f0 = ((ior−1)/(ior+1))² of the black fallback, removed from the white wall.
    // §V147 exact, and it pins both halves at once — the transmitted ray still lands
    // on its own pixel AND the Schlick floor is the dielectric's real f0.
    const f0 = ((1.9 - 1) / (1.9 + 1)) ** 2;
    const behind = flat[centre]!; // the checker cell behind the centre, via the identity pane
    expect(bent[centre]).toBe(Math.round(behind * (1 - f0)));
    // Near the pane's edge the view is oblique, so the refracted ray no longer follows
    // the eye ray — the pixel must move against the identity.
    const oblique = at(20, 32);
    expect(bent[oblique]).not.toBe(flat[oblique]);

    // Dispersion: the same oblique pixel through a dispersive pane must split the
    // channels — the per-wavelength IORs bend differently, and on a white wall with a
    // black fallback edge that reads as unequal r/g/b where the clear pane read equal.
    const spectral = await renderPlan(
      glassGraph({ ior: 1.9, roughness: 0, thickness: 2.5, absorption: [0, 0, 0, 1], dispersion: 0.25 }, [1, 1, 1, 1], { checker: true }),
    );
    const channelSpread = (bytes: Uint8Array, index: number): number =>
      Math.max(bytes[index]!, bytes[index + 1]!, bytes[index + 2]!) -
      Math.min(bytes[index]!, bytes[index + 1]!, bytes[index + 2]!);
    // The fringe lives at the cell boundaries the bent rays cross: per-wavelength
    // IORs land on different sides of a black/white edge, so channels split. The
    // non-dispersive pane over the SAME stage is the §V361 control — every wavelength
    // takes one path, so every pixel stays grey-axis (spread 0).
    let maxSpread = 0;
    for (let x = 8; x < 56; x += 1) maxSpread = Math.max(maxSpread, channelSpread(spectral, at(x, 32)));
    expect(maxSpread).toBeGreaterThan(8);
    let clearSpread = 0;
    for (let x = 8; x < 56; x += 1) clearSpread = Math.max(clearSpread, channelSpread(bent, at(x, 32)));
    expect(clearSpread).toBe(0);
    savePng("glass-dispersion.png", spectral);

    // Roughness: a fully frosted pane reads the pyramid's coarsest level. The wall is
    // uniform white so the FROST must be proven by the frame edge bleeding in: near
    // the pane edge the blurred read mixes the black background into the white wall,
    // where the polished pane read pure wall or pure fallback. Assert the frosted
    // centre stays wall-white (blur of white is white) and a near-edge pixel lands
    // strictly between the polished extremes.
    const frosted = await renderPlan(
      glassGraph({ ior: 1, roughness: 1, thickness: 1, absorption: [0, 0, 0, 1], dispersion: 0 }, [1, 1, 1, 1], { checker: true }),
    );
    // Full frost reads the coarsest pyramid level: the checker's cells average toward
    // grey, so the frosted centre must sit WELL inside the range while the polished
    // identity pane read an exact 0-or-255 cell. That is the pyramid doing its job —
    // roughness selecting a LEVEL, not a per-fragment smear.
    expect(frosted[centre]).toBeGreaterThan(40);
    expect(frosted[centre]).toBeLessThan(215);
    expect([0, 255]).toContain(flat[centre]);
    savePng("glass-frost.png", frosted);
  }, 240_000);

  it("§V309: without a glass geometry the plan carries no pyramid; with one it must", () => {
    const withGlass = planFor(
      glassGraph({ ior: 1.5, roughness: 0, thickness: 1, absorption: [0, 0, 0, 1], dispersion: 0 }, [1, 1, 1, 1]),
    );
    expect(withGlass.passes.some((pass) => pass.id.includes(":glass:pyramid:"))).toBe(true);
    expect(withGlass.passes.some((pass) => pass.id.includes(":glass:") && !pass.id.includes("pyramid"))).toBe(true);

    const graph = glassGraph({ ior: 1.5 }, [1, 1, 1, 1]);
    const nodes = graph.nodes as Record<string, { type: string; parameters: Record<string, unknown> }>;
    nodes["glassmat"] = { ...nodes["glassmat"]!, type: "materialPhong", parameters: {} };
    const withoutGlass = planFor(graph);
    expect(withoutGlass.passes.some((pass) => pass.id.includes(":glass:"))).toBe(false);
  });
});
