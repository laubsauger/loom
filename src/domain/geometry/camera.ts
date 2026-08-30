/**
 * Camera math (T295, §V198): column-major mat4, WGSL layout, WebGPU depth range.
 *
 * §V198 is the reason this file is mostly documentation: the composition order is
 * PUBLISHED and pinned by test, because "which order" is the most expensive thing in a
 * geometry system to get wrong and the cheapest to fix on day one. The order is:
 *
 *     clip = projection × view × world
 *
 * with matrices COLUMN-MAJOR (WGSL's layout: `m[c][r]`, columns contiguous), vectors
 * multiplied on the RIGHT (`clip = M * v`), a RIGHT-HANDED world (+x right, +y up, -z
 * forward — the camera looks down its own -z), and WebGPU's [0, 1] clip depth (NOT
 * GL's [-1, 1]; reusing a GL projection matrix halves your depth precision and shifts
 * the near plane, silently). `viewProjection` composes the two on the CPU once per
 * frame so shaders multiply one matrix, not two.
 */

/** 16 numbers, column-major. `m[column * 4 + row]`. */
export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** `a × b` — apply `b` first, then `a`. Column-major, right-multiplied vectors. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function transformPoint(m: Mat4, point: readonly [number, number, number]): [number, number, number, number] {
  const [x, y, z] = point;
  const at = (index: number): number => m[index] ?? 0;
  return [
    at(0) * x + at(4) * y + at(8) * z + at(12),
    at(1) * x + at(5) * y + at(9) * z + at(13),
    at(2) * x + at(6) * y + at(10) * z + at(14),
    at(3) * x + at(7) * y + at(11) * z + at(15),
  ];
}

/**
 * Perspective projection, WebGPU depth range [0, 1], infinite-far-free classic form.
 * `fovY` in radians; `aspect` = width / height.
 */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

/** View matrix: the world as seen from `eye` looking at `center`, `up` roughly up. */
export function lookAt(
  eye: readonly [number, number, number],
  center: readonly [number, number, number],
  up: readonly [number, number, number] = [0, 1, 0],
): Mat4 {
  const sub = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  ];
  const normalize = (v: [number, number, number]): [number, number, number] => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
  const dot = (a: readonly number[], b: readonly number[]): number =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

  const forward = normalize(sub(eye, center)); // camera's +z (it LOOKS down -z)
  const right = normalize(cross(up, forward));
  const trueUp = cross(forward, right);

  const m = new Float32Array(16);
  m[0] = right[0]; m[1] = trueUp[0]; m[2] = forward[0];
  m[4] = right[1]; m[5] = trueUp[1]; m[6] = forward[1];
  m[8] = right[2]; m[9] = trueUp[2]; m[10] = forward[2];
  m[12] = -dot(right, eye);
  m[13] = -dot(trueUp, eye);
  m[14] = -dot(forward, eye);
  m[15] = 1;
  return m;
}

/** The one matrix a shader multiplies: `projection × view` (§V198's published order). */
export function viewProjection(
  eye: readonly [number, number, number],
  center: readonly [number, number, number],
  options: { fovY?: number; aspect?: number; near?: number; far?: number; up?: readonly [number, number, number] } = {},
): Mat4 {
  return multiply(
    perspective(options.fovY ?? Math.PI / 3, options.aspect ?? 1, options.near ?? 0.1, options.far ?? 100),
    lookAt(eye, center, options.up ?? [0, 1, 0]),
  );
}

/** Orthographic projection (T377): [0,1] depth, y up, matching `perspective`'s conventions. */
export function orthographic(height: number, aspect: number, near: number, far: number): Mat4 {
  const halfH = Math.max(height, 1e-6) / 2;
  const halfW = halfH * Math.max(aspect, 1e-6);
  const m = identity();
  m[0] = 1 / halfW;
  m[5] = 1 / halfH;
  m[10] = 1 / (near - far);
  m[14] = near / (near - far);
  return m;
}
