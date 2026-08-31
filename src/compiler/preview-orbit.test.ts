import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENE_PAYLOAD_KINDS } from "../domain/types/scene.ts";
import {
  POINTS_PREVIEW_EYE,
  PREVIEW_ORBIT_RIGS,
  previewOrbitBasis,
  SCENE_PREVIEW_BALL_RIG,
} from "./preview-orbit.ts";
import type { PreviewPayloadKind } from "./preview-orbit.ts";

/**
 * T675 — ORBIT CAPABILITY IS DERIVED AT ONE SITE, and that is the part of the fix that
 * stops the bug recurring rather than fixing today's instance.
 *
 * The owner's words are the requirement: "did we miss some of the point/geo/3d nodes in
 * our pass to add that? imo this should be something they inherit from a common thing or
 * something right?". They had not been missed — geometry has carried an orbit since T561
 * — but the SHAPE they objected to was real: the answer lived in two hand-written
 * branches in `compile.ts` that had to agree and never referenced each other, one of
 * which handed every unlisted kind the ball rig by falling off the end of a ternary.
 *
 * §V461 governs how this is gated. A test that lists today's four payload kinds and
 * asserts each one's orbit is a test that CANNOT FAIL when the class of bug recurs: the
 * fifth kind nobody wrote a row for is precisely the thing such a list does not mention.
 * T532 already paid for that lesson — a payload kind shipped with no preview at all and
 * every suite stayed green, because absence is not failure (§V437). So the gates here are
 * STRUCTURAL, and there are two of them:
 *
 *  1. every kind that exists must have a DECISION in the table — proved against
 *     `SCENE_PAYLOAD_KINDS`, which the domain already proves exhaustive against the
 *     `ScenePayload` union, so a fifth kind fails this test without anyone editing it
 *     (and fails `tsc` first, at the `satisfies`);
 *  2. `compile.ts` must not build an orbit basis of its own — asserted by reading the
 *     file, because "there is only one site" is a claim about the SOURCE and no
 *     behavioural assertion can see a second branch that happens to agree today.
 */

/** Both halves of what a preview can synthesize; the scene half is the exhaustive one. */
const ALL_KINDS: ReadonlyArray<PreviewPayloadKind> = [...SCENE_PAYLOAD_KINDS, "pointset"];

const BASIS_OPTIONS = { aspect: 16 / 9, passIds: ["n1#pass"] };

describe("T675 — every preview payload kind has a stated orbit decision", () => {
  it.each(ALL_KINDS)("%s appears in the table", (kind) => {
    // `null` counts and is the point: it is how a kind says "decided: no orbit". What
    // fails here is a kind with no ROW — the fall-through that used to be a ternary's
    // last arm, where a new kind inherited a camera nobody chose for it.
    expect(Object.hasOwn(PREVIEW_ORBIT_RIGS, kind)).toBe(true);
  });

  it("has no rows for kinds that do not exist", () => {
    // The other direction, so the table cannot rot into a list of kinds we used to have
    // — the same bidirectional proof `SCENE_PAYLOAD_KINDS` uses on the union itself.
    expect(Object.keys(PREVIEW_ORBIT_RIGS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("CAMERA is refused, and refused explicitly — the tile shows its own matrix", () => {
    // §T639(a)'s rule, one affordance over: a camera preview draws THROUGH the payload's
    // own view matrix, so an inspection camera would override the single thing that tile
    // exists to report. An affordance that lies is worse than no affordance.
    expect(PREVIEW_ORBIT_RIGS.camera).toBeNull();
    expect(previewOrbitBasis("camera", BASIS_OPTIONS)).toBeUndefined();
  });

  it("PROJECTOR is refused for the same reason — the tile shows its own throw (T704)", () => {
    // Same rule as the camera: the tile draws through the projector's OWN frustum, so
    // an inspection orbit would falsify the aim/lens picture the tile exists to show.
    // The document-writing gizmo (T692's shape) is the legitimate control here.
    expect(PREVIEW_ORBIT_RIGS.projector).toBeNull();
    expect(previewOrbitBasis("projector", BASIS_OPTIONS)).toBeUndefined();
  });

  it("every other kind is orbitable, and carries its OWN stock framing", () => {
    // The T663 coupling, asserted rather than commented: the basis must reproduce the
    // rig the stock matrix was baked from, optics included, or an orbit at identity
    // renders through a projection the target does not share — i.e. stretched.
    const orbitable = ALL_KINDS.filter((kind) => kind !== "camera" && kind !== "projector");
    for (const kind of orbitable) {
      const basis = previewOrbitBasis(kind, BASIS_OPTIONS);
      expect([kind, basis?.aspect]).toEqual([kind, 16 / 9]);
      expect([kind, basis?.passIds]).toEqual([kind, ["n1#pass"]]);
      expect([kind, basis?.lookAt]).toEqual([kind, [0, 0, 0]]);
    }

    // A pointset and a geometry ARE the same framing — one row, read twice, so the two
    // cannot drift the way two hand-maintained branches did.
    expect(previewOrbitBasis("geometry", BASIS_OPTIONS)?.eye).toEqual([...POINTS_PREVIEW_EYE]);
    expect(previewOrbitBasis("pointset", BASIS_OPTIONS)?.eye).toEqual([...POINTS_PREVIEW_EYE]);
    // The ball rig's own optics travel with it; the pointset framing takes the default.
    expect(previewOrbitBasis("light", BASIS_OPTIONS)?.fovY).toBe(SCENE_PREVIEW_BALL_RIG.fovY);
    expect(previewOrbitBasis("material", BASIS_OPTIONS)?.far).toBe(SCENE_PREVIEW_BALL_RIG.far);
    expect(previewOrbitBasis("geometry", BASIS_OPTIONS)?.fovY).toBeUndefined();
  });
});

describe("T675 — `compile.ts` derives orbit HERE, and builds none of its own", () => {
  const source = readFileSync(fileURLToPath(new URL("./compile.ts", import.meta.url)), "utf8");
  /** Comments talk about orbits constantly; only CODE can build one. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  it("names the shared derivation at both synthesized-preview sites", () => {
    // Guards the guard: if the calls were renamed away this suite would otherwise pass
    // by asserting the absence of something that had simply moved.
    expect(code.match(/previewOrbitBasis\(/g)?.length).toBe(2);
  });

  it("constructs no orbit basis inline", () => {
    /*
     * The failure mode this catches, stated so a future reader can weigh it: someone adds
     * a fifth synthesized preview — a volume, a curve, a text layout — and writes its
     * orbit where they are already working, because that is one line and importing the
     * table is three. The `satisfies` in `preview-orbit.ts` cannot see that, since the
     * new site never asks it anything. Two sites is exactly how T675 arrived.
     *
     * Two markers, both specific to a BASIS and neither to the options object the call
     * sites do build: `lookAt` is a field only a basis has (the stock matrices pass their
     * target positionally), and an object literal assigned straight to `orbit` is the
     * exact shape both deleted branches had. `passIds` deliberately is NOT a marker —
     * naming the passes to move is the caller's job and always was.
     */
    expect(code).not.toMatch(/lookAt/);
    expect(code).not.toMatch(/orbit\s*:\s*\{/);
  });
});
