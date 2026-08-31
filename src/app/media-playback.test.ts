import { describe, expect, it } from "vitest";

import {
  SEEK_TOLERANCE_SECONDS,
  applyMediaPlayhead,
  createMediaTransportRunner,
  durationOf,
  playableMedia,
  type PlayableMedia,
} from "./media-playback.ts";
import { createMediaControlRegistry } from "./media-commands.ts";
import { MEDIA_OPEN_TIMEOUT_MS, awaitMediaReady } from "./media-sources.ts";
import { mediaPlayhead, type MediaTransportValues } from "@domain/media/transport.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";

/**
 * T493 — THE REACH: does the transport actually move a `<video>`?
 *
 * This file exists because of the class of bug this codebase has hit six times (B12, B23,
 * T264, B87 …): a feature built, unit-tested and never wired, with every suite green. The
 * arithmetic is gated next door in `domain/media/transport.test.ts`; what is gated HERE is
 * that a resolved parameter reaches an element, and that the element is corrected only
 * when it has actually drifted.
 */

const BASE: MediaTransportValues = {
  playMode: "timeline",
  play: true,
  speed: 1,
  cue: false,
  cuePoint: 0,
  trimStart: 0,
  trimEnd: 0,
  extend: "loop",
};

/** A `<video>`'s observable surface, and a log of what was done to it. */
function fakeElement(duration = 10, at = 0) {
  const calls: string[] = [];
  let paused = true;
  let currentTime = at;
  const element: PlayableMedia & { readonly calls: readonly string[] } = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      calls.push(`seek:${value}`);
    },
    playbackRate: 1,
    get duration() {
      return duration;
    },
    get paused() {
      return paused;
    },
    play() {
      paused = false;
      calls.push("play");
    },
    pause() {
      paused = true;
      calls.push("pause");
    },
    calls,
  };
  return element;
}

describe("T493 — the element is corrected on DRIFT, not every frame", () => {
  it("plays and does not seek while it is already where the playhead says", () => {
    const element = fakeElement(10, 3);
    const seeked = applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 3, 10));
    expect(seeked).toBe(false);
    expect(element.calls).toEqual(["play"]);
  });

  it("tolerates a small drift — otherwise every decode hiccup re-seeks the decoder", () => {
    const element = fakeElement(10, 3);
    const drift = SEEK_TOLERANCE_SECONDS / 2;
    expect(applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 3 + drift, 10))).toBe(false);
    expect(element.calls.filter((call) => call.startsWith("seek"))).toEqual([]);
  });

  it("corrects a large drift to EXACTLY the derived position", () => {
    const element = fakeElement(10, 3);
    applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 7.5, 10));
    expect(element.currentTime).toBe(7.5);
  });

  it("A LAP is that same correction, with no special case: 9.9 → 0.4 is one seek", () => {
    const element = fakeElement(10, 9.9);
    // t = 10.4 into a 10s window: the derived position has wrapped to 0.4.
    applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 10.4, 10));
    expect(element.currentTime).toBeCloseTo(0.4, 10);
  });

  it("carries SPEED to the element's own playbackRate rather than seeking per frame", () => {
    const element = fakeElement(10, 0);
    const fast = { ...BASE, speed: 2 };
    applyMediaPlayhead(element, fast, mediaPlayhead(fast, 0, 10));
    expect(element.playbackRate).toBe(2);
  });

  it("clamps a rate the browser would refuse instead of throwing at it", () => {
    const element = fakeElement(10, 0);
    const crawl = { ...BASE, speed: 0.001 };
    applyMediaPlayhead(element, crawl, mediaPlayhead(crawl, 0, 10));
    expect(element.playbackRate).toBe(0.0625);
  });
});

describe("T493 — held states PAUSE the element, because the position no longer advances with it", () => {
  it("a cue pauses and lands on the exact point, with no tolerance", () => {
    const element = fakeElement(10, 3);
    const cued = { ...BASE, cue: true, cuePoint: 3.05 };
    applyMediaPlayhead(element, cued, mediaPlayhead(cued, 99, 10));
    expect(element.paused).toBe(true);
    // Inside the drift tolerance, and still seeked: a cue is a scrub, and a scrub that
    // lands "close enough" is the wrong frame.
    expect(element.currentTime).toBe(3.05);
  });

  it("a NEGATIVE speed pauses and steps by hand — no browser plays a reverse rate", () => {
    const element = fakeElement(10, 0);
    const back = { ...BASE, speed: -1 };
    applyMediaPlayhead(element, back, mediaPlayhead(back, 1, 10));
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(9);
    expect(element.playbackRate).toBe(1);
  });

  it("a stopped FREE-RUN transport holds; a stopped play under the LOCK does not (it is inactive)", () => {
    const stopped = { ...BASE, playMode: "freeRun" as const, play: false };
    const freeRun = fakeElement(10, 2);
    applyMediaPlayhead(freeRun, stopped, mediaPlayhead(stopped, 2, 10));
    expect(freeRun.paused).toBe(true);

    // Same `play: false`, locked to the timeline: §V146 says the control cannot act, and
    // the element must therefore keep running with the timeline that is still running.
    const locked = fakeElement(10, 2);
    const lockedTransport = { ...BASE, play: false };
    applyMediaPlayhead(locked, lockedTransport, mediaPlayhead(lockedTransport, 2, 10));
    expect(locked.paused).toBe(false);
  });

  it("an extend:black window past its end goes silent AND stops", () => {
    const element = fakeElement(10, 9);
    const black = { ...BASE, extend: "black" as const };
    const head = mediaPlayhead(black, 13, 10);
    expect(head.visible).toBe(false);
    applyMediaPlayhead(element, black, head);
    expect(element.paused).toBe(true);
  });
});

