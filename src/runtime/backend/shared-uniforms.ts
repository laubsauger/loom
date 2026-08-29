import { wallDeltaSecondsOf, wallSecondsOf } from "../../domain/types/frame.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";

/**
 * The per-frame uniform block every pass may bind (§T16).
 *
 * Every value here originates in `FrameEvaluationInput`, which the transport supplies.
 * Nothing in the runtime reads `Date.now`, `performance.now` or rAF to fill it (§V44, §V49).
 */
export interface SharedUniformValues extends Record<string, unknown> {
  /** TIMELINE seconds — `frameIndex / fps` (T271). Uniform by construction. */
  time: number;
  /** The step belonging to `time`, and never the other clock's (§V172). */
  deltaTime: number;
  frameIndex: number;
  randomSeed: number;
  /** WALL seconds, for anything that must match the outside world (T271). */
  wallTime: number;
  /** The step belonging to `wallTime`. */
  wallDelta: number;
  resolution: readonly [number, number];
  /** x, y, buttons, unused. Packed as vec4f so the block stays 16-byte aligned. */
  pointer: readonly [number, number, number, number];
}

/** WGSL declaration matching {@link SharedUniformValues}. Node shaders include this verbatim. */
// Six f32 then a vec2f then a vec4f: 24 + 8 = 32 bytes before `pointer`, which is already
// 16-byte aligned, so adding the wall pair changes no offset that was there before.
export const SHARED_UNIFORMS_WGSL = `struct SharedFrame {
  time: f32,
  deltaTime: f32,
  frameIndex: f32,
  randomSeed: f32,
  wallTime: f32,
  wallDelta: f32,
  resolution: vec2f,
  pointer: vec4f,
};`;

export function initialSharedUniforms(): SharedUniformValues {
  return {
    time: 0,
    deltaTime: 0,
    frameIndex: 0,
    randomSeed: 0,
    wallTime: 0,
    wallDelta: 0,
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
    wallTime: wallSecondsOf(frame),
    wallDelta: wallDeltaSecondsOf(frame),
    resolution: [resolution[0], resolution[1]],
    pointer: [pointer.x, pointer.y, pointer.buttons, 0],
  };
}
