/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1084 — THE THREE BYTES THAT MOVE RVM ONTO THE GPU, APPLIED IN MEMORY AND NOWHERE ELSE
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * ## What is wrong upstream, stated exactly
 *
 * `onnxruntime-web`'s WebGPU AveragePool kernel refuses the `ceil_mode` ATTRIBUTE:
 *
 *     if (r.ceilMode !== 0) throw new Error("ceil_mode output-shape is computed, but
 *       ceil_mode kernel execution (padding/divisor) is not yet implemented ...")
 *
 * — taken before any shape is looked at. RVM carries `ceil_mode=1` on exactly three of
 * its 353 nodes: `AveragePool_169/170/171`, the recurrent decoder's source pyramid off
 * `Resize_3`, all kernel 2x2 / strides 2x2 / pads 0. (NOT the MobileNetV3 backbone,
 * whose pooling is 9x `GlobalAveragePool` and carries no such attribute — the catalogue
 * said otherwise for a while and the artefact disagreed.)
 *
 * For kernel 2 / stride 2 / pads 0 the two rounding modes differ ONLY when the pooled
 * extent is odd. Every extent this app can ask for is even. So the provider is refusing
 * a flag that provably changes nothing about the work it would do, and clearing the flag
 * gives back the identical graph.
 *
 * ## Why this is a patch and not a download
 *
 * The owner: "we don't wanna redistribute". The weights are GPL-3.0, and §V858 rules the
 * licence no bar precisely BECAUSE we are not a distributor — the user's browser fetches
 * the author's own release asset and we never serve a byte of it. Committing a modified
 * copy, or hosting one, would make us a distributor and re-open that ruling for no gain.
 *
 * So the pipeline is unchanged up to the last moment: fetch the author's exact asset,
 * check it against the SHA-256 already recorded in the catalogue, cache THOSE bytes, and
 * only then, in memory, on the way into the runtime, flip three bytes. Nothing is written
 * to the repository, nothing is hosted, nothing is published. The cache stays an honest
 * mirror of upstream, so `uninstall` and the byte-count check keep meaning what they say.
 *
 * ## The two assertions, and why neither is defensive padding
 *
 * 1. EVERY PRE-IMAGE BYTE MUST BE `0x01`. This is not belt-and-braces around an offset
 *    table — it is the DETECTOR for the artefact changing under us. A GitHub release
 *    asset is as close to immutable as a release gets, but "close" is not a promise, and
 *    a silent flip of a byte that was already something else would corrupt the graph in
 *    exactly the way the shape-refusal argument below says cannot otherwise happen.
 *
 * 2. THE RESULT MUST HASH TO `9e6ed25b…`. That single number inherits an entire
 *    equivalence proof rather than restating it: those bytes are the file that was
 *    measured bit-identical to the author's — `pha` and `r4o` compared through a Uint32
 *    view, 0 differing bits — across all 20 combinations of the matte node's four input
 *    sides and five downsample ratios, on the wasm provider where both graphs run. If the
 *    hash matches, the thing about to be handed to the runtime IS that file.
 *
 * A failure of either is a REFUSAL, never a warning and never a best effort: the patch is
 * abandoned, the author's untouched bytes are what run, and `requiredFor` takes WebGPU
 * off the ladder so the un-patched graph cannot reach the provider that throws on it. The
 * reason travels with the refusal and surfaces on the node.
 *
 * ## Why a wrong patch cannot quietly produce a wrong matte
 *
 * Worth stating because it is the unusual property here. The pyramid these three pools
 * build is concatenated with a backbone feature map of fixed shape. On any extent where
 * `ceil_mode` would have mattered, the cleared graph does not drift — it DIES, at
 * `Concat_199`, with "Non concat axis dimensions must match: Axis 2 has mismatched
 * dimensions of 63 and 62". Measured at sides 501, 502 and 500 (odd at the first, second
 * and third pool respectively). Side 504 — off the node's menu but still a multiple of 8
 * — is bit-identical, as the rule requires. There is no silent-wrong region to fall into.
 */

