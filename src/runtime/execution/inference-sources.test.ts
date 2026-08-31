import { describe, expect, it } from "vitest";
import {
  blocksForResult,
  createInferenceSources,
  type InferenceEntry,
} from "./inference-sources.ts";

/**
 * The async inference seam (T715/T384, §V585, §V586).
 *
 * These assert the SEMANTICS, not the plumbing: what a node's output means between
 * inferences, and that an unavailable accelerator degrades the rate without ever
 * degrading the contract. A test here that could still pass if "stale" quietly became
 * "blank" would be testing nothing worth testing.
 */

const GREY = 128;

function entry(nodeId: string, overrides: Partial<InferenceEntry> = {}): InferenceEntry {
  return {
    nodeId,
    inputResourceId: `${nodeId}:input`,
    sourceId: `infer:${nodeId}`,
    // Depth's identity: mid-grey, which `displace` reads as "no displacement".
    fallback: new Uint8Array([GREY, GREY, GREY, 255]),
    ...overrides,
  };
}

/** A model that echoes a byte the caller controls, so a result is traceable to its input. */
function echoRunner(log: string[] = []) {
  return {
    log,
    run: async (nodeId: string, input: ArrayBuffer): Promise<Uint8Array> => {
      log.push(nodeId);
      const first = new Uint8Array(input)[0] ?? 0;
      return new Uint8Array([first, first, first, 255]);
    },
  };
}

/** A readBuffer whose first byte is whatever the current frame was set to. */
function frameBuffer(byte: number): ArrayBuffer {
  return new Uint8Array([byte, 0, 0, 0]).buffer;
}

describe("the fill-policy predicate", () => {
  /**
   * The subtle version of this branch is `mode === "offline"`, and it would leave the
   * headless harness (fixed-step) and every Dawn gate on the STALE path while looking
   * correct. That is the reader-that-cannot-see failure this seam exists not to join,
   * so the predicate is asserted directly rather than only through its callers.
   */
  it("blocks for every mode that is not a real-time presentation", () => {
    expect(blocksForResult("realtime")).toBe(false);
    expect(blocksForResult("fixed-step")).toBe(true);
    expect(blocksForResult("offline")).toBe(true);
  });
});

describe("the contract holds without an accelerator", () => {
  /**
   * The owner's constraint, as an assertion. A document using an inference node must
   * LOAD AND RENDER on a machine that cannot run the model — just staler. If this test
   * can be made to pass by returning `undefined` here, the node has a hole in its
   * declared output type and documents stop being portable.
   */
  it("publishes the identity fallback before any result exists", () => {
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(1),
      run: async () => new Uint8Array([9, 9, 9, 255]),
    });
    sources.track([entry("depth1")]);

    const frame = sources.currentFrame("depth1");

    expect(frame).toBeDefined();
    expect([...frame!.bytes]).toEqual([GREY, GREY, GREY, 255]);
    expect(sources.ready("depth1")).toBe(false);
  });

  it("reports no age for a node that has never produced a result", () => {
    // Reporting 0 would claim a fresh result exists. The absence of a row is the honest
    // answer, and it is what lets the UI distinguish "not ready" from "up to date".
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(1),
      run: async () => new Uint8Array([1]),
    });
    sources.track([entry("depth1")]);

    expect(sources.resultAges(10)).toEqual([]);
  });

  it("keeps serving the previous result when a run fails, rather than blanking", () => {
    // "Stale beats stalled" (§V144) has a second half that matters more here: stale also
    // beats BLANK. A model that fails on frame 40 must not make the picture vanish.
    return (async () => {
      let fail = false;
      const sources = createInferenceSources({
        readBuffer: async () => frameBuffer(7),
        run: async () => {
          if (fail) throw new Error("model not acquired");
          return new Uint8Array([7, 7, 7, 255]);
        },
      });
      sources.track([entry("depth1")]);

      await sources.settle(0);
      expect([...sources.currentFrame("depth1")!.bytes]).toEqual([7, 7, 7, 255]);

      fail = true;
      await sources.settle(1);

      // The value survived the failure, and its AGE now tells the truth about it.
      expect([...sources.currentFrame("depth1")!.bytes]).toEqual([7, 7, 7, 255]);
      expect(sources.resultAges(1)).toEqual([{ nodeId: "depth1", ageFrames: 1 }]);
    })();
  });
});

