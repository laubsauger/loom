import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { viewportPortId } from "../compiler/resources.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * §T1311b(a) — E68 SANCTUM ADOPTS THE VIEW-CAMERA CONTRACT, proved on Dawn.
 *
 * The owner's ask was "very easy to turn the viewer into something we can EXPLORE with,
 * where we're not just stuck viewing a video texture", and for this piece the phrase was
 * literal: a `customWgsl` marcher is a TEXTURE payload, `PREVIEW_ORBIT_RIGS` is keyed by
 * scene-payload KIND, so E68 declared no rig and the viewer refused it outright.
 *
 * These are the two halves of the answer, and each is worthless without the other:
 *
 *   1. THE OVERRIDE WORKS — the viewport really is rendered from somewhere else. Asserted
 *      as a pixel difference against the authored frame, because "the uniform was bound" is
 *      mechanism and this project does not accept mechanism as evidence.
 *   2. ⚑ THE PIECE IS UNTOUCHED — the authored frame is BYTE-IDENTICAL whether a viewport
 *      exists or not. That is the view-only ruling, and byte identity is the only honest
 *      spelling of it: a tolerance band would pass a camera that had moved a little.
 *
 * And the third, which is what makes the first two safe to ship: with no preview sink there
 * is NO viewport row at all, so an export, a thumbnail build and every claims run in this
 * directory compile a plan that has never heard of it.
 */

function e68() {
  const file = listExamples().find((entry) => entry.fileName === "E68-Sanctum.loom.json");
  if (file === undefined) throw new Error("E68-Sanctum.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const TEMPLE = "temple";
const WATCHED = [{ nodeId: TEMPLE, portId: "out" }];

/**
 * One frame of the marcher, small and NOT animated: the claim is about WHERE the camera is,
 * and a still frame answers that for a fraction of a 720p render. `frames: 1` with
 * `animate: false` puts both renders at exactly the same instant, which is what lets the
 * authored comparison below be a byte equality rather than a similarity.
 */
async function shoot(options: {
  readonly sinks?: ReadonlyArray<{ nodeId: string; portId: string }>;
  readonly portId?: string;
}): Promise<{ width: number; height: number; bytes: Uint8Array; ports: string[] }> {
  const { document, result } = e68();
  const graph = structuredClone(document.graph) as GraphDocument;
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { width: 320, height: 180 } },
    frames: 1,
    capture: [0],
    outputNodeId: TEMPLE,
    ...(options.portId === undefined ? {} : { outputPortId: options.portId }),
    ...(options.sinks === undefined ? {} : { sinks: options.sinks }),
    ...(result.components ? { components: result.components } : {}),
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = rendered.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return {
    width: frame.width,
    height: frame.height,
    bytes: frame.bytes,
    ports: rendered.plan.outputs.filter((output) => output.nodeId === TEMPLE).map((output) => output.portId),
  };
}

describe("E68 Sanctum — the view camera", () => {
  it("publishes a viewport row ONLY while an editor is watching the marcher", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const watched = await shoot({ sinks: WATCHED });
    const unwatched = await shoot({});
    expect(watched.ports).toContain(viewportPortId("out"));
    // The absence half, asserted as hard as the presence: this is the state every export,
    // thumbnail and claims run compiles in, and it must not have grown a second render.
    expect(unwatched.ports).not.toContain(viewportPortId("out"));
  }, 180_000);

  it("renders the viewport from the DECLARED view camera, not from the piece's own walk", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const authored = await shoot({ sinks: WATCHED, portId: "out" });
    const viewport = await shoot({ sinks: WATCHED, portId: viewportPortId("out") });
    /*
     * The declared home stands in the nave at z = -5.2 looking down the axis; the walk
     * begins at the origin looking down the same axis with a different height, drift, yaw
     * and bank. Those are two different places in one hall, so the pictures differ — and if
     * `viewOverride` were never set, or the fields were bound by a name the shader does not
     * read, they would be the same picture and this is the assertion that says so.
     */
    let differing = 0;
    const pixels = Math.min(authored.bytes.length, viewport.bytes.length);
    for (let at = 0; at < pixels; at += 1) {
      if (authored.bytes[at] !== viewport.bytes[at]) differing += 1;
    }
    expect(pixels).toBeGreaterThan(0);
    expect(differing / pixels).toBeGreaterThan(0.2);
  }, 180_000);

  it("⚑ leaves the piece BYTE-IDENTICAL — the viewport is view-only, and this is what that means", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    /*
     * The defect this is against, in the owner's own terms: "definitely is not destructive
     * and has to be separate from what renders at exports". A camera override that reached
     * the authored pass would change what is exported, thumbnailed and measured against
     * every look baseline in the catalogue, in every session where somebody had dragged in
     * the viewer — and nothing would have said so, because the picture would still look
     * like the piece.
     *
     * Byte equality, not a tolerance (§V147): the whole claim is that NOTHING reached the
     * authored pass, and a band would pass a camera that moved by a pixel.
     */
    const withViewport = await shoot({ sinks: WATCHED, portId: "out" });
    const without = await shoot({ portId: "out" });
    expect(withViewport.width).toBe(without.width);
    expect(withViewport.height).toBe(without.height);
    expect(withViewport.bytes.length).toBe(without.bytes.length);
    /* Counted rather than `toEqual`d: these are hundreds of thousands of bytes, and a
       whole-buffer deep-equal spends minutes building a diff nobody can read on the one
       run that matters — the failing one. A count and a first offset say more, faster. */
    let differing = 0;
    let firstAt = -1;
    for (let at = 0; at < without.bytes.length; at += 1) {
      if (withViewport.bytes[at] === without.bytes[at]) continue;
      differing += 1;
      if (firstAt < 0) firstAt = at;
    }
    expect({ differing, firstAt }).toEqual({ differing: 0, firstAt: -1 });
  }, 180_000);
});
