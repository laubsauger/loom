/**
 * THE VIEW-CAMERA CONTRACT — how a shader that builds its OWN eye lets the viewer fly it
 * (§T1311b(a)).
 *
 * ## Why this is a contract and not a mechanism
 *
 * The viewer already orbits, zooms, homes and frames content for any output that declares a
 * rig (`side-panes.tsx`), and every rig it knows comes from `PREVIEW_ORBIT_RIGS`, keyed by
 * SCENE PAYLOAD KIND. A raymarched `customWgsl` node outputs a TEXTURE, so it declares no
 * kind, so it declares no rig, so the viewer refuses it — and E55, E57, E68 and E70, the
 * pieces this project actually makes, are all exactly that. For them the viewer literally is
 * "stuck viewing a video texture", which is the owner's own phrase for the complaint.
 *
 * Two measurements settle why no amount of viewer-side work fixes that (both verified in
 * `src/runtime/previews/system.ts:269-281` and `src/runtime/previews/orbit.ts:237`):
 *
 *  1. the orbit uniform push is gated on `request.synthesis.orbit`, which a texture payload
 *     never has — the merge is not refusing, it NEVER RUNS; and
 *  2. the uniforms it would push are `{ viewProjection, eye }`, merged BY NAME, and E68
 *     declares neither name. Names that do not exist cannot be overridden.
 *
 * ⚑ AND THE CONSEQUENCE THAT OUTRANKS BOTH: **a raymarcher cannot consume a `viewProjection`
 * matrix.** It does not transform vertices — it builds a ray per pixel from an eye and a
 * direction. So the contract here is NOT the scene path's uniform set behind a different
 * gate; it is a DIFFERENT SET — an eye, a point it looks at, and a field of view. Anyone who
 * scopes this as "make the existing push reach `customWgsl`" has scoped the wrong feature.
 *
 * ## The contract
 *
 * A shader opts in by declaring FOUR fields in its own `struct Params`, which reflection
 * already turns into named, typed, drivable controls (T880). All four or none:
 *
 * ```wgsl
 * struct Params {
 *   viewEye: vec3f,     // @default [0, 1.6, -6]   where an explorer starts
 *   viewTarget: vec3f,  // @default [0, 1.6, 0]    what they start looking at
 *   viewFov: f32,       // @default 1.06           vertical field of view, RADIANS
 *   viewOverride: f32,  // @default 0              0 = the piece's own camera
 *   ...
 * }
 * ```
 *
 * and by branching on the flag where it builds its ray:
 *
 * ```wgsl
 * if (params.viewOverride > 0.5) { eye = params.viewEye; dir = viewRay(ndc); }
 * ```
 *
 * THE FLAG IS THE WHOLE REASON THIS IS NON-DESTRUCTIVE BY CONSTRUCTION rather than by
 * discipline. The authored pass is compiled with the flag at its STORED value — 0 in every
 * shipped piece — so it renders the piece's own animated camera, byte for byte, and it is
 * that pass whose target is exported, thumbnailed, claimed and consumed downstream. The
 * VIEWPORT is a SECOND pass into a SECOND target that nothing else reads, compiled with the
 * flag at 1, and it exists only while an editor preview sink is watching the node. There is
 * no code path from the viewport to the document, to the authored pass, or to export —
 * not a guard that refuses to write, a shape with nowhere to write to (§T1311b's ruling).
 *
 * ## Why the shader declares the HOME framing too
 *
 * §V986: an unmeasurable value must read as absent, never as a confident default. The eye of
 * an animated marcher is a function of time computed INSIDE the shader; the compiler cannot
 * know where it is, and inventing a rig for it would be a confident default for a value
 * nobody measured. So `viewEye`/`viewTarget`/`viewFov` are the AUTHOR's answer to "if someone
 * wants to walk around in this, where should they start" — stored parameters, read straight
 * off the pass, and the identity orbit reproduces them exactly.
 *
 * ## Refusal
 *
 * A shader that declares NONE of the four has no view camera and the viewer must SAY SO by
 * name rather than silently do nothing, which is today's behaviour (`PREVIEW_ORBIT_RIGS`
 * refuses `camera` and `projector` by name with a written reason each; §T1111 is the same
 * shape one layer down). A shader that declares SOME of them is a different and louder case:
 * the author meant to opt in and the shader will not do what they wrote, so it is a compile
 * DIAGNOSTIC naming the missing fields, never a silent half-contract.
 */

