import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";

/**
 * Shaders for the point family (T121, T122).
 *
 * The kernel node's compute WGSL is GENERATED per instance by `src/points/codegen.ts`;
 * only the render side lives here. Sprites are billboarded quads expanded in the vertex
 * stage — six vertices per instance, corner picked by vertex_index, size converted from
 * pixels to clip space through the shared frame block's resolution (§V44: everything
 * per-frame arrives through that block, nothing else).
 */

/**
 * The kernel a fresh point kernel node ships with — and, since T1210, THE STRUCT IS PART OF
 * THE STARTING POINT rather than something the author has to know to add.
 *
 * ⚑ WHY THE `struct Params` IS HERE AND NOT IN A SENTENCE SOMEWHERE. The reflection (T880,
 * T900) is what turns a field into a KNOB: `jitter: f32` becomes a named, typed, drivable,
 * publishable control on the node, read back here as `ctx.params.jitter`. A kernel with no
 * such block is a DEAD END THAT LOOKS FINE — it compiles, it renders, and there is nothing
 * to turn — which is the silent-success failure the owner named: *"we need to instruct for
 * it to write struct params… this needs to become something that ideally is INHERENT. For
 * both user and agents."* A default that ships with the block serves both identically, where
 * a line in a tool description reaches only the agents that read it.
 *
 * The two fields are DIRECTION, not implementation (§T1053's test): `jitter` is how hard the
 * random walk shoves, `gravity` is the steady pull. Neither can be dragged into breaking the
 * kernel, both are visible on the first drag, and each carries the `// @default <literal>`
 * (T1184) and the trailing sentence (T1053) that this file wants copied — the source is the
 * convention's own worked example.
 *
 * ⚠ THE DEFAULTS REPRODUCE THE OLD MOTION EXACTLY. `jitter` 1 and `gravity` 0.05 make the
 * push `vec3f(jitterX, jitterY - 0.05, 0)` term for term, so promoting the constants moved
 * no point of any document that stores this text and none of any that omits `kernel` and
 * falls back to it. `x * 1.0` is exact in f32; this is arithmetic, not a tolerance.
 *
 * ⚠ AND IT IS A STARTING POINT, NOT AN ENFORCEMENT. The kernel is STORED on the node at
 * creation (`addNode` spreads `defaultParameters` into the document), so a user who deletes
 * the struct is editing their own stored text and reflection honestly reports no fields.
 * Nothing re-derives the block behind them. Refusing to compile a kernel without one was
 * never on the table either — the editor recompiles per keystroke, so a hard refusal blacks
 * the node out mid-typing (§V940).
 */
