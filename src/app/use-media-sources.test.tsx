// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { MediaSource, LoomBackend } from "@runtime/backend/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { createMediaControlRegistry, useMediaCommands } from "./media-commands.ts";
import type { MediaControlRegistry } from "./media-commands.ts";
import { createVideoMediaSource } from "./media-sources.ts";
import type { MediaElement } from "./media-sources.ts";
import type { TextMediaSource, TextRaster } from "./text-source.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { MediaEnvironment, MediaWiring, ResolvedSizeSource } from "./use-media-sources.ts";
import { useMediaSources } from "./use-media-sources.ts";

/**
 * T264 — media nodes are black until something registers a source (§V135, §V136).
 *
 * The node half and the backend half both shipped and both passed: a Movie File In
 * declares an external texture keyed by `mediaSourceIdFor(nodeId)`, and the backend
 * uploads whatever is registered under that key. Nothing registered anything, so both
 * media nodes rendered black in the product while every suite stayed green — the same
 * seam B12 is on the board for. What is asserted here is therefore the WIRING: that a
 * media node in the document produces a registration under the key the compiler emits,
 * that a refused camera reports instead of throwing, and that the frame id advances only
 * when a frame is actually decoded.
 */

afterEach(cleanup);

/** A `<video>` stand-in with no codec, no camera and no `requestVideoFrameCallback`. */
function fakeElement(width = 640, height = 360) {
  const listeners = new Map<string, Set<() => void>>();
  const element = {
    videoWidth: width,
    videoHeight: height,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    // T493: the transport half of a `<video>`. A camera stand-in keeps none of these, so
    // `playableMedia` correctly declines to drive it.
    currentTime: 0,
    playbackRate: 1,
    duration: 12,
    paused: true,
    playCalls: 0,
    play() {
      element.paused = false;
      element.playCalls += 1;
    },
    pause() {
      element.paused = true;
    },
  };
  return element;
}

function fakeBackend() {
  const registered = new Map<string, MediaSource>();
  const unregistered: string[] = [];
  const backend = {
    registerMediaSource(sourceId: string, source: MediaSource) {
      registered.set(sourceId, source);
      return () => {
        registered.delete(sourceId);
        unregistered.push(sourceId);
      };
    },
  } as unknown as LoomBackend;
  return { backend, registered, unregistered };
}

function graphWith(nodes: Record<string, { type: string; parameters?: Record<string, unknown> }>): GraphDocument {
  return {
    revision: 1,
    groups: {},
    edges: {},
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, node]) => [
        id,
        {
          id,
          type: node.type,
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: node.parameters ?? {},
        },
      ]),
    ),
  } as unknown as GraphDocument;
}

