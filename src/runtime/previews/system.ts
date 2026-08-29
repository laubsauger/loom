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
 * the tile atlas, and it is the only thing that talks to the presentation host — so the
 * "rebuild resources" call happens exactly when the program's signature moves, and the
 * per-frame call carries nothing but ids and rectangles.
 *
 * Deliberately not a React store and deliberately not a subscriber to the document. Preview
 * pixels and per-frame decisions never enter the document store and never re-render the node
 * tree (§V16); node-facing STATUS (is this preview live, why is it suspended) goes out on the
 * existing `NodeRuntimeStore` channel, which is already coalesced to <= 10 Hz.
 */

export interface PreviewSystemOptions {
  readonly host: PreviewRuntimeHost;
  /** Tile budget — the maximum number of live previews (§V28). */
  readonly capacity: number;
}

export interface PreviewSystemFrame {
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
  update(input: PreviewSystemFrame): PreviewSystemResult;
  /** Drop every tile and refresh clock — device loss, project load, pane close (§V23). */
  reset(): void;
}

export function createPreviewSystem(options: PreviewSystemOptions): PreviewSystem {
  const scheduler: PreviewScheduler = createPreviewScheduler({ capacity: options.capacity });
  const atlas: TileAtlas = createTileAtlas({ capacity: options.capacity });
  let lastSignature: string | null = null;

  return {
    capacity: options.capacity,

    update(input: PreviewSystemFrame): PreviewSystemResult {
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
        surface: {
          size: [input.surface.width, input.surface.height],
          dpr: input.devicePixelRatio,
        },
      };
      options.host.presentPreviews(command);

      return { schedule, program, command, programChanged };
    },

    reset(): void {
      scheduler.reset();
      atlas.reset();
      lastSignature = null;
    },
  };
}
