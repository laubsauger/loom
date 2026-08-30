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
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
${declarations}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  switch (u32(params.index + 0.5)) {
${cases}
    default: { return ${sample(count - 1)}; }
  }
}`;
}
