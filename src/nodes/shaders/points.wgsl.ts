import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * Shaders for the point family (T121, T122).
 *
 * The kernel node's compute WGSL is GENERATED per instance by `src/points/codegen.ts`;
 * only the render side lives here. Sprites are billboarded quads expanded in the vertex
 * stage — six vertices per instance, corner picked by vertex_index, size converted from
 * pixels to clip space through the shared frame block's resolution (§V44: everything
 * per-frame arrives through that block, nothing else).
 */

export const DEFAULT_POINT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // Deterministic drift: same seed, same point, same frame, same motion (§V74).
  let jitterX = pointRand(p.id, 1u) - 0.5;
  let jitterY = pointRand(p.id, 2u) - 0.5;
  q.velocity = q.velocity + vec3f(jitterX, jitterY - 0.05, 0.0) * ctx.delta;
  q.position = q.position + q.velocity * ctx.delta;
  // Wrap in clip space so the system never drifts off screen.
  if (q.position.y < -1.1) { q.position.y = 1.1; }
  if (q.position.x < -1.1) { q.position.x = 1.1; }
  if (q.position.x > 1.1) { q.position.x = -1.1; }
  return q;
}`;

/**
 * T286: ONE sprite shader, two spellings. Unmapped, `sizePixels` is a uniform —
 * byte-identical to what shipped before the Map page existed, so the feature's
 * existence changes no pass signatures (T300's property, kept deliberately). Mapped,
 * the size is a PER-POINT attribute read straight off the SoA pair, swizzled by the
 * attribute's declared type — the pscale that turns copies into a medium.
 */
export function spriteRenderWgsl(options?: {
  sizeMap?: { type: string; channel?: string };
  /** T364: per-point colour — a vec4f attribute, LINEAR by convention (attributes are data, §V56). */
  colorMap?: boolean;
  /**
   * T333: the draw-time group — a WGSL predicate over `p.<attribute>`. The node
   * resolves each referenced attribute against the TYPED edge payload (§V308) and
   * hands the binds here; an excluded instance collapses to a zero-area quad (§V219's
   * trick — no discard cost, no indirect rewrite).
   */
  group?: { expression: string; binds: ReadonlyArray<{ attribute: string; type: string }> };
}): string {
  const sizeMap = options?.sizeMap;
  const colorMap = options?.colorMap === true;
  const group = options?.group;
  const groupBindings =
    group === undefined
      ? ""
      : group.binds
          .map(
            (bind, index) =>
              `@group(0) @binding(${5 + index}) var<storage, read> group_${bind.attribute}: array<${bind.type}>;\n`,
          )
          .join("");
  const groupFunction =
    group === undefined
      ? ""
      : `
struct GroupPoint {
${group.binds.map((bind) => `  ${bind.attribute}: ${bind.type},`).join("\n")}
};

fn groupMatch(p: GroupPoint) -> bool {
  return (${group.expression});
}
`;
  const groupGate =
    group === undefined
      ? ""
      : `  var p: GroupPoint;
${group.binds.map((bind) => `  p.${bind.attribute} = group_${bind.attribute}[instance];`).join("\n")}
  if (!groupMatch(p)) {
    /* Excluded: every vertex of the quad lands on one point — zero area, no cost. */
    var gated: VertexOut;
    gated.position = vec4f(2.0, 2.0, 0.0, 1.0);
    gated.corner = vec2f(0.0, 0.0);
${colorMap ? "    gated.color = vec4f(0.0);\n" : ""}    return gated;
  }
`;

  const fields = `${colorMap ? "" : "  color: vec4f,\n"}${sizeMap === undefined ? "  sizePixels: f32,\n" : ""}`;
  // Both mapped = an EMPTY struct, which WGSL refuses: the block vanishes entirely
  // and the pass carries no uniforms (the sweep skips uniform-less passes).
  const structBlock =
    fields === ""
      ? ""
      : `struct SpriteParams {
${fields}};

