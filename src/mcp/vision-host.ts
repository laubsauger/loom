import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import type { VisionOutcome, VisionSegmentRequest } from "./device-protocol.ts";

/**
 * T1029 — the helper's VISION door: person segmentation through Apple's Vision
 * framework, for the bridge's device role. The laser door's sibling in shape — the
 * helper owns the process, every refusal is a sentence naming its mechanism, and
 * nothing is guessed.
 *
 * ## Why an OS API next to the in-page models at all
 *
 * The in-page matte (MODNet/RVM through onnxruntime) answers "who is in frame" with
 * downloaded weights. Vision answers it with ZERO download, ZERO weights and — per
 * §V858 — zero provenance question, because an OS framework has no bytes for us to
 * verify. The measured cost (this machine, Apple Silicon, warm): 20–35 ms a frame at
 * 640×360, with a one-time ~2 s model load inside the worker's first request and a
 * one-time `swiftc` compile (~8 s) per machine, cached by source hash.
 *
 * ## The worker is a COMPILED child process, and the source ships next to this file
 *
 * `vision-worker.swift` speaks length-prefixed raw frames over stdio (its docblock is
 * the wire spec). It is compiled on first use into a per-user cache keyed by the
 * SHA-256 of the source, so editing the worker invalidates the binary and two loom
 * checkouts never fight over one path. An interpreted `swift file.swift` start was
 * rejected: it costs seconds per session where the compiled binary costs milliseconds.
 *
 * ## Refusals name the mechanism (§T950's precedent)
 *
 *  - not macOS                  → the framework does not exist here; nothing to probe.
 *  - no `swiftc`                → names the Xcode Command Line Tools, the actual gate.
 *  - compile failed             → the compiler's own words, verbatim.
 *  - worker died mid-request    → its stderr, verbatim — never a silent black mask.
 *  - a request already in flight → refused rather than queued, because the caller (the
 *    inference seam) never starts a run while one is in flight; a second concurrent
 *    caller is a bug and should hear so.
 */

/** The slice of a child process this module uses. Injected so tests need no Swift. */
export interface VisionProcess {
  write(bytes: Uint8Array): void;
  onData(handler: (bytes: Uint8Array) => void): void;
  /** Fired once, with the process's parting words (stderr) — surfaced verbatim. */
  onExit(handler: (detail: string) => void): void;
  kill(): void;
}

export type VisionStart = () => Promise<VisionProcess | { readonly refusal: string }>;

export interface VisionHostOptions {
  /** Builds (or refuses) the worker process. The real one compiles and spawns Swift. */
  readonly start: VisionStart;
  readonly now?: () => number;
}

export interface VisionHost {
  segment(request: VisionSegmentRequest): Promise<VisionOutcome>;
  dispose(): void;
}

const HEADER_BYTES = 8;

