import { describe, expect, it } from "vitest";

import { createAnalyzeChannels } from "./analyze-channels.ts";
import type { AnalyzeEntry } from "./analyze-channels.ts";
import type { NodeId } from "../../domain/types/ids.ts";

/**
 * §V329's FIRST HALF, at exact values (T645, T644).
 *
 * "An async result in a per-frame graph must expose its staleness." Analyze has published a
 * latest-wins number since T236 and exposed NO age at all — `latest` was a `Map<string,
 * number>` and nothing anywhere recorded which frame a number came from. So a parameter
 * driven by an Analyze showed a value from an unknown number of frames ago, which is
 * §V147's family exactly: plausible and wrong.
 *
 * §V144's contract is "one frame late", and the numbers below are chosen where a plausible
 * wrong implementation gives a DIFFERENT number rather than a differently-shaped one: an
 * age stamped at LANDING rather than at issue reads 0 forever, an age counted in samples
 * rather than frames reads 1 forever, and an age that survives a `track` reads a number for
 * a channel nobody can resolve. Each of those is a specific integer here.
 */

const ENTRY: AnalyzeEntry = {
  channel: "meter",
  nodeId: "meter1" as NodeId,
  resourceId: "scratch:meter1:result",
  operation: "average",
};

/** A readback that resolves on demand, so a test controls exactly when a value lands. */
function pendingReads() {
  const queue: Array<(raw: ArrayBuffer) => void> = [];
  const channels = createAnalyzeChannels({
    readBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        queue.push(resolve);
      }),
  });
  return {
    channels,
    /** Complete the oldest outstanding read with `value` as the average. */
    async land(value: number) {
      const resolve = queue.shift();
      if (resolve === undefined) throw new Error("no read was outstanding");
      resolve(new Float32Array([value, value, value, 1]).buffer);
      await Promise.resolve();
      await Promise.resolve();
    },
    outstanding: () => queue.length,
  };
}

describe("T645 — Analyze exposes the AGE of the value it is publishing (§V329)", () => {
  it("reports no age at all until a readback has actually completed", async () => {
    const { channels } = pendingReads();
    channels.track([ENTRY]);

    channels.sample(10);
    // Issued, not landed. There is no value either, and reporting `0` here would say the
    // opposite of the truth — that the node is showing this frame's reduction.
    expect(channels.resolver("meter", {} as never)).toBeUndefined();
    expect(channels.resultAges(10)).toEqual([]);
  });

  it("reads 1 the frame after the read was issued — §V144's contract, as a number", async () => {
    const read = pendingReads();
    read.channels.track([ENTRY]);

    read.channels.sample(10);
    await read.land(0.25);

    expect(read.channels.resolver("meter", {} as never)).toBeCloseTo(0.25, 6);
    // The value reduces frame 10; frame 11 is rendering; it is one frame behind.
    expect(read.channels.resultAges(11)).toEqual([{ nodeId: "meter1", ageFrames: 1 }]);
    // Stamped at ISSUE, not at landing: an implementation that stamped when the promise
    // resolved would have no idea which frame the buffer holds and would read 0 here.
    expect(read.channels.resultAges(10)).toEqual([{ nodeId: "meter1", ageFrames: 0 }]);
  });

  it("GROWS while a readback does not land — the case §V329 exists for", async () => {
    const read = pendingReads();
    read.channels.track([ENTRY]);

    read.channels.sample(10);
    await read.land(0.25);
    // Frames keep running and the next read never completes: `inFlight` skips the buffer,
    // §V144 leaves the previous value standing, and THIS is the number that was invisible.
    read.channels.sample(11);
    expect(read.channels.resultAges(40)).toEqual([{ nodeId: "meter1", ageFrames: 30 }]);
    // The value is unchanged and perfectly plausible. Only the age says it is 30 frames old.
    expect(read.channels.resolver("meter", {} as never)).toBeCloseTo(0.25, 6);
  });

  it("a FAILED read keeps the old value AND its old age, rather than resetting either", async () => {
    const queue: Array<(reason: Error) => void> = [];
    const values: Array<(raw: ArrayBuffer) => void> = [];
    const channels = createAnalyzeChannels({
      readBuffer: () =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          if (values.length === 0) values.push(resolve);
          else queue.push(reject);
        }),
    });
    channels.track([ENTRY]);

    channels.sample(5);
    values[0]?.(new Float32Array([0.5, 0.5, 0.5, 1]).buffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(channels.resultAges(6)).toEqual([{ nodeId: "meter1", ageFrames: 1 }]);

    channels.sample(6);
    queue.shift()?.(new Error("plan mid-swap"));
    await Promise.resolve();
    await Promise.resolve();
    // Still frame 5's reduction, now two frames behind — which is exactly what a user
    // needs to see when a device is recovering and the picture stopped updating.
    expect(channels.resultAges(7)).toEqual([{ nodeId: "meter1", ageFrames: 2 }]);
  });

  it("drops the age with the value when the node stops being tracked", async () => {
    const read = pendingReads();
    read.channels.track([ENTRY]);
    read.channels.sample(3);
    await read.land(0.5);
    expect(read.channels.resultAges(4)).toHaveLength(1);

    // A deleted or renamed Analyze. An age that outlived its value would report staleness
    // for a number nothing can resolve (§V421's rot, one field down).
    read.channels.track([]);
    expect(read.channels.resultAges(4)).toEqual([]);
    expect(read.channels.resolver("meter", {} as never)).toBeUndefined();
  });
});