`;
  const paramsBinding = fields === "" ? "" : "@group(0) @binding(1) var<uniform> params: SpriteParams;\n";
  const sizeBinding =
    sizeMap === undefined
      ? ""
      : `@group(0) @binding(3) var<storage, read> mapSizes: array<${sizeMap.type}>;\n`;
  const colorBinding = colorMap ? "@group(0) @binding(4) var<storage, read> mapColors: array<vec4f>;\n" : "";
  const sizeExpr =
    sizeMap === undefined
      ? "params.sizePixels"
      : sizeMap.channel === undefined
        ? "mapSizes[instance]"
        : `mapSizes[instance].${sizeMap.channel}`;
  const colorExpr = colorMap ? "input.color" : "params.color";
  return `${SHARED_UNIFORMS_WGSL}
${structBlock}@group(0) @binding(0) var<uniform> frameU: SharedFrame;
${paramsBinding}@group(0) @binding(2) var<storage, read> positions: array<vec3f>;
${sizeBinding}${colorBinding}${groupBindings}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
${colorMap ? "  @location(1) color: vec4f,\n" : ""}};
${groupFunction}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  /* Two triangles of a unit quad, expanded around the point's clip position. */
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
${groupGate}  let center = positions[instance];
  let size = ${sizeExpr};
  let sizeClip = vec2f(size, size) / frameU.resolution * 2.0;
  var out: VertexOut;
  out.position = vec4f(center.xy + corner * sizeClip * 0.5, 0.0, 1.0);
  out.corner = corner;
${colorMap ? "  out.color = mapColors[instance];\n" : ""}  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  /* Soft disc: alpha falls off toward the quad edge. */
  let distance = length(input.corner);
  if (distance > 1.0) {
    discard;
  }
  let falloff = 1.0 - distance * distance;
  return vec4f(${colorExpr}.rgb, ${colorExpr}.a * falloff);
}`;
}

/** The unmapped spelling, kept as the constant its consumers always imported. */
export const SPRITE_RENDER_WGSL = spriteRenderWgsl();

/**
 * TextureToAttribute (T124): the TOP→POP bridge. One thread per point: read the
 * upstream position, project clip xy to texel coordinates, `textureLoad` the input
 * (unfiltered — works for any renderable format incl. r32float data fields, §V57),
 * write the sample to this node's own pair and copy position through so downstream
 * consumers read a coherent set from ONE producer.
 */
export const TEXTURE_TO_ATTRIBUTE_WGSL = `struct BridgeFrame {
  count: u32,
};

@group(0) @binding(0) var<uniform> bridgeFrame: BridgeFrame;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read_write> out_sample: array<vec4f>;
@group(0) @binding(3) var sourceTexture: texture_2d<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= bridgeFrame.count) {
    return;
  }
  /* T296/§V197: position passes downstream BY REFERENCE through the edge map — this
     kernel writes only what it owns (sample). The old position copy existed for an
     id-derivation convention, not a physical need. */
  let position = in_position[index];
  /* Clip space [-1,1] -> uv [0,1] -> texel, y INVERTED (T512): world +y is UP and
     texel row 0 is the TOP of the picture, so position.y = +1 must reach uv.y = 0.
     The old same-sign mapping read every texture upside down — a webcam through this
     bridge rendered the user's face inverted — and survived since T262 because it
     agreed with fieldAt's identical mistake and every test image was symmetric.
     Clamped so off-screen points still sample. */
  let dims = vec2f(textureDimensions(sourceTexture, 0));
  let uv = clamp(vec2f(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5), vec2f(0.0), vec2f(1.0));
  let texel = vec2i(uv * (dims - vec2f(1.0)));
  out_sample[index] = textureLoad(sourceTexture, texel, 0);
}`;

/**
 * T483 — the RAY POP: every point casts one ray against a HEIGHT FIELD and writes what
 * it hit. GPU-resident per point (TD's Ray POP, not the SOP), and deliberately a
 * heightfield rather than mesh intersection: a grid surface is analytic in
 * CONNECTIVITY but its positions are arbitrary displaced buffers (E20's whole point),
 * so no closed form exists and brute-force ray-triangle is P×2C tests a frame.
 * A marched field costs steps×P — visible, controllable — and covers the scenes we
 * build: rain onto terrain, sparks hugging a fluid surface. Exact mesh intersection is
 * specced when an example demands it, not before.
 *
 * THE FIELD'S CONVENTION, documented exactly: the texture spans world x,z ∈ [−extent,
 * +extent] (u = x/(2·extent) + 0.5, v = z/(2·extent) + 0.5), and its R channel is
 * height: y = r × heightScale + heightOffset. Read with textureLoad — data fields
 * (r32float) work on Tier B (§V57).
 *
 * The march samples `steps` points along the ray; on the first below-surface sample it
 * refines by ONE secant between the straddling pair — exact on a locally-linear
 * surface, cheap everywhere. A miss writes hit = 0 with the ray's end, so downstream
 * kernels can branch without a sentinel convention.
 */
export function pointRayWgsl(options: { steps: number; directionAttribute: boolean }): string {
  const steps = Math.max(1, Math.floor(options.steps));
  const directionDeclaration = options.directionAttribute
    ? "@group(0) @binding(2) var<storage, read> in_direction: array<vec3f>;\n"
    : "";
  const directionExpression = options.directionAttribute
    ? "normalize(in_direction[index])"
    : "normalize(rayFrame.direction.xyz)";
  const outBase = options.directionAttribute ? 3 : 2;
  return `struct RayFrame {
  count: u32,
  extent: f32,
  heightScale: f32,
  heightOffset: f32,
  maxDistance: f32,
  direction: vec4f,
};

