import { absFrameIndexOf, absTimeSecondsOf, wallDeltaSecondsOf, wallSecondsOf } from "../../domain/types/frame.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";
import type { UniformValues } from "./plan.ts";

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
  /**
   * T468: the ABSOLUTE clock — `absFrameIndex / fps`, the one that keeps growing across
   * timeline laps (T461). The same number expressions read as `abstime`, so a shader and
   * an expression driven by it cannot disagree about how long the show has run. Never a
   * wall reading: a frame count at the timeline's rate, deterministic under replay.
   */
  absTime: number;
  /** The frame count behind `absTime`, as f32 (the block is f32 throughout). */
  absFrame: number;
  resolution: readonly [number, number];
  /** x, y, buttons, unused. Packed as vec4f so the block stays 16-byte aligned. */
  pointer: readonly [number, number, number, number];
}

/** WGSL declaration matching {@link SharedUniformValues}. Node shaders include this verbatim. */
// Eight f32 (32 bytes) then a vec2f at offset 32 (align 8) and a vec4f at 48 (align 16).
// The abs pair slots in after the wall pair: every shader includes this text verbatim, so
// all of them regenerate together and no shader can hold the old layout (V380: NAMED
// members, never an array — uniform arrays defeat the writer's reflection).
export const SHARED_UNIFORMS_WGSL = `struct SharedFrame {
  time: f32,
  deltaTime: f32,
  frameIndex: f32,
  randomSeed: f32,
  wallTime: f32,
  wallDelta: f32,
  absTime: f32,
  absFrame: f32,
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
    absTime: 0,
    absFrame: 0,
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
    absTime: absTimeSecondsOf(frame),
    absFrame: absFrameIndexOf(frame),
    resolution: [resolution[0], resolution[1]],
    pointer: [pointer.x, pointer.y, pointer.buttons, 0],
  };
}

/**
 * The per-frame values every DISPATCH pass's own uniform block receives (T172, T489).
 *
 * A compute pass does not bind the shared block above — it binds its own `KernelFrame`,
 * generated per kernel — so the frame fields have to be written into it by name, and this
 * is the one place that decides which fields those are. It lives here, beside the block it
 * mirrors, rather than inline in the backend, because §V437's whole lesson is that a clock
 * reaching one surface and not the next is what happens when two places each answer "which
 * numbers is a frame" separately. One answer, gated in `loop-continuity.test.ts`.
 *
 * The pointer and the ABSOLUTE pair are read off the shared values rather than re-derived
 * from the frame, so a point kernel and a fragment shader cannot come to disagree about
 * where the cursor is or how long the show has run (§V182).
 *
 * Passes whose block declares none of these ignore the keys — vgpu writes by NAME into the
 * layout it reflected — so a kernel that named no optional member pays nothing (§V309).
 */
export function dispatchFrameUniforms(
  frame: FrameEvaluationInput,
  shared: SharedUniformValues,
): UniformValues {
  return {
    // T271/§V172: the TIMELINE pair, which wraps at a lap...
    timeSeconds: frame.timeSeconds,
    deltaSeconds: frame.deltaSeconds,
    frameIndex: frame.frameIndex,
    pointer: shared.pointer,
    // ...and T461/T489's absolute pair, which does not. `ctx.absTime`/`ctx.absFrame`.
    absTimeSeconds: shared.absTime,
    absFrameIndex: shared.absFrame,
  };
}
