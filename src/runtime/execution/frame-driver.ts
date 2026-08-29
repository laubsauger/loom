import type { CompiledExecutionPlan, FrameInputs } from "../../domain/types/backend.ts";
import type { TransportSource } from "../../domain/types/frame.ts";
import type { FrameLoopControl, ShaderloomBackend } from "../backend/backend-types.ts";
import type { PointerSource } from "./pointer.ts";

/**
 * Drives the compiled plan one frame at a time (§T16).
 *
 * The scheduler and the clock are separate concerns on purpose (§V49): the backend's
 * `loop()` decides *when* a frame happens (rAF today, an offline queue later), while every
 * time value handed to passes comes from the injected `TransportSource`. Nothing here reads
 * `Date.now`, `performance.now` or rAF (§V44) — swapping the transport for a playhead or a
 * fixed-step offline source needs no change in this file.
 *
 * `step()` renders exactly one frame synchronously. That is the headless/offline entry
 * point and what tests use, and it is the same code the live loop runs (§V47).
 */

export interface FrameDriverOptions {
  readonly backend: ShaderloomBackend;
  readonly transport: TransportSource;
  readonly pointer: PointerSource;
  /** Output resolution in pixels; read per frame so a resize needs no driver restart. */
  readonly resolution: () => readonly [number, number];
  readonly fps?: number;
  /** Called with the inputs of every frame actually rendered (metrics, §V16). */
  readonly onFrame?: (inputs: FrameInputs) => void;
}

export interface FrameDriver {
  readonly running: boolean;
  readonly framesRendered: number;
  readonly plan: CompiledExecutionPlan | null;
  setPlan(plan: CompiledExecutionPlan | null): void;
  start(): void;
  stop(): void;
  /** Renders exactly one frame. Used by the offline/headless path and by tests. */
  step(): FrameInputs | null;
}

export function createFrameDriver(options: FrameDriverOptions): FrameDriver {
  const { backend, transport, pointer, resolution } = options;

  let plan: CompiledExecutionPlan | null = null;
  let control: FrameLoopControl | undefined;
  let framesRendered = 0;

  function tick(): FrameInputs | null {
    if (!plan) return null;
    const inputs: FrameInputs = {
      frame: transport.next(),
      pointer: pointer.state,
      resolution: resolution(),
    };
    backend.render(plan, inputs);
    framesRendered += 1;
    options.onFrame?.(inputs);
    return inputs;
  }

  return {
    get running() {
      return control !== undefined;
    },
    get framesRendered() {
      return framesRendered;
    },
    get plan() {
      return plan;
    },
    setPlan(next) {
      plan = next;
    },
    start() {
      if (control) return;
      control = backend.loop(
        () => {
          tick();
        },
        options.fps === undefined ? {} : { fps: options.fps },
      );
    },
    stop() {
      control?.stop();
      control = undefined;
    },
    step() {
      return tick();
    },
  };
}