@group(0) @binding(0) var<uniform> rayFrame: RayFrame;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
${directionDeclaration}@group(0) @binding(${outBase}) var<storage, read_write> out_hit: array<f32>;
@group(0) @binding(${outBase + 1}) var<storage, read_write> out_hitPosition: array<vec3f>;
@group(0) @binding(${outBase + 2}) var<storage, read_write> out_hitNormal: array<vec3f>;
@group(0) @binding(${outBase + 3}) var<storage, read_write> out_hitDistance: array<f32>;
@group(0) @binding(${outBase + 4}) var fieldTexture: texture_2d<f32>;

fn heightAt(x: f32, z: f32) -> f32 {
  let uv = clamp(vec2f(x, z) / (2.0 * rayFrame.extent) + vec2f(0.5), vec2f(0.0), vec2f(1.0));
  let dims = vec2f(textureDimensions(fieldTexture, 0));
  let r = textureLoad(fieldTexture, vec2i(uv * (dims - vec2f(1.0))), 0).r;
  return r * rayFrame.heightScale + rayFrame.heightOffset;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= rayFrame.count) {
    return;
  }
  let origin = in_position[index];
  let direction = ${directionExpression};
  let stepLength = rayFrame.maxDistance / ${steps}.0;

  var previous = origin;
  var previousAbove = origin.y - heightAt(origin.x, origin.z);
  var hit = 0.0;
  var where3 = origin + direction * rayFrame.maxDistance;
  var travelled = rayFrame.maxDistance;

  for (var step = 1u; step <= ${steps}u; step += 1u) {
    let sample = origin + direction * (stepLength * f32(step));
    let above = sample.y - heightAt(sample.x, sample.z);
    if (previousAbove > 0.0 && above <= 0.0) {
      /* The straddling pair: one secant — exact where the surface is locally linear. */
      let t = previousAbove / max(previousAbove - above, 1e-6);
      where3 = previous + (sample - previous) * t;
      travelled = stepLength * (f32(step - 1u) + t);
      hit = 1.0;
      break;
    }
    previous = sample;
    previousAbove = above;
  }

  /* The field's normal from its own gradient — two taps per axis, world-space epsilon. */
  let e = rayFrame.extent / 128.0;
  let dhdx = (heightAt(where3.x + e, where3.z) - heightAt(where3.x - e, where3.z)) / (2.0 * e);
  let dhdz = (heightAt(where3.x, where3.z + e) - heightAt(where3.x, where3.z - e)) / (2.0 * e);

  out_hit[index] = hit;
  out_hitPosition[index] = where3;
  out_hitNormal[index] = select(vec3f(0.0, 1.0, 0.0), normalize(vec3f(-dhdx, 1.0, -dhdz)), hit > 0.5);
  out_hitDistance[index] = travelled;
}`;
}