describe("T493 — the runner reads the node's REAL parameters, through the real resolver", () => {
  const registry = createNodeRegistry(allNodeDefinitions);
  const frame = (timeSeconds: number): FrameEvaluationInput => ({
    timeSeconds,
    deltaSeconds: 1 / 60,
    frameIndex: Math.round(timeSeconds * 60),
    mode: "realtime",
    randomSeed: 1,
  });

  const graphWith = (parameters: Record<string, unknown>): GraphDocument =>
    ({
      revision: 1,
      nodes: {
        m: {
          id: "m",
          type: "movieFileIn",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters,
        },
      },
      edges: {},
    }) as unknown as GraphDocument;

  const runnerFor = (graph: GraphDocument) =>
    createMediaTransportRunner("m", {
      graph: () => graph,
      registry,
      channels: () => undefined,
    });

  it("a node with NO transport parameters stored reads the manifest default, which T586 moved to free run", () => {
    const stepped = runnerFor(graphWith({})).step(frame(2), 10);
    expect(stepped?.transport.playMode).toBe("freeRun");
  });

  /**
   * T586's CONSEQUENCE, which is the assertion that matters — "the default is free run"
   * is trivially true the moment the literal is edited and would pass on a flip that did
   * nothing (§V461: a fixture must be able to distinguish what it asserts).
   *
   * The owner's actual complaint is that a freshly dropped-in file DOES NOTHING until the
   * timeline runs. So: hold the TIMELINE clock still — `timeSeconds` never moves, which is
   * exactly a stopped transport — and feed real frame deltas. A free-run node advances
   * anyway; a timeline-locked one is pinned. Under T493's default this test reads 0.
   */
  it("a freshly instantiated node advances its playhead with the TIMELINE STOPPED — the owner's ask", () => {
    const runner = runnerFor(graphWith({}));
    // Same `timeSeconds` every frame: the timeline is not moving. Only the delta is real.
    const stopped = (): FrameEvaluationInput => ({ ...frame(0), deltaSeconds: 1 / 60 });
    const positions = [1, 2, 3, 4].map(() => runner.step(stopped(), 10)?.head.position ?? -1);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1] as number);
    }
    expect(positions[3]).toBeCloseTo(4 / 60, 6);
  });

  it("...and under the LOCK the same node is pinned, which is the cost the flip buys off", () => {
    // The counter-example that proves the test above is measuring the mode and not the
    // clock: identical frames, `playMode` opted back to the lock, and nothing moves.
    const runner = runnerFor(graphWith({ playMode: "timeline" }));
    const stopped = (): FrameEvaluationInput => ({ ...frame(0), deltaSeconds: 1 / 60 });
    const positions = [1, 2, 3, 4].map(() => runner.step(stopped(), 10)?.head.position ?? -1);
    expect(positions).toEqual([0, 0, 0, 0]);
  });

  /*
   * The parameter-plumbing trio below pins `playMode: "timeline"` EXPLICITLY. They are
   * about §V107 — that a static, an expression and a driven value each reach the playhead
   * — and they used to lean on the default to make `elapsed === frame.timeSeconds`. T586
   * moved that default out from under them, which is the right lesson to bank: a test
   * whose arithmetic depends on a mode should say which mode.
   */

  it("a STATIC speed reaches the playhead", () => {
    const stepped = runnerFor(graphWith({ speed: 3, playMode: "timeline" })).step(frame(2), 10);
    expect(stepped?.head.position).toBe(6);
  });

  it("an EXPRESSION on trimStart reaches it too — every mode, like everything else (§V107)", () => {
    // The assertion that the transport is not a bespoke widget: nothing in the transport
    // code knows what an expression is, and one works anyway.
    const stepped = runnerFor(
      graphWith({
        playMode: "timeline",
        trimStart: {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "1 + 2" } },
        },
      }),
    ).step(frame(0.5), 10);
    expect(stepped?.head.start).toBe(3);
    expect(stepped?.head.position).toBe(3.5);
  });

  it("a DRIVEN speed reaches it through the value graph's resolver", () => {
    const graph = graphWith({
      playMode: "timeline",
      speed: { mode: "driven", bindings: { driven: { kind: "driven", channel: "rate" } } },
    });
    const runner = createMediaTransportRunner("m", {
      graph: () => graph,
      registry,
      channels: () => (channel) => (channel === "rate" ? 4 : undefined),
    });
    expect(runner.step(frame(2), 10)?.head.position).toBe(8);
  });

  it("a node that has been DELETED steps to null rather than throwing into the frame loop", () => {
    const runner = createMediaTransportRunner("gone", {
      graph: () => graphWith({}),
      registry,
      channels: () => undefined,
    });
    expect(runner.step(frame(1), 10)).toBeNull();
  });
});

