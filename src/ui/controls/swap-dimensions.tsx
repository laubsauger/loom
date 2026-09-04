import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cx } from "../cx.ts";
import styles from "./controls.module.css";

/**
 * Swap a width/height pair — the portrait/landscape control (T1157).
 *
 * ## It is a BUTTON, not a mode, and that is the whole design (§T1064)
 *
 * Orientation is `width < height`. It is a FUNCTION of the resolution, not a fact stored
 * beside it, so this control keeps no state and the document grows no field: it reads the
 * pair it is handed, hands back the same two numbers the other way round, and re-derives
 * the word "portrait" from whatever comes back.
 *
 * An `orientation` flag stored alongside the pair would be a second answer to a question
 * the pair already answers, and the two can disagree — which is exactly the ~180-line
 * resolution mirror §T1064 deleted, a panel that "lied on every device below the project
 * cap". One source, derived on read, is the only arrangement with no second answer in it.
 *
 * ## A square is a no-op, and it SAYS SO
 *
 * When the two are equal there is nothing to swap. The button goes unavailable and its
 * hover text names the size and the reason, rather than staying live and pretending a
 * click did something. `onSwap` is never called with a pair equal to the one passed in,
 * so no caller can dirty a document by clicking this.
 *
 * ## Structural, and nothing can drive it
 *
 * A swap changes the pixels every downstream target is allocated at, so the click
 * recompiles and resets feedback history (§V50, §V22) — fine for one deliberate press,
 * which is why the rows that carry it are marked `compileTime`. There is no per-frame
 * path in: the pair lives in `ProjectSettings.outputResolution` and in
 * `GraphNode.resolution`, neither of which is a `StoredParameter`, so no expression,
 * binding, channel or map can reach it (§V29 — the only way to move either is a command).
 */

export type Orientation = "landscape" | "portrait" | "square";

/**
 * The one derivation, exported so both the control and its gates read the same rule
 * rather than each writing `width < height` again.
 */
export function orientationOf(width: number, height: number): Orientation {
  if (width === height) return "square";
  return width < height ? "portrait" : "landscape";
}

export interface SwapDimensionsProps {
  readonly width: number;
  readonly height: number;
  /**
   * Handed the SWAPPED pair, not a bare "it was clicked". The arithmetic happens once,
   * here, so a call site cannot get the two the wrong way round on the way to its command.
   */
  readonly onSwap: (next: { width: number; height: number }) => void;
  /** Unavailable for a reason of the caller's, on top of the square case. */
  readonly disabled?: boolean;
}

export function SwapDimensions({ width, height, onSwap, disabled = false }: SwapDimensionsProps) {
  // §V20: the press belongs to the control, not to the node or the canvas under it.
  const stop = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const orientation = orientationOf(width, height);
  const square = orientation === "square";
  const title = square
    ? `${width} × ${height} is square — nothing to swap`
    : `Swap to ${orientation === "landscape" ? "portrait" : "landscape"} — ${height} × ${width}`;

  return (
    <button
      type="button"
      className={cx(styles.swap, "nodrag")}
      aria-label="Swap width and height"
      title={title}
      data-orientation={orientation}
      disabled={disabled || square}
      onPointerDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        if (square) return;
        onSwap({ width: height, height: width });
      }}
    >
      <span aria-hidden>⇄</span>
    </button>
  );
}