/** SHA-256 of `bytes`, lowercase hex, or `undefined` where the origin has no WebCrypto. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return undefined;
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An in-memory edit to one artefact's bytes, declared rather than coded per model. */
export interface WeightPatch {
  readonly modelId: string;
  /** Byte offsets, ZERO-BASED. */
  readonly offsets: readonly number[];
  /** What each offset must already hold. A mismatch refuses the whole patch. */
  readonly from: number;
  /** What each becomes. */
  readonly to: number;
  /** SHA-256 the patched bytes must have, or the patch is refused. */
  readonly sha256: string;
  /**
   * Providers that are ONLY offered when the patch applied.
   *
   * The point of naming them here rather than in `cannotRun`: `cannotRun` is a property
   * of an artefact and is true or false before anything runs, whereas this is contingent
   * on a step that can fail on the user's machine. If the patch is refused these rungs
   * come off the ladder, with the reason, so a create-succeeds/run-fails provider is
   * never reached by un-patched bytes.
   */
  readonly requiredFor: readonly string[];
  /** Said out loud on the node when the patch is refused. */
  readonly why: string;
}

/**
 * Offsets read off the two files, then re-derived: flipping exactly these three in the
 * author's asset reproduces the measured artefact byte for byte. The file's LENGTH does
 * not change, so the catalogue's `bytes` check is unaffected either way.
 */
export const RVM_CEIL_MODE_PATCH: WeightPatch = {
  modelId: "rvm-mobilenetv3",
  offsets: [14105, 14225, 14345],
  from: 0x01,
  to: 0x00,
  sha256: "9e6ed25bc24ac9e9ee2b14e510a31abfa69a0b734875371df8f7a05c817bb235",
  requiredFor: ["webgpu"],
  why:
    "Robust Video Matting carries ceil_mode on three pooling nodes, and onnxruntime-web " +
    "refuses that attribute on the WebGPU provider — the session starts and then every " +
    "run throws. Loom clears it in memory after checking the download's hash; that check " +
    "did not pass here, so the untouched model is running on the CPU instead.",
};

export const WEIGHT_PATCHES: readonly WeightPatch[] = [RVM_CEIL_MODE_PATCH];

export function weightPatchFor(modelId: string): WeightPatch | undefined {
  return WEIGHT_PATCHES.find((patch) => patch.modelId === modelId);
}

export type PatchOutcome =
  /** No patch is declared for this model. The bytes are handed on untouched. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "patched"; readonly bytes: ArrayBuffer }
  /** The patch did not apply. `providers` must come off the ladder, `reason` is shown. */
  | { readonly kind: "refused"; readonly reason: string; readonly providers: readonly string[] };

/**
 * Apply the declared patch for `modelId`, in memory, to a COPY of `bytes`.
 *
 * A copy because the caller's buffer is the one the acquisition cache handed out and the
 * worker transfers: mutating it in place would edit the machine-wide cached artefact
 * through a shared reference, which is the "nothing is written" promise broken by
 * aliasing rather than by intent.
 */
export async function applyWeightPatch(
  modelId: string,
  bytes: ArrayBuffer,
): Promise<PatchOutcome> {
  const patch = weightPatchFor(modelId);
  if (patch === undefined) return { kind: "unchanged" };

  const refuse = (detail: string): PatchOutcome => ({
    kind: "refused",
    reason: `${patch.why} (${detail})`,
    providers: patch.requiredFor,
  });

  const copy = bytes.slice(0);
  const view = new Uint8Array(copy);
  for (const offset of patch.offsets) {
    if (offset >= view.length) {
      return refuse(`offset ${offset} is past the end of a ${view.length}-byte download`);
    }
    const found = view[offset];
    if (found !== patch.from) {
      // THE DETECTOR. The upstream asset changed, or the wrong artefact arrived under
      // this id. Either way the offset table no longer describes these bytes and flipping
      // anything would be vandalism.
      return refuse(
        `byte ${offset} holds 0x${found!.toString(16).padStart(2, "0")}, not the ` +
          `0x${patch.from.toString(16).padStart(2, "0")} this patch was measured against`,
      );
    }
    view[offset] = patch.to;
  }

  const digest = await sha256Hex(copy);
  if (digest === undefined) {
    return refuse("this origin has no WebCrypto, so the patched bytes could not be verified");
  }
  if (digest !== patch.sha256) {
    return refuse(`the patched bytes hash to ${digest}, not the verified ${patch.sha256}`);
  }
  return { kind: "patched", bytes: copy };
}
