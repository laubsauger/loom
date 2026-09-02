// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GraphDocument } from "@domain/types/graph.ts";
import type { MediaSource, LoomBackend } from "@runtime/backend/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { MediaElement } from "./media-sources.ts";
import type { MediaEnvironment } from "./use-media-sources.ts";
import { useMediaSources } from "./use-media-sources.ts";

/**
 * T577 — a MUTED or BYPASSED media node does not DECODE.
 *
 * The owner's shape from T555, one subsystem further along. Muting a `movieFileIn` already
 * removed both of its outputs: no sound, because `browserMediaEnvironment` creates every
 * element `muted = true`, and no picture, because the compiler drops a muted node from the
 * plan (T250). What it did not remove was the WORK — the `<video>` kept decoding frames
 * for a texture nobody uploads, which is §V504's "a muted node is not cooked" being true
 * of everything except the expensive part.
 *
 * ## The gate is the ELEMENT, not the request list
 *
 * A test asserting only that `mediaRequests` dropped the node would pass while the decoder
 * ran on: the element was already open, and taking it off the list unregisters the source
 * without touching the thing that is doing the work. `createVideoMediaSource.dispose()`
 * unhooks the frame callback and returns — it never paused anything. So the assertions
 * below are on the element the hook actually opened: it was playing, and after the mute it
 * is PAUSED. Both halves are load-bearing and each fails on its own.
 *
 * BYPASS is the same silence for the same reason as T555: all three media types declare
 * `inputs: []`, so a bypassed one has nothing to pass through, and nothing to pass is off.
 * That assumption is gated below rather than commented (§V437).
 */

afterEach(cleanup);

/** A `<video>` stand-in that records whether it is running. Mirrors the T264 harness. */
function fakeElement() {
  const listeners = new Map<string, Set<() => void>>();
  const element = {
    videoWidth: 640,
    videoHeight: 360,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    currentTime: 0,
    playbackRate: 1,
    duration: 12,
    // The environment hands over an element that is ALREADY playing (`openFile` kicks
    // `play()` before it resolves), so this starts where a real one starts.
    paused: false,
    play() {
      element.paused = false;
    },
    pause() {
      element.paused = true;
    },
  };
  return element;
}

function fakeBackend() {
  const registered = new Map<string, MediaSource>();
  const backend = {
    registerMediaSource(sourceId: string, source: MediaSource) {
      registered.set(sourceId, source);
      return () => registered.delete(sourceId);
    },
  } as unknown as LoomBackend;
  return { backend, registered };
}

function movieGraph(ui?: { muted?: boolean; bypassed?: boolean }): GraphDocument {
  return {
    revision: 1,
    groups: {},
    edges: {},
    nodes: {
      movie: {
        id: "movie",
        type: "movieFileIn",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { file: "clip.mp4" },
        ...(ui === undefined ? {} : { ui }),
      },
    },
  } as unknown as GraphDocument;
}

function Harness({
  runtime,
  backend,
  graph,
  environment,
}: {
  runtime: AppRuntime;
  backend: LoomBackend | null;
  graph: GraphDocument;
  environment: MediaEnvironment;
}) {
  useMediaSources(runtime, backend, graph, null, environment);
  return null;
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

function harnessFor() {
  const element = fakeElement();
  let opens = 0;
  const environment: MediaEnvironment = {
    openFile: () => {
      opens += 1;
      return Promise.resolve(element as unknown as MediaElement);
    },
    openCamera: () => Promise.reject(new Error("not used")),
  };
  return { element, environment, opens: () => opens };
}

describe("T577 — muting a movie node stops the DECODE, not just the picture", () => {
  it("never opens the file for a node that is already muted", async () => {
    const { backend, registered } = fakeBackend();
    const { environment, opens } = harnessFor();

    await act(async () => {
      render(
        <Harness
          runtime={newRuntime()}
          backend={backend}
          graph={movieGraph({ muted: true })}
          environment={environment}
        />,
      );
    });

    // Nothing opened and nothing registered: the node is off, so it is not a candidate at
    // all — the same shape as T555's silenced audio source, not a second rule.
    expect(opens()).toBe(0);
    expect(registered.size).toBe(0);
  });

  it("is ON when nothing says otherwise, so an ordinary movie still decodes", async () => {
    // NON-VACUITY for every case here: the same fixture with no flag does all the work.
    const { backend, registered } = fakeBackend();
    const { element, environment, opens } = harnessFor();

    await act(async () => {
      render(
        <Harness
          runtime={newRuntime()}
          backend={backend}
          graph={movieGraph()}
          environment={environment}
        />,
      );
    });

    await waitFor(() => expect(registered.has(mediaSourceIdFor("movie"))).toBe(true));
    expect(opens()).toBe(1);
    expect(element.paused).toBe(false);
  });

  it("PAUSES an element that is already running when the node is muted", async () => {
    const { backend, registered } = fakeBackend();
    const { element, environment } = harnessFor();
    const runtime = newRuntime();
    const backendRef = backend;

    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const result = render(
        <Harness runtime={runtime} backend={backendRef} graph={movieGraph()} environment={environment} />,
      );
      rerender = result.rerender;
    });
    await waitFor(() => expect(registered.has(mediaSourceIdFor("movie"))).toBe(true));
    expect(element.paused).toBe(false);

    await act(async () => {
      rerender(
        <Harness
          runtime={runtime}
          backend={backendRef}
          graph={movieGraph({ muted: true })}
          environment={environment}
        />,
      );
    });

    // Unregistered — the texture goes away — AND stopped. Only the first of those two
    // held before T577: `dispose()` unhooks the frame callback and leaves the decoder
    // running, so "off" cost exactly as much as "on".
    await waitFor(() => expect(registered.size).toBe(0));
    expect(element.paused).toBe(true);
  });

  it("treats BYPASSED the same, because a source has nothing to pass through", async () => {
    const { backend, registered } = fakeBackend();
    const { environment, opens } = harnessFor();

    await act(async () => {
      render(
        <Harness
          runtime={newRuntime()}
          backend={backend}
          graph={movieGraph({ bypassed: true })}
          environment={environment}
        />,
      );
    });

    expect(opens()).toBe(0);
    expect(registered.size).toBe(0);
  });
});

/**
 * The assumption `isSilencedSource` makes, gated rather than commented (§V437) — the media
 * twin of T555's own gate.
 *
 * It answers "is this node off" from the flags alone, which is only sound for a node with
 * NO INPUTS: that is where bypass unambiguously means silence, because there is nothing to
 * pass through. All three media types are such nodes today. If one grows an input
 * tomorrow, this reddens and whoever added it decides what bypass means there before the
 * media path can keep using the cheap answer.
 */
describe("T577 — the media sources really are inputless sources", () => {
  it("movieFileIn, webcam and text declare no inputs", () => {
    for (const type of ["movieFileIn", "webcam", "text"]) {
      const definition = allNodeDefinitions.find((entry) => entry.type === type);
      expect(definition, `${type} is gone from the registry`).toBeDefined();
      expect(
        definition?.inputs,
        `${type} grew an input; bypass no longer trivially means silence`,
      ).toEqual([]);
    }
  });
});
