import { describe, expect, it } from "vitest";

import { createVisionHost, nodeVisionStart, type VisionProcess } from "./vision-host.ts";

/**
 * T1029 — the vision door. The protocol gates run against a FAKE process (deterministic,
 * no Swift); the last gate compiles and runs the REAL worker against Apple's Vision
 * framework, fail-loud like the Dawn gates — a machine without the toolchain must hear
 * WHY, never skip (§V147's spirit for a second kind of hardware).
 */

function fakeProcess() {
  const written: Uint8Array[] = [];
  let dataHandler: ((bytes: Uint8Array) => void) | null = null;
  let exitHandler: ((detail: string) => void) | null = null;
  const process: VisionProcess = {
    write: (bytes) => written.push(bytes),
    onData: (handler) => {
      dataHandler = handler;
    },
    onExit: (handler) => {
      exitHandler = handler;
    },
    kill: () => {},
  };
  return {
    process,
    written,
    reply: (bytes: Uint8Array) => dataHandler?.(bytes),
    die: (detail: string) => exitHandler?.(detail),
  };
}

/** The start() handshake settles over several microtasks; a macrotask flushes them all. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const rgba = (width: number, height: number): string =>
  Buffer.from(new Uint8Array(width * height * 4).fill(7)).toString("base64");

function maskReply(maskWidth: number, maskHeight: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(8 + maskWidth * maskHeight);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, maskWidth, true);
  view.setUint32(4, maskHeight, true);
  bytes.fill(fill, 8);
  return bytes;
}

describe("T1029 — the door's protocol, against a fake worker", () => {
  it("frames the request exactly (LE header + raw RGBA) and decodes a CHUNKED reply", async () => {
    const fake = fakeProcess();
    const host = createVisionHost({ start: () => Promise.resolve(fake.process), now: () => 5 });
    const pending = host.segment({ width: 3, height: 2, rgbaBase64: rgba(3, 2) });
    await flush();
    // Header then pixels, two writes: [w=3, h=2] LE, 24 bytes of RGBA.
    expect([...fake.written[0]!]).toEqual([3, 0, 0, 0, 2, 0, 0, 0]);
    expect(fake.written[1]!.length).toBe(24);
    // The reply arrives split mid-header and mid-mask — stdio has no message boundaries.
    const reply = maskReply(4, 2, 200);
    fake.reply(reply.slice(0, 5));
    fake.reply(reply.slice(5, 10));
    fake.reply(reply.slice(10));
    const outcome = await pending;
    expect(outcome).toEqual({
      ok: true,
      maskWidth: 4,
      maskHeight: 2,
      maskBase64: Buffer.from(new Uint8Array(8).fill(200)).toString("base64"),
      millis: 0,
    });
  });

  it("refuses a picture whose bytes disagree with its declared size — before any process exists", async () => {
    let started = 0;
    const host = createVisionHost({
      start: () => {
        started += 1;
        return Promise.resolve(fakeProcess().process);
      },
    });
    const outcome = await host.segment({ width: 4, height: 4, rgbaBase64: rgba(2, 2) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("does not match its declared size");
    expect(started).toBe(0);
  });

  it("a start refusal is held and repeated with its mechanism — never retried into a spawn loop", async () => {
    let attempts = 0;
    const host = createVisionHost({
      start: () => {
        attempts += 1;
        return Promise.resolve({ refusal: "no swiftc — install the Xcode Command Line Tools" });
      },
    });
    const first = await host.segment({ width: 1, height: 1, rgbaBase64: rgba(1, 1) });
    const second = await host.segment({ width: 1, height: 1, rgbaBase64: rgba(1, 1) });
    for (const outcome of [first, second]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain("Xcode Command Line Tools");
    }
    expect(attempts).toBe(1);
  });

  it("a concurrent request is refused, and a worker death fails the owed mask with its stderr", async () => {
    const fake = fakeProcess();
    const host = createVisionHost({ start: () => Promise.resolve(fake.process) });
    const owed = host.segment({ width: 1, height: 1, rgbaBase64: rgba(1, 1) });
    await flush();
    const refused = await host.segment({ width: 1, height: 1, rgbaBase64: rgba(1, 1) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("already in flight");
    fake.die("Vision refused: some framework detail");
    const outcome = await owed;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("some framework detail");
  });
});

describe("T1029 — the REAL worker, compiled and driven through Apple Vision", () => {
  it(
    "segments a synthetic frame end to end: a mask comes back at Vision's own size, and a frame with nobody in it reads as nobody",
    { timeout: 60_000 },
    async () => {
      const host = createVisionHost({ start: nodeVisionStart() });
      try {
        const width = 320;
        const height = 180;
        const pixels = new Uint8Array(width * height * 4);
        for (let at = 0; at < pixels.length; at += 4) {
          pixels[at] = 40;
          pixels[at + 1] = 90;
          pixels[at + 2] = 60;
          pixels[at + 3] = 255;
        }
        const outcome = await host.segment({
          width,
          height,
          rgbaBase64: Buffer.from(pixels).toString("base64"),
        });
        // Fail LOUD with the mechanism when the toolchain is absent — a skip here would
        // green a machine that cannot segment (the Dawn rule, applied to Vision).
        expect(outcome.ok, outcome.ok ? "" : outcome.reason).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.maskWidth).toBeGreaterThan(0);
        expect(outcome.maskHeight).toBeGreaterThan(0);
        const mask = Buffer.from(outcome.maskBase64, "base64");
        expect(mask.length).toBe(outcome.maskWidth * outcome.maskHeight);
        // A flat green field holds no person: the model's own verdict, read from its
        // bytes — the "found nothing" half §V856 says must be distinguishable. (The
        // "found someone" half needs a real photograph and lives with the operator.)
        const lit = mask.filter((value) => value > 128).length;
        expect(lit / mask.length).toBeLessThan(0.01);
      } finally {
        host.dispose();
      }
    },
  );
});
