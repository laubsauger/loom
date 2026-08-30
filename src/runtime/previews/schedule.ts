import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import {
  MAX_TILE_BOOST_SCALE,
  MAX_TILE_SCALE,
  MIN_ONSCREEN_LONG_EDGE_CSS,
  ladderSnap,
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
  /**
   * T490: the ladder step each kept preview was last GRANTED, in device px.
   *
   * The hysteresis state (V310): a tile-size change is structural — the host rebuilds the
   * preview program and every tile blanks for a frame (B13/§V142) — so a zoom gesture must
   * cross ladder steps deliberately, never jitter across a boundary. A granted step is kept
   * while it still covers what the screen asks (growing is immediate, snap-up semantics) and
   * shrinks only after the ask has fallen a FULL rung below it.
   */
  const grantedStep = new Map<string, number>();

  return {
    capacity,

    select(requests: ReadonlyArray<PreviewRequest>, input: ScheduleInput): PreviewSchedule {
      const baseCap = Math.max(1, input.previewLongEdge) * MAX_TILE_SCALE;
      const boostCap = Math.max(1, input.previewLongEdge) * MAX_TILE_BOOST_SCALE;
      const dpr = Math.max(input.devicePixelRatio, 1);
      /**
       * T490's budget: the pixel pool the base cap always implied — capacity tiles at the
       * base size — now ALLOCATED instead of divided evenly. Fewer previews on screen (the
       * zoomed-in case, since offscreen ones are suspended above) means each may take a
       * bigger tile; forty on screen means everyone gets the guaranteed base. Accounted in
       * long-edge squares, which over-counts non-square tiles — conservative on purpose.
       */
      const pixelBudget = capacity * baseCap * baseCap;

      // The sizing FLOOR: the node's own preview area, same at any zoom (§V142's rule for
      // everything outside the budgeted path). A SUSPENDED preview keeps the step it was
      // last granted: its tile still exists at that size (§V142 keeps tiles across
      // scrolls), and reporting base here resized the tile the moment a boosted preview
      // left the screen — one program reinstall on the way out and another on the way
      // back, which is B13 wearing the budget's clothes.
      const baseTileFor = (request: PreviewRequest): readonly [number, number] => {
        const held = grantedStep.get(previewKey(request.ref));
        return tileSizeFor({
          sourceSize: request.source.size,
          // A held step is already dpr-scaled and ladder-quantised, like a fresh grant.
          areaLongEdge: held ?? Math.max(request.area.width, request.area.height),
          devicePixelRatio: held === undefined ? input.devicePixelRatio : 1,
          maxLongEdge: held ?? baseCap,
        });
      };

      const suspended: SuspendedPreview[] = [];
      const eligible: PreviewRequest[] = [];

      for (const request of requests) {
        const reason = suspensionReason(request, input);
        if (reason === null) eligible.push(request);
        else suspended.push({ ref: request.ref, request, tileSize: baseTileFor(request), reason });
      }

      eligible.sort(budgetOrder);
      const kept = eligible.slice(0, capacity);
      for (const overflow of eligible.slice(capacity)) {
        suspended.push({
          ref: overflow.ref,
          request: overflow,
          tileSize: baseTileFor(overflow),
          reason: "budget",
        });
      }

      // ---- T490: allocate the pixel budget over the kept set, in the SAME priority order —
      // the atlas keeps the head of the list, so the head gets first claim on sharpness too.
      const stepFor = (request: PreviewRequest): number => {
        const key = previewKey(request.ref);
        const areaAsk = Math.max(request.area.width, request.area.height) * dpr;
        // What the SCREEN asks: the on-screen rect carries the zoom. Never above the stated
        // boost ceiling, never below the area floor.
        const ask = Math.min(Math.max(areaAsk, rectLongEdge(request.rect) * dpr), boostCap);
        const snapped = ladderSnap(Math.min(ask, boostCap));
        const previous = grantedStep.get(key);
        // Hysteresis: keep a bigger granted step until the ask falls a full rung below it.
        if (previous !== undefined && previous > snapped && previous <= snapped * 1.55) return previous;
        return snapped;
      };

      // Every kept preview's BASE is reserved first — that is the guarantee, and it is
      // what the pool was sized for (capacity tiles at the base size, so a full graph
      // spends exactly the pool and boosts nothing). Boosts then spend the HEADROOM the
      // absent previews left behind, in priority order, degrading a rung at a time; a
      // preview is never suspended for wanting to be sharp.
      const baseByKey = new Map<string, number>();
      let spent = 0;
      for (const request of kept) {
        const base = ladderSnap(Math.min(Math.max(request.area.width, request.area.height) * dpr, baseCap));
        baseByKey.set(previewKey(request.ref), base);
        spent += base * base;
      }
      const grantedByKey = new Map<string, number>();
      for (const request of kept) {
        const key = previewKey(request.ref);
        const base = baseByKey.get(key) ?? baseCap;
        const desired = stepFor(request);
        let granted = Math.max(desired, base);
        while (granted > base && spent - base * base + granted * granted > pixelBudget) {
          granted = ladderSnap(granted / 1.55);
        }
        granted = Math.max(granted, base);
        spent += granted * granted - base * base;
        grantedByKey.set(key, granted);
      }
      // A grant is remembered while the preview EXISTS at all — a suspended one keeps
      // its tile at the granted size, so it keeps the memory of it too. Only a preview
      // that vanished from the request set entirely forgets.
      const requestedKeys = new Set(requests.map((request) => previewKey(request.ref)));
      for (const key of [...grantedStep.keys()]) {
        if (!requestedKeys.has(key)) grantedStep.delete(key);
      }
      for (const [key, step] of grantedByKey) grantedStep.set(key, step);

      const boostedTileFor = (request: PreviewRequest): readonly [number, number] => {
        const granted = grantedByKey.get(previewKey(request.ref));
        if (granted === undefined) return baseTileFor(request);
        return tileSizeFor({
          sourceSize: request.source.size,
          // The granted step IS the long edge: already dpr-scaled and ladder-quantised.
          areaLongEdge: granted,
          devicePixelRatio: 1,
          maxLongEdge: granted,
        });
      };

      // A suspended preview surrenders its tile AND its refresh clock. Keeping the clock would
      // mean a preview that comes back after a long scroll waits out a stale interval before
      // showing anything; dropping it makes the first frame after it returns a render.
      const keptKeys = new Set(kept.map((request) => previewKey(request.ref)));
      for (const key of [...lastRefresh.keys()]) {
        if (!keptKeys.has(key)) lastRefresh.delete(key);
      }

      const time = input.frame.timeSeconds;

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
        return { ref: request.ref, request, tileSize: boostedTileFor(request), due };
      });

      return { active, suspended };
    },

    reset(): void {
      lastRefresh.clear();
      grantedStep.clear();
    },
  };
}