describe("T493 — the structural element checks", () => {
  it("playableMedia rejects a webcam-shaped element that cannot seek", () => {
    expect(playableMedia({ videoWidth: 640, videoHeight: 480 })).toBeNull();
    expect(playableMedia(null)).toBeNull();
    expect(playableMedia(fakeElement())).not.toBeNull();
  });

  it("durationOf reports 0 for the states a browser uses before metadata arrives", () => {
    expect(durationOf({ duration: Number.NaN })).toBe(0);
    expect(durationOf({ duration: Infinity })).toBe(0);
    expect(durationOf({})).toBe(0);
    expect(durationOf({ duration: 12.5 })).toBe(12.5);
  });
});

describe("T493 — the control registry is what makes the two pulses reach either door", () => {
  it("registers, resolves and releases by node id", () => {
    const registry = createMediaControlRegistry();
    const fired: string[] = [];
    const release = registry.register("m", {
      cue: () => fired.push("cue"),
      reload: () => fired.push("reload"),
    });
    expect(registry.ids()).toEqual(["m"]);
    registry.get("m")?.cue();
    expect(fired).toEqual(["cue"]);
    release();
    expect(registry.get("m")).toBeUndefined();
    expect(registry.ids()).toEqual([]);
  });

  it("a release from a SUPERSEDED registration does not evict the live one", () => {
    // The remount case: the effect re-runs, registers again, and only then tears the old
    // one down. Without the identity check that teardown deletes the new registration and
    // the node's pulses go dead with nothing on screen saying why (B87's shape).
    const registry = createMediaControlRegistry();
    const stale = registry.register("m", { cue: () => undefined, reload: () => undefined });
    const live = { cue: () => undefined, reload: () => undefined };
    registry.register("m", live);
    stale();
    expect(registry.get("m")).toBe(live);
  });
});

/**
 * T493, §V369 — A FILE THAT WILL NOT OPEN MUST SAY SO.
 *
 * Found by looking at the running app (§V383), not by a test: `openFile` awaited
 * `video.play()`, and a `play()` on a source that never decodes stays PENDING FOREVER —
 * it neither resolves nor rejects, because nothing tells the browser that playback will
 * never begin. The open loop therefore stranded BEFORE `registerMediaSource`, the node
 * held black, and the diagnostic that was written to name it never ran. Exactly the
 * "refuse by name rather than silently hold black" case T493 was told to close.
 */
describe("T493 — awaitMediaReady refuses by name instead of hanging (§V369)", () => {
  function openable(readyState = 0) {
    const listeners = new Map<string, Set<() => void>>();
    return {
      readyState,
      error: null as { code?: number } | null,
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
  }

  it("resolves on loadedmetadata, and stops listening afterwards", async () => {
    const element = openable();
    const ready = awaitMediaReady(element);
    element.emit("loadedmetadata");
    await expect(ready).resolves.toBeUndefined();
    expect(element.listenerCount("loadedmetadata")).toBe(0);
    expect(element.listenerCount("error")).toBe(0);
  });

  it("rejects on a decode error, naming the code", async () => {
    const element = openable();
    element.error = { code: 4 };
    const ready = awaitMediaReady(element);
    element.emit("error");
    await expect(ready).rejects.toThrow(/could not be decoded \(code 4\)/);
  });

  it("TIMES OUT rather than hanging — the whole point, since `play()` never settles", async () => {
    const element = openable();
    let fire: (() => void) | null = null;
    const ready = awaitMediaReady(element, 250, (callback) => {
      fire = callback;
      return 1;
    });
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();
    await expect(ready).rejects.toThrow(/Timed out after 250ms/);
    // And it let go of the element, so a late `loadedmetadata` cannot resolve a settled
    // promise or leak a listener onto a source nobody is waiting for any more.
    expect(element.listenerCount("loadedmetadata")).toBe(0);
  });

  it("does not wait at all when metadata is ALREADY there", async () => {
    // The fast path, and the one a naive event-only version hangs on forever: a cached
    // file can be at HAVE_METADATA before anyone attaches a listener, and the event that
    // would have resolved it has already been and gone.
    const element = openable(1);
    await expect(awaitMediaReady(element)).resolves.toBeUndefined();
    expect(element.listenerCount("loadedmetadata")).toBe(0);
  });

  it("ships a stated timeout rather than an unbounded wait", () => {
    expect(MEDIA_OPEN_TIMEOUT_MS).toBe(10_000);
  });
});
