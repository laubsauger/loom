/**
 * Positions FROM a texture (T743).
 *
 * The catalogue could sample a texture at a point's position (`textureToAttribute`) but
 * had no way to let a texture DECIDE a position. Two addressings, because the two things
 * that want this address it differently:
 *
 *   GRID   the texel's COORDINATE is the position and its value raises z — a depth map
 *          becomes a point cloud, one point per grid cell.
 *   VALUE  the texel's CONTENTS are the position, read by INDEX — texel i is point i.
 *          Pose keypoints: the model says where the wrist is, not the texture's layout.
 *
 * §V427 recorded `textureLoad`'s nearest, unfiltered read as a LIMITATION (it is why the
 * reaction-diffusion displacement was abandoned). For 17 discrete keypoint texels it is
 * the correct read and filtering would be the bug: a blend between the left wrist and the
 * right ear is not a joint.
 *
 * Confidence below the threshold PARKS the point far behind the camera rather than
 * placing it at the origin — E34's idiom (§V588). The origin is a real location and a
 * cluster of "unknown" joints sitting there reads as a wad of geometry; parked points are
 * simply not in the shot. It is also what makes the no-model identity fall out for free:
 * an all-zero keypoint texture parks every point, which is exactly what "no person in
 * frame" does, so the unavailable-model state needs no special case anywhere.
 */
export const POINTS_FROM_TEXTURE_WGSL = `struct TexturePointsParams {
  count: u32,
  mode: u32,          // 0 = grid (coordinate is position), 1 = value (texel is position)
  cols: u32,
  rows: u32,
  sizeX: f32,
  sizeY: f32,
  depth: f32,
  threshold: f32,
};

@group(0) @binding(0) var<uniform> params: TexturePointsParams;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> out_position: array<vec3f>;

const PARKED: vec3f = vec3f(0.0, 0.0, -1.0e6);

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let cols = max(params.cols, 1u);
  let rows = max(params.rows, 1u);
  let col = index % cols;
  let row = index / cols;
  let dims = vec2i(textureDimensions(sourceTexture, 0));

  if (params.mode == 1u) {
    // VALUE: texel i holds point i's position. Read by INDEX, never by location — the
    // whole point is that the model decides where the joint is.
    let at = clamp(vec2i(i32(col), i32(row)), vec2i(0), dims - vec2i(1));
    let v = textureLoad(sourceTexture, at, 0);
    if (v.b < params.threshold) {
      out_position[index] = PARKED;
      return;
    }
    // r,g are normalised across the frame; y flips because texture v runs down.
    out_position[index] = vec3f((v.r - 0.5) * params.sizeX, (0.5 - v.g) * params.sizeY, 0.0);
    return;
  }

  // GRID: the coordinate is the position, the value is the height.
  let u = (f32(col) + 0.5) / f32(cols);
  let w = (f32(row) + 0.5) / f32(rows);
  let at = clamp(vec2i(vec2f(u, w) * vec2f(dims)), vec2i(0), dims - vec2i(1));
  let s = textureLoad(sourceTexture, at, 0);
  if (s.a < params.threshold) {
    out_position[index] = PARKED;
    return;
  }
  /* T959: a SINGLE-CHANNEL map (the depth node's r32float) carries its value in .r with
     g and b hard zero — luma-weighting it would read at 0.21x. A colour map keeps the
     luma read; grey maps agree under both. */
  let height = select(dot(s.rgb, vec3f(0.2126, 0.7152, 0.0722)), s.r, s.g + s.b < 1e-6);
  out_position[index] = vec3f(
    (u - 0.5) * params.sizeX,
    (0.5 - w) * params.sizeY,
    (height - 0.5) * params.depth,
  );
}`;