export function createVisionHost(options: VisionHostOptions): VisionHost {
  const now = options.now ?? (() => Date.now());
  let worker: VisionProcess | null = null;
  let starting: Promise<VisionProcess | { refusal: string }> | null = null;
  let received = new Uint8Array(0);
  let inFlight: { resolve(outcome: VisionOutcome): void } | null = null;
  let startedAt = 0;
  let died: string | null = null;

  const onBytes = (bytes: Uint8Array): void => {
    const joined = new Uint8Array(received.length + bytes.length);
    joined.set(received, 0);
    joined.set(bytes, received.length);
    received = joined;
    if (received.length < HEADER_BYTES) return;
    const view = new DataView(received.buffer, received.byteOffset);
    const maskWidth = view.getUint32(0, true);
    const maskHeight = view.getUint32(4, true);
    const total = HEADER_BYTES + maskWidth * maskHeight;
    if (received.length < total) return;
    const mask = received.slice(HEADER_BYTES, total);
    received = received.slice(total);
    const waiter = inFlight;
    inFlight = null;
    waiter?.resolve({
      ok: true,
      maskWidth,
      maskHeight,
      maskBase64: Buffer.from(mask).toString("base64"),
      millis: now() - startedAt,
    });
  };

  const ensureWorker = async (): Promise<VisionProcess | { refusal: string }> => {
    if (worker !== null) return worker;
    if (died !== null) return { refusal: died };
    starting ??= options.start();
    const outcome = await starting;
    starting = null;
    if ("refusal" in outcome) {
      died = outcome.refusal;
      return outcome;
    }
    worker = outcome;
    worker.onData(onBytes);
    worker.onExit((detail) => {
      // The process's own words, held: every later request refuses with WHY the door
      // is shut instead of hanging on a dead pipe.
      died = `the segmentation worker exited: ${detail === "" ? "(no stderr)" : detail}`;
      worker = null;
      const waiter = inFlight;
      inFlight = null;
      waiter?.resolve({ ok: false, reason: died });
    });
    return worker;
  };

  return {
    async segment(request) {
      if (inFlight !== null) {
        return {
          ok: false,
          reason:
            "a segmentation is already in flight — one picture, one owed mask; the caller must wait for its answer",
        };
      }
      const expected = request.width * request.height * 4;
      const pixels = Buffer.from(request.rgbaBase64, "base64");
      if (request.width <= 0 || request.height <= 0 || pixels.length !== expected) {
        return {
          ok: false,
          reason: `the picture does not match its declared size: ${String(pixels.length)} bytes for ${String(request.width)}x${String(request.height)} RGBA (${String(expected)} expected)`,
        };
      }
      const live = await ensureWorker();
      if ("refusal" in live) return { ok: false, reason: live.refusal };
      const header = new Uint8Array(HEADER_BYTES);
      const view = new DataView(header.buffer);
      view.setUint32(0, request.width, true);
      view.setUint32(4, request.height, true);
      startedAt = now();
      const settled = new Promise<VisionOutcome>((resolve) => {
        inFlight = { resolve };
      });
      live.write(header);
      live.write(pixels);
      return settled;
    },
    dispose() {
      // The direct child handle, never a pattern (§V843).
      worker?.kill();
      worker = null;
      const waiter = inFlight;
      inFlight = null;
      waiter?.resolve({ ok: false, reason: "the vision door closed while a mask was owed" });
    },
  };
}

/* ------------------------------------------------------------------ real process */

const WORKER_SOURCE_URL = new URL("./vision-worker.swift", import.meta.url);

/**
 * Compile-and-spawn, the real `start`. Everything that can refuse does so with the
 * mechanism named; nothing downloads and nothing is guessed.
 */
export function nodeVisionStart(): VisionStart {
  return async () => {
    if (platform() !== "darwin") {
      return {
        refusal:
          "person segmentation needs Apple's Vision framework, which only exists on macOS — this helper is not running on one",
      };
    }
    const source = readFileSync(fileURLToPath(WORKER_SOURCE_URL));
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const cacheDir = join(homedir(), ".cache", "loom");
    const binary = join(cacheDir, `vision-worker-${hash}`);
    if (!existsSync(binary)) {
      const probe = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });
      if (probe.status !== 0) {
        return {
          refusal:
            "compiling the segmentation worker needs swiftc, which is not installed — install the Xcode Command Line Tools (xcode-select --install)",
        };
      }
      mkdirSync(cacheDir, { recursive: true });
      const compile = spawnSync(
        "swiftc",
        ["-O", fileURLToPath(WORKER_SOURCE_URL), "-o", binary],
        { encoding: "utf8", timeout: 120_000 },
      );
      if (compile.status !== 0) {
        return {
          refusal: `the segmentation worker failed to compile: ${(compile.stderr ?? "").trim().slice(0, 500)}`,
        };
      }
    }
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    return {
      write: (bytes) => child.stdin.write(bytes),
      onData: (handler) => child.stdout.on("data", handler),
      onExit: (handler) => {
        child.on("exit", () => handler(stderr.trim()));
      },
      kill: () => child.kill(),
    };
  };
}