function Harness({
  runtime,
  backend,
  graph,
  environment,
  resolved,
  onDiagnostics,
  onWiring,
  controls,
}: {
  runtime: AppRuntime;
  backend: LoomBackend | null;
  graph: GraphDocument;
  environment: MediaEnvironment;
  /** T493/T1223: where `media.cue` and `media.reload` find a node, when a test cares. */
  controls?: MediaControlRegistry;
  /** Resolved output sizes (T312). Omitted where the test is only about video wiring. */
  resolved?: ResolvedSizeSource | null;
  onDiagnostics?: (messages: readonly string[]) => void;
  /** T493: the per-frame seam, so a test can drive a frame the way the loop does. */
  onWiring?: (wiring: MediaWiring) => void;
}) {
  const media = useMediaSources(runtime, backend, graph, resolved ?? null, environment, controls);
  onDiagnostics?.(media.diagnostics.map((entry) => entry.message));
  onWiring?.(media);
  return null;
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

describe("media sources reach the backend (T264)", () => {
  it("registers a webcam under the key the compiler emits", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const element = fakeElement();
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: () => Promise.resolve(element as unknown as MediaElement),
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({ cam: { type: "webcam" } })}
          environment={environment}
        />,
      );
    });

    await waitFor(() => {
      // The key is derived from the node id by the same function the node's compile uses.
      // Anything else registers a source nothing will ever read.
      expect(registered.has(mediaSourceIdFor("cam"))).toBe(true);
    });
  });

  it("reports a refused camera and registers nothing, rather than throwing", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const messages: string[][] = [];
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({ cam: { type: "webcam" } })}
          environment={environment}
          onDiagnostics={(next) => messages.push([...next])}
        />,
      );
    });

    await waitFor(() => {
      expect(messages.at(-1)?.some((message) => message.includes("cam"))).toBe(true);
    });
    // Declining is a normal outcome: the node stays black by contract, and nothing
    // pretends to have a source.
    expect(registered.size).toBe(0);
  });

  /**
   * T810 — the picker's parameter actually STEERS the open. Without this, a written
   * `device` is a string nothing reads, which is the shape the owner hit: "webcam node
   * needs a way to pick the camera no?".
   */
  it("opens the CHOSEN camera: the node's device parameter reaches getUserMedia", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const element = fakeElement();
    const askedFor: string[] = [];
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: (device: string) => {
        askedFor.push(device);
        return Promise.resolve(element as unknown as MediaElement);
      },
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({ cam: { type: "webcam", parameters: { device: "usb-cam-7" } } })}
          environment={environment}
        />,
      );
    });

    await waitFor(() => {
      expect(registered.has(mediaSourceIdFor("cam"))).toBe(true);
    });
    expect(askedFor).toEqual(["usb-cam-7"]);
  });

  /**
   * T810, the half that bites later: a camera unplugged between sessions. The exact
   * constraint throws OverconstrainedError; the fallback is taken AND named — silent
   * would leave the picker lying about what is live (the T434 contract, camera edition).
   */
  it("a vanished chosen camera falls back to the default AND says so", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const element = fakeElement();
    const messages: string[][] = [];
    const askedFor: string[] = [];
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: (device: string) => {
        askedFor.push(device);
        if (device !== "") {
          return Promise.reject(
            Object.assign(new Error("gone"), { name: "OverconstrainedError" }),
          );
        }
        return Promise.resolve(element as unknown as MediaElement);
      },
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({ cam: { type: "webcam", parameters: { device: "unplugged-9" } } })}
          environment={environment}
          onDiagnostics={(next) => messages.push([...next])}
        />,
      );
    });

    await waitFor(() => {
      expect(registered.has(mediaSourceIdFor("cam"))).toBe(true);
    });
    expect(askedFor).toEqual(["unplugged-9", ""]);
    const latest = messages.at(-1) ?? [];
    expect(latest.some((message) => message.includes("system default"))).toBe(true);
  });

  it("does not open anything for a movie node with no file yet", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    let opens = 0;
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => {
        opens += 1;
        return Promise.reject(new Error("should not be called"));
      },
      openCamera: () => Promise.reject(new Error("should not be called")),
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({ movie: { type: "movieFileIn" } })}
          environment={environment}
        />,
      );
    });

    expect(opens).toBe(0);
    expect(registered.size).toBe(0);
  });

  it("matches the node's resolution to the media's intrinsic size, through the bus (§V29)", async () => {
    const runtime = newRuntime();
    await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "seed",
        operations: [{ op: "addNode", ref: "$cam", type: "webcam", position: { x: 0, y: 0 } }],
      },
      runtime.invocation,
    );
    const nodeId = Object.keys(runtime.bus.store.getGraph().nodes)[0];
    if (nodeId === undefined) throw new Error("expected a seeded webcam node");

    const { backend } = fakeBackend();
    const element = fakeElement(1920, 1080);
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: () => Promise.resolve(element as unknown as MediaElement),
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={runtime.bus.store.getGraph()}
          environment={environment}
        />,
      );
    });

    // `copyExternalImageToTexture` will not scale: the node has to be the media's size or
    // the upload fails. One patch, on the bus, so the change is undoable and attributed.
    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.resolution).toEqual({
        mode: "fixed",
        width: 1920,
        height: 1080,
      });
    });
  });

  /**
   * T493 — THE REACH, at the hook level.
   *
   * `media-playback.test.ts` proves the seek policy and `domain/media/transport.test.ts`
   * proves the arithmetic. Neither would notice if `useMediaSources` never called them,
   * which is the exact shape of B12/B23/T264/B87 and the reason this case is here: a real
   * document, a real element, one frame pushed through the seam the frame loop uses, and
   * the ELEMENT asserted.
   */
  it("a frame through `sync` puts the movie element where the transport says (T493)", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const element = fakeElement();
    let wiring: MediaWiring | null = null;
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.resolve(element as unknown as MediaElement),
      openCamera: () => Promise.reject(new Error("not used")),
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({
            // T586 pins `playMode` EXPLICITLY. This case is about the plumbing — that a
            // resolved `speed` reaches a real element — and its arithmetic only works out
            // to a single exact number under the lock. It used to get that from the
            // default; the default moved, and a test whose numbers depend on a mode should
            // name the mode rather than inherit it.
            movie: {
              type: "movieFileIn",
              parameters: { file: "blob:clip", speed: 2, playMode: "timeline" },
            },
          })}
          environment={environment}
          onWiring={(value) => {
            wiring = value;
          }}
        />,
      );
    });
    await waitFor(() => expect(registered.has(mediaSourceIdFor("movie"))).toBe(true));

    const frame: FrameEvaluationInput = {
      timeSeconds: 3,
      deltaSeconds: 1 / 60,
      frameIndex: 180,
      mode: "realtime",
      randomSeed: 1,
    };
    act(() => (wiring as unknown as MediaWiring).sync(frame));

    // speed 2 at t=3 into a 12s clip: second SIX, exactly. A transport that reached the
    // element with the default speed would say 3, and a transport that never reached it
    // at all would leave the element at 0 — three distinguishable numbers.
    expect(element.currentTime).toBe(6);
    expect(element.playbackRate).toBe(2);

    // ...and a stopped app transport stops the element, which `sync` alone cannot do
    // because a stopped loop produces no frames to be called from.
    act(() => (wiring as unknown as MediaWiring).setRunning(false));
    expect(element.paused).toBe(true);
  });

  /**
   * T586 — THE SHIPPED DEFAULT, at the same seam.
   *
   * The case above now pins `playMode` by hand, which would leave the mode users actually
   * GET untested here. This is the owner's complaint asserted one layer above
   * `media-playback.test.ts`: a clip with nothing stored on it, and a TIMELINE THAT NEVER
   * MOVES — every frame carries `timeSeconds: 3` — must still walk the element forward.
   * Under T493's default the element would sit at 3 and never leave it.
   */
  it("a clip with NOTHING stored advances while the timeline stands still (T586)", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const element = fakeElement();
    let wiring: MediaWiring | null = null;
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.resolve(element as unknown as MediaElement),
      openCamera: () => Promise.reject(new Error("not used")),
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          // No `playMode`, no `speed`: exactly what dropping a file in gives you.
          graph={graphWith({ movie: { type: "movieFileIn", parameters: { file: "blob:clip" } } })}
          environment={environment}
          onWiring={(value) => {
            wiring = value;
          }}
        />,
      );
    });
    await waitFor(() => expect(registered.has(mediaSourceIdFor("movie"))).toBe(true));

    // Ten frames of 0.1s, all reporting the SAME timeline second. The step is chosen so
    // the seek schedule is exact rather than landing mid-window: this fake element does
    // not play on its own, so it only moves when the derived position has drifted past
    // `SEEK_TOLERANCE_SECONDS` (0.15). At 0.1 per frame the drift alternates 0.1 / 0.2, so
    // every even frame corrects and the tenth lands the element exactly on 1.0. At 1/60
    // the last correction falls short of the accumulator by a frame or two, which is
    // correct behaviour and a fixture that cannot state an exact number (§V147).
    for (let index = 0; index < 10; index += 1) {
      act(() =>
        (wiring as unknown as MediaWiring).sync({
          timeSeconds: 3,
          deltaSeconds: 0.1,
          frameIndex: 180,
          mode: "realtime",
          randomSeed: 1,
        }),
      );
    }

    // One second of accumulated delta at speed 1 is second 1.0 — and NOT 3, which is where
    // a timeline-locked clip would have been pinned on the very first frame and stayed for
    // all ten. Two exact, distinguishable numbers.
    expect(element.currentTime).toBeCloseTo(1, 6);
    expect(element.currentTime).not.toBeCloseTo(3, 6);
    expect(element.paused).toBe(false);
  });

  it("unregisters when the node goes away", async () => {
    const runtime = newRuntime();
    const { backend, registered, unregistered } = fakeBackend();
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("no still in this test")),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: () => Promise.resolve(fakeElement() as unknown as MediaElement),
    };

    const view = render(
      <Harness
        runtime={runtime}
        backend={backend}
        graph={graphWith({ cam: { type: "webcam" } })}
        environment={environment}
      />,
    );
    await waitFor(() => {
      expect(registered.size).toBe(1);
    });

    await act(async () => {
      view.rerender(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({})}
          environment={environment}
        />,
      );
    });

    expect(unregistered).toEqual([mediaSourceIdFor("cam")]);
    expect(registered.size).toBe(0);
  });
});

