import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { viewportPortId } from "../compiler/resources.ts";
import { viewCameraUniforms } from "../domain/geometry/view-camera.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitPose } from "../runtime/previews/orbit.ts";
import type { PreviewOrbit } from "../runtime/previews/orbit.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * §T1311b(b) — **THE VIEWER FLIES E68, PROVED ON DAWN.**
 *
 * ## Why this file is not "the orbit test with another parameter"
 *
 * §T1311b(a) made a raymarcher's camera reachable; it did not make it explorable. The
 * viewer's existing gestures are FENCED to an inspection neighbourhood — pan clamps at ±2
 * stock radii, `distance` at [0.2, 5]× — and those fences are the owner's complaint in
 * geometry: "we're not just stuck viewing a video texture", about a hall they wanted to walk
 * down. `orbit-fly.test.ts` proves the confinement exactly, in arithmetic. THIS file proves
 * the other half, which arithmetic cannot: that the flown pose actually reaches the shader
 * and actually renders the hall from somewhere the orbit could never stand.
 *
 * ## The delivery path is the app's, not a re-staging of it
 *
 * The camera is pushed through `control.updateUniforms` — the same `backend.updateUniforms`
 * call `use-view-camera.ts` makes every frame while the viewer is adjustable, onto the pass
 * id the compiler published on the viewport row. Setting the document's stored `viewEye`
 * instead would render a picture through a path the app never takes, and would prove the
 * shader reads a uniform rather than that the FEATURE works (§V998: a call-site audit is not
 * evidence; assert a rendered result).
 *
 * ## And it must still be view-only
 *
 * The last test flies the camera and reads back the AUTHORED port. Byte-identical, because
 * the only pass id in scope is the viewport's — the same construction §T1311b(a) landed,
 * re-asserted under the gesture that actually moves the camera a hundred times a second.
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

interface Shot {
  readonly bytes: Uint8Array;
  /** Where the camera was told to stand, for the geometry claims below. */
  readonly eye: readonly number[];
  readonly lookAt: readonly number[];
}

/**
 * One still frame of the marcher, from the camera `orbit` puts it at.
 *
 * `frames: 1` with no animation: every shot is the same instant of the piece, so a pixel
 * difference between two of them is a camera difference and nothing else.
 */
async function shoot(options: {
  readonly orbit?: PreviewOrbit;
  /** Which port to read back. The viewport by default; the authored row for the view-only claim. */
  readonly portId?: string;
}): Promise<Shot> {
  const { document, result } = e68();
  const graph = structuredClone(document.graph) as GraphDocument;
  let eye: readonly number[] = [];
  let lookAt: readonly number[] = [];
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { width: 320, height: 180 } },
    frames: 1,
    capture: [0],
    outputNodeId: TEMPLE,
    outputPortId: options.portId ?? viewportPortId("out"),
    sinks: WATCHED,
    ...(result.components ? { components: result.components } : {}),
    beforeFrames: (control) => {
      if (options.orbit === undefined) return;
      const row = control.plan.outputs.find(
        (output) => output.nodeId === TEMPLE && output.viewCamera !== undefined,
      );
      const camera = row?.viewCamera;
      if (camera === undefined) throw new Error("E68 published no viewport row to fly");
      /*
       * Exactly what the pane does: the compiler's own published framing is the basis, the
       * view state is the deltas, and `orbitPose` is the one place the two become a pose.
       */
      const pose = orbitPose(
        { eye: camera.eye, lookAt: camera.lookAt, fovY: camera.fovY, aspect: camera.aspect },
        options.orbit,
      );
      eye = pose.eye;
      lookAt = pose.lookAt;
      control.updateUniforms(camera.passId, viewCameraUniforms(pose, camera.fovY));
    },
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = rendered.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return { bytes: frame.bytes, eye, lookAt };
}

/** Share of bytes that differ. The claim is "a different picture", counted. */
function difference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) throw new Error("nothing to compare");
  let differing = 0;
  for (let at = 0; at < length; at += 1) if (a[at] !== b[at]) differing += 1;
  return differing / length;
}

