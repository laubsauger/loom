import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RVM_CEIL_MODE_PATCH, applyWeightPatch, weightPatchFor } from "./model-patch.ts";
import { createWorkerCore } from "./inference-worker-core.ts";
import { DEPTH_ACCURATE, MATTE_RVM } from "./model-catalogue.ts";
import type { InferenceResponse } from "./inference-protocol.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1084 — the in-memory weight patch, gated on the two things that make it safe
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The patch itself is three byte writes; almost none of the risk is in the writing. It is
 * in the two questions either side:
 *
 *   - are these the bytes the offsets were measured against?  (the pre-image assertion)
 *   - are the bytes that come out the ones that were PROVED equivalent?  (the hash)
 *
 * The hash is the load-bearing one and it is deliberately a single number. `9e6ed25b…`
 * is the artefact that was compared against the author's original on the wasm provider —
 * `pha` and `r4o` bitwise through a Uint32 view, 0 differing bits — across all 20 pairs
 * of the matte node's four input sides and five downsample ratios. Asserting the digest
 * inherits that whole proof; restating the proof here as a tolerance would weaken it.
 */
describe("the RVM ceil_mode patch, applied in memory", () => {
  /** A stand-in artefact: `0x01` where the patch expects to write, so it gets that far. */
  function fakeWeights(size = MATTE_RVM.bytes): ArrayBuffer {
    const bytes = new Uint8Array(size);
    for (const offset of RVM_CEIL_MODE_PATCH.offsets) bytes[offset] = 0x01;
    return bytes.buffer;
  }

  it("leaves a model with no declared patch completely alone", async () => {
    const outcome = await applyWeightPatch(DEPTH_ACCURATE.id, new ArrayBuffer(8));
    expect(outcome.kind).toBe("unchanged");
    expect(weightPatchFor(DEPTH_ACCURATE.id)).toBeUndefined();
  });

  it("REFUSES when a pre-image byte is not the 0x01 it was measured against", async () => {
    // THE DETECTOR, and the reason it is not defensive padding: this is what fires if the
    // upstream release asset is ever replaced, or if the wrong artefact arrives under this
    // id. Flipping a byte that already held something else would corrupt the graph in
    // exactly the way the Concat shape-refusal argument says cannot otherwise happen —
    // silently, with a plausible matte coming out the far end.
    const bytes = new Uint8Array(fakeWeights());
    bytes[RVM_CEIL_MODE_PATCH.offsets[1]!] = 0x07;
    const outcome = await applyWeightPatch(MATTE_RVM.id, bytes.buffer);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    // The reason has to be actionable: WHICH byte, what was there, what was expected.
    expect(outcome.reason).toContain(String(RVM_CEIL_MODE_PATCH.offsets[1]));
    expect(outcome.reason).toContain("0x07");
    expect(outcome.providers).toEqual(["webgpu"]);
  });

  it("REFUSES when the patched bytes do not hash to the verified artefact", async () => {
    // Pre-images all correct, so the first gate passes and only the digest can catch it.
    // This is the case where the offsets still describe SOMETHING but the rest of the file
    // is not the model the equivalence was proved on.
    const outcome = await applyWeightPatch(MATTE_RVM.id, fakeWeights());

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain(RVM_CEIL_MODE_PATCH.sha256);
    expect(outcome.providers).toEqual(["webgpu"]);
  });

  it("never writes through to the caller's buffer, patched or refused", async () => {
    // The buffer handed in is the one the acquisition cache holds. Patching in place would
    // edit the machine-wide cached artefact through a shared reference — "nothing is
    // written" broken by aliasing rather than by intent — and the next load would then see
    // a file whose bytes no longer match the recorded 88d4531… on re-verification.
    // Only large enough to hold the offsets — this is about aliasing, not about size.
    const original = fakeWeights(20_000);
    const before = new Uint8Array(original).slice();
    await applyWeightPatch(MATTE_RVM.id, original);
    expect(Buffer.compare(Buffer.from(original), Buffer.from(before))).toBe(0);
    // Spelled out, because a whole-buffer compare passing for the wrong reason (both
    // already patched) would be invisible: the write targets are still their pre-image.
    for (const offset of RVM_CEIL_MODE_PATCH.offsets) {
      expect(new Uint8Array(original)[offset]).toBe(RVM_CEIL_MODE_PATCH.from);
    }
  });
});

/**
 * The wiring, asserted as the value a consumer reads back: WHICH BACKEND ANSWERED.
 *
 * "The patch was applied" is mechanism. What the node shows, and what decides whether a
 * frame ever arrives, is the backend the ladder settled on — so that is what these check.
 */