/**
 * §V136 — the frame id is what stops a 30 fps video uploading 60 times a second, so it
 * advances on DECODE and on nothing else.
 */
describe("a video media source only reports a new frame when there is one", () => {
  it("offers nothing before the first decoded frame", () => {
    const element = fakeElement();
    const media = createVideoMediaSource(element as unknown as MediaElement);
    expect(media.source.currentFrame()).toBeUndefined();
  });

  it("advances the frame id once per decoded frame, not once per ask", () => {
    const element = fakeElement();
    const media = createVideoMediaSource(element as unknown as MediaElement);

    element.emit("timeupdate");
    const first = media.source.currentFrame();
    expect(first?.frameId).toBe(1);
    // Asked again with nothing decoded in between: the SAME id, so the backend uploads
    // nothing. An implementation that counted calls would report 2 here.
    expect(media.source.currentFrame()?.frameId).toBe(1);

    element.emit("timeupdate");
    expect(media.source.currentFrame()?.frameId).toBe(2);
    // The element itself is handed over — `copyExternalImageToTexture` takes it directly,
    // so no pixel is ever read back to the CPU (§V7).
    expect(first?.image).toBe(element);
  });

  it("flags a stream that ended, and keeps offering its last frame", () => {
    const element = fakeElement();
    const media = createVideoMediaSource(element as unknown as MediaElement);
    element.emit("timeupdate");

    expect(media.source.ended).toBeFalsy();
    element.emit("ended");
    expect(media.source.ended).toBe(true);
    // The texture keeps its contents: a webcam that was unplugged holds its last picture
    // rather than going black.
    expect(media.source.currentFrame()?.frameId).toBe(1);
  });

  it("stops listening when disposed", () => {
    const element = fakeElement();
    const media = createVideoMediaSource(element as unknown as MediaElement);
    expect(element.listenerCount("timeupdate")).toBe(1);
    media.dispose();
    expect(element.listenerCount("timeupdate")).toBe(0);
    expect(element.listenerCount("ended")).toBe(0);
  });
});


