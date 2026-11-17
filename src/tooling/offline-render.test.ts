import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { linearToSrgb } from "../runtime/export/pixel-format.ts";
import { BoundedFrameReader, LinearAverager } from "./offline-render.ts";

/**
 * T1738b — the two pieces of `pnpm render` that need no GPU, held to what they are FOR.
 */

const sixteen = (linear: number): number => Math.round(linearToSrgb(linear) * 65_535);

describe("--spp averages sub-frames in LINEAR light (T1738b)", () => {
  // A shutter adds light. Half the exposure white and half black is half the light, linear 0.5,
  // which a display shows as code 188. Averaging the display codes gives 128: a motion-blurred
  // edge or an antialiased one comes out too dark, the darkening the scratch renders avoided.
  it("black and white average to encoded 188, not the 128 an average of display values gives", () => {
    const averager = new LinearAverager(1, 1, "rgba8unorm", "encoded");
    averager.add(Uint8Array.from([0, 0, 0, 255]));
    averager.add(Uint8Array.from([255, 255, 255, 255]));
    const [red, green, blue, alpha] = averager.resolve();
    expect([red, green, blue, alpha]).toEqual([sixteen(0.5), sixteen(0.5), sixteen(0.5), 65_535]);
    expect(Math.round(red! / 257)).toBe(188);
    expect(Math.round(red! / 257)).not.toBe(128);
  });

  it("does the same for an rgba16float target holding display values, the Output node's own case", () => {
    // Half-float 0 and 1, little-endian: what an Output node writes in a float working format.
    const pixel = (one: boolean): Uint8Array => {
      const half = one ? 0x3c00 : 0;
      return Uint8Array.from([half & 0xff, half >> 8, half & 0xff, half >> 8, half & 0xff, half >> 8, 0x00, 0x3c]);
    };
    const averager = new LinearAverager(1, 1, "rgba16float", "encoded");
    averager.add(pixel(false));
    averager.add(pixel(true));
    expect(Math.round(averager.resolve()[0]! / 257)).toBe(188);
  });

  // A pixel transparent in one sub-frame contributes no colour from it: straight colour from a
  // straight average would mix in whatever a transparent pixel happens to carry.
  it("weights colour by alpha, and composites over black for a container without alpha", () => {
    const red = Uint8Array.from([255, 0, 0, 255]);
    const clearGreen = Uint8Array.from([0, 255, 0, 0]);
    const straight = new LinearAverager(1, 1, "rgba8unorm", "encoded");
    straight.add(red);
    straight.add(clearGreen);
    expect([...straight.resolve()]).toEqual([65_535, 0, 0, Math.round(0.5 * 65_535)]);
    const overBlack = new LinearAverager(1, 1, "rgba8unorm", "encoded");
    overBlack.add(red);
    overBlack.add(clearGreen);
    expect([...overBlack.resolve({ opaque: true })]).toEqual([sixteen(0.5), 0, 0, 65_535]);
  });
});

/**
 * A decoder that never waits: every chunk it is asked for, on the next turn of the loop (as a
 * pipe delivers), numbered by frame.
 */
function fastDecoder(frameBytes: number, chunkBytes: number, totalBytes: number): { stream: Readable; produced: () => number } {
  let produced = 0;
  const stream = new Readable({
    read() {
      setImmediate(() => {
        if (produced >= totalBytes) {
          this.push(null);
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - produced);
        const chunk = Buffer.alloc(size);
        for (let i = 0; i < size; i += 1) chunk[i] = Math.floor((produced + i) / frameBytes) % 251;
        produced += size;
        this.push(chunk);
      });
    },
  });
  return { stream, produced: () => produced };
}

describe("the Movie File In decoder is read through a bounded reader (T1738b)", () => {
  // A 256 x 256 RGBA frame, in chunks the size of a pipe read that do not divide it.
  const FRAME = 256 * 256 * 4;
  const CHUNK = 50_000;

  // The decoder outruns the GPU. A reader that takes everything it is offered holds the clip in
  // memory and spends the CPU copying it while the GPU waits (the Buffer.concat reader did).
  it("holds at most a few frames while the consumer is slower than the decoder", async () => {
    // A clip of 100 frames, 40 of them read.
    const decoder = fastDecoder(FRAME, CHUNK, FRAME * 100);
    const reader = new BoundedFrameReader(decoder.stream, FRAME);
    let consumed = 0;
    let mostAhead = 0;
    for (let index = 0; index < 40; index += 1) {
      const frame = await reader.next();
      expect(frame?.length).toBe(FRAME);
      // Whole frames in order, across chunk boundaries: every byte carries its frame's number.
      expect(frame!.every((byte) => byte === index % 251)).toBe(true);
      consumed += FRAME;
      // The render takes its time; the decoder does not.
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
      mostAhead = Math.max(mostAhead, decoder.produced() - consumed);
    }
    expect(mostAhead).toBeLessThanOrEqual(4 * FRAME);
    decoder.stream.destroy();
  });

  // A decoder that stops mid-frame (killed, a truncated file) must not hand the GPU half a picture.
  it("ends after the last whole frame and drops a partial one", async () => {
    const decoder = fastDecoder(FRAME, CHUNK, FRAME * 2 + FRAME / 2);
    const reader = new BoundedFrameReader(decoder.stream, FRAME);
    expect((await reader.next())?.[0]).toBe(0);
    expect((await reader.next())?.[0]).toBe(1);
    expect(await reader.next()).toBeUndefined();
    expect(await reader.next()).toBeUndefined();
  });
});
