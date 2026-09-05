import { beforeAll, describe, expect, it } from "vitest";

import { createComponentSystem, parseComponentDefinition } from "../domain/components/index.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeToLinear } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listStarterComponentFiles } from "./catalogue.ts";

/**
 * THE SHIPPED BLOOM COMPONENT ADDS THE PICTURE BACK — B191b.
 *
 * ## The bug this file is the repro for
 *
 * An agent reported "Bloom outputs only its glow, not source-plus-glow". The observation
 * was right and every diagnosis of it was wrong, including "the threshold is too high":
 * Bloom always HAD a second input on its composite, and it was fed from `floor`, which sits
 * downstream of `hot` — a Level with `blacklevel 0.605, whitelevel 0.65`. That 0.045-wide
 * window is a hard HIGHLIGHT ISOLATOR: correct as the input to `bright`/`glow`, and as the
 * BASE LAYER it means the component returns (the picture crushed to near-black) + glow.
 *
 * Measured on Dawn over a flat mid-grey plate before the fix: the picture went in at linear
 * luma 0.5996 and came out at 0.0057 — one percent of itself, tinted violet by the palette's
 * first stop. That is the "black plus chromatic streaks" the report described.
 *
 * ## Why the claims are shaped like this
 *
 * A bloom is `picture + glow`, so the two halves are asserted separately and both are
 * exercised against the mutant that restores the old edge (`asItShipped` below) — the "what
 * differs if the edge were cut" bar taken literally, since this bug WAS one edge.
 *
 * The exact assertion (§V147, no tolerance band) is the one at `intensity 0`: `opacity`
 * scales the FRONT of the composite and the glow is the front, so a zero intensity leaves
 * the picture and nothing else, and "the picture" means BYTE-IDENTICAL to rendering the
 * plate on its own. That single frame comparison says both of the things this bug was
 * about — the base layer is the picture, and `intensity` scales the glow rather than the
 * picture — and it cannot be satisfied by a base layer that is any function of `hot`.
 *
 * The plate is a flat colour BELOW the isolator's black point on purpose: nothing clears
 * the bright cut, so the glow branch contributes only its own floor and the picture is the
 * whole picture. `withHighlights` is the legitimate case the wiring guard could otherwise
 * swallow — the glow must still be there, and still be LOCAL to the highlights.
 */

const SIZE = { width: 160, height: 90 };

/** Mid-grey, sRGB in (a colour swatch is display-space) and well under `hot`'s 0.605. */
const MID_GREY: readonly [number, number, number, number] = [0.6, 0.6, 0.6, 1];

const SETTINGS: ProjectSettings = {
  outputResolution: SIZE,
  // Float readback: the claims are about values, and an 8-bit sink would clip the glow
  // at the bright end of `withHighlights` and quantise the survival margin away.
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

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
}

/** The definition as it SHIPS, read out of the file rather than re-authored. */
function shippedBloom(): GraphComponentDefinition {
  const file = listStarterComponentFiles().find((entry) => entry.fileName === "Bloom.loom.json");
  if (file === undefined) throw new Error("Bloom.loom.json is not shipped");
  const library = (JSON.parse(file.text) as { componentLibrary?: { components?: unknown[] } })
    .componentLibrary;
  const parsed = parseComponentDefinition(library?.components?.[0]);
  if (!parsed.ok) throw new Error(`Bloom.loom.json did not parse: ${parsed.issues.join(", ")}`);
  return parsed.definition;
}

/**
 * The B191b mutant: `combine.in2` back on `floor`, i.e. exactly what shipped before.
 *
 * Everything else — the same seven nodes, the same measured Level window, the same palette
 * — is untouched, so a claim that separates this from the shipped definition is a claim
 * about the ONE edge and nothing else.
 */
function asItShipped(definition: GraphComponentDefinition): GraphComponentDefinition {
  const edges = Object.fromEntries(
    Object.entries(definition.graph.edges).filter(
      ([, edge]) => !(edge.target.nodeId === "combine" && edge.target.portId === "in2"),
    ),
  );
  edges["b191b-floor-combine"] = {
    id: "b191b-floor-combine",
    source: { nodeId: "floor", portId: "out" },
    target: { nodeId: "combine", portId: "in2" },
  };
  return { ...definition, graph: { ...definition.graph, edges } };
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}) =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as never;