/**
 * Text reaches the backend the same way a camera does (T243, T312, §V193).
 *
 * The node half declares an external texture and the backend uploads whatever is
 * registered under its sourceId — which is exactly the shape that shipped twice before
 * with nothing registering anything. So what is asserted here is the WIRING: that a Text
 * node in the document produces a registration under the key the compiler emits, that the
 * string and the colour reach the rasterizer, and that the size it draws at is the node's
 * RESOLVED size rather than the project's.
 */
describe("text sources reach the backend (T243)", () => {
  /** A text source that records what it was asked to draw, needing no canvas. */
  function recordingTextSource() {
    const updates: TextRaster[] = [];
    let disposed = false;
    const source: TextMediaSource = {
      source: { currentFrame: () => undefined },
      update(raster) {
        updates.push(raster);
      },
      dispose() {
        disposed = true;
      },
    };
    return { source, updates, wasDisposed: () => disposed };
  }

  const noMedia = (createTextSource: () => TextMediaSource): MediaEnvironment => ({
    openStill: () => Promise.reject(new Error("no still in this test")),
    openFile: () => Promise.reject(new Error("not used")),
    openCamera: () => Promise.reject(new Error("not used")),
    createTextSource,
  });

  it("registers under the compiler's key and draws at the node's RESOLVED size", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const recorder = recordingTextSource();

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({
            title: { type: "text", parameters: { text: "Hi", color: [1, 0, 0, 1] } },
          })}
          // Deliberately NOT the project resolution: T312's whole point is that a
          // generated source draws at the node's target extent, because
          // `copyExternalImageToTexture` asserts matching extents and a per-node
          // resolution override would otherwise fail the upload instead of scaling.
          resolved={{ outputs: [{ nodeId: "title", size: [320, 200] }] }}
          environment={noMedia(() => recorder.source)}
        />,
      );
    });

    await waitFor(() => {
      expect(registered.has(mediaSourceIdFor("title"))).toBe(true);
    });
    const last = recorder.updates.at(-1);
    expect(last?.text).toBe("Hi");
    expect([last?.width, last?.height]).toEqual([320, 200]);
    // Display space, straight from the picker: the decode to linear is the -srgb texture's
    // job at sample time, not this path's (§V56).
    expect(last?.color).toEqual([1, 0, 0, 1]);
  });

  it("draws nothing until the node has a resolved size", async () => {
    // Not compiled yet, or pruned. A node that renders nothing is exactly what a pruned
    // node should look like — and guessing the project resolution would produce a canvas
    // the target does not accept.
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const recorder = recordingTextSource();

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({ title: { type: "text", parameters: { text: "Hi" } } })}
          resolved={null}
          environment={noMedia(() => recorder.source)}
        />,
      );
    });

    await waitFor(() => {
      expect(registered.has(mediaSourceIdFor("title"))).toBe(true);
    });
    expect(recorder.updates).toEqual([]);
  });

  it("pushes an edited string without re-registering the source", async () => {
    // Typing changes content many times a second. Re-opening the source on every keystroke
    // would be the video path's cost model applied to the one node that does not need it —
    // and would drop a frame of black between every character.
    const runtime = newRuntime();
    const { backend, registered, unregistered } = fakeBackend();
    const recorder = recordingTextSource();
    const environment = noMedia(() => recorder.source);
    const resolved: ResolvedSizeSource = { outputs: [{ nodeId: "title", size: [320, 200] }] };

    const view = render(
      <Harness
        runtime={runtime}
        backend={backend}
        graph={graphWith({ title: { type: "text", parameters: { text: "a" } } })}
        resolved={resolved}
        environment={environment}
      />,
    );
    await waitFor(() => expect(registered.size).toBe(1));

    await act(async () => {
      view.rerender(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({ title: { type: "text", parameters: { text: "ab" } } })}
          resolved={resolved}
          environment={environment}
        />,
      );
    });

    expect(recorder.updates.map((update) => update.text)).toEqual(["a", "ab"]);
    expect(unregistered).toEqual([]);
  });

  it("unregisters and disposes when the node goes away", async () => {
    const runtime = newRuntime();
    const { backend, registered, unregistered } = fakeBackend();
    const recorder = recordingTextSource();

    const view = render(
      <Harness
        runtime={runtime}
        backend={backend}
        graph={graphWith({ title: { type: "text" } })}
        resolved={{ outputs: [{ nodeId: "title", size: [64, 64] }] }}
        environment={noMedia(() => recorder.source)}
      />,
    );
    await waitFor(() => expect(registered.size).toBe(1));

    await act(async () => {
      view.rerender(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({})}
          resolved={{ outputs: [] }}
          environment={noMedia(() => recorder.source)}
        />,
      );
    });

    expect(registered.size).toBe(0);
    expect(unregistered).toEqual([mediaSourceIdFor("title")]);
    expect(recorder.wasDisposed()).toBe(true);
  });
});