export const DEFAULT_POINT_KERNEL = wgsl`struct Params {
  jitter: f32,   // @default 1  How hard the random walk shoves each point; 0 is a clean fall.
  gravity: f32,  // @default 0.05  The steady downward pull, in clip units per second squared.
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // Deterministic drift: same seed, same point, same frame, same motion (§V74).
  let jitterX = pointRand(p.id, 1u) - 0.5;
  let jitterY = pointRand(p.id, 2u) - 0.5;
  // Every field of the struct above is a control on this node, read here as ctx.params.<name>.
  // Add a field and the knob appears; delete the struct and the knobs go with it.
  let push = (vec3f(jitterX, jitterY, 0.0) * ctx.params.jitter) - vec3f(0.0, ctx.params.gravity, 0.0);
  q.velocity = q.velocity + push * ctx.delta;
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
}): EmittedWgsl {
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
  return wgsl`${SHARED_UNIFORMS_WGSL}
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
export const TEXTURE_TO_ATTRIBUTE_WGSL = wgsl`struct BridgeFrame {
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
export function pointRayWgsl(options: { steps: number; directionAttribute: boolean }): EmittedWgsl {
  const steps = Math.max(1, Math.floor(options.steps));
  const directionDeclaration = options.directionAttribute
    ? "@group(0) @binding(2) var<storage, read> in_direction: array<vec3f>;\n"
    : "";
  const directionExpression = options.directionAttribute
    ? "normalize(in_direction[index])"
    : "normalize(rayFrame.direction.xyz)";
  const outBase = options.directionAttribute ? 3 : 2;
  return wgsl`struct RayFrame {
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

/**
 * Proximity (T819) — each point's K nearest neighbours within a radius, as LINKS.
 *
 * BRUTE FORCE, deliberately: one thread per source point scans every candidate and keeps
 * the K nearest by insertion into a K-slot local array. At the supported envelope
 * (N ≤ 4096, K ≤ 8) that is ~16.7M distance evaluations per frame — microsecond-scale on
 * anything Tier B calls a GPU, and the whole cost is one multiply-add chain per pair.
 * A SPATIAL HASH IS REFUSED BY NAME, not missed: grid binning needs atomics and a
 * multi-pass sort, complexity bought against a workload (tens of thousands of points) no
 * consumer asks for. If a measured need past ~16k points arrives, that is the moment to
 * build it — against the measurement, not ahead of it.
 *
 * THE OUTPUT IS DRAWN, NOT CONSUMED: each link is one point whose `position` is the
 * source and whose `tip` is the neighbour, which is exactly the pair the beam renderer
 * already draws (geometry `mode: "beam", endpoint: "tip"` — E13's rays). A link that
 * does not exist — beyond radius, fewer than K in range, or a dead source on a counted
 * set — collapses to ZERO LENGTH (§V788: position == tip, zero area, no cost) with a
 * zero tint, so the capacity stays fixed at N×K and no live-count machinery is needed.
 *
 * K-nearest is NOT SYMMETRIC: A→B can exist without B→A, and when both exist the line
 * draws twice at beam alpha. Cheap, visually harmless, and deduping would cost a second
 * pass — documented rather than fixed.
 */
export function pointProximityWgsl(options: { neighbors: number; counted: boolean }): EmittedWgsl {
  const k = Math.max(1, Math.min(8, Math.floor(options.neighbors)));
  const countDeclaration = options.counted
    ? "@group(0) @binding(2) var<storage, read> in_count: array<u32>;\n"
    : "";
  const outBase = options.counted ? 3 : 2;
  const liveExpression = options.counted
    ? "min(params.count, in_count[0])"
    : "params.count";
  /* T1071: the neighbour's SLOT, written beside its position. Without it a link says
     WHERE the neighbour is and never WHO it is, so nothing downstream can look up that
     neighbour's colour, degree or any other attribute — which is why every consumer that
     wanted an adjacency had to rebuild the scan. §V73's word: a slot is ADDRESSING, and
     the address is the one thing `tip` cannot carry. */
  return wgsl`struct ProximityParams {
  count: u32,
  radius: f32,
  falloff: f32,
};

@group(0) @binding(0) var<uniform> params: ProximityParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
${countDeclaration}@group(0) @binding(${outBase}) var<storage, read_write> out_position: array<vec3f>;
@group(0) @binding(${outBase + 1}) var<storage, read_write> out_tip: array<vec3f>;
@group(0) @binding(${outBase + 2}) var<storage, read_write> out_tint: array<vec4f>;
@group(0) @binding(${outBase + 3}) var<storage, read_write> out_neighbor: array<u32>;

const K: u32 = ${k}u;
const FAR: f32 = 1.0e30;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let live = ${liveExpression};
  let origin = in_position[index];
  let radius = max(params.radius, 1.0e-6);
  let r2 = radius * radius;

  var bestD: array<f32, ${k}>;
  var bestJ: array<u32, ${k}>;
  for (var s = 0u; s < K; s += 1u) {
    bestD[s] = FAR;
    bestJ[s] = index;
  }

  /* A dead source on a counted set emits only parked links; the scan still runs so the
     shader has one exit and the write below covers every slot unconditionally. */
  let sourceLive = index < live;
  if (sourceLive) {
    for (var j = 0u; j < live; j += 1u) {
      if (j == index) {
        continue;
      }
      let d = in_position[j] - origin;
      let d2 = dot(d, d);
      if (d2 > r2 || d2 >= bestD[K - 1u]) {
        continue;
      }
      bestD[K - 1u] = d2;
      bestJ[K - 1u] = j;
      /* Bubble the newcomer to its rank — K is tiny, this is a handful of compares. */
      for (var s = K - 1u; s > 0u; s -= 1u) {
        if (bestD[s] < bestD[s - 1u]) {
          let td = bestD[s]; bestD[s] = bestD[s - 1u]; bestD[s - 1u] = td;
          let tj = bestJ[s]; bestJ[s] = bestJ[s - 1u]; bestJ[s - 1u] = tj;
        }
      }
    }
  }

  for (var s = 0u; s < K; s += 1u) {
    let base = index * K + s;
    let found = sourceLive && bestD[s] < FAR;
    if (found) {
      let d = sqrt(bestD[s]);
      let alpha = pow(max(1.0 - d / radius, 0.0), max(params.falloff, 0.0));
      out_position[base] = origin;
      out_tip[base] = in_position[bestJ[s]];
      out_tint[base] = vec4f(1.0, 1.0, 1.0, alpha);
      out_neighbor[base] = bestJ[s];
    } else {
      /* §V788: the absent link is a zero-length beam — position == tip, zero area. */
      out_position[base] = origin;
      out_tip[base] = origin;
      out_tint[base] = vec4f(0.0);
      /* T1071: the absent link addresses ITSELF. The scan never selects j == index, so
         neighbor == index is an EXACT, float-free presence test for a consumer — and it is
         in range by construction, which a sentinel like 0xffffffff would not be. */
      out_neighbor[base] = index;
    }
  }
}`;
}

/**
 * Range (T983) — keep points where one attribute falls inside [from, to]; park the rest.
 *
 * PARK, NOT COMPACT, and the choice is documented because the compaction machinery
 * exists (src/points/lifecycle.ts) and was declined: compaction MOVES SLOTS, which
 * destroys a grid topology claim (the lattice is slot order) and forces a live-count
 * every consumer must honour. Parking keeps every slot where it is — the same idiom
 * `pointsFromTexture`'s threshold and DepthPoints' carve already use — so topology,
 * capacity and every carried attribute pass through untouched and the filter costs one
 * pass. A parked point sits at z = -1e6: out of every camera, out of every proximity
 * radius, zero pixels.
 *
 * THE BOUNDARY BELONGS TO INSIDE (>= from, <= to). Keep-outside drops it. That makes
 * two instances of this node with the same range an EXACT PARTITION — §T983's design
 * property, the reason §T979's backdrop wall can be "everything outside the subject's
 * slab" with no point drawn twice and none lost.
 *
 * On a counted set the dead tail is parked too, and the output deliberately does NOT
 * republish the count: count means "the first N slots are the live ones, contiguous",
 * and a range filter's survivors are not contiguous — republishing it would be a lie a
 * consumer acts on.
 */
export function pointRangeWgsl(options: {
  /** WGSL type of the tested attribute's array element. */
  attributeType: string;
  /** Component accessor for vectors ("" for scalars, ".x" … ".w"). */
  component: string;
  /** The tested attribute IS position — no second input binding. */
  positionIsSource: boolean;
  counted: boolean;
}): EmittedWgsl {
  const scalar = options.attributeType === "u32" ? "u32" : "f32";
  const source = options.positionIsSource ? "in_position" : "in_attr";
  let binding = 2;
  const attrDeclaration = options.positionIsSource
    ? ""
    : `@group(0) @binding(${binding++}) var<storage, read> in_attr: array<${options.attributeType}>;\n`;
  const countDeclaration = options.counted
    ? `@group(0) @binding(${binding++}) var<storage, read> in_count: array<u32>;\n`
    : "";
  const liveExpression = options.counted ? "min(params.count, in_count[0])" : "params.count";
  const valueExpression =
    scalar === "u32" ? `f32(${source}[index]${options.component})` : `${source}[index]${options.component}`;
  /* "from" is a WGSL reserved keyword — the struct spells the range lo/hi. */
  return wgsl`struct RangeParams {
  count: u32,
  keepInside: u32,
  lo: f32,
  hi: f32,
};

@group(0) @binding(0) var<uniform> params: RangeParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
${attrDeclaration}${countDeclaration}@group(0) @binding(${binding}) var<storage, read_write> out_position: array<vec3f>;

/* The park spot every absent point in this codebase uses (pointsFromTexture, carve). */
const PARKED: vec3f = vec3f(0.0, 0.0, -1.0e6);

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  if (index >= ${liveExpression}) {
    out_position[index] = PARKED;
    return;
  }
  let value = ${valueExpression};
  /* Boundary is INSIDE on both modes: two instances over one range partition exactly. */
  let inside = value >= params.lo && value <= params.hi;
  let keep = inside == (params.keepInside == 1u);
  out_position[index] = select(PARKED, in_position[index], keep);
}`;
}

/**
 * Gather (T1071) — a REDUCTION OVER AN ADJACENCY, and it needs no scan machinery at all.
 *
 * ⚑ THE ARITHMETIC THAT MAKES THIS CHEAP. A link set is SOURCE-MAJOR at a FIXED stride —
 * `pointProximity` writes point `i`'s links to slots `i*K … i*K+K-1` and nothing else ever
 * lands there. So a point's neighbourhood is a CONTIGUOUS RUN AT A COMPUTED OFFSET, not a
 * run that has to be FOUND. §T983's segmented-reduction machinery (Hillis-Steele scan plus
 * serial blocks) exists for runs whose boundaries are data; here the boundary is
 * multiplication. One thread per point, K serial steps, no atomics, no scan, no scratch,
 * and no workgroup barrier — O(N·K) with K ≤ 8 against the O(N²) an in-kernel predicate
 * costs. Reaching for the scan would have been a heavier answer to an easier question.
 *
 * ⚑ THE ABSENT LINK IS GATED BY AN INTEGER COMPARE. Proximity parks a link it did not find
 * by pointing it at its own source (`neighbor == index`, §V788's zero-length collapse in
 * the address domain), so `slot == index` removes it from the reduction before any load of
 * its value: it contributes nothing AND costs nothing, which is the promise the fixed
 * capacity is only worth keeping if this honours. Testing the STRENGTH instead would have
 * been the plausible-wrong version (§V288) — a real link sitting exactly on the radius has
 * alpha 0 under any falloff, and would have been dropped from an unweighted mean.
 *
 * ⚑ §V887, AND IT IS FREE HERE. Every output slot is written by exactly one invocation and
 * every read is from an INPUT buffer — the source pointset's half as the edge names it, the
 * link set's as proximity wrote it. Nothing reads what this pass writes, so there is no
 * before/after to straddle and the answer cannot depend on the scheduler.
 *
 * THE EMPTY NEIGHBOURHOOD, decided rather than defaulted. `sum` and `degree` return ZERO,
 * because an empty sum IS zero and that is exact — an unaffiliated point lands on it bit
 * for bit. `mean`, `min` and `max` return THE POINT'S OWN VALUE, because the mean of no
 * numbers is not zero, it is undefined, and zero is the plausible-wrong answer that reads
 * as black. A point with no neighbours is its own neighbourhood.
 */
export function pointGatherWgsl(options: {
  /** WGSL element type of the gathered source attribute. Unused when reducing to degree. */
  attributeType: string;
  /** WGSL element type of the emitted aggregate. */
  outputType: string;
  reduce: "sum" | "mean" | "min" | "max" | "degree";
  /** Weight each link by its strength (proximity's tint alpha) rather than uniformly. */
  weighted: boolean;
  /** Links per point — the link set's fixed source-major stride. */
  k: number;
}): EmittedWgsl {
  const { attributeType, outputType, reduce, weighted, k } = options;
  const degree = reduce === "degree";
  /* The strength buffer is bound when a weight is actually read. Degree IS the weight sum,
     so it needs it too; an unweighted min/max never touches it (§V309). */
  const needsStrength = weighted || degree;
  const needsAttribute = !degree;
  let binding = 1;
  const neighborDeclaration = `@group(0) @binding(${binding++}) var<storage, read> in_link_neighbor: array<u32>;\n`;
  const strengthDeclaration = needsStrength
    ? `@group(0) @binding(${binding++}) var<storage, read> in_link_strength: array<vec4f>;\n`
    : "";
  const attributeDeclaration = needsAttribute
    ? `@group(0) @binding(${binding++}) var<storage, read> in_attr: array<${attributeType}>;\n`
    : "";

  const zero = ((): string => {
    switch (outputType) {
      case "f32":
        return "0.0";
      case "u32":
        return "0u";
      case "vec4u":
        return "vec4u(0u)";
      default:
        return wgsl`${outputType}(0.0)`;
    }
  })();

  const weightExpression = weighted ? "in_link_strength[link].a" : "1.0";
  /* The accumulate/finish pair is the ONLY thing the reduction changes. Written as two
     strings rather than five shader bodies so a new reduction cannot quietly diverge in
     how it gates the absent link or how it reads a slot. */
  const accumulate = ((): string => {
    switch (reduce) {
      case "degree":
        return "";
      case "sum":
      case "mean":
        return wgsl`    acc = acc + in_attr[slot] * w;`;
      case "min":
        return wgsl`    acc = select(min(acc, in_attr[slot]), in_attr[slot], found == 1u);`;
      case "max":
        return wgsl`    acc = select(max(acc, in_attr[slot]), in_attr[slot], found == 1u);`;
    }
  })();
  const finish = ((): string => {
    switch (reduce) {
      case "degree":
        return "  let result = wsum;";
      case "sum":
        return "  let result = acc;";
      case "mean":
        /* Divided by the WEIGHT, not by the count: a weighted mean whose normaliser is the
           count is not a mean of anything. An all-zero weight sum falls back with the empty
           case, because dividing by it would be a NaN wearing a value's clothes. */
        return wgsl`  let result = select(in_attr[index], acc / wsum, found > 0u && wsum > 0.0);`;
      case "min":
      case "max":
        return wgsl`  let result = select(in_attr[index], acc, found > 0u);`;
    }
  })();

  return wgsl`struct GatherParams {
  count: u32,
};

@group(0) @binding(0) var<uniform> params: GatherParams;
${neighborDeclaration}${strengthDeclaration}${attributeDeclaration}@group(0) @binding(${binding}) var<storage, read_write> out_value: array<${outputType}>;

/* Links per point. COMPILE-TIME, because it is the link set's stride and a different K is
   a different program (§V62b) — reading it from a uniform would let a plan whose link set
   was rebuilt at another K read the wrong run entirely. */
const K: u32 = ${k}u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  /* SOURCE-MAJOR, FIXED STRIDE: this point's links are the run at index * K. No search. */
  let base = index * K;

  var acc = ${zero};
  var wsum = 0.0;
  var found = 0u;
  for (var s = 0u; s < K; s += 1u) {
    let link = base + s;
    let slot = in_link_neighbor[link];
    /* The absent link addresses its own source (T1071). Gated here, before any load. */
    if (slot == index) {
      continue;
    }
    let w = ${weightExpression};
    wsum = wsum + w;
    found = found + 1u;
${accumulate}
  }
${finish}
  out_value[index] = result;
}`;
}

/**
 * Transform (T1205) — MOVE, TURN AND SCALE A CLOUD AS A WHOLE, about a pivot.
 *
 * ⚑ WHY THIS IS A POINT NODE AND NOT A PARAMETER ON `geometry`. The owner reached for
 * `geometry.scale` and got points that "freak out", which is the honest reading of what
 * that parameter is: `scale` there is PER-POINT SIZE — the billboard's, the instance
 * primitive's — and `scene.ts` says so in its own refusal ("a surface spans its grid and
 * has no per-point size"). The same file also refuses a per-object ORIENTATION by name
 * ("a geometry has no per-object orientation to apply it to"), which is a stated design
 * position, not a hole. So the transform belongs where TD puts it: on THE DATA, as a
 * Transform SOP does, where it composes with the rest of the point chain and serves every
 * downstream consumer — export, laser, proximity, topology, a second render — instead of
 * only the one renderer that would have owned an object matrix.
 *
 * ⚑⚑ THE PIVOT IS THE WHOLE FEATURE. Scaling about the ORIGIN moves the cloud off screen
 * as it grows; scaling about its own CENTROID grows it IN PLACE, and "make it take up more
 * of the screen" is the second one. The centroid is therefore the DEFAULT, with origin and
 * an explicit point available for the cases where the frame, not the cloud, is the anchor.
 *
 * ⚑ THE CENTROID IS A REAL REDUCTION, COMPUTED THIS FRAME, NOT ESTIMATED. Two extra
 * dispatches ahead of the apply pass: a workgroup tree reduction into one partial per
 * block, then a single-thread serial sum over the partials. Both are the shape
 * `lifecycle.ts`'s scan already uses and for the same reason — fixed order, no atomics,
 * so the answer is bit-identical run to run and device to device (§V74/§V147). A RUNNING
 * ESTIMATE was the alternative and it is refused: its lag is a cloud that visibly SLIDES
 * while the true centroid moves, which is exactly the artefact this node exists to remove.
 * The full reduction is cheap enough that the trade never had to be made — see the node's
 * docblock for the measured number.
 *
 * ⚑ PARKED POINTS ARE EXCLUDED FROM THE CENTROID AND PASS THROUGH UNTRANSFORMED. A parked
 * point sits at exactly `PARKED` (z = -1e6), which is 40 000 scene units from anything
 * real: average one of them into a 25k-point centroid and the cloud jumps. And a parked
 * point that got TRANSFORMED would be dragged back toward the camera by a large enough
 * translate — a point `pointRange` deleted, reappearing. Both are the same test, and it is
 * an EXACT comparison against the whole sentinel vector rather than a threshold on z:
 * -1e6 is exactly representable in f32 and is written as a literal, so it reads back bit
 * for bit, while a threshold would silently swallow a legitimately distant point.
 */
export const TRANSFORM_REDUCE_WORKGROUP_SIZE = 256;

/** The park spot, shared by every pass below. Matches `pointRangeWgsl` and points-from-texture. */
const PARKED_WGSL = "const PARKED: vec3f = vec3f(0.0, 0.0, -1.0e6);";

/**
 * Pass 1 of the centroid: one `vec4f(sum.xyz, liveCount)` per workgroup.
 *
 * The tree halves in shared memory with the barrier OUTSIDE the branch, so control flow at
 * every barrier is uniform. Summation order is fixed by the tree, so two runs agree to the
 * bit — the property a "roughly the middle" reduction would have thrown away for nothing.
 */
export function pointCentroidPartialsWgsl(options: { counted: boolean }): EmittedWgsl {
  const size = TRANSFORM_REDUCE_WORKGROUP_SIZE;
  const countDeclaration = options.counted
    ? "@group(0) @binding(3) var<storage, read> in_count: array<u32>;\n"
    : "";
  const liveExpression = options.counted ? "min(params.count, in_count[0])" : "params.count";
  return wgsl`struct CentroidParams {
  count: u32,
};

@group(0) @binding(0) var<uniform> params: CentroidParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read_write> partials: array<vec4f>;
${countDeclaration}
${PARKED_WGSL}

var<workgroup> sums: array<vec4f, ${size}>;

@compute @workgroup_size(${size})
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let index = gid.x;
  var contribution = vec4f(0.0);
  if (index < ${liveExpression}) {
    let p = in_position[index];
    /* A parked point is not a member of the cloud; averaging it in moves the centroid
       40 000 units. The w lane counts the members, so the divisor agrees by construction. */
    if (!all(p == PARKED)) {
      contribution = vec4f(p, 1.0);
    }
  }
  sums[lid.x] = contribution;
  workgroupBarrier();

  var stride = ${size / 2}u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (lid.x < stride) {
      sums[lid.x] = sums[lid.x] + sums[lid.x + stride];
    }
    workgroupBarrier();
    stride = stride >> 1u;
  }

  if (lid.x == 0u) {
    partials[wid.x] = sums[0];
  }
}`;
}

/**
 * Pass 2 of the centroid: one thread, serial over the block partials, into `centroid[0]`.
 *
 * `xyz` is the mean, `w` is the member count kept alongside it — an EMPTY set (every point
 * parked, or a zero-length input) yields the ORIGIN and a count of zero, which makes the
 * transform a scale about the origin rather than a NaN. The mean of no points is undefined
 * and the origin is the one answer that renders as "nothing moved" instead of as nothing.
 */
export function pointCentroidFinalizeWgsl(): EmittedWgsl {
  return wgsl`struct FinalizeParams {
  blocks: u32,
};

@group(0) @binding(0) var<uniform> params: FinalizeParams;
@group(0) @binding(1) var<storage, read> partials: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> centroid: array<vec4f>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u) {
    return;
  }
  /* Serial, one thread, fixed order — the same determinism argument the block scan in
     lifecycle.ts makes, and the block count is small enough that it costs nothing. */
  var acc = vec4f(0.0);
  var block = 0u;
  while (block < params.blocks) {
    acc = acc + partials[block];
    block = block + 1u;
  }
  if (acc.w > 0.0) {
    centroid[0] = vec4f(acc.xyz / acc.w, acc.w);
  } else {
    centroid[0] = vec4f(0.0);
  }
}`;
}

/**
 * Pass 3: apply. `p' = pivot + R · (S ⊙ (p − pivot)) + T`.
 *
 * ⚑ ROTATION IS EULER XYZ IN A DECLARED ORDER, AND THAT IS NOT THE MISTAKE `scene.ts:504`
 * NAMES. That note refuses Euler angles for a per-point ORIENTATION ATTRIBUTE, because
 * "adding angles is not composing rotations" and a per-point frame has to interpolate. Two
 * of this node in a chain do not add angles — each builds its own matrix and the matrices
 * MULTIPLY, which is composition. What Euler still costs here is gimbal lock and the
 * absence of a slerp between two authored orientations; against that, a quaternion is a
 * control no one can author by hand in an inspector, and every DCC's Transform SOP made
 * the same call. The order is X then Y then Z (`R = Rz·Ry·Rx`) and it is written down
 * because an undeclared order is the thing that makes two tools disagree.
 *
 * Scale is a vec3f rather than a scalar because it costs the same instruction and a
 * flattened cloud is a real look; the default is (1,1,1) so it is inert until set.
 */
export function pointTransformWgsl(options: {
  /** 0 = centroid (the reduction runs), 1 = origin, 2 = the authored point. */
  pivot: "centroid" | "origin" | "point";
}): EmittedWgsl {
  const centroidDeclaration =
    options.pivot === "centroid"
      ? "@group(0) @binding(3) var<storage, read> centroid: array<vec4f>;\n"
      : "";
  const pivotExpression =
    options.pivot === "centroid"
      ? "centroid[0].xyz"
      : options.pivot === "point"
      ? "params.pivotPoint"
      : "vec3f(0.0)";
  return wgsl`struct TransformParams {
  translate: vec3f,
  scale: vec3f,
  rotate: vec3f,
  pivotPoint: vec3f,
  count: u32,
};

@group(0) @binding(0) var<uniform> params: TransformParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read_write> out_position: array<vec3f>;
${centroidDeclaration}
${PARKED_WGSL}

/* R = Rz(z) * Ry(y) * Rx(x): X first, then Y, then Z. Columns, as WGSL wants them. */
fn rotation(r: vec3f) -> mat3x3f {
  let c = cos(r);
  let s = sin(r);
  return mat3x3f(
    vec3f(c.y * c.z, c.y * s.z, -s.y),
    vec3f(s.x * s.y * c.z - c.x * s.z, s.x * s.y * s.z + c.x * c.z, s.x * c.y),
    vec3f(c.x * s.y * c.z + s.x * s.z, c.x * s.y * s.z - s.x * c.z, c.x * c.y),
  );
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let p = in_position[index];
  /* A parked point stays parked. Transforming it would drag a DELETED point back into
     shot under any large enough translate — see the docblock. */
  if (all(p == PARKED)) {
    out_position[index] = p;
    return;
  }
  let pivot = ${pivotExpression};
  let local = (p - pivot) * params.scale;
  out_position[index] = pivot + rotation(params.rotate) * local + params.translate;
}`;
}
