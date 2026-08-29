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
import type { MediaEnvironment } from "./use-media-sources.ts";
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
  onDiagnostics,
}: {
  runtime: AppRuntime;
  backend: ShaderloomBackend | null;
  graph: GraphDocument;
  environment: MediaEnvironment;
  onDiagnostics?: (messages: readonly string[]) => void;
}) {
  const media = useMediaSources(runtime, backend, graph, environment);
  onDiagnostics?.(media.diagnostics.map((entry) => entry.message));
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
