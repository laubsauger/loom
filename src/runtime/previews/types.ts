import type { OutputRef as DomainOutputRef } from "../../domain/types/ids.ts";
import type { TextureFormat } from "../../domain/types/node-definition.ts";
import type { ColorSpace } from "../../domain/types/ports.ts";
import type { DrawPassDescriptor, EffectPassDescriptor, ResourceDescriptor, UniformValues } from "../backend/plan.ts";
import type { OrbitCameraBasis, PreviewOrbit } from "./orbit.ts";

/**
 * Shared vocabulary for the preview system (T34, T35, T36).
 *
 * Nothing in this directory touches the DOM — `src/runtime/**` is lint-banned from `window`
 * and `document` (T92, §V63) so the renderer stays movable into a worker. Everything the
 * previews need from the browser (device pixel ratio, element rects, the viewport transform)
 * arrives as plain numbers from the editor.
 */

/**
 * Port-scoped output identity (§V59).
 *
 * T80 will lift this into `src/domain/types` as the shared `OutputRef` used by the backend,
 * the export interface, previews and the agent tools alike. Until that lands the shape is
 * declared here, structurally identical, so the eventual merge is an import change and not a
 * rewrite. A single-output node uses the default port `"out"`.
 */
export type PreviewOutputRef = DomainOutputRef;

export const DEFAULT_OUTPUT_PORT = "out";

/** Stable string key for a ref. Used for pool keys, maps and deterministic ordering. */
export function previewKey(ref: PreviewOutputRef): string {
  return `${ref.nodeId}:${ref.portId}`;
}

/** Screen-space rectangle in CSS pixels, relative to the shared preview surface. */
export interface PreviewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The debug preview effects (T35, doc §12.4).
 *
 * Each kind compiles to its own fragment shader rather than to one uber-shader with a mode
 * branch: the pass's structural key includes the shader text (§V5), so distinct shaders make
 * "which effect is this preview showing" visible in the plan, and a mode switch is a cheap
 * pass rebuild rather than a permanently-branchy shader on every preview pixel.
 */
export const PREVIEW_MODES = [
  "color",
  "channel",
  "luminance",
  "alpha",
  "exposure",
  "nan",
  "signed",
] as const;

export type PreviewModeKind = (typeof PREVIEW_MODES)[number];

export const PREVIEW_CHANNELS = ["r", "g", "b", "a"] as const;

export type PreviewChannel = (typeof PREVIEW_CHANNELS)[number];

/** Which channels reach the display. All four on is the default, "normal colour". */
export interface ChannelMask {
  readonly r: boolean;
  readonly g: boolean;
  readonly b: boolean;
  readonly a: boolean;
}

export const ALL_CHANNELS: ChannelMask = Object.freeze({ r: true, g: true, b: true, a: true });

/** Everything that decides what a preview LOOKS like. Uniform values only — never structure. */
export interface PreviewView {
  readonly mode: PreviewModeKind;
  /** Which channel `mode: "channel"` isolates. Ignored by every other mode. */
  readonly channel: PreviewChannel;
  readonly channels: ChannelMask;
  /** Exposure in stops; the shader applies `pow(2, stops)`. 0 = unchanged. */
  readonly exposureStops: number;
  /** Filmic tonemap after exposure. Off means "show me the clipping". */
  readonly tonemap: boolean;
  /** Checkerboard square size in tile pixels, for `mode: "alpha"`. */
  readonly checkerSize: number;
  /** Value mapped to full intensity by `mode: "signed"`. */
  readonly signedScale: number;
}

/**
 * Where a PINNED tile that has no place on screen is parked (T756).
 *
 * A tile is pinned when something OTHER than the canvas wants it kept alive — the viewer
 * presenting a node whose slot is not measured, most of all. The scheduler keeps a pinned
 * tile ACTIVE by design, so it still arrives at the compositor with a destination, and
 * this is the destination that means "composite nowhere".
 *
 * Stated ONCE, here, because both ends have to agree about it: the requester parks a tile
 * at this rect and the backend's composite loop recognises it as off-surface and skips it
 * (`vgpu-backend.ts`). It used to be a literal in the requester only, and the backend
 * multiplied it by the device pixel ratio and handed it to vgpu as a viewport — outside
 * vgpu's ±(2·maxTextureDimension2D) bound at every dpr, so `f.pass` threw and took the
 * whole preview update with it. Anything far enough outside a surface will do; what must
 * not drift is that one side's "nowhere" is the other side's "nowhere".
 */
export const OFF_SURFACE_TILE_RECT = Object.freeze({ x: -100000, y: -100000, width: 1, height: 1 });

export const DEFAULT_PREVIEW_VIEW: PreviewView = Object.freeze({
  mode: "color",
  channel: "r",
  channels: ALL_CHANNELS,
  exposureStops: 0,
  tonemap: false,
  checkerSize: 8,
  signedScale: 1,
});

