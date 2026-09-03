/**
 * Switch — one of N inputs, chosen by a number (T235). TD's Switch TOP.
 *
 * The index arrives ALREADY FLOORED AND WRAPPED, as a uniform. That is the decision this
 * shader is shaped by: selecting the input by recompiling — the way Composite selects its
 * blend (§V141) — would be right for a value that changes approximately never, and this is
 * the opposite kind of parameter. A Switch exists to be DRIVEN: by an LFO, a timer, a
 * beat, an expression. Rebuilding a pipeline every time the index moved would make the one
 * thing the node is for the most expensive thing it can do.
 *
 * So the branch is per pixel, and it is uniform across the draw (every fragment reads the
 * same uniform), which is the cheap case for a GPU. Only one `textureSampleLevel` executes.
 * Sampling all N and mixing would cost N samples per pixel to answer a question the CPU
 * already knows the answer to.
 *
 * The LAST input is the `default` branch rather than a case of its own: the CPU guarantees
 * the index is in range, so `default` is not an error path, and WGSL requires one anyway.
 *
 * T1054 put the selection in `sampleInput` so CROSSFADE can call it twice. The `blend <= 0`
 * early return is what keeps the promise made above: with the toggle off the CPU sends 0 and
 * exactly one `textureSampleLevel` runs, so the argument against "sample all N and mix"
 * still holds — this samples at most TWO, and only while a fraction is actually being
 * crossfaded. `next` arrives as a uniform rather than being derived here as
 * `(index + 1) % count`, keeping the CPU the single author of what wrapping means (T235).
 */
export function switchFragmentWgsl(inputs: number): string {
  const count = Math.max(1, Math.floor(inputs));
  const declarations = Array.from(
    { length: count },
    (_, index) => `@group(0) @binding(${index + 2}) var inputTexture${index}: texture_2d<f32>;`,
  ).join("\n");
  const sample = (index: number): string =>
    `textureSampleLevel(inputTexture${index}, inputSampler, uv, 0.0)`;
  const cases = Array.from(
    { length: count - 1 },
    (_, index) => `    case ${index}u: { return ${sample(index)}; }`,
  ).join("\n");

  return `struct Params {
  index: f32,
  next: f32,
  blend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
${declarations}

fn sampleInput(which: u32, uv: vec2f) -> vec4f {
  switch (which) {
${cases}
    default: { return ${sample(count - 1)}; }
  }
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = sampleInput(u32(params.index + 0.5), uv);
  // Crossfade off, or a fractional index that landed exactly on an input: ONE sample, and
  // bit-for-bit the picture this node produced before T1054 existed. The branch is uniform
  // across the draw (every fragment reads the same uniform), so it is the cheap kind.
  if (params.blend <= 0.0) {
    return base;
  }
  // Linear, on all four channels, straight alpha — TD's Switch TOP. mix is convex, so it
  // cannot push alpha past whichever input was already highest; see the node's docblock for
  // why a clamp here would be a behaviour change rather than a safety net (V833/V838).
  return mix(base, sampleInput(u32(params.next + 0.5), uv), params.blend);
}`;
}
