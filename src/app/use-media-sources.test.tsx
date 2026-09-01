// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { MediaSource, ShaderloomBackend } from "@runtime/backend/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
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
  } as unknown as ShaderloomBackend;
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
}: {
  runtime: AppRuntime;
  backend: ShaderloomBackend | null;
  graph: GraphDocument;
  environment: MediaEnvironment;
  /** Resolved output sizes (T312). Omitted where the test is only about video wiring. */
  resolved?: ResolvedSizeSource | null;
  onDiagnostics?: (messages: readonly string[]) => void;
  /** T493: the per-frame seam, so a test can drive a frame the way the loop does. */
  onWiring?: (wiring: MediaWiring) => void;
}) {
  const media = useMediaSources(runtime, backend, graph, resolved ?? null, environment);
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
