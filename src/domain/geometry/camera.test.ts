import { describe, expect, it } from "vitest";
import { identity, lookAt, multiply, perspective, transformPoint, viewProjection } from "./camera.ts";

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
