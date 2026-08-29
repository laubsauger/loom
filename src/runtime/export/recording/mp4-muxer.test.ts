import { describe, expect, it } from "vitest";
import { avcCodecString, muxMp4, sampleDurationFor, timescaleFor } from "./mp4-muxer.ts";
import type { Mp4Sample } from "./mp4-muxer.ts";

/**
 * The muxer is checked by walking the box tree back out of the bytes. Every assertion here is
 * about a property a player actually depends on: box order (mdat before moov is what makes
 * the chunk offsets knowable), the sample count, the timescale, and the presence of the avcC
 * record without which the file is undecodable.
 */

interface Box {
  readonly type: string;
  readonly start: number;
  readonly length: number;
  readonly payload: Uint8Array;
}

function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    const length = view.getUint32(at);
    expect(length).toBeGreaterThanOrEqual(8);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    found.push({ type, start: at, length, payload: bytes.subarray(at + 8, at + length) });
    at += length;
  }
  expect(at).toBe(end);
  return found;
}

function find(bytes: Uint8Array, path: ReadonlyArray<string>): Box {
  let scope = bytes;
  let box: Box | undefined;
  for (const type of path) {
    box = boxes(scope).find((candidate) => candidate.type === type);
    expect(box, `missing box ${type}`).toBeDefined();
    if (!box) throw new Error(`missing box ${type}`);
    scope = box.payload;
  }
  if (!box) throw new Error("empty path");
  return box;
}

/** A plausible avcC: configurationVersion, profile 0x42, compat 0x00, level 0x1f. */
const DESCRIPTION = Uint8Array.from([1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0, 0x1f, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80]);

function samples(count: number, duration: number): Mp4Sample[] {
  return Array.from({ length: count }, (_value, index) => ({
    bytes: Uint8Array.from({ length: 10 + index }, () => index + 1),
    keyFrame: index === 0,
    duration,
  }));
}

describe("mp4 muxing", () => {
  const fps = 30;
  const timescale = timescaleFor(fps);
  const duration = sampleDurationFor(fps);
  const frames = samples(5, duration);
  const file = muxMp4({ width: 320, height: 240, timescale, samples: frames, codecDescription: DESCRIPTION });

  it("keeps every per-frame duration an exact integer", () => {
    // timescale = fps*1000 exists precisely so 1/30 s is not a repeating fraction. A rounded
    // per-frame duration accumulates into visible drift over a long take.
    expect(timescale).toBe(30000);
    expect(duration).toBe(1000);
    expect(duration * fps).toBe(timescale);
  });

  it("writes ftyp, then mdat, then moov", () => {
    // mdat first is what makes stco offsets knowable in one pass.
    expect(boxes(file).map((box) => box.type)).toEqual(["ftyp", "mdat", "moov"]);
  });

  it("points stco at the real start of the media data", () => {
    const top = boxes(file);
    const mdat = top[1];
    const stco = find(file, ["moov", "trak", "mdia", "minf", "stbl", "stco"]);
    const view = new DataView(stco.payload.buffer, stco.payload.byteOffset, stco.payload.byteLength);
    expect(view.getUint32(4)).toBe(1); // one chunk
    expect(view.getUint32(8)).toBe((mdat?.start ?? -1) + 8);
  });

  it("declares exactly as many samples as it was given, with their real sizes", () => {
    const stsz = find(file, ["moov", "trak", "mdia", "minf", "stbl", "stsz"]);
    const view = new DataView(stsz.payload.buffer, stsz.payload.byteOffset, stsz.payload.byteLength);
    expect(view.getUint32(4)).toBe(0); // per-sample sizes follow
    expect(view.getUint32(8)).toBe(frames.length);
    for (let index = 0; index < frames.length; index += 1) {
      expect(view.getUint32(12 + index * 4)).toBe(frames[index]?.bytes.length);
    }
  });

  it("collapses a constant-fps take into one stts entry", () => {
    const stts = find(file, ["moov", "trak", "mdia", "minf", "stbl", "stts"]);
    const view = new DataView(stts.payload.buffer, stts.payload.byteOffset, stts.payload.byteLength);
    expect(view.getUint32(4)).toBe(1); // entry count
    expect(view.getUint32(8)).toBe(frames.length);
    expect(view.getUint32(12)).toBe(duration);
  });

  it("lists sync samples when only some frames are key frames", () => {
    const stss = find(file, ["moov", "trak", "mdia", "minf", "stbl", "stss"]);
    const view = new DataView(stss.payload.buffer, stss.payload.byteOffset, stss.payload.byteLength);
    expect(view.getUint32(4)).toBe(1);
    expect(view.getUint32(8)).toBe(1); // sample 1, 1-based
  });

  it("omits stss when every sample is a sync sample", () => {
    const allKey = muxMp4({
      width: 16,
      height: 16,
      timescale,
      samples: samples(3, duration).map((sample) => ({ ...sample, keyFrame: true })),
      codecDescription: DESCRIPTION,
    });
    const stbl = find(allKey, ["moov", "trak", "mdia", "minf", "stbl"]);
    expect(boxes(stbl.payload).map((box) => box.type)).not.toContain("stss");
  });

  it("carries the avcC record, and the real dimensions, inside the avc1 sample entry", () => {
    const stsd = find(file, ["moov", "trak", "mdia", "minf", "stbl", "stsd"]);
    // stsd is a full box: 4 bytes of version+flags, then a 4-byte entry count.
    const sampleEntry = boxes(stsd.payload.subarray(8))[0];
    expect(sampleEntry?.type).toBe("avc1");
    const entry = sampleEntry?.payload ?? new Uint8Array(0);
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(view.getUint16(24)).toBe(320);
    expect(view.getUint16(26)).toBe(240);
    // Sub-boxes begin after the 78-byte VisualSampleEntry preamble.
    const avcC = boxes(entry, 78).find((box) => box.type === "avcC");
    expect(avcC?.payload).toEqual(DESCRIPTION);
  });

  it("writes the movie duration in the movie timescale, not the media one", () => {
    const mvhd = find(file, ["moov", "mvhd"]);
    const view = new DataView(mvhd.payload.buffer, mvhd.payload.byteOffset, mvhd.payload.byteLength);
    expect(view.getUint32(12)).toBe(1000); // movie timescale
    // 5 frames at 30fps = 166.67ms.
    expect(view.getUint32(16)).toBe(Math.round((5 * duration * 1000) / timescale));
  });

  it("refuses to write a file it knows no player can decode", () => {
    expect(() => muxMp4({ width: 8, height: 8, timescale, samples: frames, codecDescription: new Uint8Array(0) })).toThrow(
      /avcC/i,
    );
    expect(() => muxMp4({ width: 8, height: 8, timescale, samples: [], codecDescription: DESCRIPTION })).toThrow(
      /no samples/i,
    );
  });

  it("derives the codec string from the SPS rather than hardcoding one", () => {
    expect(avcCodecString(DESCRIPTION)).toBe("avc1.42001f");
  });
});
