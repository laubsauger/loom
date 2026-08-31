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

/**
 * T706/T704 — the ONE guarded, rolled up-vector (§V437). The camera's view and the
 * projector's throw share it: the degenerate-pole guard swaps to [0,0,1] exactly as the
 * shadow path does, and `roll` banks the result around the view axis (Rodrigues).
 */
export function guardedRolledUp(
  eye: readonly [number, number, number],
  lookAt3: readonly [number, number, number],
  rollDeg: number,
): [number, number, number] {
  const view3 = ((): [number, number, number] => {
    const dx = lookAt3[0] - eye[0];
    const dy = lookAt3[1] - eye[1];
    const dz = lookAt3[2] - eye[2];
    const length = Math.hypot(dx, dy, dz) || 1;
    return [dx / length, dy / length, dz / length];
  })();
  let up: [number, number, number] = Math.abs(view3[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  if (rollDeg !== 0) {
    const theta = (rollDeg * Math.PI) / 180;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const k = view3;
    const kCrossUp: [number, number, number] = [
      k[1] * up[2] - k[2] * up[1],
      k[2] * up[0] - k[0] * up[2],
      k[0] * up[1] - k[1] * up[0],
    ];
    const kDotUp = k[0] * up[0] + k[1] * up[1] + k[2] * up[2];
    up = [
      up[0] * c + kCrossUp[0] * sn + k[0] * kDotUp * (1 - c),
      up[1] * c + kCrossUp[1] * sn + k[1] * kDotUp * (1 - c),
      up[2] * c + kCrossUp[2] * sn + k[2] * kDotUp * (1 - c),
    ];
  }
  return up;
}

/** The optics a venue spec lists (T704). All of it is geometry — no light math here. */
export interface ProjectorLens {
  /** Throw distance ÷ image width — the number printed on the lens. */
  readonly throwRatio: number;
  /** The projector's NATIVE aspect (width/height of the image it throws). */
  readonly aspect: number;
  /** Lens shift, as fractions of image width/height. Off-axis, not a re-aim. */
  readonly shiftX: number;
  readonly shiftY: number;
  /** Keystone, degrees. Applied as the trapezoid it actually is (w-row shear). */
  readonly keystoneH: number;
  readonly keystoneV: number;
}

/**
 * T704 — the projector's viewProjection: what the venue's lens sheet says, as a matrix.
 *
 * fovX comes from the throw ratio (tan(fovX/2) = 0.5/throw); fovY from the native
 * aspect. Near/far derive from the throw DISTANCE (|eye − lookAt|) so the frustum
 * brackets the surface being hit without another parameter to explain: near at 2% of
 * the distance, far at 8×. Lens shift is a true off-axis offset (the image moves, the
 * body does not re-aim) — implemented on the projection's z-column so it survives the
 * perspective divide as a constant NDC offset. Keystone is the trapezoid a tilted
 * screen produces: a shear INTO THE W ROW, so one side of the image genuinely scales
 * against the other rather than merely sliding.
 */
export function projectorMatrix(
  pose: {
    readonly eye: readonly [number, number, number];
    readonly lookAt: readonly [number, number, number];
    readonly roll?: number;
  },
  lens: ProjectorLens,
): Mat4 {
  const distance = Math.max(
    0.05,
    Math.hypot(
      pose.lookAt[0] - pose.eye[0],
      pose.lookAt[1] - pose.eye[1],
      pose.lookAt[2] - pose.eye[2],
    ),
  );
  const near = Math.max(0.01, distance * 0.02);
  const far = distance * 8;
  const tanHalfX = 0.5 / Math.max(lens.throwRatio, 0.05);
  const tanHalfY = tanHalfX / Math.max(lens.aspect, 0.05);

  const projection = identity();
  projection[0] = 1 / tanHalfX;
  projection[5] = 1 / tanHalfY;
  projection[10] = far / (near - far);
  projection[11] = -1;
  projection[14] = (near * far) / (near - far);
  projection[15] = 0;
  // Off-axis shift: x_ndc = (m0·x + m8·z)/(−z) = m0·x/(−z) − m8, so writing +2·shift
  // slides the IMAGE by `shift` image-widths — positive = up/right in the world, the
  // venue convention — without re-aiming the axis (the optical-axis point then lands
  // at −2·shift ndc, because the frustum moved and the axis did not).
  projection[8] = 2 * lens.shiftX;
  projection[9] = 2 * lens.shiftY;
  // Keystone: shear x (and y) into the w row — after the divide, one side of the image
  // is nearer in projector terms than the other, which is exactly the trapezoid.
  const kH = Math.tan((lens.keystoneH * Math.PI) / 180);
  const kV = Math.tan((lens.keystoneV * Math.PI) / 180);
  if (kH !== 0 || kV !== 0) {
    projection[3] = kH * (projection[0] ?? 0);
    projection[7] = kV * (projection[5] ?? 0);
  }

  const up = guardedRolledUp(pose.eye, pose.lookAt, pose.roll ?? 0);
  const view = lookAt(
    [pose.eye[0], pose.eye[1], pose.eye[2]],
    [pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]],
    up,
  );
  return multiply(projection, view);
}

/**
 * T457: one camera VALUE to one matrix, composed where the aspect is known (§V198).
 * Every consumer of a camera payload — Render, renderSurface, renderInstances — goes
 * through this, so a camera node means the same picture wherever it is named (V387).
 */
export function cameraPayloadMatrix(
  camera: {
    readonly eye: readonly [number, number, number];
    readonly lookAt: readonly [number, number, number];
    readonly fovDeg: number;
    readonly near: number;
    readonly far: number;
    readonly ortho: boolean;
    readonly orthoHeight: number;
    /** Degrees of bank around the view axis (T706). Absent = 0, the old behaviour. */
    readonly roll?: number;
  },
  aspect: number,
): Mat4 {
  /*
   * T706 — the missing third guard, and the roll that finally reaches the node.
   *
   * Of the three lookAt call sites this was the only one that took the default up with
   * NO degenerate-basis guard (directionalShadowMatrix swaps at |d.y| > 0.999,
   * scene.ts's environment basis at 0.99) — so a camera aimed straight down or up fed
   * cross([0,1,0],[0,1,0]) = 0 into the view basis and rendered a collapsed frame.
   * The guard picks [0,0,1] exactly as the shadow path does.
   *
   * `roll` banks the guarded up around the view axis (Rodrigues), so aim stays the
   * look-at vector's job and orientation is complete: eye + lookAt + roll is a full
   * rotation representation, which is what the positioning gizmo (T692) writes into.
   */
  const up = guardedRolledUp(camera.eye, camera.lookAt, camera.roll ?? 0);
  const view = lookAt(
    [camera.eye[0], camera.eye[1], camera.eye[2]],
    [camera.lookAt[0], camera.lookAt[1], camera.lookAt[2]],
    up,
  );
  const projection = camera.ortho
    ? orthographic(camera.orthoHeight, aspect, camera.near, camera.far)
    : perspective((camera.fovDeg * Math.PI) / 180, aspect, camera.near, camera.far);
  return multiply(projection, view);
}

/**
 * T481: the CASTING matrix for a directional light — an orthographic camera looking
 * along the light's travel, framed by an EXPLICIT half-extent around the origin (V426:
 * payloads carry no scene bounds, so a derived box would crop shadows plausibly-wrong).
 * Coverage is at least `extent` on BOTH map axes whatever the map's aspect; a direction
 * parallel to world-up swaps the up vector rather than degenerating.
 */
export function directionalShadowMatrix(
  direction: readonly [number, number, number],
  extent: number,
  aspect: number,
): Mat4 {
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const d: [number, number, number] = [direction[0] / length, direction[1] / length, direction[2] / length];
  const eye: [number, number, number] = [-d[0] * extent, -d[1] * extent, -d[2] * extent];
  const up: [number, number, number] = Math.abs(d[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const safeAspect = Math.max(aspect, 1e-6);
  const height = 2 * extent * Math.max(1, 1 / safeAspect);
  const view = lookAt(eye, [0, 0, 0], up);
  const projection = orthographic(height, safeAspect, 0.01, 3 * extent);
  return multiply(projection, view);
}