/** The identity — the author's own framing, which is what an unflown viewport shows. */
const HOME: PreviewOrbit = DEFAULT_PREVIEW_ORBIT;
/**
 * The nearest an ORBIT can ever get to flying forward: dolly all the way in, `MIN_DISTANCE`.
 * It is the honest rival, because it is the gesture a user reaches for when they want to
 * move toward something and the viewer has no fly.
 */
const DOLLIED_IN: PreviewOrbit = { ...DEFAULT_PREVIEW_ORBIT, distance: 0.2 };
/** Four stock radii down the hall — well past anything the pan and dolly clamps allow. */
const FLOWN: PreviewOrbit = { ...DEFAULT_PREVIEW_ORBIT, fly: [0, 0, 4] };

describe("E68 Sanctum — flying the viewport", () => {
  it("⚑ renders the hall from somewhere NO ORBIT CAN STAND", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const home = await shoot({ orbit: HOME });
    const dollied = await shoot({ orbit: DOLLIED_IN });
    const flown = await shoot({ orbit: FLOWN });

    /*
     * The geometry first, so the pixel claims below are about a camera whose position is
     * known rather than about two pictures that happen to differ. `MIN_DISTANCE` keeps the
     * dolly within one stock radius of the author's target; the flight is four radii past
     * it, which is outside every fence `orbitPose` applies.
     */
    const target = home.lookAt;
    const from = (point: readonly number[]): number =>
      Math.hypot(point[0]! - target[0]!, point[1]! - target[1]!, point[2]! - target[2]!);
    expect(from(dollied.eye)).toBeLessThan(from(home.eye));
    expect(from(flown.eye)).toBeGreaterThan(from(home.eye) * 3);
    // The flight took the target with it — a dolly cannot move what it is looking at.
    expect(Math.hypot(...dollied.lookAt.map((v, i) => v - target[i]!))).toBeLessThan(1e-6);
    expect(Math.hypot(...flown.lookAt.map((v, i) => v - target[i]!))).toBeGreaterThan(10);

    /*
     * And the pixels. If the flight never reached the shader — the uniforms bound by a name
     * it does not read, the pose never pushed, `fly` silently dropped by `orbitPose` — the
     * viewport would render the author's framing and this would be a difference of zero.
     */
    expect(difference(home.bytes, flown.bytes)).toBeGreaterThan(0.2);
    // Not merely "the camera moved": the picture from four radii down the hall is not the
    // picture from the closest the fences let anyone dolly, which is the whole feature.
    expect(difference(dollied.bytes, flown.bytes)).toBeGreaterThan(0.2);
    // The rival is a real one — the dolly is a genuinely different picture too, so the
    // comparison above is between two working cameras rather than against a dead control
    // (§V968: validate the detector against a known positive).
    expect(difference(home.bytes, dollied.bytes)).toBeGreaterThan(0.2);
  }, 300_000);

  it("⚑ leaves the piece BYTE-IDENTICAL while it is being flown — view-only, still", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    /*
     * The owner's ruling, under the gesture that exercises it hardest: "definitely is not
     * destructive and has to be separate from what renders at exports". A flight is hundreds
     * of uniform pushes a second; if any of them could reach the authored pass, every export
     * and every look baseline in the catalogue would depend on where somebody last left the
     * viewer. Byte equality, not a band (§V147) — the claim is that NOTHING arrived.
     */
    const still = await shoot({ portId: "out" });
    const whileFlying = await shoot({ portId: "out", orbit: FLOWN });
    expect(whileFlying.bytes.length).toBe(still.bytes.length);
    let differing = 0;
    let firstAt = -1;
    for (let at = 0; at < still.bytes.length; at += 1) {
      if (whileFlying.bytes[at] === still.bytes[at]) continue;
      differing += 1;
      if (firstAt < 0) firstAt = at;
    }
    expect({ differing, firstAt }).toEqual({ differing: 0, firstAt: -1 });
  }, 300_000);
});
