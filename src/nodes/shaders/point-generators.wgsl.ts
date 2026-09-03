/**
 * The generator kernel (T298): ONE module for every preset, per the Composite/Over
 * "both, one implementation" convention — grid, line, circle, sphere, tube, torus and
 * box are the same dispatch with a different `shape` uniform, so switching shapes never
 * recompiles (§V5) and a fix lands in all seven at once.
 *
 * Positions are analytic functions of the point INDEX — deterministic by construction
 * (§V45), no state, no randomness. The sphere is a Fibonacci spiral (uniform area
 * coverage, no pole clustering); grid/tube/torus use a cols×rows unwrap of the index;
 * the box (T1057) is the SURFACE of a sizeX×sizeY×sizeZ box, its six faces sharing the
 * index range BY AREA and each filled by the 2D analogue of the sphere's spiral.
 * Everything lands centred on the origin in the units of `size`/`radius`, ready for
 * §V198's published transform order downstream.
 */
export const POINT_GENERATOR_WGSL = `struct GeneratorParams {
  count: u32,
  shape: u32,          // 0=line 1=circle 2=grid 3=sphere 4=tube 5=torus 6=box
  cols: u32,
  rows: u32,
  sizeX: f32,
  sizeY: f32,
  sizeZ: f32,
  radius: f32,
  radius2: f32,        // torus minor radius / tube radius
};

@group(0) @binding(0) var<uniform> params: GeneratorParams;
@group(0) @binding(1) var<storage, read_write> out_position: array<vec3f>;

const TAU: f32 = 6.28318530717958647692;
const GOLDEN_ANGLE: f32 = 2.39996322972865332223; // pi * (3 - sqrt(5))

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let n = f32(max(params.count, 1u));
  let i = f32(index);
  let t = i / max(n - 1.0, 1.0);

  let cols = max(params.cols, 1u);
  let rows = max(params.rows, 1u);
  let u = f32(index % cols) / max(f32(cols) - 1.0, 1.0);
  let v = f32((index / cols) % rows) / max(f32(rows) - 1.0, 1.0);
  /* Wrapped axes parametrize EXCLUSIVELY — [0, 1), so column cols-1 is one step short
     of TAU and the wrap topology (T302) closes the seam without a duplicated ring. */
  let uw = f32(index % cols) / f32(cols);
  let vw = f32((index / cols) % rows) / f32(rows);

  var position = vec3f(0.0);
  switch (params.shape) {
    case 0u: { // line, along x
      position = vec3f((t - 0.5) * params.sizeX, 0.0, 0.0);
    }
    case 1u: { // circle, xy plane
      let angle = t * TAU;
      position = vec3f(cos(angle), sin(angle), 0.0) * params.radius;
    }
    case 2u: { // grid, xy plane
      position = vec3f((u - 0.5) * params.sizeX, (v - 0.5) * params.sizeY, 0.0);
    }
    case 3u: { // sphere — Fibonacci spiral, uniform coverage
      let y = 1.0 - (i + 0.5) * 2.0 / n;
      let ring = sqrt(max(0.0, 1.0 - y * y));
      let angle = GOLDEN_ANGLE * i;
      position = vec3f(cos(angle) * ring, y, sin(angle) * ring) * params.radius;
    }
    case 4u: { // tube along z: u around (wrapped), v along (open)
      let angle = uw * TAU;
      position = vec3f(cos(angle) * params.radius, sin(angle) * params.radius, (v - 0.5) * params.sizeZ);
    }
    case 5u: { // torus — u around the major ring, v around the minor, both wrapped
      let major = uw * TAU;
      let minor = vw * TAU;
      let ring = params.radius + cos(minor) * params.radius2;
      position = vec3f(cos(major) * ring, sin(minor) * params.radius2, sin(major) * ring);
    }
    default: { // 6: box — the SURFACE of a sizeX x sizeY x sizeZ box, six faces
      let half = vec3f(params.sizeX, params.sizeY, params.sizeZ) * 0.5;
      let areaX = params.sizeY * params.sizeZ; // the two faces whose normal is x
      let areaY = params.sizeZ * params.sizeX;
      let areaZ = params.sizeX * params.sizeY;
      let total = 2.0 * (areaX + areaY + areaZ);
      /* Faces split the index range BY AREA, not evenly: point i claims the slice
         [i, i+1)/n of the total surface, so a 2 x 2 x 0.1 box puts ~20x as many points
         on a broad face as on a sliver instead of the same number on both. */
      let area = (i + 0.5) / n * total;
      /* The 2D analogue of the sphere's Fibonacci spiral: the R2 (Roberts) additive
         recurrence on the PLASTIC constant, carried in u32 fixed point so the wrap is
         exact — fract(a * f32(i)) bands into a handful of values past ~10^5 points,
         where a u32 multiply keeps all 32 fractional bits at any count we allow. The
         sequence is CONTIGUOUS across the faces (index, not a per-face counter): a
         contiguous block of an additive recurrence is still equidistributed, and one
         counter is one thing to get wrong. Centring in fixed point rather than
         subtracting 0.5 afterwards keeps the low end exact, and the +1 means the u32
         product is never 0 for any count we allow: a coordinate can therefore never
         reach -half, no point lands on a box EDGE, and no seam carries a duplicate. */
      let j = index + 1u;
      let u = (f32(3242174889u * j) - 2147483648.0) * 2.3283064365386963e-10;
      let v = (f32(2447445413u * j) - 2147483648.0) * 2.3283064365386963e-10;
      if (area < areaX) {
        position = vec3f(half.x, u * params.sizeY, v * params.sizeZ);
      } else if (area < 2.0 * areaX) {
        position = vec3f(-half.x, u * params.sizeY, v * params.sizeZ);
      } else if (area < 2.0 * areaX + areaY) {
        position = vec3f(u * params.sizeX, half.y, v * params.sizeZ);
      } else if (area < 2.0 * (areaX + areaY)) {
        position = vec3f(u * params.sizeX, -half.y, v * params.sizeZ);
      } else if (area < 2.0 * (areaX + areaY) + areaZ) {
        position = vec3f(u * params.sizeX, v * params.sizeY, half.z);
      } else {
        position = vec3f(u * params.sizeX, v * params.sizeY, -half.z);
      }
    }
  }
  out_position[index] = position;
}`;