/**
 * ⚑ T1223 — A STILL IS A ONE-FRAME STREAM, and the node's description finally means it.
 *
 * `movieFileIn` opened with *"Plays a video or still image file"* since T493 while
 * `browserMediaEnvironment` called `document.createElement("video")` and nothing else — no
 * `createImageBitmap`, no image branch anywhere in `src/app` or `src/runtime`. A picked
 * PNG therefore produced BLACK with no diagnostic, which is the worst failure an
 * overclaiming description can produce: the user assumes their own mistake.
 *
 * These cases are about the seam the owner asked for — *"it shouldn't matter, image or
 * video"* — and the transparency is asserted as what it is: the SAME `MediaSource`
 * contract, a `frameId` that never advances (§V136 → uploaded exactly once), and no
 * transport at all.
 */
describe("a still loads as a one-frame stream (T1223)", () => {
  /** An `ImageBitmap` stand-in: three fields, no DOM, no decoder. */
  function fakeBitmap(width = 800, height = 600) {
    let closed = false;
    return {
      width,
      height,
      close() {
        closed = true;
      },
      wasClosed: () => closed,
    };
  }

  const stillEnvironment = (image: unknown, calls: string[] = []): MediaEnvironment => ({
    openStill: (url) => {
      calls.push(`still:${url}`);
      return Promise.resolve(image as never);
    },
    openFile: (url) => {
      calls.push(`video:${url}`);
      return Promise.reject(new Error("a still must not open the video door"));
    },
    openCamera: () => Promise.reject(new Error("not used")),
  });

  it("registers the picked image under the key the compiler emits, as frame 1", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const image = fakeBitmap();
    const calls: string[] = [];

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({
            photo: { type: "movieFileIn", parameters: { file: "blob:abc#holiday.png" } },
          })}
          environment={stillEnvironment(image, calls)}
        />,
      );
    });
    await waitFor(() => expect(registered.has(mediaSourceIdFor("photo"))).toBe(true));

    // The IMAGE door, not the video one. Before T1223 the second entry was the only one
    // that existed and it is what made a picked PNG black.
    expect(calls).toEqual(["still:blob:abc#holiday.png"]);

    const frame = registered.get(mediaSourceIdFor("photo"))?.currentFrame();
    // `frameId` 0 would mean "already uploaded" to the backend's cursor and the node would
    // hold black forever — the off-by-one that would make this feature look like the bug
    // it replaces.
    expect(frame?.frameId).toBe(1);
    // The bitmap itself reaches `copyExternalImageToTexture` untouched (§V7).
    expect(frame?.image).toBe(image);
  });

  /**
   * ⚑ THE CLAIM THE OWNER MADE — "played back as a continuous video stream… transparent
   * for anyone who consumes it" — and the §V136 claim, which are the same claim.
   *
   * A hundred frames later, through the same per-frame seam the frame loop drives, with a
   * transport that would have moved a video by fifty seconds: the source still answers the
   * IDENTICAL frame. An unchanged `frameId` is what tells the backend to upload nothing, so
   * "it looks the same" and "it uploaded once" are one assertion here, not two.
   */
  it("answers the identical frame forever, whatever the transport says", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const image = fakeBitmap();
    let wiring: MediaWiring | null = null;

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({
            photo: {
              type: "movieFileIn",
              // Every verb the transport has, set to something that would visibly move a
              // video: speed 4, free run, playing, trimmed, mirroring.
              parameters: {
                file: "blob:abc#holiday.png",
                playMode: "freeRun",
                play: true,
                speed: 4,
                trimStart: 1,
                trimEnd: 9,
                extend: "mirror",
              },
            },
          })}
          environment={stillEnvironment(image)}
          onWiring={(value) => {
            wiring = value;
          }}
        />,
      );
    });
    await waitFor(() => expect(registered.has(mediaSourceIdFor("photo"))).toBe(true));

    const source = registered.get(mediaSourceIdFor("photo")) as MediaSource;
    const first = source.currentFrame();
    act(() => {
      for (let index = 0; index < 100; index += 1) {
        (wiring as unknown as MediaWiring).sync({
          timeSeconds: index / 2,
          deltaSeconds: 1 / 2,
          frameIndex: index,
          mode: "realtime",
          randomSeed: 1,
        } as FrameEvaluationInput);
      }
    });
    const later = source.currentFrame();

    expect(later?.frameId).toBe(first?.frameId);
    expect(later?.image).toBe(first?.image);
    // §V136's consequence, stated as the number the backend actually compares.
    expect(later?.frameId).toBe(1);
  });

  /**
   * T312 / the resolution match, for a source whose size is known at DECODE time rather
   * than at `loadedmetadata`. `copyExternalImageToTexture` asserts matching extents, so a
   * still that did not push its size would fail the upload rather than scale.
   */
  it("makes the node the image's own size", async () => {
    const runtime = newRuntime();
    // Seeded through the bus, like the video case: the patch is written against the STORE,
    // so a node that only exists in a literal has nothing to set a resolution on.
    await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "seed",
        operations: [
          { op: "addNode", ref: "$photo", type: "movieFileIn", position: { x: 0, y: 0 } },
        ],
      },
      runtime.invocation,
    );
    const nodeId = Object.keys(runtime.bus.store.getGraph().nodes)[0];
    if (nodeId === undefined) throw new Error("expected a seeded movie node");
    await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "pick",
        operations: [
          {
            op: "setParameters",
            nodeId,
            parameters: { file: "blob:abc#ladybrand_2k.jpg" },
          },
        ],
      },
      runtime.invocation,
    );

    const { backend, registered } = fakeBackend();

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={runtime.bus.store.getGraph()}
          environment={stillEnvironment(fakeBitmap(2048, 1024))}
        />,
      );
    });
    await waitFor(() => expect(registered.has(mediaSourceIdFor(nodeId))).toBe(true));

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.resolution).toEqual({
        mode: "fixed",
        width: 2048,
        height: 1024,
      });
    });
  });

  /**
   * ⚠ §T1222's BOUNDARY, and the rule this whole task turns on: do not accept a format and
   * quietly hand back 8 bits. An EXR decoded into `rgba8unorm-srgb` is a very expensive
   * JPEG, so it is refused — and refused BY NAME, with the format and the fix in the
   * sentence, because "I picked my file and got a black frame" is the experience this task
   * exists to end.
   */
  it("refuses an EXR by name instead of decoding it into 8 bits", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const calls: string[] = [];
    let messages: readonly string[] = [];

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({
            env: {
              type: "movieFileIn",
              parameters: { file: "blob:abc#ladybrand_heritage_house_4k.exr" },
            },
          })}
          environment={stillEnvironment(fakeBitmap(), calls)}
          onDiagnostics={(value) => {
            messages = value;
          }}
        />,
      );
    });

    await waitFor(() => expect(messages.length).toBe(1));
    expect(messages[0]).toContain("env");
    expect(messages[0]).toContain("ladybrand_heritage_house_4k.exr");
    expect(messages[0]).toContain("OpenEXR");
    // NOT opened by either door: a refusal that still decoded would be the silent 8-bit
    // hand-back with a warning stapled on.
    expect(calls).toEqual([]);
    expect(registered.size).toBe(0);
  });

  it("names a still it cannot decode, rather than holding black", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    let messages: readonly string[] = [];
    const environment: MediaEnvironment = {
      openStill: () => Promise.reject(new Error("The source image type is not supported.")),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: () => Promise.reject(new Error("not used")),
    };

    await act(async () => {
      render(
        <Harness
          runtime={runtime}
          backend={backend}
          graph={graphWith({
            photo: { type: "movieFileIn", parameters: { file: "blob:abc#photo.heic" } },
          })}
          environment={environment}
          onDiagnostics={(value) => {
            messages = value;
          }}
        />,
      );
    });

    await waitFor(() => expect(messages.length).toBe(1));
    expect(messages[0]).toContain("photo");
    expect(messages[0]).toContain("could not be decoded");
    expect(registered.size).toBe(0);
  });

  /**
   * An `ImageBitmap` holds its decoded bytes until closed — a 4K still is ~32 MB. A
   * document swap that unregistered without closing would leak one per picked file, which
   * is invisible until the tab dies.
   */
  it("closes the decoded bitmap when the node goes away", async () => {
    const runtime = newRuntime();
    const { backend, registered, unregistered } = fakeBackend();
    const image = fakeBitmap();
    const environment = stillEnvironment(image);

    const view = render(
      <Harness
        runtime={runtime}
        backend={backend}
        graph={graphWith({
          photo: { type: "movieFileIn", parameters: { file: "blob:abc#holiday.png" } },
        })}
        environment={environment}
      />,
    );
    await waitFor(() => expect(registered.size).toBe(1));

    await act(async () => {
      view.rerender(
        <Harness runtime={runtime} backend={backend} graph={graphWith({})} environment={environment} />,
      );
    });

    expect(registered.size).toBe(0);
    expect(unregistered).toEqual([mediaSourceIdFor("photo")]);
    expect(image.wasClosed()).toBe(true);
  });
});