describe("a refused patch takes its provider off the ladder", () => {
  function coreWith(posted: InferenceResponse[]) {
    return createWorkerCore({
      isolated: true,
      // Succeeds on EVERY provider. So if `webgpu` is still on the ladder it WILL win, and
      // a green result here cannot be an accident of the fake refusing it.
      createSession: async () => ({ inputNames: ["src"], outputNames: ["pha"], run: async () => ({}) }),
      createTensor: (type, data, dims) => ({ type, data, dims }),
      post: (response) => posted.push(response),
    });
  }

  async function backendFor(modelId: string, providers: readonly string[]): Promise<InferenceResponse> {
    const posted: InferenceResponse[] = [];
    await coreWith(posted).handle({
      kind: "load",
      sessionKey: `${modelId}@${providers.join("+")}`,
      modelId,
      // Junk bytes: the patch refuses on them, which is the state under test.
      weights: new ArrayBuffer(64),
      providers,
    });
    const answer = posted.at(-1);
    if (answer === undefined) throw new Error("the worker posted nothing");
    return answer;
  }

  it("falls back to the CPU rather than reporting a provider that cannot run", async () => {
    const answer = await backendFor(MATTE_RVM.id, ["webgpu", "wasm"]);
    expect(answer.kind).toBe("loaded");
    // Not "webgpu" — which is what a fake that succeeds everywhere would otherwise give,
    // and what the un-patched artefact used to report right before every run threw.
    if (answer.kind === "loaded") expect(answer.backend).toBe("wasm");
  });

  it("leaves the ladder alone for a model with no patch, so the drop is the refusal's", async () => {
    // THE LEGITIMATE CASE THE GUARD COULD SWALLOW. Without this, a bug that dropped
    // `webgpu` unconditionally would pass the test above and take every model off the GPU.
    const answer = await backendFor(DEPTH_ACCURATE.id, ["webgpu", "wasm"]);
    expect(answer.kind).toBe("loaded");
    if (answer.kind === "loaded") expect(answer.backend).toBe("webgpu");
  });

  it("fails loudly on a PINNED provider instead of quietly running somewhere else", async () => {
    // A pin means exactly that one (§V469). Silently substituting wasm here would be the
    // picker-that-does-nothing bug, so an empty ladder must surface the patch's reason.
    const answer = await backendFor(MATTE_RVM.id, ["webgpu"]);
    expect(answer.kind).toBe("error");
    if (answer.kind === "error") {
      expect(answer.message).toContain("[webgpu]");
      expect(answer.message).toContain("ceil_mode");
    }
  });
});

/**
 * THE ONE NUMBER THAT CARRIES THE WHOLE PROOF — against the real 15 MB artefact.
 *
 * Gated on `SHADERLOOM_MODEL_DIR` the same way `matte-rvm.test.ts`'s real-weights block
 * is: GPL weights are not a thing to download per suite. Everything above runs on a fake
 * and therefore agrees with whoever wrote the fake (§V742); this is the half that can
 * disagree with it.
 */
const MODEL_DIR = process.env["SHADERLOOM_MODEL_DIR"];
const RVM_FILE = MODEL_DIR === undefined ? undefined : join(MODEL_DIR, "matte-rvm.onnx");

describe.skipIf(RVM_FILE === undefined || !existsSync(RVM_FILE))(
  "the real artefact patches to the file the equivalence was proved on",
  () => {
    it("turns the author's 88d4531… into the verified 9e6ed25…, and only those 3 bytes", async () => {
      const author = readFileSync(RVM_FILE!);
      // The chain starts where acquisition leaves it: these must be the bytes the
      // catalogue already checks, or the patch is being measured against the wrong file.
      const authorDigest = await crypto.subtle.digest("SHA-256", author);
      expect([...new Uint8Array(authorDigest)].map((b) => b.toString(16).padStart(2, "0")).join(""))
        .toBe(MATTE_RVM.sha256);

      const outcome = await applyWeightPatch(
        MATTE_RVM.id,
        author.buffer.slice(author.byteOffset, author.byteOffset + author.byteLength),
      );
      // The digest is asserted INSIDE applyWeightPatch, so reaching "patched" at all is
      // the proof. Restating it would be testing the assertion rather than the artefact.
      expect(outcome.kind).toBe("patched");
      if (outcome.kind !== "patched") throw new Error("unreachable");

      // The size promise the catalogue's byte-count check depends on.
      expect(outcome.bytes.byteLength).toBe(MATTE_RVM.bytes);

      // And the edit is exactly as narrow as it claims — three bytes, at the three
      // declared offsets, 0x01 -> 0x00. A patch that quietly touched a fourth would still
      // hash correctly if the offset table and the hash were regenerated together, so this
      // is checked against the ORIGINAL rather than against the table.
      const patched = new Uint8Array(outcome.bytes);
      const differing: number[] = [];
      for (let i = 0; i < author.length; i += 1) if (author[i] !== patched[i]) differing.push(i);
      expect(differing).toEqual([...RVM_CEIL_MODE_PATCH.offsets]);
      for (const offset of differing) {
        expect({ was: author[offset], now: patched[offset] }).toEqual({ was: 0x01, now: 0x00 });
      }
    });
  },
);