describe("the non-realtime fill policy is reproducible", () => {
  /**
   * §V586's whole claim: offline BLOCKS, so the take does not depend on when a result
   * arrived. If this drifts, the same project renders differently twice and every
   * pixel-exact gate over a document with an inference node becomes a coin flip.
   */
  it("resolves with a result computed from THIS frame, at age zero", async () => {
    let currentByte = 0;
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(currentByte),
      ...echoRunner(),
    });
    sources.track([entry("depth1")]);

    for (const frameIndex of [0, 1, 2]) {
      currentByte = 10 + frameIndex;
      await sources.settle(frameIndex);

      expect([...sources.currentFrame("depth1")!.bytes]).toEqual([
        10 + frameIndex,
        10 + frameIndex,
        10 + frameIndex,
        255,
      ]);
      expect(sources.resultAges(frameIndex)).toEqual([{ nodeId: "depth1", ageFrames: 0 }]);
    }
  });

  it("renders the same bytes for the same frames across two independent runs", async () => {
    // Run-to-run determinism on one machine, which is what blocking buys. It is NOT
    // machine-to-machine determinism — different backends give different numbers for the
    // same input — and that is why gates replay a RECORDED result rather than running a
    // model. This asserts the half that blocking actually delivers.
    const take = async (): Promise<number[]> => {
      let currentByte = 0;
      const sources = createInferenceSources({
        readBuffer: async () => frameBuffer(currentByte),
        ...echoRunner(),
      });
      sources.track([entry("depth1")]);
      const out: number[] = [];
      for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
        currentByte = frameIndex * 3;
        await sources.settle(frameIndex);
        out.push(sources.currentFrame("depth1")!.bytes[0]!);
      }
      return out;
    };

    expect(await take()).toEqual(await take());
  });

  it("does not satisfy a frame with a run issued for an earlier one", async () => {
    // The recorder's backlog lesson: a capture that completes late encodes the WRONG
    // pixels. A settle that accepted an in-flight run from frame N-1 would stamp it as
    // frame N and silently reproduce a shifted take.
    let currentByte = 0;
    const gate: { release: (() => void) | null } = { release: null };
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(currentByte),
      run: async (_nodeId, input) => {
        const first = new Uint8Array(input)[0] ?? 0;
        if (first === 1) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return new Uint8Array([first, first, first, 255]);
      },
    });
    sources.track([entry("depth1")]);

    currentByte = 1;
    sources.sample(0); // live, fire-and-forget — still running
    await Promise.resolve();

    currentByte = 2;
    const settled = sources.settle(1);
    // Let the stalled frame-0 run finish; frame 1 must then run for itself.
    while (gate.release === null) await Promise.resolve();
    gate.release();
    await settled;

    expect([...sources.currentFrame("depth1")!.bytes]).toEqual([2, 2, 2, 255]);
    expect(sources.resultAges(1)).toEqual([{ nodeId: "depth1", ageFrames: 0 }]);
  });
});

