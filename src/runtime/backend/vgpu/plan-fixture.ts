import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { PassDescriptor, ResourceDescriptor, UniformValues } from "../plan.ts";
import { SHARED_UNIFORMS_WGSL } from "../shared-uniforms.ts";

/**
 * A small but complete plan: a generator pass, a feedback pair with a swap, and a
 * composite into the output target. Exercises every descriptor kind the backend handles.
 *
 * Shared by the backend tests; kept out of a `.test.ts` file so the driver tests can reuse it.
 */

export const GENERATE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params { amount: f32, tint: f32 };
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv * params.amount, params.tint + frameU.time, 1.0);
}`;

/** Same bindings, different body — an edit that must force a rebuild (§V5 control case). */
export const GENERATE_WGSL_EDITED = `${SHARED_UNIFORMS_WGSL}
struct Params { amount: f32, tint: f32 };
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv.yx * params.amount, params.tint * frameU.deltaTime, 1.0);
}`;

export const FEEDBACK_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var historyTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scene = textureSample(sceneTexture, inputSampler, uv);
  let history = textureSample(historyTexture, inputSampler, uv);
  return mix(scene, history, 0.5);
}`;

export const COMPOSITE_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var historyTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(historyTexture, inputSampler, uv);
}`;

export interface FixtureOptions {
  readonly size?: readonly [number, number];
  readonly uniforms?: UniformValues;
  /** Swapped in to prove that a *structural* change does rebuild (§V5 control case). */
  readonly generateShader?: string;
}

export function fixturePlan(options: FixtureOptions = {}): LogicalExecutionPlan {
  const size = options.size ?? ([64, 64] as const);

  const resources: ResourceDescriptor[] = [
    { kind: "target", id: "scene", size, format: "rgba16float" },
    { kind: "target", id: "output", size, format: "rgba8unorm" },
    { kind: "pingPong", id: "history", size, format: "rgba16float" },
    { kind: "sampler", id: "linear", filter: "linear" },
  ];

  const passes: PassDescriptor[] = [
    {
      kind: "effect",
      id: "generate",
      nodeId: "node-generate",
      shader: options.generateShader ?? GENERATE_WGSL,
      target: "scene",
      sharedBinding: "frameU",
      uniformBinding: "params",
      uniforms: options.uniforms ?? { amount: 1, tint: 0 },
    },
    {
      kind: "effect",
      id: "feedback",
      nodeId: "node-feedback",
      shader: FEEDBACK_WGSL,
      target: "history",
      samplers: [{ binding: "inputSampler", resourceId: "linear" }],
      textures: [
        { binding: "sceneTexture", resourceId: "scene" },
        { binding: "historyTexture", resourceId: "history" },
      ],
    },
    {
      kind: "effect",
      id: "composite",
      nodeId: "node-output",
      shader: COMPOSITE_WGSL,
      target: "output",
      samplers: [{ binding: "inputSampler", resourceId: "linear" }],
      textures: [{ binding: "historyTexture", resourceId: "history" }],
    },
    // §V22: the pair swaps only after every current-frame consumer has been encoded.
    { kind: "swap", id: "history-swap", resourceId: "history" },
  ];

  return { passes, resources, diagnostics: [] };
}
