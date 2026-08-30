import type { MediaSource, MediaSourceFrame } from "@runtime/backend/index.ts";

/**
 * Turning a browser video element into a `MediaSource` (T264, §V135, §V136).
 *
 * The nodes and the backend half already exist: a Movie File In or a Webcam declares an
 * `external` scratch texture keyed by `mediaSourceIdFor(nodeId)`, and the backend uploads
 * whatever source is registered under that key. Nothing registered one, so both nodes
 * rendered black — the same "built, tested, unreachable" shape as B12.
 *
 * ## The frameId rule is the whole performance story
 *
 * §V136: `frameId` is monotonic, and an UNCHANGED id means "nothing new", so the backend
 * uploads nothing. A source that bumped the id every time it was asked would upload a
 * 30 fps video sixty times a second — the texture would be identical and the cost real.
 * So the id advances from `requestVideoFrameCallback`, which fires once per DECODED
 * frame, and from nothing else. Where that API is missing the id advances on
 * `timeupdate`, which is coarser but still tied to decode rather than to render.
 *
 * ## Structural, not DOM-typed
 *
 * `MediaElement` is the handful of members this module touches, so a test can hand in an
 * object and the browser can hand in a `<video>`; the same reason `PresentableCanvas` is
 * structural. `MediaSourceFrame.image` is `unknown` in the backend contract for exactly
 * this reason — the element goes to `copyExternalImageToTexture` untouched (§V7: no
 * readback, no CPU copy).
 */

export interface VideoFrameMetadata {
  readonly mediaTime: number;
}

/** The parts of `HTMLVideoElement` this module uses. */
export interface MediaElement {
  readonly videoWidth: number;
  readonly videoHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(
    callback: (now: number, metadata: VideoFrameMetadata) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
}

/**
 * How long a file may take to produce metadata before it is called unopenable (T493).
 *
 * TD's Movie File In has this exact parameter (`opentimeout`) for the same reason. Ten
 * seconds is generous for a local file and short enough that a user does not sit in front
 * of a black node wondering.
 */
export const MEDIA_OPEN_TIMEOUT_MS = 10_000;

/** What `awaitMediaReady` needs. A superset of `MediaElement`'s listener pair. */
export interface OpenableMedia {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  readonly readyState?: number;
  readonly error?: { readonly code?: number } | null;
}

/**
 * Resolve when the element has METADATA, reject when it cannot get any (T493, §V369).
 *
 * ## The bug this replaces, found by looking at the running app (§V383)
 *
 * `openFile` used to `await video.play()`. **A `play()` on a source that never decodes
 * stays PENDING FOREVER** — no rejection, no timeout, because the promise resolves when
 * playback actually begins and nothing says it never will. So the open loop stranded
 * *before* `registerMediaSource`, the node held black, and NOTHING was reported: the exact
 * "a media element that has not loaded must refuse BY NAME rather than silently holding
 * black" case T493 was told to close, sitting in the code the whole time.
 *
 * `loadedmetadata` is the right event to wait on rather than `canplay`: it is what
 * `videoWidth`/`duration` need, it is what the node's resolution match needs, and it
 * arrives without requiring the browser to have buffered anything.
 */
export function awaitMediaReady(
  element: OpenableMedia,
  timeoutMs: number = MEDIA_OPEN_TIMEOUT_MS,
  schedule: (callback: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): Promise<void> {
  // HAVE_METADATA. Already there — a cached file, a stream that came up instantly — so
  // there is no event left to wait for and waiting would hang on exactly the fast path.
  if ((element.readyState ?? 0) >= 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let handle: unknown = null;
    const done = (settle: () => void) => {
      element.removeEventListener("loadedmetadata", onReady);
      element.removeEventListener("error", onError);
      if (handle !== null) cancel(handle);
      settle();
    };
    const onReady = () => done(resolve);
    const onError = () =>
      done(() => reject(new Error(`The file could not be decoded (code ${element.error?.code ?? 0}).`)));
    element.addEventListener("loadedmetadata", onReady);
    element.addEventListener("error", onError);
    handle = schedule(
      () => done(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for the file to open.`))),
      timeoutMs,
    );
  });
}

export interface VideoMediaSource {
  readonly source: MediaSource;
  /** Intrinsic size once the browser has decoded enough to know it. Null until then. */
  size(): { readonly width: number; readonly height: number } | null;
  dispose(): void;
}

/**
 * Wraps an element as a pull-based source.
 *
 * Nothing here starts playback, picks a file or asks for a camera: the owner does that
 * and hands over an element that is already producing frames. This module's only job is
 * to answer "is there a new frame, and what is it".
 */
export function createVideoMediaSource(element: MediaElement): VideoMediaSource {
  let frameId = 0;
  let ended = false;
  let disposed = false;
  let handle: number | null = null;

  const advance = () => {
    frameId += 1;
  };

  const onEnded = () => {
    ended = true;
  };
  element.addEventListener("ended", onEnded);

  const request = element.requestVideoFrameCallback?.bind(element);
  if (request !== undefined) {
    const step = () => {
      if (disposed) return;
      advance();
      handle = request(step);
    };
    handle = request(step);
  } else {
    // Older engines and test doubles: coarser, but still driven by DECODE rather than by
    // the render loop, which is what §V136 actually cares about.
    element.addEventListener("timeupdate", advance);
  }

  return {
    source: {
      currentFrame(): MediaSourceFrame | undefined {
        // No frame decoded yet: the texture keeps its contents, which is black. A node
        // whose file has not loaded shows black BY CONTRACT rather than by accident.
        if (frameId === 0 || element.videoWidth === 0 || element.videoHeight === 0) {
          return undefined;
        }
        return { frameId, image: element };
      },
      get ended() {
        return ended;
      },
    } as MediaSource,
    size() {
      if (element.videoWidth === 0 || element.videoHeight === 0) return null;
      return { width: element.videoWidth, height: element.videoHeight };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      element.removeEventListener("ended", onEnded);
      if (request === undefined) element.removeEventListener("timeupdate", advance);
      else if (handle !== null) element.cancelVideoFrameCallback?.(handle);
    },
  };
}