describe("the live fill policy never stalls the frame loop", () => {
  it("returns before the model resolves, leaving the last result standing", async () => {
    // §V184: a stall is invisible in a test and fatal in a 60Hz loop. `sample` must be
    // synchronous in effect — it issues work and returns, and the picture keeps whatever
    // it had. The assertion is that the value is UNCHANGED at the moment sample returns.
    const gate: { resolve: ((bytes: Uint8Array) => void) | null } = { resolve: null };
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(5),
      run: () =>
        new Promise<Uint8Array>((resolve) => {
          gate.resolve = resolve;
        }),
    });
    sources.track([entry("depth1")]);

    sources.sample(0);
    expect([...sources.currentFrame("depth1")!.bytes]).toEqual([GREY, GREY, GREY, 255]);

    while (gate.resolve === null) await Promise.resolve();
    gate.resolve(new Uint8Array([5, 5, 5, 255]));
    await Promise.resolve();
    await Promise.resolve();

    expect([...sources.currentFrame("depth1")!.bytes]).toEqual([5, 5, 5, 255]);
  });

  it("does not pile up runs for a node whose model is slower than the frame rate", async () => {
    // The unbounded-latency case that separates this from `analyze`. Sixty samples
    // against a model that has not answered must issue ONE run, or a slow model becomes
    // a queue that grows until the tab dies.
    const runner = echoRunner();
    const gate: { resolve: ((bytes: Uint8Array) => void) | null } = { resolve: null };
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(1),
      run: (nodeId) => {
        runner.log.push(nodeId);
        return new Promise<Uint8Array>((resolve) => {
          gate.resolve = resolve;
        });
      },
    });
    sources.track([entry("depth1")]);

    for (let frameIndex = 0; frameIndex < 60; frameIndex += 1) {
      sources.sample(frameIndex);
      await Promise.resolve();
    }

    expect(runner.log).toEqual(["depth1"]);

    while (gate.resolve === null) await Promise.resolve();
    gate.resolve(new Uint8Array([1, 1, 1, 255]));
  });

  it("reports a growing age while a slow result is outstanding", async () => {
    // The visible half of the owner's constraint. A degraded RATE must be readable as a
    // number, not merely survivable — §V469: a swallowed refusal is worse than a slow one.
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(3),
      ...echoRunner(),
    });
    sources.track([entry("depth1")]);

    await sources.settle(0);
    expect(sources.resultAges(0)).toEqual([{ nodeId: "depth1", ageFrames: 0 }]);
    expect(sources.resultAges(6)).toEqual([{ nodeId: "depth1", ageFrames: 6 }]);
    expect(sources.resultAges(120)).toEqual([{ nodeId: "depth1", ageFrames: 120 }]);
  });
});

describe("uploads and tracking", () => {
  it("bumps the upload generation only when the bytes change", async () => {
    // §V136: media uploads on frame-ready, never per render frame. A stale result asked
    // for sixty times a second must re-upload nothing, or the seam costs a texture copy
    // per frame for a value that did not move.
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(4),
      ...echoRunner(),
    });
    sources.track([entry("depth1")]);

    await sources.settle(0);
    const first = sources.currentFrame("depth1")!.frameId;
    expect(sources.currentFrame("depth1")!.frameId).toBe(first);
    expect(sources.currentFrame("depth1")!.frameId).toBe(first);

    await sources.settle(1);
    expect(sources.currentFrame("depth1")!.frameId).toBe(first + 1);
  });

  it("drops a node's result when it leaves the tracked set", async () => {
    // A renamed or deleted node whose stamp survived would report an age for bytes
    // nobody can read — and, worse, a later node reusing the id would inherit them.
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(8),
      ...echoRunner(),
    });
    sources.track([entry("depth1")]);
    await sources.settle(0);
    expect(sources.ready("depth1")).toBe(true);

    sources.track([]);

    expect(sources.ready("depth1")).toBe(false);
    expect(sources.resultAges(0)).toEqual([]);
    expect(sources.currentFrame("depth1")).toBeUndefined();
  });

  it("serves each tracked node its own result", async () => {
    const sources = createInferenceSources({
      readBuffer: async (resourceId) => frameBuffer(resourceId.startsWith("a") ? 1 : 2),
      ...echoRunner(),
    });
    sources.track([entry("a"), entry("b")]);

    await sources.settle(0);

    expect(sources.currentFrame("a")!.bytes[0]).toBe(1);
    expect(sources.currentFrame("b")!.bytes[0]).toBe(2);
  });
});