/** A flat mid-grey plate with no highlights at all. */
const flatPlate = () => node("plate", "solid", { color: MID_GREY });

/**
 * The same mid-grey with ONE white disc in the middle of it — a picture with a highlight.
 *
 * A disc rather than a gradient because a bloom's palette is authored for a SPARSE mask: a
 * ramp puts a third of the frame over the bright cut, the blurred mask never falls back
 * into the palette's range, and the lookup wraps to black. That measures the palette, not
 * the wiring. One small bright thing wearing a large halo is what a bloom is for.
 */
const discPlate = () =>
  node("plate", "circle", {
    mode: "fill",
    center: [0.5, 0.5],
    radius: [0.18, 0.3],
    softness: 0.02,
    fillcolor: [1, 1, 1, 1],
    bgcolor: MID_GREY,
  });

function plateOnly(plate: ReturnType<typeof flatPlate>): GraphDocument {
  return {
    revision: 1,
    nodes: { plate, out: node("out", "output") },
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "plate", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
    groups: {},
  } as GraphDocument;
}

function throughBloom(
  plate: ReturnType<typeof flatPlate>,
  parameters: Record<string, unknown> = {},
): GraphDocument {
  return {
    revision: 1,
    nodes: { plate, bloom1: node("bloom1", "component:bloom@1", parameters), out: node("out", "output") },
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "plate", portId: "out" },
        target: { nodeId: "bloom1", portId: "picture" },
      },
      e2: {
        id: "e2",
        source: { nodeId: "bloom1", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
    groups: {},
  } as GraphDocument;
}

interface Frame {
  readonly bytes: Uint8Array;
  readonly rgba: Float32Array;
}

