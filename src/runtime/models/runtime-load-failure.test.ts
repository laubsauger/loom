import { describe, expect, it } from "vitest";
import { describeRuntimeLoadFailure } from "./runtime-load-failure.ts";

/**
 * §B171 — THE DIAGNOSTIC THAT COST AN AFTERNOON, decoded.
 *
 * The owner pasted three errors and nothing in the app said anything. Only the first named
 * the cause, and it named it in hexadecimal. These are the exact strings the runtime
 * produced, not paraphrases: the whole value of this module is that it reads what
 * onnxruntime and V8 actually print, so a fixture written from memory would prove nothing
 * (§V743's rule about third-party artifacts, applied to a third-party error message).
 */

const OWNERS_ERROR =
  "CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f @+0";

describe("§B171 — the magic-word bytes are the cause and get decoded", () => {
  it("names HTML, because 3c 21 64 6f IS `<!do`", () => {
    const said = describeRuntimeLoadFailure(OWNERS_ERROR);
    expect(said).toBeDefined();
    // The DECODE is the whole point. A message repeating the hex would be the same
    // afternoon over again.
    expect(said).toContain("HTML");
    expect(said).toContain("<!do");
    // And it says WHY a .wasm request answers with HTML, so the reader knows where to
    // look rather than concluding their GPU is missing.
    expect(said).toContain("404");
    expect(said).toContain("wasmPaths");
  });

  it("keeps the raw bytes as well, so the decode can be checked rather than trusted", () => {
    expect(describeRuntimeLoadFailure(OWNERS_ERROR)).toContain("3c 21 64 6f");
  });

  it("does not claim HTML for a wasm that is merely truncated or corrupt", () => {
    const corrupt =
      "CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 1f 8b 08 00 @+0";
    const said = describeRuntimeLoadFailure(corrupt);
    expect(said).toBeDefined();
    expect(said).not.toContain("HTML");
    // 1f 8b is gzip; it is not printable, so the decode must not invent characters.
    expect(said).toContain("not a WebAssembly module");
  });
});

describe("the downstream symptoms are rewritten as the cause they share", () => {
  it("turns `no available backend found` into an asset-path statement", () => {
    const said = describeRuntimeLoadFailure(
      "Error: no available backend found. ERR: [wasm] Error: previous call to initWasm() failed.",
    );
    expect(said).toBeDefined();
    // §V469: the runtime's sentence names the SYMPTOM. It is kept — it is what the console
    // shows — but it stops being the headline.
    expect(said).toContain("no available backend found");
    expect(said).toContain("asset-path");
    // ⚠ And it must NOT read as a hardware problem, which is exactly how the original was
    // read for long enough to matter.
    expect(said).toContain("rather than a missing GPU");
  });

  it("claims NOTHING it cannot explain, so a real model error is never buried", () => {
    // A kernel refusal, a bad tensor shape, an out-of-memory — these are the runtime
    // telling the truth about the model, and rewriting them would be the same lie in the
    // other direction.
    expect(describeRuntimeLoadFailure("kernel refused")).toBeUndefined();
    expect(
      describeRuntimeLoadFailure("failed to allocate 4096 MB for the session"),
    ).toBeUndefined();
    expect(describeRuntimeLoadFailure("the model returned no output")).toBeUndefined();
  });
});
