import { describe, expect, it } from "vitest";
import { cameraPayloadMatrix, identity, lookAt, multiply, perspective, transformPoint, viewProjection } from "./camera.ts";

/**
 * §V198: the composition order is PUBLISHED (clip = projection × view × world,
 * column-major, right-multiplied, right-handed, WebGPU [0,1] depth) and these tests
 * pin every clause — the cheapest insurance in the whole geometry system.
 */

const close = (a: readonly number[], b: readonly number[]): void => {
  expect(a.length).toBe(b.length);
  a.forEach((value, index) => expect(value).toBeCloseTo(b[index] ?? NaN, 5));
};

describe("camera math (T295, §V198)", () => {
  it("multiplies column-major, applying the RIGHT matrix first", () => {
    // Translate(1,0,0) then Scale(2): scale × translate moves THEN scales → x = 4.
    const translate = identity();
    translate[12] = 1;
    const scale = identity();
    scale[0] = scale[5] = scale[10] = 2;
    const composed = multiply(scale, translate);
    close(transformPoint(composed, [1, 0, 0]), [4, 0, 0, 1]);
    // The other order: scales THEN moves → x = 3. Order is not a matter of taste.
    close(transformPoint(multiply(translate, scale), [1, 0, 0]), [3, 0, 0, 1]);
  });

  it("looks down -z: a point in front of the camera lands at negative view z", () => {
    const view = lookAt([0, 0, 5], [0, 0, 0]);
    const inFront = transformPoint(view, [0, 0, 0]);
    close(inFront, [0, 0, -5, 1]);
  });

  it("projects into WebGPU's [0,1] depth — near→0, far→1, monotone between", () => {
    const proj = perspective(Math.PI / 2, 1, 1, 10);
    const ndcZ = (viewZ: number): number => {
      const clip = transformPoint(proj, [0, 0, viewZ]);
      return clip[2] / clip[3];
    };
    expect(ndcZ(-1)).toBeCloseTo(0, 5); // the near plane
    expect(ndcZ(-10)).toBeCloseTo(1, 5); // the far plane
    expect(ndcZ(-2)).toBeGreaterThan(0);
    expect(ndcZ(-2)).toBeLessThan(ndcZ(-5)); // farther = deeper, always
  });

  it("viewProjection composes projection × view — the published order, end to end", () => {
    const vp = viewProjection([0, 0, 5], [0, 0, 0], { fovY: Math.PI / 2, aspect: 1, near: 1, far: 100 });
    // The look-at target sits dead centre, in front of the camera.
    const centre = transformPoint(vp, [0, 0, 0]);
    expect(centre[0] / centre[3]).toBeCloseTo(0, 5);
    expect(centre[1] / centre[3]).toBeCloseTo(0, 5);
    expect(centre[3]).toBeGreaterThan(0); // in front, not behind
    // A point up and right of the target lands up and right on screen.
    const upRight = transformPoint(vp, [1, 1, 0]);
    expect(upRight[0] / upRight[3]).toBeGreaterThan(0);
    expect(upRight[1] / upRight[3]).toBeGreaterThan(0);
  });
});

describe("T706 — the camera can aim anywhere and bank (cameraPayloadMatrix)", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    eye: [0, 5, 0] as const,
    lookAt: [0, 0, 0] as const,
    fovDeg: 60,
    near: 0.1,
    far: 100,
    ortho: false,
    orthoHeight: 2,
    ...over,
  });

  it("straight DOWN is a picture, not a collapsed basis — the missing third guard", () => {
    // Before T706 this path fed cross([0,1,0],[0,1,0]) = 0 into the view basis (the
    // shadow path guards at |d.y| > 0.999 and the environment basis at 0.99; this was
    // the one of three without a guard) — verified red: every basis entry read 0.
    // §V461 lesson, learned in THIS test's first draft: a zero basis is perfectly
    // finite, so "every entry is finite" passed with the guard deleted. The claim that
    // cannot pass on a collapsed basis is SEPARATION: under a working straight-down
    // camera, two distinct ground points land on distinct screen points; under the
    // degenerate basis every world point projects to screen (0,0).
    const project = (m: Float32Array, point: [number, number, number]) => {
      const w = (m[3] ?? 0) * point[0] + (m[7] ?? 0) * point[1] + (m[11] ?? 0) * point[2] + (m[15] ?? 0);
      return [
        ((m[0] ?? 0) * point[0] + (m[4] ?? 0) * point[1] + (m[8] ?? 0) * point[2] + (m[12] ?? 0)) / w,
        ((m[1] ?? 0) * point[0] + (m[5] ?? 0) * point[1] + (m[9] ?? 0) * point[2] + (m[13] ?? 0)) / w,
      ] as const;
    };
    const down = cameraPayloadMatrix(payload(), 1);
    const px = project(down, [1, 0, 0]);
    const pz = project(down, [0, 0, 1]);
    expect(Math.hypot(px[0] ?? 0, px[1] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.hypot(pz[0] ?? 0, pz[1] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.hypot((px[0] ?? 0) - (pz[0] ?? 0), (px[1] ?? 0) - (pz[1] ?? 0))).toBeGreaterThan(0.1);
    // And straight UP guards identically.
    const up = cameraPayloadMatrix(payload({ eye: [0, -5, 0] }), 1);
    expect(Math.hypot(project(up, [1, 0, 0])[0] ?? 0, project(up, [1, 0, 0])[1] ?? 0)).toBeGreaterThan(0.1);
  });

  it("roll 0 and roll absent are byte-identical to the old matrix", () => {
    const level = payload({ eye: [0, 0.5, 3] });
    const a = cameraPayloadMatrix(level, 16 / 9);
    const b = cameraPayloadMatrix({ ...level, roll: 0 }, 16 / 9);
    expect([...a]).toEqual([...b]);
  });

  it("roll banks around the view axis by exact degrees, aim untouched", () => {
    // Looking down -z from the origin side: world +x is screen-right. At roll 90 the
    // camera's up becomes world -x... the exact expectation is computed from the
    // definition rather than guessed: up' = Rodrigues([0,0,-1] view axis, 90°) of
    // [0,1,0] = [1,0,0] — so world +x lands on screen-UP's row.
    const level = payload({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    const rolled = cameraPayloadMatrix({ ...level, roll: 90 }, 1);
    const flat = cameraPayloadMatrix(level, 1);
    // Project world +x with both. Screen x/y live in rows 0 and 1 of the view part;
    // through the full view-projection a point at [1,0,0] swaps its screen axis.
    const apply = (m: Float32Array, p: [number, number, number]) => {
      const w = (m[3] ?? 0) * p[0] + (m[7] ?? 0) * p[1] + (m[11] ?? 0) * p[2] + (m[15] ?? 0);
      return [
        ((m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0)) / w,
        ((m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0)) / w,
      ];
    };
    const [fx = 0, fy = 0] = apply(flat, [1, 0, 0]);
    const [rx = 0, ry = 0] = apply(rolled, [1, 0, 0]);
    expect(fx).toBeGreaterThan(0.1); // screen-right, flat
    expect(Math.abs(fy)).toBeLessThan(1e-6);
    expect(Math.abs(rx)).toBeLessThan(1e-6); // rolled 90: same point is now vertical
    expect(Math.abs(ry)).toBeGreaterThan(0.1);
    // And the aim did not move: the look-at point projects to centre in both.
    expect(apply(flat, [0, 0, 0])[0]).toBeCloseTo(0, 6);
    expect(apply(rolled, [0, 0, 0])[0]).toBeCloseTo(0, 6);
  });
});