/** The four field names the viewer understands, and the WGSL type each must have. */
export const VIEW_CAMERA_FIELDS = Object.freeze({
  /** Ray origin, world units. */
  viewEye: "vec3f",
  /** The point the centre ray aims at. A target, not a direction: it is what an orbit
      orbits AROUND, and a direction would have to be re-derived on every delta. */
  viewTarget: "vec3f",
  /** VERTICAL field of view, in RADIANS — not a focal length, not degrees. A marcher's own
      `lens` is a focal length as often as not; one spelling has to win at the seam and the
      angle is the one an orbit can reason about. `focal = 1 / tan(viewFov * 0.5)`. */
  viewFov: "f32",
  /** 0 = the piece's own camera; 1 = the three fields above. See the docblock. */
  viewOverride: "f32",
} as const satisfies Readonly<Record<string, string>>);

export type ViewCameraFieldName = keyof typeof VIEW_CAMERA_FIELDS;

/** The names, in declaration order, for messages and for the ordered checks below. */
export const VIEW_CAMERA_FIELD_NAMES = Object.freeze(
  Object.keys(VIEW_CAMERA_FIELDS) as ViewCameraFieldName[],
);

/** A reflected struct field, as little of it as this contract needs to read. */
export interface ViewCameraCandidateField {
  readonly name: string;
  readonly wgsl: string;
}

/**
 * What a source's reflected fields say about the contract.
 *
 * Three answers, and the middle one is the point: "absent" is a legitimate shader (most of
 * the catalogue is 2D and has no camera at all), "partial" is a MISTAKE that must be loud.
 */
export type ViewCameraDeclaration =
  | { readonly kind: "absent"; readonly reason: string }
  | {
      readonly kind: "partial";
      readonly declared: ReadonlyArray<ViewCameraFieldName>;
      readonly missing: ReadonlyArray<ViewCameraFieldName>;
      readonly mistyped: ReadonlyArray<{ readonly name: ViewCameraFieldName; readonly wgsl: string; readonly expected: string }>;
      readonly reason: string;
    }
  | { readonly kind: "declared" };

/**
 * The sentence a surface shows when a shader has no view camera. Written ONCE, here, because
 * "refuse by name" means the refusal is a stated decision with a reason — a UI that invents
 * its own wording is a second answer to the same question (§V349).
 *
 * ⚠ §T1311b(a) ships the reason and its one reader (`viewCameraDeclaration`'s `absent` arm).
 * The SURFACE that shows it is the viewer's camera affordance, which does not exist yet:
 * today the orbit gestures are simply inert on an output with no camera, and there is no
 * control to grey out and explain. That control arrives with §T1311b(b)/(c)'s viewer mode,
 * and it reads THIS — it does not write its own sentence.
 */
export function viewCameraAbsentReason(): string {
  return (
    "This shader declares no view camera, so there is nothing to fly. A shader opts in by " +
    `declaring ${VIEW_CAMERA_FIELD_NAMES.join(", ")} in its \`struct Params\` and branching ` +
    "on `viewOverride` where it builds its ray."
  );
}

/** Reads a source's reflected fields for the contract. Ordered, so messages are stable. */
export function viewCameraDeclaration(
  fields: ReadonlyArray<ViewCameraCandidateField>,
): ViewCameraDeclaration {
  const byName = new Map(fields.map((field) => [field.name, field.wgsl]));
  const declared: ViewCameraFieldName[] = [];
  const missing: ViewCameraFieldName[] = [];
  const mistyped: { name: ViewCameraFieldName; wgsl: string; expected: string }[] = [];
  for (const name of VIEW_CAMERA_FIELD_NAMES) {
    const wgsl = byName.get(name);
    if (wgsl === undefined) {
      missing.push(name);
      continue;
    }
    declared.push(name);
    const expected = VIEW_CAMERA_FIELDS[name];
    if (wgsl !== expected) mistyped.push({ name, wgsl, expected });
  }
  if (declared.length === 0) return { kind: "absent", reason: viewCameraAbsentReason() };
  if (missing.length === 0 && mistyped.length === 0) return { kind: "declared" };
  const complaints = [
    ...(missing.length === 0 ? [] : [`does not declare ${missing.join(", ")}`]),
    ...mistyped.map(({ name, wgsl, expected }) => `declares \`${name}: ${wgsl}\`, which must be \`${expected}\``),
  ];
  return {
    kind: "partial",
    declared,
    missing,
    mistyped,
    reason:
      `this shader ${complaints.join(", and ")}. The view camera is all four fields ` +
      `(${VIEW_CAMERA_FIELD_NAMES.join(", ")}) or none of them — a half-declared one would ` +
      "give the viewer a camera the shader does not read.",
  };
}

