import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_PLANS, createWorkerCore, type InferenceSessionLike } from "./inference-worker-core.ts";
import { MODEL_SIGNATURES, signatureFor } from "./model-signatures.ts";
import { MATTE_RVM } from "./model-catalogue.ts";
import { refusalFor } from "./model-acquisition.ts";
import { weightPatchFor } from "./model-patch.ts";
import type { InferenceResponse } from "./inference-protocol.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §V861 — THE PICTURE IS THE ONE THE MODEL NAMES, NOT THE ONE AT INDEX 0
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * RVM declares `[fgr, pha, r1o, r2o, r3o, r4o]`. `fgr` is the three-channel COLOUR
 * foreground; `pha` is the alpha the matte node wants. The worker read `outputNames[0]`.
 *
 * What makes this worth a file of its own is that the wrong read DOES NOT FAIL. The matte
 * encoder walks `side × side` floats out of whatever it is handed, so `fgr` resamples into
 * a correctly-shaped, finite, plausible-looking picture — a wrong matte that looks like a
 * matte. Every gate that checks dimensions, byte counts, "a result arrived", coverage or
 * centroid stays GREEN through it. §V864 already established that coverage cannot see a
 * holed matte; it cannot see this either.
 *
 * So the assertions here are per-pixel, and they are about what an ALPHA IS:
 *
 *   - it equals the named plane, texel for texel;
 *   - it is BIMODAL — an alpha is mostly "yes" and "no", with a thin soft edge — while a
 *     colour channel is a continuous field. That is the property colour cannot fake, and
 *     it is measured on the real artefact in the last block of this file, not assumed:
 *     `pha` puts 72.5% of its pixels below 0.01 and 6.2% in the 0.1-0.9 band; `fgr`'s red
 *     channel puts 5.9% below 0.01 and 87.0% in that band, and the two agree within 0.05
 *     on 9.5% of pixels.
 *
 * The fake session below takes its NAMES from `model-signatures.ts`, which is extracted
 * from the real `.onnx` — §V742's rule, and the reason this gate can disagree with the
 * code rather than merely echo it.
 */

const SIDE = 4;
const PIXELS = SIDE * SIDE;

/**
 * A real alpha: opaque right half, transparent left. Bimodal by construction, because
 * that is the property being gated.
 */
const PHA = Float32Array.from({ length: PIXELS }, (_, i) => (i % SIDE < SIDE / 2 ? 0 : 1));

/**
 * A real colour foreground: three continuous planes, every value in the soft band and
 * NONE at 0 or 1 — so if the worker ever reads index 0 again, both assertions below fail
 * rather than one of them squeaking through.
 */
const FGR = Float32Array.from({ length: 3 * PIXELS }, (_, i) => 0.3 + (i % 17) * 0.025);

interface Recorded {
  readonly feeds: Record<string, unknown>;
}

/** State tensors carrying a per-run marker, so "was it fed back" is answerable exactly. */
function stateFor(run: number): Record<string, { data: Float32Array; marker: string }> {
  return {
    r1o: { data: new Float32Array([run]), marker: `r1o#${run}` },
    r2o: { data: new Float32Array([run]), marker: `r2o#${run}` },
    r3o: { data: new Float32Array([run]), marker: `r3o#${run}` },
    r4o: { data: new Float32Array([run]), marker: `r4o#${run}` },
  };
}

function rvmSession(runs: Recorded[]): InferenceSessionLike {
  const signature = signatureFor(MATTE_RVM.id);
  if (signature === undefined) throw new Error("no recorded signature for RVM");
  let run = 0;
  return {
    inputNames: [...signature.inputs],
    outputNames: [...signature.outputs],
    run: async (feeds) => {
      runs.push({ feeds });
      run += 1;
      return { fgr: { data: FGR }, pha: { data: PHA }, ...stateFor(run) } as never;
    },
  };
}

function rvmCore(runs: Recorded[]) {
  const posted: InferenceResponse[] = [];
  const tensors: Array<{ type: string; data: readonly number[]; dims: readonly number[] }> = [];
  const instance = createWorkerCore({
    isolated: true,
    createSession: async () => rvmSession(runs),
    createTensor: (type, data, dims) => {
      const made = { type, data: [...data], dims };
      tensors.push(made);
      return made;
    },
    post: (response) => posted.push(response),
  });
  return { posted, tensors, instance };
}

const KEY = "rvm@wasm";

async function load(core: ReturnType<typeof rvmCore>): Promise<void> {
  await core.instance.handle({
    kind: "load",
    modelId: MATTE_RVM.id,
    sessionKey: KEY,
    weights: new ArrayBuffer(4),
    providers: ["wasm"],
  });
}

