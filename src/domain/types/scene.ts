import type { PointTopology } from "./ports.ts";

/**
 * T447/T377: the SCENE payloads — what camera, light, geometry and material nodes
 * publish on their (reference-synthesized) edges, and what a Render consumes.
 *
 * All CPU VALUES, resolved at compile and re-resolved by the animate path, so an
 * orbiting camera or a moving light is a uniform write and never a rebuild (§V5).
 * The payloads travel the same structural channel `pointsets` does (compile.ts reads
 * them off CompiledNodeDescription and hands them to consumers on the input binding):
 * ports are the plumbing, references are the authoring surface (V373).
 */

export interface CameraPayload {
  readonly kind: "camera";
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  /** Degrees. The matrix is composed where CONSUMED — the render knows the aspect. */
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
  readonly ortho: boolean;
  /** World-units height of the ortho frustum (width follows aspect). */
  readonly orthoHeight: number;
  /** Degrees of bank around the view axis (T706). Optional: absent reads as 0. */
  readonly roll?: number;
}

export interface LightPayload {
  readonly kind: "light";
  readonly light: {
    readonly type: "directional" | "point";
    /** Linear-space colour, premultiplied by nothing — intensity is separate. */
    readonly color: readonly [number, number, number];
    readonly intensity: number;
    /** Direction the light TRAVELS (directional). Normalised by the consumer. */
    readonly direction: readonly [number, number, number];
    readonly position: readonly [number, number, number];
    /**
     * T481: this light CASTS — one extra scene pass per render, stated on the
     * parameter. Directional only in this build; a casting point light refuses by
     * name at the render (six faces is a different feature).
     */
    readonly shadows: boolean;
    /**
     * T481 (V426): the world-units half-extent of the ortho shadow volume around the
     * origin. EXPLICIT, never auto-fit — payloads carry no scene bounds, and a derived
     * box would silently crop the shadow plausibly-wrong. A number the user can see
     * beats a guess they cannot.
     */
    readonly shadowExtent: number;
  };
}

/**
 * One point attribute as the edge map carries it (T296 vocabulary, T1076 layout).
 *
 * Structurally `PointsetAttributeRef` with everything readonly: the scene channel copies
 * the pointset payload verbatim, so the two shapes must stay identical or a geometry
 * payload would carry an attribute the renderer cannot address.
 */
export interface ScenePairRef {
  /** The bufferPair holding this attribute's region — one per producer, not per attribute. */
  readonly buffer: string;
  readonly half: "read" | "write";
  /** T1076: byte offset of the attribute's region inside `buffer`. */
  readonly offset: number;
  /** T1076: bytes the region occupies (`stride × capacity`). */
  readonly bytes: number;
  readonly type?: string;
}

