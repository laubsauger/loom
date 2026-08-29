import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as exportModule from "./index.ts";
import { isRecordingAvailable, loadVideoEncoder } from "./recording/encoder-loader.ts";

/**
 * The WebCodecs boundary, asserted structurally.
 *
 * "Recording is browser-only, but the export interface is not" is a claim that decays the
 * first time someone adds a convenience re-export. So this checks the actual sources: the
 * only module allowed to name a browser-only API is `recording/webcodecs.ts`, and nothing may
 * import it statically.
 *
 * The whole file also serves as the headless proof itself — it runs in the Node project, with
 * no `VideoEncoder` and no DOM, and it imports the barrel.
 */

const DIR = fileURLToPath(new URL(".", import.meta.url));
const ENCODER_MODULE = "webcodecs.ts";

function sources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
          ? [join(dir, entry.name)]
          : [],
    );
  return walk(DIR);
}

/** Comments stripped: this is about what the CODE does, not what it explains about itself. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

describe("the export interface is usable with no WebCodecs present", () => {
  it("imports headlessly, with the encoder module never loaded", async () => {
    // Node has no VideoEncoder. If the barrel reached the encoder module, this import would
    // have failed at module evaluation rather than reaching an assertion.
    expect(typeof exportModule.createExportInterface).toBe("function");
    expect(typeof exportModule.encodePng).toBe("function");
    expect(typeof exportModule.createFrameRecorder).toBe("function");
    expect((globalThis as { VideoEncoder?: unknown }).VideoEncoder).toBeUndefined();
    expect(isRecordingAvailable()).toBe(false);
    // Null, not a stub: a fake encoder would produce a file claiming to be a recording.
    await expect(loadVideoEncoder()).resolves.toBeNull();
  });

  it("names WebCodecs in exactly one module", () => {
    const offenders = sources()
      .filter((file) => basename(file) !== ENCODER_MODULE)
      .filter((file) => /\bVideoEncoder\b|\bVideoFrame\b|\bEncodedVideoChunk\b/.test(code(file)))
      // The loader feature-detects by name off globalThis; that is the detection, not a use.
      .filter((file) => basename(file) !== "encoder-loader.ts");
    expect(offenders.map((file) => basename(file))).toEqual([]);
  });

  it("imports the encoder module dynamically or not at all", () => {
    for (const file of sources()) {
      if (basename(file) === ENCODER_MODULE) continue;
      const body = code(file);
      expect(body, `${basename(file)} statically imports the encoder`).not.toMatch(
        /^\s*import\s[^\n]*webcodecs\.ts/m,
      );
    }
  });

  it("keeps the DOM out of every module, encoder included (§V63)", () => {
    // src/runtime/** is lint-banned from window/document so the renderer can move into a
    // worker. Download and file-save paths are injected as a FileSink instead.
    for (const file of sources()) {
      expect(code(file), basename(file)).not.toMatch(
        /\bdocument\b|\bwindow\.|\bHTMLCanvasElement\b|\bOffscreenCanvas\b/,
      );
    }
  });

  it("imports no vgpu subpath (§V3)", () => {
    for (const file of sources()) {
      expect(code(file), basename(file)).not.toMatch(/from\s+["']vgpu/);
    }
  });

  it("reads no clock — a recording is keyed on frameIndex, not on time (§V44)", () => {
    // The one rule that makes a take reproducible. A wall-clock read anywhere on this path
    // would reintroduce exactly the drift exact-frame capture exists to remove.
    for (const file of sources()) {
      expect(code(file), basename(file)).not.toMatch(
        /\bDate\.now\b|\bperformance\.now\b|\brequestAnimationFrame\b/,
      );
    }
  });
});