async function run(
  core: ReturnType<typeof rvmCore>,
  options: { requestId: number; ratio?: number; smoothing?: number },
): Promise<void> {
  await core.instance.handle({
    kind: "run",
    requestId: options.requestId,
    sessionKey: KEY,
    nodeType: "matte",
    modelId: MATTE_RVM.id,
    texels: new ArrayBuffer(PIXELS * 4 * 4),
    width: SIDE,
    height: SIDE,
    side: SIDE,
    sourceWidth: SIDE,
    sourceHeight: SIDE,
    ratio: options.ratio ?? 0.5,
    smoothing: options.smoothing ?? MODEL_PLANS[MATTE_RVM.id]!.smoothing,
  });
}

/** The published matte, as the floats a consumer reads back. */
function published(core: ReturnType<typeof rvmCore>, requestId: number): Float32Array {
  const result = core.posted.find(
    (message) => message.kind === "result" && message.requestId === requestId,
  );
  if (result === undefined || result.kind !== "result") {
    const failure = core.posted.find((message) => message.kind === "error");
    throw new Error(
      `no result for ${requestId}` +
        (failure !== undefined && failure.kind === "error" ? `: ${failure.message}` : ""),
    );
  }
  return new Float32Array(result.bytes);
}

/** What separates an alpha from a colour plane: the shape of its distribution. */
function distribution(values: Float32Array) {
  let extreme = 0;
  let soft = 0;
  for (const value of values) {
    if (value < 0.01 || value > 0.99) extreme += 1;
    if (value > 0.1 && value < 0.9) soft += 1;
  }
  return { extreme: extreme / values.length, soft: soft / values.length };
}

describe("§V861 — the matte node publishes the alpha RVM names, never its index 0", () => {
  it("publishes `pha` texel for texel, and NOT the colour plane at index 0", async () => {
    const runs: Recorded[] = [];
    const core = rvmCore(runs);
    await load(core);
    await run(core, { requestId: 1 });

    // (1) THE VALUES. Not "a picture came back" — the picture, per texel.
    expect([...published(core, 1)]).toEqual([...PHA]);

    // (2) THE PROPERTY, so this still means something if the fixture is ever rewritten:
    // an alpha is bimodal, a colour channel is continuous. Measured on the real weights
    // (see the block at the foot of this file) an alpha sits at 91% extreme / 6% soft and
    // the foreground's red channel at 6% / 87%; the fixture keeps that separation.
    const matte = distribution(published(core, 1));
    expect(matte).toEqual({ extreme: 1, soft: 0 });

    // (3) AND WHAT THE BUG WOULD HAVE PUBLISHED, spelled out — the plane an index read
    // hands over is finite, correctly shaped, and a completely different picture. This is
    // the assertion that a dimension check or a byte count could never make.
    const wouldHaveBeen = FGR.subarray(0, PIXELS);
    expect(distribution(wouldHaveBeen)).toEqual({ extreme: 0, soft: 1 });
    expect([...wouldHaveBeen]).not.toEqual([...PHA]);
  });

  it("refuses loudly if the named output is absent, rather than falling back to index 0", async () => {
    const core = {
      posted: [] as InferenceResponse[],
      instance: createWorkerCore({
        isolated: true,
        createSession: async () => ({
          inputNames: ["src", "r1i", "r2i", "r3i", "r4i", "downsample_ratio"],
          // A build that dropped `pha` — the exact shape a silent index fallback would
          // paper over by publishing the foreground instead.
          outputNames: ["fgr"],
          run: async () => ({ fgr: { data: FGR } }),
        }),
        createTensor: (type, data, dims) => ({ type, data, dims }),
        post: (response: InferenceResponse) => core.posted.push(response),
      }),
    };
    await core.instance.handle({
      kind: "load",
      modelId: MATTE_RVM.id,
      sessionKey: KEY,
      weights: new ArrayBuffer(4),
      providers: ["wasm"],
    });
    await core.instance.handle({
      kind: "run",
      requestId: 9,
      sessionKey: KEY,
      nodeType: "matte",
      modelId: MATTE_RVM.id,
      texels: new ArrayBuffer(PIXELS * 4 * 4),
      width: SIDE,
      height: SIDE,
      side: SIDE,
      sourceWidth: SIDE,
      sourceHeight: SIDE,
      ratio: 0.5,
      smoothing: 1,
    });
    const failure = core.posted.find((message) => message.kind === "error");
    expect(failure?.kind === "error" && failure.message).toContain('no "pha"');
  });
});

