import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { createParameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import {
  createMediaClock,
  mediaPlayhead,
  mediaTransportFrom,
  type MediaClock,
  type MediaPlayhead,
  type MediaTransportValues,
} from "@domain/media/transport.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * DRIVING A REAL `<video>` / `<audio>` FROM A DERIVED PLAYHEAD (T493).
 *
 * `mediaPlayhead` says where the media should be. This is the half that makes a browser
 * element agree with it — and it is written ONCE, for both doors, because the movie hook
 * and the audio hook driving elements by two different rules is exactly the drift T493
 * was told to design out. The video element and the audio element differ in nothing this
 * module touches, so it takes the structural `PlayableMedia` and neither hook owns a copy
 * of the seek policy.
 *
 * ## Why it is not "just set currentTime every frame"
 *
 * Writing `currentTime` sixty times a second re-seeks the decoder sixty times a second and
 * the picture stutters and the sound clicks. So the element PLAYS — at `playbackRate` —
 * and this only intervenes when it has drifted past `SEEK_TOLERANCE_SECONDS` from where
 * the timeline says it should be. That is what makes the two clocks agree without
 * fighting: the element does the smooth interpolation it is good at, and the derived
 * playhead does the correcting.
 *
 * A LOOP is that same correction and needs no special case at all: at the lap the derived
 * position jumps from the out point back to the in point, the drift is a whole window
 * wide, and the seek happens. Same for a scrub, a cue, a trim edit and a speed change.
 *
 * ## Reverse is a scrub, and says so
 *
 * No browser plays a negative `playbackRate` — Chrome and Safari throw, Firefox ignores.
 * So a negative speed PAUSES the element and steps `currentTime` per frame, which is what
 * reverse playback actually is. Stated here rather than left as a mystery stutter.
 */

/** The members of `HTMLMediaElement` this module touches. Structural, so a test needs no DOM. */
export interface PlayableMedia {
  currentTime: number;
  playbackRate: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
}

/**
 * How far the element may drift before it is corrected.
 *
 * Roughly four frames at 25fps. Tighter and an ordinary decode hiccup triggers a seek,
 * which causes the stutter it was meant to prevent; looser and a scrub feels lagged.
 */
export const SEEK_TOLERANCE_SECONDS = 0.15;

/** Browsers clamp playback rate; outside this range they throw or silently ignore. */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;

/**
 * Put the element where the playhead says, as cheaply as the element allows.
 *
 * Returns whether it seeked, so a caller can assert the "only corrects on drift" property
 * rather than trust it.
 */
export function applyMediaPlayhead(
  element: PlayableMedia,
  transport: MediaTransportValues,
  head: MediaPlayhead,
): boolean {
  const speed = Number.isFinite(transport.speed) ? transport.speed : 1;
  // HELD: a cue, a stopped free-run transport, a zero or reverse speed, or a `black`
  // extend that has taken us outside the window. In every one of those the element must
  // not be running on its own clock, because the position no longer advances with it.
  const held =
    head.cued ||
    speed <= 0 ||
    !head.visible ||
    (transport.playMode === "freeRun" && !transport.play);

  if (held) {
    if (!element.paused) element.pause();
    // Reverse and cue both need the exact frame, so the tolerance does not apply: this is
    // a scrub, and a scrub that lands "close enough" is the wrong frame.
    if (element.currentTime !== head.position) {
      element.currentTime = head.position;
      return true;
    }
    return false;
  }

  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, speed));
  if (element.playbackRate !== rate) element.playbackRate = rate;
  if (element.paused) void element.play();

  if (Math.abs(element.currentTime - head.position) > SEEK_TOLERANCE_SECONDS) {
    element.currentTime = head.position;
    return true;
  }
  return false;
}

/**
 * One node's live transport: its own free-run accumulator, and the last playhead it
 * produced. Kept per node id, because two Movie File In nodes on one file are two
 * independent transports — the same reason `mediaSourceIdFor` keys on the node.
 */
export interface MediaSteppedTransport {
  readonly transport: MediaTransportValues;
  readonly head: MediaPlayhead;
  /**
   * Everything else the node resolved this frame — `volume`, and whatever a door adds
   * next. Handed back rather than re-resolved by the caller so the audio hook's volume
   * and its playhead cannot come from two different reads of the same frame (§B8's shape).
   */
  readonly read: (key: string) => ParameterValue | undefined;
}

