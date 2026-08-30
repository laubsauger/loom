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
  readonly mode: "surface" | "instances" | "points";
  /** Instances mode: the primitive worn per point (T428b). */
  readonly instance?: { readonly shape: "quad" | "box" | "octahedron"; readonly scale: number };
  /**
   * T478: per-point colour — the geometry's `tint` in MAP mode, resolved to a vec4f
   * attribute pair. It MULTIPLIES the material's base colour per point, exactly as the
   * static tint multiplies it per object: the material stays fully live (specular,
   * roughness, maps), white = inherit holds pointwise, and no half of the material is
   * silently ignored (V349's lesson).
   */
  readonly colorAttribute?: ScenePairRef;
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
