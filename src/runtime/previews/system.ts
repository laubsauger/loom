import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { buildPreviewProgram, previewPassId } from "./program.ts";
import { createPreviewScheduler } from "./schedule.ts";
import type { PreviewScheduler } from "./schedule.ts";
import { createTileAtlas } from "./tile-atlas.ts";
import type { TileAtlas } from "./tile-atlas.ts";
import { previewKey } from "./types.ts";
import type {
  PreviewCompositeTile,
  PreviewFrameCommand,
  PreviewProgram,
  PreviewRect,
  PreviewRequest,
  PreviewRuntimeHost,
  PreviewSchedule,
} from "./types.ts";

/**
 * The preview system (T34).
 *
 * One object the editor drives per display frame. It owns the scheduler's refresh clocks and
 * the tile atlas, and it is the only thing that talks to the presentation host.
 *
 * TWO PHASES, because the host's two methods live on opposite sides of §V8:
 *
 *  - `plan()` may allocate — it builds tile targets and preview pipelines — so the backend
 *    guards `setPreviewProgram` with `assertOutsideFrame` and it MUST be called before the
 *    frame is opened. (`backend.loop(onFrame)` runs `onFrame` with a frame already open, so
 *    calling `plan()` in there throws `FrameEncodingViolation` by design, not by accident.)
 *  - `present()` never allocates and works inside or outside an open frame, exactly like
 *    `backend.render()`.
 *
 * `update()` does both and is therefore an outside-the-frame call: fine for a standalone
 * tick, wrong inside `loop()`. The split is not a workaround for the guard — it IS the §V8
 * boundary, made impossible to cross by accident.
 *
 * Deliberately not a React store and deliberately not a subscriber to the document. Preview
 * pixels and per-frame decisions never enter the document store and never re-render the node
 * tree (§V16); node-facing STATUS (is this preview live, why is it suspended) goes out on the
 * existing `NodeRuntimeStore` channel, which is already coalesced to <= 10 Hz.
 */

export interface PreviewSystemOptions {
  /** `backend.previewHost(canvas)` returns exactly this, plus a `dispose()` the caller owns. */
  readonly host: PreviewRuntimeHost;
  /** Tile budget — the maximum number of live previews (§V28). */
  readonly capacity: number;
}

export interface PreviewSystemFrame {
  /**
   * The previews that exist right now. AUTHORITATIVE (§V28a): an empty array means nothing is
   * previewing, never "carry on with whatever was live last frame". Deriving this list from
   * visibility is the composition root's job, and it must pass every visible preview rather
   * than relying on a union with anything else.
   */
  readonly requests: ReadonlyArray<PreviewRequest>;
  readonly frame: FrameEvaluationInput;
  /** The shared surface's rect in CSS px (usually origin 0,0) and its device pixel ratio. */
  readonly surface: PreviewRect;
  readonly devicePixelRatio: number;
  readonly previewFps: number;
  readonly previewLongEdge: number;
}

export interface PreviewSystemResult {
  readonly schedule: PreviewSchedule;
  readonly program: PreviewProgram;
  readonly command: PreviewFrameCommand;
  /** True when the program changed this frame and the host was asked to rebuild. */
  readonly programChanged: boolean;
}

export interface PreviewSystem {
  readonly capacity: number;
  /**
   * Schedule, build and hand the program to the host. Allocates, so it must run OUTSIDE frame
   * encoding (§V8). Returns the command `present()` should be given.
   */
  plan(input: PreviewSystemFrame): PreviewSystemResult;
  /** Encode refreshes and composite. Never allocates; safe inside an open frame. */
  present(command: PreviewFrameCommand): void;
  /** `plan()` then `present()`. Outside-the-frame convenience for a standalone tick. */
  update(input: PreviewSystemFrame): PreviewSystemResult;
  /** Drop every tile and refresh clock — device loss, project load, pane close (§V23). */
  reset(): void;
}

export function createPreviewSystem(options: PreviewSystemOptions): PreviewSystem {
  const scheduler: PreviewScheduler = createPreviewScheduler({ capacity: options.capacity });
  const atlas: TileAtlas = createTileAtlas({ capacity: options.capacity });
  let lastSignature: string | null = null;

  function plan(input: PreviewSystemFrame): PreviewSystemResult {
    const schedule = scheduler.select(input.requests, {
      frame: input.frame,
      surface: input.surface,
      devicePixelRatio: input.devicePixelRatio,
      previewFps: input.previewFps,
      previewLongEdge: input.previewLongEdge,
    });

    const program = buildPreviewProgram(schedule, atlas);
    const programChanged = program.signature !== lastSignature;
    if (programChanged) {
      lastSignature = program.signature;
      options.host.setPreviewProgram(program);
    }

    const refresh: string[] = [];
    const composite: PreviewCompositeTile[] = [];
    for (const entry of schedule.active) {
      const key = previewKey(entry.ref);
      const tile = atlas.get(key);
      if (tile === undefined) continue;
      if (entry.due) refresh.push(previewPassId(key));
      // Every active tile composites every frame, due or not: a pan moves the destination
      // rect without changing a single pixel inside the tile.
      composite.push({ ref: entry.ref, resourceId: tile.resourceId, dest: entry.request.rect });
    }

    const command: PreviewFrameCommand = {
      refresh,
      composite,
      surface: { size: [input.surface.width, input.surface.height], dpr: input.devicePixelRatio },
    };

    return { schedule, program, command, programChanged };
  }

  function present(command: PreviewFrameCommand): void {
    options.host.presentPreviews(command);
  }

  return {
    capacity: options.capacity,
    plan,
    present,

    update(input: PreviewSystemFrame): PreviewSystemResult {
      const result = plan(input);
      present(result.command);
      return result;
    },

    reset(): void {
      scheduler.reset();
      atlas.reset();
      lastSignature = null;
    },
  };
}