/**
 * The LENS — the subset of a `PreviewView` a person can set from the editor (T336).
 *
 * Deliberately smaller than `PreviewView`. The view carries seven fields, three of which
 * (`checkerSize`, `signedScale`, and the `nan`/`signed` diagnostic modes) answer questions a
 * user does not yet have a reason to ask from a node's own preview; exposing all of them
 * would put a seven-control panel behind a surface that has to stay quiet (§V90, §V92).
 * `viewForLens` is the one place the small vocabulary widens into the full view, so the two
 * cannot drift.
 */
export const PREVIEW_LENSES = ["rgb", "r", "g", "b", "a", "luminance"] as const;

export type PreviewLensKind = (typeof PREVIEW_LENSES)[number];

export interface PreviewLens {
  /** Which channel reaches the eye. `rgb` is "no isolation", the ordinary picture. */
  readonly lens: PreviewLensKind;
  /** Exposure in stops, applied before the optional tonemap. 0 = unchanged. */
  readonly exposureStops: number;
  /** Filmic tonemap. Off means "show me the clipping" — which is the useful default. */
  readonly tonemap: boolean;
}

export const DEFAULT_PREVIEW_LENS: PreviewLens = Object.freeze({
  lens: "rgb",
  exposureStops: 0,
  tonemap: false,
});

/** True when nothing is being done to the picture — the state that needs no indicator. */
export function isDefaultLens(lens: PreviewLens): boolean {
  return (
    lens.lens === DEFAULT_PREVIEW_LENS.lens &&
    lens.exposureStops === DEFAULT_PREVIEW_LENS.exposureStops &&
    lens.tonemap === DEFAULT_PREVIEW_LENS.tonemap
  );
}

/**
 * One request for a live preview, as the editor sees it.
 *
 * `visible` / `collapsed` / `occluded` are reported, not inferred: the runtime has no DOM and
 * cannot discover them, and §V28 is exactly about honouring them.
 */
export interface PreviewRequest {
  readonly ref: PreviewOutputRef;
  /** Plan resource backing the output, and its resolved size/format (from `ResolvedOutput`). */
  readonly source: {
    readonly resourceId: string;
    readonly size: readonly [number, number];
    readonly format: TextureFormat;
    /**
     * T375 (§V57): the space the compiler DECLARED for this resource. Required, so a new
     * caller cannot skip it and get a plausible-looking double encode (B47).
     */
    readonly space: ColorSpace;
  };
  /** Where the tile lands on the shared surface, CSS px (see `geometry.ts`). */
  readonly rect: PreviewRect;
  /**
   * The preview area in the NODE's own CSS px — what the tile is sized from (§V117, §V142).
   *
   * Separate from `rect` on purpose: `rect` is where the tile is drawn and carries the
   * viewport transform, this is how big the thing being previewed is and does not. Sizing a
   * tile from `rect` makes the camera reallocate render targets, which is B13.
   */
  readonly area: { readonly width: number; readonly height: number };
  /** The node's preview toggle is on and the node is inside the viewport. */
  readonly visible: boolean;
  /** Pinned previews survive every visibility reason (§V28 "visible OR pinned"). */
  readonly pinned: boolean;
  readonly collapsed: boolean;
  readonly occluded: boolean;
  readonly view: PreviewView;
  /** Per-preview refresh rate override. Absent = `ProjectSettings.previewFps`. */
  readonly fps?: number;
  /**
   * T563: for a SYNTHESIZED preview (pointset splat, scene-payload stock scene), the
   * draw passes that render `source.resourceId` — carried from the compiler's
   * `ResolvedOutput.synthesis`. The preview program owns the target (sized to the
   * granted tile) and runs these on the preview cadence, ahead of the lens pass.
   */
  readonly synthesis?: {
    readonly passes: ReadonlyArray<DrawPassDescriptor>;
    readonly depth: boolean;
    /** T561: the stock framing's basis and the passes an inspection orbit re-cameras. */
    readonly orbit?: OrbitCameraBasis & { readonly passIds: ReadonlyArray<string> };
  };
  /**
   * T561: this pane's inspection orbit for the synthesized picture — VIEW STATE, never
   * document state (no revision, no `.loom.json`, no touching a scene's camera node).
   * Identity deltas (or absence) show the compiler's baked framing.
   */
  readonly orbit?: PreviewOrbit;
}

export const SUSPEND_REASONS = [
  "collapsed",
  "occluded",
  "offscreen",
  "too-small",
  "not-visible",
  "budget",
] as const;

export type SuspendReason = (typeof SUSPEND_REASONS)[number];