export interface GeometryPayload {
  readonly kind: "geometry";
  /** The bound pointset, forwarded from the geometry node's points edge (T296). */
  readonly pairs: Readonly<Record<string, ScenePairRef>>;
  readonly capacity: number;
  readonly topology?: PointTopology | string;
  /** How this object renders. */
  readonly mode: "surface" | "instances" | "points" | "beam";
  /**
   * The per-point primitive's sizing. Instances wear the `shape` (T428b); the two
   * billboard modes ignore it and use `scale` alone; `taper` is beam-only.
   */
  readonly instance?: {
    readonly shape: "quad" | "box" | "octahedron";
    readonly scale: number;
    /**
     * T680, beam mode: the fraction of the full width the beam has AT ITS ORIGIN. 1 is a
     * parallel-sided ribbon; 0 pinches the near end to a point, which is what a
     * divergent beam does and — measured, not assumed — the only thing that keeps N
     * beams sharing one origin from fusing into a solid opaque wedge around it.
     */
    readonly taper?: number;
    /** T917: soft edge falloff share (0 hard .. 1 from the centreline). Rides instance.w. */
    readonly soft?: number;
    /** T940b: points mode — draw each billboard as a lit spherical splat. */
    readonly spherical?: boolean;
  };
  /**
   * T721 — a PER-POINT size factor, as an f32 attribute (or one channel of a float
   * vector). It MULTIPLIES `instance.scale` rather than replacing it, for two reasons
   * that are not style: the authored Scale stays a live number the inspector can move,
   * which is the fault §B132 shipped for weeks in the other direction; and it makes the
   * attribute dimensionless, so a kernel writes "twice as big" rather than having to
   * know the object's world size. Same shape and same arithmetic as the mapped `tint`
   * one field up, which is the other map on this node.
   */
  /** T917: additive light — the draw blends additively and stops writing depth. */
  readonly blend?: "additive";
  readonly scaleAttribute?: ScenePairRef & {
    readonly type: string;
    readonly channel?: string;
  };
  /**
   * T723 — a PER-INSTANCE ORIENTATION, as a vec4f attribute holding a unit quaternion.
   *
   * It REPLACES rather than multiplying, and that is not a departure from the size one
   * field up: `scale` multiplies because there is an authored Scale to keep live, and
   * there is no authored rotation anywhere on this node to keep. The map supplies the
   * whole turn against an identity default, and a non-identity authored value refuses
   * rather than being dropped.
   *
   * INSTANCES ONLY. A points billboard faces the camera by construction and a beam
   * takes its axis from its endpoints, so neither has a free frame; both refuse by name.
   * A vec4f, not a vec3f of Euler angles or a forward direction, because `vec3f` and
   * `vec4f` both stride 16 bytes — the choice is free, so it is made on what each
   * cannot do, and only the quaternion can compose, interpolate and carry roll.
   */
  readonly orientAttribute?: ScenePairRef;
  /**
   * T680 — BEAM mode: the other end of each segment, as a vec3f attribute pair.
   *
   * The beam is the third member of the billboard family and the one that carries a
   * DIRECTION: a quad spanning `position` → this endpoint, widened along the axis the
   * camera can see. Where `points` mode derives its whole basis from the camera, a beam
   * derives only its WIDTH from the camera and takes its length and its bearing from
   * the data — which is why it needs a second position and the billboard does not.
   *
   * Required in beam mode and refused by name when absent or mistyped (§V288): a beam
   * that silently fell back to a zero-length segment would draw nothing and teach that
   * the mode is broken.
   */
  readonly endpoint?: ScenePairRef;
  /**
   * T478: per-point colour — the geometry's `tint` in MAP mode, resolved to a vec4f
   * attribute pair. It MULTIPLIES the material's base colour per point, exactly as the
   * static tint multiplies it per object: the material stays fully live (specular,
   * roughness, maps), white = inherit holds pointwise, and no half of the material is
   * silently ignored (V349's lesson).
   */
  readonly colorAttribute?: ScenePairRef;
  /**
   * T642: the draw-time GROUP — §V471's selection idiom, in the scene path. The same
   * {expression, binds} `resolveGroupPredicate` hands `renderPoints` (§V349: one
   * resolver, one concept); the instances draw gates per instance in the vertex stage
   * and collapses excluded ones to zero area (§V219 — no discard, no indirect rewrite,
   * no fragment work). Instances (and, when it lands, points) mode only: a predicate
   * that removed points from a SURFACE would punch holes in mesh connectivity, which
   * is a different feature.
   */
  readonly group?: {
    readonly expression: string;
    readonly binds: ReadonlyArray<ScenePairRef & { readonly attribute: string; readonly type: string }>;
  };
  /**
   * T478: the GPU-resident live count, when the producer spawns and kills (T322).
   * Instances draw INDIRECTLY off it (countedDrawSupport), so a dead tail is never
   * resurrected. A counted SURFACE stays refused: grid topology addresses fixed
   * points, and a claim over points that may be dead is a lie (§V13).
   */
  readonly count?: { readonly buffer: string };
  /**
   * The resolved material, EMBEDDED: the geometry node composes its referenced
   * material with its own per-object overrides (T449), so the render sees one
   * finished material per object and never resolves the pairing itself.
   */
  readonly material: MaterialPayload;
}