export interface MediaTransportRunner {
  /** Resolve the node's parameters for this frame and return where its media should be. */
  step(frame: FrameEvaluationInput, duration: number): MediaSteppedTransport | null;
  /** A cue PULSE (free-run only): land on the cue point and carry on from there. */
  cue(): void;
  reset(): void;
}

export interface MediaTransportContext {
  readonly graph: () => GraphDocument;
  readonly registry: NodeRegistryView;
  /** The value graph's resolver, so a DRIVEN speed or trim reaches here like any other. */
  readonly channels: () => ChannelResolver | undefined;
}

/**
 * A node's transport, resolved through the ONE parameter read path (§V61, §V107).
 *
 * Every transport parameter therefore takes every mode: an expression on `speed`, a
 * `cuePoint` bound to a sibling, a `trimStart` driven by an audio channel. Nothing here
 * knows about modes — that is the whole reason it calls `resolveParameters` rather than
 * reading `node.parameters` directly, which is what a bespoke transport widget would have
 * had to do.
 */
export function createMediaTransportRunner(
  nodeId: NodeId,
  context: MediaTransportContext,
): MediaTransportRunner {
  const clock: MediaClock = createMediaClock();
  let lastDuration = 0;

  const readAll = (
    frame?: FrameEvaluationInput,
  ): ((key: string) => ParameterValue | undefined) | null => {
    const node = context.graph().nodes[nodeId];
    if (node === undefined) return null;
    const definition = context.registry.get(node.type);
    if (definition === undefined) return null;
    const channels = context.channels();
    /**
     * ⚑ T1155 — §V837's ONE FACTORY, and this call site is why it exists.
     *
     * These options used to be `{ frame, channels }` spelled out here, with NO `nodes`
     * reader — and `op('sun1').chan.high` is read INSIDE that reader, never off
     * `channels`. So every expression on a transport parameter failed with "this context
     * has no channel resolver", fell back to §V108's retained static, and froze there:
     * the docblock above has promised "a `cuePoint` bound to a sibling, a `trimStart`
     * driven by an audio channel" since T493 and NOT ONE OF THEM HAS EVER WORKED.
     *
     * §B8's shape, and §V837 already names it as having recurred four times (§T593, the
     * inspector §T1000, the OSC pump §T1001, §B46). This was the fifth, and it was found
     * by E56, whose whole picture is a driven `cuePoint`: the file loaded, the element
     * reached readyState 4, and `currentTime` sat at the retained 3.42 forever.
     */
    const resolved = resolveParameters(node, definition, createParameterReadOptions({
      graph: context.graph(),
      registry: context.registry,
      ...(frame === undefined ? {} : { frame }),
      ...(channels === undefined ? {} : { channels }),
    }));
    return (key) => resolved.get(key)?.value;
  };

  return {
    step(frame, duration) {
      const read = readAll(frame);
      if (read === null) return null;
      const transport = mediaTransportFrom(read);
      lastDuration = duration;
      const elapsed = clock.advance(transport, frame.deltaSeconds, frame.timeSeconds);
      return { transport, head: mediaPlayhead(transport, elapsed, duration), read };
    },
    cue() {
      const read = readAll();
      if (read === null) return;
      const transport = mediaTransportFrom(read);
      // Through the playhead's own arithmetic, so a cue lands on the frame the playhead
      // function would report for that point rather than on a second opinion about it.
      const head = mediaPlayhead(transport, 0, lastDuration);
      const point = Math.max(head.start, Math.min(head.end > head.start ? head.end : Infinity, transport.cuePoint));
      clock.cueTo(transport, head, point);
    },
    reset() {
      clock.reset();
    },
  };
}

/**
 * The element as something a transport can drive, or null.
 *
 * A STRUCTURAL check rather than an `instanceof`, for the same reason `MediaElement` is
 * structural: a test hands in a plain object, the browser hands in a `<video>`. It also
 * gives the honest answer for the two cases that have no playhead — a webcam stream and a
 * test double that never claimed to be seekable — which then simply are not driven,
 * instead of throwing on a missing `play`.
 */
export function playableMedia(element: unknown): PlayableMedia | null {
  if (element === null || typeof element !== "object") return null;
  const candidate = element as Partial<PlayableMedia>;
  if (typeof candidate.currentTime !== "number") return null;
  if (typeof candidate.play !== "function" || typeof candidate.pause !== "function") return null;
  return candidate as PlayableMedia;
}

/** A media element's length in seconds, or 0 while the browser does not know it yet. */
export function durationOf(element: { readonly duration?: number }): number {
  const duration = element.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : 0;
}
