/**
 * What onnxruntime's own failure MEANS, said as the CAUSE rather than the symptom
 * (§B171, §V469).
 *
 * ## The three errors that were one bug
 *
 * The owner pasted this, in this order, and no surface in the app said anything:
 *
 *   1. `CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d,
 *      found 3c 21 64 6f`
 *   2. `previous call to initWasm() failed.`
 *   3. `no available backend found. ERR: [wasm] ...`
 *
 * Only the FIRST one names the cause, and it names it in hexadecimal: `3c 21 64 6f` is
 * ASCII `<!do`. The runtime asked for a `.wasm` and was handed `<!doctype html>` — a 404
 * falling back to the single-page app's index. Everything after that is the runtime
 * reporting, accurately, that it has no working backend; which is true, and useless.
 *
 * The one an app can surface is (3), because it is the one that comes back as a rejected
 * promise. So this module decodes (1) out of whatever it is given and rewrites the
 * message into the sentence the owner needed: **got HTML where a `.wasm` was expected,
 * check the asset path.** That is §V469 applied to a third-party runtime — a diagnostic
 * that names the symptom while the cause is one decode away is a diagnostic that costs
 * someone an afternoon.
 *
 * Pure and string-in/string-out on purpose: the failure happens inside a worker, inside a
 * dynamic import, inside a WebAssembly compile, and none of that is reachable from a test.
 * The DECODE is, and the decode is the part that was missing.
 */

/** The magic word every wasm module starts with: `\0asm`. */
const WASM_MAGIC = "00 61 73 6d";

/**
 * `expected magic word 00 61 73 6d, found 3c 21 64 6f` — V8's wording. Firefox and
 * WebKit phrase the sentence differently but all three print the bytes as spaced lowercase
 * hex, which is the only part this needs.
 */
const MAGIC_WORD = /expected magic word\s+([0-9a-f]{2}(?:\s[0-9a-f]{2})*)\s*,\s*found\s+([0-9a-f]{2}(?:\s[0-9a-f]{2})*)/i;

/** Downstream symptoms. True of any wasm load failure, and specific to none. */
const SYMPTOMS = /no available backend found|previous call to initWasm\(\) failed|multiple calls to 'initWasm\(\)'/i;

/** `3c 21 64 6f` -> `<!do`. Non-printable bytes become `.` so the result is safe to show. */
function decodeHexBytes(hex: string): string {
  return hex
    .trim()
    .split(/\s+/)
    .map((byte) => {
      const code = Number.parseInt(byte, 16);
      return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ".";
    })
    .join("");
}

/**
 * The sentence a person can act on, or `undefined` when this is not a runtime-load
 * failure and the original message is already the best available answer.
 *
 * Deliberately NOT a catch-all: rewriting an arbitrary model error would bury the real
 * one. Only the two shapes above are claimed.
 */
export function describeRuntimeLoadFailure(message: string): string | undefined {
  const magic = MAGIC_WORD.exec(message);
  if (magic !== null) {
    const expected = magic[1] ?? WASM_MAGIC;
    const found = magic[2] ?? "";
    const decoded = decodeHexBytes(found);
    const looksLikeMarkup = decoded.startsWith("<");
    const what = looksLikeMarkup
      ? `HTML (the response begins "${decoded}")`
      : `bytes that are not a WebAssembly module (it begins "${decoded}")`;
    return (
      `The model runtime could not load: fetching its WebAssembly binary returned ${what} ` +
      `instead of a .wasm module (expected the magic word ${expected}, found ${found}). ` +
      `That is what a 404 looks like in a single-page app — the request fell through to ` +
      `index.html. The .wasm asset path is wrong: check that onnxruntime-web's ` +
      `ort.env.wasm.wasmPaths points at a URL this build actually serves.`
    );
  }
  if (SYMPTOMS.test(message)) {
    return (
      `The model runtime could not load, so no execution backend could start (${message.trim()}). ` +
      `This is an asset-path problem rather than a missing GPU: onnxruntime-web's .wasm ` +
      `binary has to be served at the URL ort.env.wasm.wasmPaths names, and a 404 there is ` +
      `answered with index.html rather than an error.`
    );
  }
  return undefined;
}