/**
 * A preview that may HOLD a tile — everything the program needs to allocate one, whether or
 * not the preview draws this frame.
 *
 * Holding a tile and drawing into it are separate lifetimes (§V142): a preview scrolled off
 * screen keeps its tile until the pool needs it for one that is drawing, so a camera move
 * costs no allocation at all. What §V28c makes cheap is the per-frame GPU work, and that is
 * still decided by `PreviewSchedule.active` alone.
 */
export interface AllocatedPreview {
  readonly ref: PreviewOutputRef;
  readonly request: PreviewRequest;
  /**
   * Physical tile size in device pixels, after ladder snapping (see the design note §4).
   * Derived from the node's preview AREA, never from zoom (§V142).
   */
  readonly tileSize: readonly [number, number];
}

export interface SuspendedPreview extends AllocatedPreview {
  readonly reason: SuspendReason;
}

export interface ScheduledPreview extends AllocatedPreview {
  /** True when this frame is the one where the tile content re-renders. */
  readonly due: boolean;
}

export interface PreviewSchedule {
  readonly active: ReadonlyArray<ScheduledPreview>;
  readonly suspended: ReadonlyArray<SuspendedPreview>;
}

/**
 * The stable half of the preview system: resources and passes that exist for as long as the
 * active set and its tile sizes do.
 *
 * Plain data from the existing plan IR, so it is structured-clone safe (§V63) and can be
 * merged into a `LogicalExecutionPlan` without growing the closed pass/resource unions (§V58).
 */
export interface PreviewProgram {
  readonly resources: ReadonlyArray<ResourceDescriptor>;
  /**
   * Lens effect passes, plus — for SYNTHESIZED previews (T563) — the draw passes that
   * render the splat or stock scene into the program-owned source target. Encode order
   * is the per-frame command's `refresh` order, never this array's (it is sorted for
   * the signature).
   */
  readonly passes: ReadonlyArray<EffectPassDescriptor | DrawPassDescriptor>;
  /** Changes iff something above changed. The host rebuilds only then (§V8). */
  readonly signature: string;
}

/** Where one live tile lands on the shared surface this frame. */
export interface PreviewCompositeTile {
  readonly ref: PreviewOutputRef;
  /** Tile target resource id, as declared in `PreviewProgram.resources`. */
  readonly resourceId: string;
  readonly dest: PreviewRect;
}

/**
 * B118: one pass's lens values, pushed by VALUE. The program's `signature` deliberately
 * excludes uniform values (§V5) so a lens change cannot rebuild resources — which means a
 * push path must exist, or exposure, mask, tonemap, checker size and signed scale are
 * recomputed every tick and handed to a program object nobody ever uploads (§V220's
 * two-correct-halves shape, and exactly what shipped).
 */
export interface PreviewUniformUpdate {
  readonly passId: string;
  readonly values: UniformValues;
}

/** The per-frame decision. Everything here is cheap to recompute every display frame. */
export interface PreviewFrameCommand {
  /**
   * Pass ids to encode this frame. A preview that is not due contributes nothing — this is the
   * pass-subset capability the backend implements, and the reason refresh cadence costs a set
   * membership rather than a plan rebuild.
   */
  readonly refresh: ReadonlyArray<string>;
  /** Every active tile, due or not — a pan moves rects without changing pixels. */
  readonly composite: ReadonlyArray<PreviewCompositeTile>;
  /** Lens value updates for passes whose view changed since the last push (B118). */
  readonly uniforms?: ReadonlyArray<PreviewUniformUpdate>;
  /** Surface size in CSS px and its device pixel ratio, for the presenter's projection. */
  readonly surface: { readonly size: readonly [number, number]; readonly dpr: number };
}

/**
 * The presentation seam (T87, §V64, §V70). IMPLEMENTED: `backend.previewHost(canvas)` returns
 * this interface plus a `dispose()`, and imports it type-only from here — so this declaration
 * is the contract both sides code against, not a placeholder for one.
 *
 * Note what is absent: there is no read, fetch or sample method. Previews are GPU→GPU (§V7);
 * the one permitted pixel read is the viewer's cursor probe, which goes through the export
 * interface (§V48) and never through here.
 */
export interface PreviewRuntimeHost {
  /**
   * Install the program. ALLOCATES — tile targets and preview pipelines — so it must be called
   * OUTSIDE frame encoding: the backend asserts that (§V8), and `backend.loop(onFrame)` runs
   * its callback with a frame already open. `PreviewSystem.plan()` is the phase that calls it.
   *
   * The backend gates on `PreviewProgram.signature`, so an identical program is free; that is
   * a safety net, not a licence to call this every frame.
   */
  setPreviewProgram(program: PreviewProgram): void;
  /**
   * Encode the named refresh passes and composite every listed tile. Never allocates, and works
   * inside an open loop frame or standalone, exactly like `backend.render()`.
   */
  presentPreviews(command: PreviewFrameCommand): void;
}
