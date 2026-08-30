import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { scratchResourceId } from "../../compiler/resources.ts";

/**
 * Analyze (T236, §V144): texture → scalar. The node that closes the image→parameter
 * loop — drive a light's intensity from the frame's own brightness.
 *
 * GPU side: one tiny dispatch samples a fixed 64×64 grid of the input (an honest
 * approximation, stated in the description; full-resolution reduction is a later
 * upgrade with the same contract) and writes `[average, minimum, maximum]` of the
 * selected channel to a 16-byte scratch buffer.
 *
 * CPU side: `createAnalyzeChannels` (src/runtime/execution) reads that buffer BETWEEN
 * frames through the sanctioned async path (§V48) and publishes the node's NAME as a
 * driven channel. §V144's latency semantics, decided deliberately: the value visible
 * while frame N renders is the reduction of the LAST COMPLETED frame — one frame late,
 * never a stall. A hitch would be wrong; a frame of latency is not.
 */

export const ANALYZE_RESULT_KEY = "result";

export const ANALYZE_WGSL = `struct AnalyzeParams {
  channel: f32,
};

@group(0) @binding(0) var<uniform> params: AnalyzeParams;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<vec4f>;

@compute @workgroup_size(1)
fn main() {
  let dims = vec2i(textureDimensions(sourceTexture, 0));
  var sum = 0.0;
  var lo = 3.4e38;
  var hi = -3.4e38;
  let grid = 64;
  for (var y = 0; y < grid; y = y + 1) {
    for (var x = 0; x < grid; x = x + 1) {
      let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(grid);
      let texel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
      let c = textureLoad(sourceTexture, texel, 0);
      var v = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
      let ch = i32(params.channel);
      if (ch == 0) { v = c.r; }
      else if (ch == 1) { v = c.g; }
      else if (ch == 2) { v = c.b; }
      else if (ch == 3) { v = c.a; }
      sum = sum + v;
      lo = min(lo, v);
      hi = max(hi, v);
    }
  }
  result[0] = vec4f(sum / f32(grid * grid), lo, hi, 1.0);
}`;

const CHANNEL_INDEX: Record<string, number> = { r: 0, g: 1, b: 2, a: 3, luminance: 4 };

export const analyzeNode: NodeDefinition = {
  type: "analyze",
  version: 1,
  title: "Analyze",
  category: "value",
  description:
    "Reduces its input to a number — average, minimum or maximum of a channel, sampled on a 64×64 grid. Its name is its channel; the value is one frame late by design.",
  tags: ["value", "measure", "reactive"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [],
  // An active SINK (§V25): nothing downstream consumes a texture from this node, but it
  // has a real side effect — it publishes a channel — so it must keep its upstream alive.
  sink: true,
  // T438: the channel is MEASURED (GPU readback), not a value-graph hook and not a
  // port — this is how the plot gate knows without a type list (§V316).
  measuredChannel: true,
  parameters: {
    channel: {
      type: "enum",
      label: "Channel",
      default: "luminance",
      options: [
        { value: "luminance", label: "Luminance" },
        { value: "r", label: "Red" },
        { value: "g", label: "Green" },
        { value: "b", label: "Blue" },
        { value: "a", label: "Alpha" },
      ],
    },
    operation: {
      type: "enum",
      label: "Operation",
      default: "average",
      options: [
        { value: "average", label: "Average" },
        { value: "minimum", label: "Minimum" },
        { value: "maximum", label: "Maximum" },
      ],
      description: "Which reduction the channel publishes. All three are computed; this picks one, with no recompile.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const source = inputs["input"];
    if (source === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, "input")] };
    }

    const channel = typeof parameters["channel"] === "string" ? parameters["channel"] : "luminance";
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:analyze`,
      shader: ANALYZE_WGSL,
      entryPoint: "main",
      workgroups: [1, 1, 1],
      buffers: [{ binding: "result", resourceId: scratchResourceId(nodeId, ANALYZE_RESULT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { channel: CHANNEL_INDEX[channel] ?? 4 },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [{ key: ANALYZE_RESULT_KEY, kind: "buffer", stride: 16, capacity: 1 }],
    };
  },
};