/**
 * ⚑ T1223 — `media.cue` ON A STILL REFUSES BY NAME, and does not report success.
 *
 * The first cut of this registered `cue: () => undefined` for a still so that `reload`
 * could ride along. That is exactly the shape §V369 forbids: the command would have
 * answered `applied` with `cued: 1` while nothing on screen moved, which is worse than the
 * unloaded-file case it already refuses for. `MediaControl.cue` is optional instead, so the
 * absence is the refusal — and the sentence names the still rather than sending the user
 * off to re-pick a file that is working fine.
 */
describe("the media pulses on a still (T1223, §V369)", () => {
  function CommandHarness({ runtime, controls }: { runtime: AppRuntime; controls: MediaControlRegistry }) {
    useMediaCommands(runtime.bus, controls);
    return null;
  }

  it("registers Reload but NOT Cue, and the command says which", async () => {
    const runtime = newRuntime();
    const { backend, registered } = fakeBackend();
    const controls = createMediaControlRegistry();
    const environment: MediaEnvironment = {
      openStill: () => Promise.resolve({ width: 32, height: 32 } as never),
      openFile: () => Promise.reject(new Error("not used")),
      openCamera: () => Promise.reject(new Error("not used")),
    };

    await act(async () => {
      render(
        <>
          <CommandHarness runtime={runtime} controls={controls} />
          <Harness
            runtime={runtime}
            backend={backend}
            graph={graphWith({
              photo: { type: "movieFileIn", parameters: { file: "blob:abc#holiday.png" } },
            })}
            environment={environment}
            controls={controls}
          />
        </>,
      );
    });
    await waitFor(() => expect(registered.size).toBe(1));

    // Reload is real work on a still — re-open and re-decode the file.
    expect(typeof controls.get("photo")?.reload).toBe("function");
    // Cue is not. Absent, rather than a no-op that would report success.
    expect(controls.get("photo")?.cue).toBeUndefined();

    const result = await runtime.bus.execute("media.cue", { nodeIds: ["photo"] }, runtime.invocation);
    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ cued: 0 });
    expect(result.diagnostics[0]?.message).toContain("photo");
    expect(result.diagnostics[0]?.message).toContain("still image");
    // §V403 — and NOT the "choose a file first" line, which would be false here.
    expect(result.diagnostics[0]?.suggestion).toContain("video file");

    // The other pulse still applies, which is what makes the refusal above a statement
    // about CUE rather than about stills being second-class.
    const reloaded = await runtime.bus.execute(
      "media.reload",
      { nodeIds: ["photo"] },
      runtime.invocation,
    );
    expect(reloaded.status).toBe("applied");
    expect(reloaded.output).toEqual({ reloaded: 1 });
  });
});