export interface MaterialPayload {
  readonly kind: "material";
  readonly model: "unlit" | "lambert" | "phong" | "pbr" | "glass";
  /** Linear-space base/diffuse colour. */
  readonly baseColor: readonly [number, number, number, number];
  readonly specularColor: readonly [number, number, number];
  readonly shininess: number;
  readonly metallic: number;
  readonly roughness: number;
  /** Plan resource ids of map textures, when the material's map inputs are wired. */
  readonly maps: {
    readonly albedo?: string;
    readonly roughness?: string;
  };
  /**
   * T725 — present exactly when model === "glass": screen-space transmission. The
   * surface SAMPLES what was already rendered behind it (§V644: sampled light, never
   * an albedo tint — baseColor is not even a glass parameter; absorption is), bent by
   * Snell refraction, dispersed per wavelength, attenuated by Beer-Lambert, and mixed
   * against a Fresnel-weighted reflection.
   */
  readonly glass?: {
    /** Index of refraction, 1–2.4. 1 is optically inert (the identity gate). */
    readonly ior: number;
    /** World-units path length assumed inside the body (v1's "simple" mode). */
    readonly thickness: number;
    /** Beer-Lambert absorption per unit path, per channel (linear). */
    readonly absorption: readonly [number, number, number];
    /** Spectral IOR spread across the visible band. 0 = no dispersion. */
    readonly dispersion: number;
  };
}

/**
 * T704 — a projector: a camera pose throwing a texture INTO the scene, occlusion-aware.
 * The pose is deliberately T706's trio (eye/lookAt/roll — one orientation
 * representation everywhere); the optics are the numbers a venue lens sheet prints.
 * To the renderer it is a LIGHT with a cookie: its contribution is ADDITIVE radiance,
 * never an albedo multiply (§V644 — everything outside the beam stays lit by the rig).
 */
export interface ProjectorPayload {
  readonly kind: "projector";
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  readonly roll: number;
  readonly throwRatio: number;
  readonly aspect: number;
  readonly shiftX: number;
  readonly shiftY: number;
  readonly keystoneH: number;
  readonly keystoneV: number;
  readonly brightness: number;
  /** Linear-space tint over the cookie. */
  readonly color: readonly [number, number, number];
  /** Inverse-square about the throw distance (brightness is nominal AT lookAt). */
  readonly falloff: boolean;
  /** Depth-compare against the projector's own map — a parapet shadows the wall. */
  readonly occlusion: boolean;
  /** The projected content's resource, when the cookie input is wired. */
  readonly cookieResource?: string;
}

export type ScenePayload =
  | CameraPayload
  | LightPayload
  | GeometryPayload
  | MaterialPayload
  | ProjectorPayload;

/**
 * Every scene-payload kind, as a value (T532).
 *
 * The union above is a TYPE, so nothing could iterate it — and that is how T462 shipped
 * previews for three of four kinds and nobody noticed the fourth. `geometry` had no
 * preview variant at all, so a geometry node correctly showed nothing, for a year, with
 * every suite green: absent, not broken (§V437's shape, one kind at a time).
 *
 * The two `satisfies` below make the array and the union each other's proof. A fifth kind
 * added to `ScenePayload` fails to compile until it is listed here, and
 * `scene-preview.test.ts` iterates THIS array to assert every kind has a preview variant
 * — so the new kind then fails a test until someone writes one. Neither half can be
 * skipped, and neither is a list anyone has to remember to update.
 */
export const SCENE_PAYLOAD_KINDS = ["camera", "light", "geometry", "material", "projector"] as const;

export type ScenePayloadKind = (typeof SCENE_PAYLOAD_KINDS)[number];

/** Bidirectional: every listed kind is a real payload kind, and every kind is listed. */
const _kindsAreExhaustive: readonly ScenePayload["kind"][] = SCENE_PAYLOAD_KINDS satisfies readonly ScenePayload["kind"][];
const _kindsAreComplete: ScenePayloadKind = null as unknown as ScenePayload["kind"];
void _kindsAreExhaustive;
void _kindsAreComplete;

/** The default material: what a geometry with no material reference renders with. */
export const DEFAULT_MATERIAL: MaterialPayload = {
  kind: "material",
  model: "lambert",
  baseColor: [0.8, 0.8, 0.8, 1],
  specularColor: [1, 1, 1],
  shininess: 32,
  metallic: 0,
  roughness: 0.6,
  maps: {},
};
