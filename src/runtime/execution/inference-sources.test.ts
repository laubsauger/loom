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

/**
 * Drain the fire-and-forget runs `sample` issues.
 *
 * `runOnce` awaits a readback and then a model, so a single `await Promise.resolve()`
 * lands mid-run and a test that used one would be asserting on a half-finished state —
 * which is how a cadence test goes green while the cadence does nothing.
 */
/** A promise this test resolves by hand, so "in flight" is a state it can hold open. */
function deferred() {
  let resolve: (value: Uint8Array) => void = () => undefined;
  const promise = new Promise<Uint8Array>((r) => {
    resolve = r;
  });
  return { promise, resolve: (value: Uint8Array) => resolve(value) };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
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

  it("keeps the REASON a run failed, so a held model that cannot run is not silent", async () => {
    /*
     * B156. Keeping the previous value on a failure is right for the picture (§V144) and
     * was the whole story: the reason went into an empty `catch` and nowhere else. A
     * document whose depth model downloaded and then could not start a session therefore
     * rendered mid-grey with nothing anywhere saying why — pixel-for-pixel the state of a
     * machine that never downloaded it, which is the pair §B156 could not tell apart.
     */
    let fail = true;
    const sources = createInferenceSources({
      readBuffer: async () => frameBuffer(9),
      run: async () => {
        if (fail) throw new Error("no ExecutionProvider bound");
        return new Uint8Array([9, 9, 9, 255]);
      },
    });
    sources.track([entry("depth1")]);

    await sources.settle(0);
    expect(sources.ready("depth1")).toBe(false);
    expect(sources.lastFailure("depth1")).toBe("no ExecutionProvider bound");
    // The contract still holds while it is failing — the node publishes its identity.
    expect(sources.currentFrame("depth1")!.bytes[0]).toBe(GREY);

    // And a success CLEARS it. A reason that outlived the failure would leave an error on
    // screen over a document that is working, which is the opposite defect.
    fail = false;
    await sources.settle(1);
    expect(sources.ready("depth1")).toBe(true);
    expect(sources.lastFailure("depth1")).toBeUndefined();
  });

  /**
   * §T384'S FRESHNESS POLICY, AS A PARAMETER (T965).
   *
   * The rate limit and the hold were hidden constants — "run whenever a run is not in
   * flight" — and §T384 says that is a decision rather than a detail. These assert the two
   * things a cadence knob must get right, and the second is the one that is easy to miss:
   * a cap belongs to LIVE playback, and a freeze belongs to the DOCUMENT, so `settle`
   * honours one and ignores the other. Get that backwards and either an export renders a
   * thinner animation than the screen showed, or a frozen depth map silently thaws in the
   * take.
   */
  describe("§T384 — the rate limit and the hold", () => {
    it("starts at most one run per interval, measured on the TIMELINE clock", async () => {
      const runner = echoRunner();
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(1), ...runner });
      sources.track([entry("depth1", { minIntervalSeconds: 0.5 })]);

      sources.sample(0, 0);
      await settled();
      sources.sample(1, 0.1);
      sources.sample(2, 0.4);
      await settled();
      // Inside the gap: exactly the first run, and no silent second.
      expect(runner.log).toEqual(["depth1"]);

      sources.sample(3, 0.6);
      await settled();
      expect(runner.log).toEqual(["depth1", "depth1"]);
    });

    it("does not lock a node out when the timeline LOOPS backwards", async () => {
      // A cap implemented as "now - last < gap" with no direction check would stop running
      // entirely for one whole lap after a loop, which reads as the model dying.
      const runner = echoRunner();
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(1), ...runner });
      sources.track([entry("depth1", { minIntervalSeconds: 5 })]);

      sources.sample(0, 10);
      await settled();
      sources.sample(1, 0);
      await settled();
      expect(runner.log).toHaveLength(2);
    });

    it("leaves an UNCAPPED entry exactly as it was", async () => {
      const runner = echoRunner();
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(1), ...runner });
      sources.track([entry("depth1")]);
      sources.sample(0, 0);
      await settled();
      sources.sample(1, 0.001);
      await settled();
      expect(runner.log).toHaveLength(2);
    });

    it("HOLDS after the first result — and keeps publishing it, never blank", async () => {
      let level = 1;
      const sources = createInferenceSources({
        readBuffer: async () => frameBuffer(level),
        run: async () => new Uint8Array([level, level, level, 255]),
      });
      sources.track([entry("depth1", { hold: true })]);

      sources.sample(0, 0);
      await settled();
      expect(sources.currentFrame("depth1")!.bytes[0]).toBe(1);

      level = 9;
      sources.sample(1, 1);
      await settled();
      // Frozen, not stopped: the node still publishes, and its age grows to say so.
      expect(sources.currentFrame("depth1")!.bytes[0]).toBe(1);
      expect(sources.resultAges(5)[0]?.ageFrames).toBe(5);
    });

    it("a HELD node still computes its FIRST result, so it is stale by choice not blank", async () => {
      const runner = echoRunner();
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(3), ...runner });
      sources.track([entry("depth1", { hold: true })]);
      await sources.settle(0);
      expect(sources.ready("depth1")).toBe(true);
      expect(sources.currentFrame("depth1")!.bytes[0]).toBe(3);
    });

    it("SETTLE ignores the rate limit and honours the hold — §V586's split", async () => {
      // The cap is a comfort setting about this machine, so an export must not inherit it:
      // a take renders every frame or it is not reproducible. The hold is part of the
      // DOCUMENT, so an export that re-ran it would render a different document.
      const capped = echoRunner();
      const cappedSources = createInferenceSources({
        readBuffer: async () => frameBuffer(1),
        ...capped,
      });
      cappedSources.track([entry("depth1", { minIntervalSeconds: 60 })]);
      await cappedSources.settle(0);
      await cappedSources.settle(1);
      expect(capped.log).toHaveLength(2);

      const frozen = echoRunner();
      const frozenSources = createInferenceSources({
        readBuffer: async () => frameBuffer(1),
        ...frozen,
      });
      frozenSources.track([entry("depth1", { hold: true })]);
      await frozenSources.settle(0);
      await frozenSources.settle(1);
      expect(frozen.log).toHaveLength(1);
    });
  });

  /**
   * §T976 — THE TIMING, PUBLISHED AS CHANNELS.
   *
   * The owner asked for a CHOP-style readout AND for smoothing to compensate when the
   * rate is low, and those are one feature: a fixed lerp is a constant pretending to know
   * the lag. So these assert the numbers a lerp would be DRIVEN by, at exact values —
   * a "it changed" assertion would pass on a resolver returning the frame index.
   */
  describe("§T976 — the timing channels", () => {
    /*
     * The ABSOLUTE clock, and the timeline one deliberately set to something ELSE.
     *
     * §T495's field, read through `absTimeSecondsOf`. If the resolver ever slipped back to
     * `timeSeconds` the delay assertions below would come out wrong rather than merely
     * equal — a fixture that set both to the same number would go green on the bug.
     */
    const frameAt = (frameIndex: number, seconds: number) =>
      ({ frameIndex, timeSeconds: seconds * 1000 + 7, absTimeSeconds: seconds } as never);
    const ask = (
      sources: ReturnType<typeof createInferenceSources>,
      channel: string,
      frameIndex: number,
      seconds: number,
    ) => sources.resolver(channel, { frame: frameAt(frameIndex, seconds) } as never);

    it("`ready` means A RESULT LANDED, never `the model downloaded`", async () => {
      // The load-bearing one: it is what a source switch reads, and a model that is
      // present but has produced nothing must read NOT ready — otherwise the switch flips
      // to a node still publishing its neutral fallback, which is §B156's pair arriving
      // in a consumer that cannot tell them apart either.
      const gate = deferred();
      const sources = createInferenceSources({
        readBuffer: async () => frameBuffer(1),
        run: async () => gate.promise,
      });
      sources.track([entry("depth1", { channel: "depth1" })]);

      sources.sample(0, 0);
      await settled();
      // Tracked, sampling, in flight — and NOT ready.
      expect(ask(sources, "depth1:ready", 0, 0)).toBe(0);

      gate.resolve(new Uint8Array([7, 7, 7, 255]));
      await settled();
      expect(ask(sources, "depth1:ready", 1, 1)).toBe(1);
    });

    it("reports the lag in FRAMES and in SECONDS, from the frame the result was computed for", async () => {
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(1), ...echoRunner() });
      sources.track([entry("depth1", { channel: "depth1" })]);
      sources.sample(10, 100);
      await settled();

      // Asked about frame 16 at t=100.5: six frames and half a second after the result.
      expect(ask(sources, "depth1:lagFrames", 16, 100.5)).toBe(6);
      expect(ask(sources, "depth1:delaySeconds", 16, 100.5)).toBeCloseTo(0.5);
      // At the frame it was computed for, the lag is zero — which is what an offline take
      // reads by construction, because `settle` blocks for THIS frame's result (§V586).
      expect(ask(sources, "depth1:lagFrames", 10, 100)).toBe(0);
    });

    it("measures fps and the realtime factor from TWO clocks, not from a setting", async () => {
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(1), ...echoRunner() });
      sources.track([entry("depth1", { channel: "depth1" })]);

      // One result is not a rate. Reporting one would be inventing a denominator.
      sources.sample(0, 0);
      await settled();
      expect(ask(sources, "depth1:fps", 0, 0)).toBe(0);
      expect(ask(sources, "depth1:realtimeFactor", 0, 0)).toBe(0);

      // Frames every 0.1 s; the second result lands 0.4 s after the first.
      sources.sample(1, 0.1);
      await settled();
      sources.sample(2, 0.2);
      await settled();
      sources.sample(3, 0.3);
      await settled();
      sources.sample(4, 0.4);
      await settled();
      expect(ask(sources, "depth1:fps", 4, 0.4)).toBeCloseTo(10, 5);
      // 0.1 s a frame against 0.1 s an inference: keeping up exactly.
      expect(ask(sources, "depth1:realtimeFactor", 4, 0.4)).toBeCloseTo(1, 5);
    });

    it("REFUSES a channel it does not own, so a typo is not a silent zero", async () => {
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(1), ...echoRunner() });
      sources.track([entry("depth1", { channel: "depth1" })]);
      await sources.settle(0);

      // An unknown FIELD and an unknown NODE both fall through to the next resolver. A 0
      // here would turn `depth1:lagFrmes` into a number a document would happily use.
      expect(ask(sources, "depth1:lagFrmes", 0, 0)).toBeUndefined();
      expect(ask(sources, "other:ready", 0, 0)).toBeUndefined();
      // And a bare name is ANALYZE's namespace, never this one.
      expect(ask(sources, "depth1", 0, 0)).toBeUndefined();
    });

    it("answers zero, WITH `ready` zero beside it, before the first result", async () => {
      // §T715 says a node with no result reports no AGE rather than 0. A channel cannot
      // express absence — `undefined` is an UNKNOWN CHANNEL and fails the expression — so
      // `ready` carries it instead, and this asserts the pairing that makes it honest.
      const sources = createInferenceSources({
        readBuffer: async () => frameBuffer(1),
        run: async () => new Promise<Uint8Array>(() => undefined),
      });
      sources.track([entry("depth1", { channel: "depth1" })]);
      expect(ask(sources, "depth1:ready", 5, 5)).toBe(0);
      expect(ask(sources, "depth1:lagFrames", 5, 5)).toBe(0);
      expect(ask(sources, "depth1:fps", 5, 5)).toBe(0);
      expect(ask(sources, "depth1:delaySeconds", 5, 5)).toBe(0);
    });

    it("publishes NOTHING for an unnamed node rather than under a name nobody can type", async () => {
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(1), ...echoRunner() });
      sources.track([entry("depth1")]);
      await sources.settle(0);
      expect(ask(sources, "depth1:ready", 0, 0)).toBeUndefined();
    });
  });

  /**
   * §T978 — the recovery gesture's half of the state.
   */
  describe("§T978 — reset", () => {
    it("forgets ONE node's result, so `ready` goes false and the fallback returns", async () => {
      const sources = createInferenceSources({ readBuffer: async () => frameBuffer(4), ...echoRunner() });
      sources.track([entry("a", { channel: "a" }), entry("b", { channel: "b" })]);
      await sources.settle(0);
      expect(sources.ready("a")).toBe(true);
      expect(sources.ready("b")).toBe(true);

      sources.reset("a");

      expect(sources.ready("a")).toBe(false);
      // Back to the identity, so the document still renders while it recomputes.
      expect(sources.currentFrame("a")!.bytes[0]).toBe(GREY);
      // ⚠ And ONLY that node: the pulse is on one node, so a `track([])` would be the
      // wrong blast radius (§V126's lesson, one seam over).
      expect(sources.ready("b")).toBe(true);
    });

    it("lets a HELD node compute again — a freeze must not survive its own reset", async () => {
      let level = 1;
      const sources = createInferenceSources({
        readBuffer: async () => frameBuffer(level),
        run: async () => new Uint8Array([level, level, level, 255]),
      });
      sources.track([entry("depth1", { hold: true, channel: "depth1" })]);
      await sources.settle(0);
      expect(sources.currentFrame("depth1")!.bytes[0]).toBe(1);

      level = 9;
      await sources.settle(1);
      expect(sources.currentFrame("depth1")!.bytes[0]).toBe(1);

      // Hold means "keep the one you computed". Reset says there is no longer one.
      sources.reset("depth1");
      await sources.settle(2);
      expect(sources.currentFrame("depth1")!.bytes[0]).toBe(9);
    });
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
