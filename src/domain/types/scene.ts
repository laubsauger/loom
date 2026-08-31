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

/** One point attribute pair as the edge map carries it (T296 vocabulary). */
export interface ScenePairRef {
  readonly pair: string;
  readonly half: "read" | "write";
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
  };
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
    readonly binds: ReadonlyArray<{ attribute: string; type: string; pair: string; half: "read" | "write" }>;
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
  readonly model: "unlit" | "lambert" | "phong" | "pbr";
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
}

export type ScenePayload = CameraPayload | LightPayload | GeometryPayload | MaterialPayload;

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
export const SCENE_PAYLOAD_KINDS = ["camera", "light", "geometry", "material"] as const;

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