describe("the recurrent state is fed back, and that is what makes RVM RVM", () => {
  it("feeds zero state on the FIRST frame and the previous run's tensors after", async () => {
    const runs: Recorded[] = [];
    const core = rvmCore(runs);
    await load(core);
    await run(core, { requestId: 1 });
    await run(core, { requestId: 2 });
    await run(core, { requestId: 3 });

    // Frame one has no memory: RVM's own documented [1,1,1,1] zero tensor per slot.
    for (const slot of ["r1i", "r2i", "r3i", "r4i"]) {
      expect(runs[0]!.feeds[slot]).toEqual({ type: "float32", data: [0], dims: [1, 1, 1, 1] });
    }
    // Frames two and three carry the PREVIOUS run's outputs, by identity — the loop is
    // closed, and cutting it is what this asserts. Markers rather than shapes, because a
    // zero tensor and a state tensor can have the same shape and mean opposite things.
    expect(runs[1]!.feeds["r1i"]).toMatchObject({ marker: "r1o#1" });
    expect(runs[1]!.feeds["r4i"]).toMatchObject({ marker: "r4o#1" });
    expect(runs[2]!.feeds["r1i"]).toMatchObject({ marker: "r1o#2" });
    expect(runs[2]!.feeds["r3i"]).toMatchObject({ marker: "r3o#2" });
  });

  it("feeds the ratio RVM asked for, on the input the plan names", async () => {
    const runs: Recorded[] = [];
    const core = rvmCore(runs);
    await load(core);
    await run(core, { requestId: 1, ratio: 0.375 });
    expect(runs[0]!.feeds["downsample_ratio"]).toEqual({
      type: "float32",
      data: [0.375],
      dims: [1],
    });
  });

  it("drops the stash when the ratio moves, because the state changes SHAPE with it", async () => {
    // 0.38 MB of state at ratio 0.25 against 6.13 MB at 1.0 — measured. Feeding the old
    // one after the dial moves hands the model tensors it refuses, which would surface as
    // an error on the frame after a user touched a control.
    const runs: Recorded[] = [];
    const core = rvmCore(runs);
    await load(core);
    await run(core, { requestId: 1, ratio: 0.5 });
    await run(core, { requestId: 2, ratio: 0.5 });
    await run(core, { requestId: 3, ratio: 1 });
    await run(core, { requestId: 4, ratio: 1 });

    expect(runs[1]!.feeds["r1i"]).toMatchObject({ marker: "r1o#1" });
    // The ratio changed: back to zero state for one frame, then the loop resumes.
    expect(runs[2]!.feeds["r1i"]).toEqual({ type: "float32", data: [0], dims: [1, 1, 1, 1] });
    expect(runs[3]!.feeds["r1i"]).toMatchObject({ marker: "r1o#3" });
  });
});

describe("the EMA is the MODEL's default, not a constant in the worker", () => {
  it("leaves RVM's matte untouched across frames, because its plan asks for no smoothing", async () => {
    const runs: Recorded[] = [];
    const core = rvmCore(runs);
    await load(core);
    await run(core, { requestId: 1 });
    await run(core, { requestId: 2 });
    // Identical input every frame, so an EMA would be invisible here — which is why the
    // fixture's alpha is bimodal: a blend of 0 and 1 lands in the soft band and shows.
    expect([...published(core, 2)]).toEqual([...PHA]);
    expect(MODEL_PLANS[MATTE_RVM.id]!.smoothing).toBe(1);
    expect(MODEL_PLANS["modnet-photographic"]!.smoothing).toBe(0.55);
  });

  it("still smooths RVM when a user asks it to, so the knob is not decorative", async () => {
    const runs: Recorded[] = [];
    const core = rvmCore(runs);
    await load(core);
    // Frame one seeds the average; frame two blends toward the same value and so stays put.
    // The observable difference is that the EMA path RUNS — proven by feeding a first
    // frame of a different shape below.
    await run(core, { requestId: 1, smoothing: 0.5 });
    await run(core, { requestId: 2, smoothing: 0.5 });
    // Both frames are the same picture, so a correct EMA is a no-op on the values — the
    // point of the assertion is that it is a no-op rather than a corruption.
    expect([...published(core, 2)]).toEqual([...PHA]);
  });
});

