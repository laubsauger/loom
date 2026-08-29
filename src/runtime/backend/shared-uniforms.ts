import type { FrameInputs } from "../../domain/types/backend.ts";

/**
 * The per-frame uniform block every pass may bind (§T16).
 *
 * Every value here originates in `FrameEvaluationInput`, which the transport supplies.
 * Nothing in the runtime reads `Date.now`, `performance.now` or rAF to fill it (§V44, §V49).
 */
export interface SharedUniformValues extends Record<string, unknown> {
  time: number;
  deltaTime: number;
  frameIndex: number;
  randomSeed: number;
  resolution: readonly [number, number];
  /** x, y, buttons, unused. Packed as vec4f so the block stays 16-byte aligned. */
  pointer: readonly [number, number, number, number];
}

/** WGSL declaration matching {@link SharedUniformValues}. Node shaders include this verbatim. */
export const SHARED_UNIFORMS_WGSL = `struct SharedFrame {
  time: f32,
  deltaTime: f32,
  frameIndex: f32,
  randomSeed: f32,
  resolution: vec2f,
  pointer: vec4f,
};`;

export function initialSharedUniforms(): SharedUniformValues {
  return {
    time: 0,
    deltaTime: 0,
    frameIndex: 0,
    randomSeed: 0,
    resolution: [1, 1],
    pointer: [0, 0, 0, 0],
  };
}

export function sharedUniformsFromFrame(inputs: FrameInputs): SharedUniformValues {
  const { frame, pointer, resolution } = inputs;
  return {
    time: frame.timeSeconds,
    deltaTime: frame.deltaSeconds,
    frameIndex: frame.frameIndex,
    randomSeed: frame.randomSeed,
    resolution: [resolution[0], resolution[1]],
    pointer: [pointer.x, pointer.y, pointer.buttons, 0],
  };
}
