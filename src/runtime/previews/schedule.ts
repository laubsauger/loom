import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import {
  MAX_TILE_SCALE,
  MIN_ONSCREEN_LONG_EDGE_CSS,
  rectArea,
  rectLongEdge,
  rectsIntersect,
  tileSizeFor,
} from "./geometry.ts";
import { previewKey } from "./types.ts";
import type {
  PreviewRect,
  PreviewRequest,
  PreviewSchedule,
  ScheduledPreview,
  SuspendReason,
  SuspendedPreview,
} from "./types.ts";

/**
 * Preview scheduling (T34, §V28).
 *
 * Three decisions per frame, in this order: who is allowed a tile, who fits in the budget, and
 * who re-renders. They are separate because they change at different rates — the first two on
 * user gestures, the third on a clock that has nothing to do with the main output's.
 *
 * NO READBACK. Nothing in this module (or anywhere else under `src/runtime/previews/`) names
 * `readOutput`, `mapAsync` or `copyTextureToBuffer`: previews are GPU→GPU (§V7). That is
 * asserted structurally by `no-readback.test.ts` scanning these sources, not by this comment.
 */

/**
 * Slack on the refresh comparison, in seconds.
 *
 * A display frame that lands a nanosecond short of the interval must not cost a preview a whole
 * refresh period. One microsecond is far below any real interval (the fastest preview rate is
 * 1/60 s) and far above the floating-point noise in an accumulated seconds clock, so this makes
 * "15 fps previews on a 60 fps loop refresh on every fourth frame" true rather than nearly true.
 */
export const REFRESH_EPSILON_SECONDS = 1e-6;

export interface ScheduleInput {
  /** Time and frame index come from the transport, never from a wall clock (§V44, §V49). */
  readonly frame: FrameEvaluationInput;
  /** The shared preview surface, in the same CSS-pixel space as `PreviewRequest.rect`. */
  readonly surface: PreviewRect;
  readonly devicePixelRatio: number;
  /** `ProjectSettings.previewFps` — the default rate, overridable per preview. */
  readonly previewFps: number;
  /** `ProjectSettings.previewLongEdge` — sets the tile resolution cap. */
  readonly previewLongEdge: number;
}

export interface PreviewSchedulerOptions {
  /** Tile budget. More eligible previews than this suspends the surplus (`budget`). */
  readonly capacity: number;
}

export interface PreviewScheduler {
  readonly capacity: number;
  select(requests: ReadonlyArray<PreviewRequest>, input: ScheduleInput): PreviewSchedule;
  reset(): void;
}

/**
 * Why a preview may not have a tile.
 *
 * `pinned` bypasses every reason except `collapsed`. Pinning is the user saying "keep this
 * alive while I work elsewhere", which is exactly §V28's "visible OR pinned"; a collapsed node
 * is different in kind, because it has no preview area at all to composite into. The large
 * viewer pane does not rely on that: it submits its own request with its own rect on its own
 * surface, rather than piggybacking on a node's slot.
 */
function suspensionReason(request: PreviewRequest, input: ScheduleInput): SuspendReason | null {
  if (request.collapsed) return "collapsed";
  if (request.pinned) return null;
  if (!request.visible) return "not-visible";
  if (request.occluded) return "occluded";
  if (!rectsIntersect(request.rect, input.surface)) return "offscreen";
  // Zoomed far enough out that the tile carries nothing a person can read. This is what makes
  // zooming out over a 200-node graph get CHEAPER instead of more expensive.
  if (rectLongEdge(request.rect) < MIN_ONSCREEN_LONG_EDGE_CSS) return "too-small";
  return null;
}

/**
 * Budget order: pinned first, then largest on screen, then key.
 *
 * The key tiebreak is not decoration. Without a total order the surviving set depends on map
 * iteration order, and previews flicker in and out between frames for no reason the user can
 * see or explain.
 */
function budgetOrder(a: PreviewRequest, b: PreviewRequest): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const areaDelta = rectArea(b.rect) - rectArea(a.rect);
  if (areaDelta !== 0) return areaDelta;
  const keyA = previewKey(a.ref);
  const keyB = previewKey(b.ref);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

export function createPreviewScheduler(options: PreviewSchedulerOptions): PreviewScheduler {
  const capacity = Math.max(0, Math.floor(options.capacity));
  /** Last time each preview's tile content was rendered, in transport seconds. */
  const lastRefresh = new Map<string, number>();

  return {
    capacity,

    select(requests: ReadonlyArray<PreviewRequest>, input: ScheduleInput): PreviewSchedule {
      const suspended: SuspendedPreview[] = [];
      const eligible: PreviewRequest[] = [];

      for (const request of requests) {
        const reason = suspensionReason(request, input);
        if (reason === null) eligible.push(request);
        else suspended.push({ ref: request.ref, reason });
      }

      eligible.sort(budgetOrder);
      const kept = eligible.slice(0, capacity);
      for (const overflow of eligible.slice(capacity)) {
        suspended.push({ ref: overflow.ref, reason: "budget" });
      }

      // A suspended preview surrenders its tile AND its refresh clock. Keeping the clock would
      // mean a preview that comes back after a long scroll waits out a stale interval before
      // showing anything; dropping it makes the first frame after it returns a render.
      const keptKeys = new Set(kept.map((request) => previewKey(request.ref)));
      for (const key of [...lastRefresh.keys()]) {
        if (!keptKeys.has(key)) lastRefresh.delete(key);
      }

      const time = input.frame.timeSeconds;
      const maxLongEdge = Math.max(1, input.previewLongEdge) * MAX_TILE_SCALE;

      const active: ScheduledPreview[] = kept.map((request) => {
        const key = previewKey(request.ref);
        const fps = Math.max(1, request.fps ?? input.previewFps);
        const interval = 1 / fps;
        const last = lastRefresh.get(key);
        // Never consults the main output's rate: a 60 fps output with 15 fps previews renders
        // previews on roughly every fourth frame, and the two are free to diverge.
        // `time < last` is a clock rebase (T100 rebases f32 time to keep precision). Treating
        // it as "not due" would stall every preview until the clock caught up again.
        const due =
          last === undefined || time < last || time - last >= interval - REFRESH_EPSILON_SECONDS;
        if (due) lastRefresh.set(key, time);
        return {
          ref: request.ref,
          request,
          tileSize: tileSizeFor({
            sourceSize: request.source.size,
            onScreenLongEdge: rectLongEdge(request.rect),
            devicePixelRatio: input.devicePixelRatio,
            maxLongEdge,
          }),
          due,
        };
      });

      return { active, suspended };
    },

    reset(): void {
      lastRefresh.clear();
    },
  };
}