describe("the declaration table agrees with the artefacts it stands for", () => {
  it("names a picture output every model actually declares", () => {
    // The typo gate. A `picture` that is not among the artefact's own outputs is caught
    // here rather than as a black node on a screen.
    for (const signature of MODEL_SIGNATURES) {
      const plan = MODEL_PLANS[signature.modelId];
      expect({ id: signature.modelId, hasPlan: plan !== undefined }).toEqual({
        id: signature.modelId,
        hasPlan: true,
      });
      expect(signature.outputs).toContain(plan!.picture);
    }
  });

  it("wires feedback between names the artefact declares, in the right direction", () => {
    for (const signature of MODEL_SIGNATURES) {
      const plan = MODEL_PLANS[signature.modelId]!;
      for (const [outputSlot, inputSlot] of Object.entries(plan.feedback ?? {})) {
        // Direction matters and is easy to write backwards: the OUTPUT feeds the INPUT.
        expect(signature.outputs).toContain(outputSlot);
        expect(signature.inputs).toContain(inputSlot);
      }
      if (plan.ratioInput !== undefined) expect(signature.inputs).toContain(plan.ratioInput);
    }
  });

  it("keeps RVM's picture DIFFERENT from its index 0, which is the whole point", () => {
    const signature = signatureFor(MATTE_RVM.id)!;
    expect(signature.outputs[0]).toBe("fgr");
    expect(MODEL_PLANS[MATTE_RVM.id]!.picture).toBe("pha");
    expect(MODEL_PLANS[MATTE_RVM.id]!.picture).not.toBe(signature.outputs[0]);
  });

  it("no longer refuses WebGPU, and names the patch that replaced the refusal (T1084)", () => {
    // This used to assert the opposite, and the flip is the point of T1084. RVM's WebGPU
    // session CREATES and then every run throws on a `ceil_mode` attribute the provider
    // rejects — invisible to a ladder that walks providers by creating them, which is why
    // the static refusal existed. It is gone because the cause is gone: the attribute is
    // cleared in memory before the session is built.
    expect(refusalFor(MATTE_RVM, "webgpu")).toBeUndefined();
    expect(refusalFor(MATTE_RVM, "wasm")).toBeUndefined();

    // But the guarantee has to live SOMEWHERE, or removing the row is just forgetting.
    // It moved to the patch, which is the thing that can actually fail on a user's
    // machine — and which takes the rung off the ladder itself when it does.
    const patch = weightPatchFor(MATTE_RVM.id);
    expect(patch).toBeDefined();
    expect(patch?.requiredFor).toContain("webgpu");
  });
});

/**
 * The half that makes the fixture above trustworthy rather than merely self-consistent.
 *
 * Everything before this point agrees with a fake, and a fake agrees with whoever wrote
 * it (§V742). This runs the REAL weights and asserts the claim the hermetic gate is built
 * on: that `pha` and `fgr` are different KINDS of picture, so the per-pixel property is a
 * property of the artefact and not of the fixture. Skipped where the file is not present,
 * because 15 MB of weights is not a thing to download per suite.
 */
const MODEL_DIR = process.env["SHADERLOOM_MODEL_DIR"];
const RVM_FILE = MODEL_DIR === undefined ? undefined : join(MODEL_DIR, "matte-rvm.onnx");

describe.skipIf(RVM_FILE === undefined || !existsSync(RVM_FILE))(
  "the real RVM weights say what the fixture claims",
  () => {
    it("returns a BIMODAL pha and a CONTINUOUS fgr from one real inference", async () => {
      const ort = (await import("onnxruntime-web")).default;
      ort.env.logLevel = "error";
      const session = await ort.InferenceSession.create(readFileSync(RVM_FILE!), {
        executionProviders: ["wasm"],
      });
      expect(session.outputNames[0]).toBe("fgr");
      expect(session.outputNames).toContain("pha");

      const side = 256;
      const src = new Float32Array(3 * side * side);
      // A subject-shaped block on a flat ground: enough for a matting model to produce a
      // real alpha, and nothing like a natural colour field.
      for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
          const inside = x > side * 0.3 && x < side * 0.7 && y > side * 0.2;
          for (let c = 0; c < 3; c += 1) {
            src[c * side * side + y * side + x] = inside ? 0.85 : 0.12;
          }
        }
      }
      const zero = () => new ort.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]);
      const outputs = await session.run({
        src: new ort.Tensor("float32", src, [1, 3, side, side]),
        r1i: zero(),
        r2i: zero(),
        r3i: zero(),
        r4i: zero(),
        downsample_ratio: new ort.Tensor("float32", new Float32Array([0.5]), [1]),
      });

      const pha = outputs["pha"]!.data as Float32Array;
      const fgr = outputs["fgr"]!.data as Float32Array;
      expect(pha.length).toBe(side * side);
      expect(fgr.length).toBe(3 * side * side);

      // THE CLAIM: an alpha is mostly decided, a colour plane is mostly not.
      const alpha = distribution(pha);
      const colour = distribution(fgr.subarray(0, side * side));
      expect(alpha.extreme).toBeGreaterThan(0.8);
      expect(alpha.soft).toBeLessThan(0.15);
      expect(colour.soft).toBeGreaterThan(alpha.soft);
      expect(alpha.extreme).toBeGreaterThan(colour.extreme);

      // And the recurrent outputs really are the four the plan wires back.
      for (const slot of Object.keys(MODEL_PLANS[MATTE_RVM.id]!.feedback ?? {})) {
        expect(outputs[slot]).toBeDefined();
      }
      await session.release?.();
    }, 300_000);
  },
);
