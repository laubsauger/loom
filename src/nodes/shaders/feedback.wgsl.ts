/**
 * Fragment shader for the Feedback node (T152, §V22).
 *
 * One write pass into the ping-pong pair's WRITE half. The node's OUTPUT is the pair
 * itself: downstream consumers bind the READ half (last frame's contents) through the
 * backend's per-frame rebinding, so this shader never has to touch the history texture —
 * the delay comes from the pair, not from the shader.
 *
 * `persistence` fades the stored image toward `clearColor` on every trip through the
 * loop: 1 stores the input untouched (a pure one-frame delay), lower values make trails
 * die out inside the loop without needing an extra Level node.
 *
 * `hold` is the Reset TOGGLE (T216). TD's Feedback TOP pairs a momentary Reset pulse
 * with a held Reset, and they answer different questions: the pulse clears the pair ONCE
 * (through `runtime.resetFeedback`, which owns the GPU-side history), the toggle keeps
 * writing `clearColor` for as long as it is on. Holding it is how you park a loop while
 * you rewire what feeds it, and it is why the toggle cannot just be "pulse repeatedly":
 * the pulse is an event and the hold is a state.
 *
 * COLOUR (§V56): operates on linear working-space values, like the rest of the catalogue.
 */
export const FEEDBACK_FRAGMENT_WGSL = `struct Params {
  clearColor: vec4f,
  persistence: f32,
  hold: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (params.hold > 0.5) {
    return params.clearColor;
  }
  let source = textureSample(sourceTexture, inputSampler, uv);
  return mix(params.clearColor, source, params.persistence);
}`;