/**
 * The HOME framing, read off the values the pass was compiled with.
 *
 * Not a rig, not a default: the author's own stored numbers, so the identity orbit renders
 * exactly what the author nominated (§V986). Anything that is not three finite numbers /
 * one finite angle reads as ABSENT — an output with no honest home has no viewport, which
 * is the same rule `PREVIEW_ORBIT_RIGS` states with its `null` rows.
 */
export interface ViewCameraHome {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  readonly fovY: number;
}

export function viewCameraHome(
  uniforms: Readonly<Record<string, number | readonly number[] | undefined>> | undefined,
): ViewCameraHome | undefined {
  if (uniforms === undefined) return undefined;
  const eye = triple(uniforms["viewEye"]);
  const lookAt = triple(uniforms["viewTarget"]);
  const fovRaw = uniforms["viewFov"];
  const fovY = typeof fovRaw === "number" && Number.isFinite(fovRaw) ? fovRaw : undefined;
  /*
   * ALL FOUR, INCLUDING THE FLAG, and that is not pedantry — it is what stops a partial
   * declaration from reaching the GPU as an error. The runtime binds by NAME and REFUSES a
   * value the shader's struct does not declare, so a shader with the three numbers and no
   * `viewOverride` would have its viewport pass compiled with a `viewOverride: 1` that has
   * nowhere to land. The node warns about that case by name at compile; this is the other
   * half, at the site that would otherwise build the broken pass anyway.
   */
  if (typeof uniforms["viewOverride"] !== "number") return undefined;
  if (eye === undefined || lookAt === undefined || fovY === undefined) return undefined;
  // A zero-or-negative fov is not a camera, and a zero-length view vector has no direction
  // to orbit around — both are "absent", never a substituted default.
  if (!(fovY > 0 && fovY < Math.PI)) return undefined;
  if (eye[0] === lookAt[0] && eye[1] === lookAt[1] && eye[2] === lookAt[2]) return undefined;
  return { eye, lookAt, fovY };
}

function triple(value: number | readonly number[] | undefined): readonly [number, number, number] | undefined {
  // EXACTLY three: the contract declares `vec3f`, and a field of some other width bound
  // by its first three components is a shader being handed a value of the wrong shape.
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [x, y, z] = value as readonly number[];
  if (x === undefined || y === undefined || z === undefined) return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
  return [x, y, z];
}

/**
 * What the override WRITES — an eye, a target and an angle, and deliberately NOT a
 * `viewProjection`. This is the whole reason the contract exists rather than a second gate
 * on the scene path's push: a marcher has no vertices to transform.
 *
 * `viewOverride: 1` rides along because the flag is what makes the shader read the other
 * three; pushing them without it would move nothing and read as a dead control.
 */
export function viewCameraUniforms(
  pose: { readonly eye: readonly [number, number, number]; readonly lookAt: readonly [number, number, number] },
  fovY: number,
): Record<string, number | number[]> {
  return {
    viewEye: [pose.eye[0], pose.eye[1], pose.eye[2]],
    viewTarget: [pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]],
    viewFov: fovY,
    viewOverride: 1,
  };
}

/**
 * The `viewCamera` a VIEWPORT row publishes — built HERE and nowhere else.
 *
 * The same rule `previewOrbitBasis` is under, and enforced by the same gate one file over
 * (`preview-orbit.test.ts` reads `compile.ts` and fails on an inline `lookAt`): a camera
 * basis assembled where somebody happened to be working is how T675's two disagreeing
 * branches arrived. One derivation, one spelling, one place to read when the numbers look
 * wrong.
 */
export interface ViewCameraRow {
  readonly passId: string;
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  readonly fovY: number;
  readonly aspect: number;
}

export function viewCameraRow(
  home: ViewCameraHome,
  options: { readonly passId: string; readonly aspect: number },
): ViewCameraRow {
  return {
    passId: options.passId,
    eye: home.eye,
    lookAt: home.lookAt,
    fovY: home.fovY,
    aspect: options.aspect,
  };
}

/** The uniform overrides the VIEWPORT pass is compiled with: the home framing, flag on. */
export function viewCameraPassUniforms(home: ViewCameraHome): Record<string, number | number[]> {
  return viewCameraUniforms({ eye: home.eye, lookAt: home.lookAt }, home.fovY);
}