async function render(
  graph: GraphDocument,
  definition?: GraphComponentDefinition,
): Promise<Frame> {
  const system = definition === undefined ? undefined : createComponentSystem(nodes, [definition]);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: SETTINGS,
    frames: 1,
    capture: [0],
    ...(system === undefined ? {} : { components: system.components.view() }),
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  expect(errors.map((diagnostic) => diagnostic.message)).toEqual([]);
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const plane = decodeToLinear(
    {
      width: frame.width,
      height: frame.height,
      format: frame.format,
      rowStride: frame.width * BYTES_PER_PIXEL[frame.format],
      bytes: frame.bytes,
    },
    "linear",
  );
  return { bytes: frame.bytes, rgba: plane.rgba };
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;
const lumaAt = (frame: Frame, x: number, y: number): number => {
  const at = (y * SIZE.width + x) * 4;
  return LUMA.reduce((sum, weight, channel) => sum + weight * (frame.rgba[at + channel] ?? 0), 0);
};
const meanLuma = (frame: Frame): number => {
  let sum = 0;
  for (let index = 0; index < frame.rgba.length; index += 4) {
    sum += LUMA.reduce((acc, weight, channel) => acc + weight * (frame.rgba[index + channel] ?? 0), 0);
  }
  return sum / (frame.rgba.length / 4);
};
/** How much of the picture came through: the smallest per-channel (out − in) in the frame. */
const worstChannelDelta = (after: Frame, before: Frame): number => {
  let worst = Infinity;
  for (let index = 0; index < after.rgba.length; index += 1) {
    if (index % 4 === 3) continue; // alpha is not a picture value; `add` sums it too
    worst = Math.min(worst, (after.rgba[index] ?? 0) - (before.rgba[index] ?? 0));
  }
  return worst;
};

describe("the shipped Bloom composites the PICTURE, not the highlight pass (B191b)", () => {
  const shipped = shippedBloom();

  it("feeds the composite's second input from the component's own picture socket", () => {
    // The premise, on the shipped bytes: a stale regen fails here rather than in a render.
    const socket = shipped.inputs.find((port) => port.externalId === "picture");
    expect(socket?.nodeId).toBe("in_picture");

    const feeding = (nodeId: string, portId: string) =>
      Object.values(shipped.graph.edges)
        .filter((edge) => edge.target.nodeId === nodeId && edge.target.portId === portId)
        .map((edge) => edge.source.nodeId);
    expect(feeding("combine", "in2")).toEqual(["in_picture"]);
    // ...and the isolator still feeds the GLOW branch, which is where it belongs. The
    // numbers in `hot` are correct values; only the branch they were on was wrong.
    expect(feeding("hot", "input")).toEqual(["in_picture"]);
    expect(feeding("bright", "input")).toEqual(["floor"]);
  });

  it("returns the picture byte-for-byte when the glow is turned all the way down", async () => {
    requireDawn();
    // §V147, exact: `opacity` scales the composite's FRONT, and the front is the glow. At
    // intensity 0 there is nothing left but the base layer, so the frame must be the plate
    // itself — which is only true if the base layer IS the plate.
    const plate = await render(plateOnly(flatPlate()));
    const bloomed = await render(throughBloom(flatPlate(), { intensity: 0 }), shipped);

    expect(bloomed.bytes).toEqual(plate.bytes);
  });

  it("did not, before B191b: the same frame came back as one percent of the picture", async () => {
    requireDawn();
    // The control case. Without it the assertion above could pass on a build where the
    // component did nothing at all, and it is the measurement the report was about.
    const plate = await render(plateOnly(flatPlate()));
    const old = await render(throughBloom(flatPlate(), { intensity: 0 }), asItShipped(shipped));

    expect(old.bytes).not.toEqual(plate.bytes);
    // A flat plate under the isolator's black point clamps to zero, so the old base layer
    // was black and `intensity 0` removed the only thing left.
    expect(meanLuma(plate)).toBeGreaterThan(0.5);
    expect(meanLuma(old)).toBe(0);
  });

  it("never returns less than the picture it was given", async () => {
    requireDawn();
    // A bloom ADDS. Per channel, per pixel, at full intensity: nothing may come out darker
    // than it went in — which is the general form of "the base layer survived".
    const plate = await render(plateOnly(flatPlate()));
    const bloomed = await render(throughBloom(flatPlate()), shipped);

    expect(worstChannelDelta(bloomed, plate)).toBeGreaterThanOrEqual(0);
    // The old wiring SUBTRACTED almost all of it, and by a margin no rounding explains.
    const old = await render(throughBloom(flatPlate()), asItShipped(shipped));
    expect(worstChannelDelta(old, plate)).toBeLessThan(-0.5);
  });

  it("still glows, and only where the highlights are", async () => {
    requireDawn();
    // The legitimate case the wiring guard could swallow: a component that merely passed
    // its picture through would satisfy every claim above. The halo just outside the disc
    // must gain what the far corner does not — so the threshold/blur branch is still alive
    // AND still keyed to the highlights rather than lifting the whole frame.
    const plate = await render(plateOnly(discPlate()));
    const bloomed = await render(throughBloom(discPlate()), shipped);

    const halo = { x: 100, y: 45 }; // ~20px right of centre, just outside the disc's edge
    const far = { x: 2, y: 2 }; // ~89px from the disc: past 40px of blur, glow-free
    expect(lumaAt(plate, halo.x, halo.y)).toBe(lumaAt(plate, far.x, far.y)); // same background
    const haloGain = lumaAt(bloomed, halo.x, halo.y) - lumaAt(plate, halo.x, halo.y);
    const farGain = lumaAt(bloomed, far.x, far.y) - lumaAt(plate, far.x, far.y);

    // Measured on Dawn: 0.389 in the halo against 0.0013 in the corner — a ratio of ~300.
    expect(haloGain).toBeGreaterThan(0.2);
    // Derived, not a band: 40px of blur cannot carry the highlight 89px across the frame,
    // so whatever the corner holds is the palette's own floor and not this disc's light.
    expect(farGain * 100).toBeLessThan(haloGain);
    // ...and the picture is still under both of them.
    expect(worstChannelDelta(bloomed, plate)).toBeGreaterThanOrEqual(0);
  });
});
