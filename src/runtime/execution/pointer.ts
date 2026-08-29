import type { FrameInputs } from "../../domain/types/backend.ts";

export type PointerState = FrameInputs["pointer"];

/**
 * Pointer values fed into the shared frame uniforms (§T16).
 *
 * Deliberately has no DOM listeners: React components own the events and call `set()`,
 * so no GPU-adjacent module reaches into the document (§V2).
 */
export interface PointerSource {
  readonly state: PointerState;
  set(next: Partial<PointerState>): void;
  reset(): void;
}

export function createPointerSource(): PointerSource {
  let state: PointerState = { x: 0, y: 0, buttons: 0 };

  return {
    get state() {
      return state;
    },
    set(next) {
      state = {
        x: next.x ?? state.x,
        y: next.y ?? state.y,
        buttons: next.buttons ?? state.buttons,
      };
    },
    reset() {
      state = { x: 0, y: 0, buttons: 0 };
    },
  };
}
