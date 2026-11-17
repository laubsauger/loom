import { describe, expect, it } from "vitest";
import { avcCodecString, hevcCodecString, mp4StreamParts, muxMp4, sampleDurationFor, timescaleFor } from "./mp4-muxer.ts";
import type { Mp4AudioTrack, Mp4Sample } from "./mp4-muxer.ts";

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

const AUDIO_DESCRIPTION = Uint8Array.from([0x12, 0x10]); // AAC-LC, 44.1 kHz, stereo

function audioTrack(sampleCount = 3): Mp4AudioTrack {
  return {
    sampleRate: 44100,
    channelCount: 2,
    codecDescription: AUDIO_DESCRIPTION,
    bitrate: 192000,
    samples: Array.from({ length: sampleCount }, (_value, index) => ({
      bytes: Uint8Array.from({ length: 7 + index }, () => 0xa0 + index),
      duration: 1024,
    })),
  };
}

function tracks(file: Uint8Array): Box[] {
  return boxes(find(file, ["moov"]).payload).filter((candidate) => candidate.type === "trak");
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
      expect(view.getUint32(12 + index * 4)).toBe(frames[index]?.bytes?.length);
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

  it("adds an AAC-LC sound track with mp4a and esds sample descriptions", () => {
    const audio = audioTrack();
    const withAudio = muxMp4({
      width: 320,
      height: 240,
      timescale,
      samples: frames,
      codecDescription: DESCRIPTION,
      audio,
    });
    const fileTracks = tracks(withAudio);
    expect(fileTracks).toHaveLength(2);

    const audioTrak = fileTracks[1];
    expect(audioTrak).toBeDefined();
    const hdlr = find(audioTrak?.payload ?? new Uint8Array(0), ["mdia", "hdlr"]);
    expect(String.fromCharCode(...hdlr.payload.subarray(8, 12))).toBe("soun");

    const mdhd = find(audioTrak?.payload ?? new Uint8Array(0), ["mdia", "mdhd"]);
    const mdhdView = new DataView(mdhd.payload.buffer, mdhd.payload.byteOffset, mdhd.payload.byteLength);
    expect(mdhdView.getUint32(12)).toBe(audio.sampleRate);
    expect(mdhdView.getUint32(16)).toBe(3 * 1024);

    const stsd = find(audioTrak?.payload ?? new Uint8Array(0), ["mdia", "minf", "stbl", "stsd"]);
    const mp4a = boxes(stsd.payload.subarray(8))[0];
    expect(mp4a?.type).toBe("mp4a");
    const entry = mp4a?.payload ?? new Uint8Array(0);
    const entryView = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(entryView.getUint16(16)).toBe(2);
    expect(entryView.getUint32(24) >>> 16).toBe(44100);
    const esds = boxes(entry, 28).find((candidate) => candidate.type === "esds");
    expect(esds).toBeDefined();
    expect(Array.from(esds?.payload ?? [])).toContain(0x40); // MPEG-4 Audio object type
    expect(Array.from(esds?.payload ?? [])).toContain(0x12); // AudioSpecificConfig byte 1
  });

  it("places the audio chunk after video samples and records every AAC sample size", () => {
    const audio = audioTrack();
    const withAudio = muxMp4({
      width: 320,
      height: 240,
      timescale,
      samples: frames,
      codecDescription: DESCRIPTION,
      audio,
    });
    const top = boxes(withAudio);
    const mdat = top.find((candidate) => candidate.type === "mdat");
    const videoByteLength = frames.reduce((total, sample) => total + (sample.bytes?.length ?? 0), 0);
    const audioTrak = tracks(withAudio)[1];
    const stco = find(audioTrak?.payload ?? new Uint8Array(0), ["mdia", "minf", "stbl", "stco"]);
    const stcoView = new DataView(stco.payload.buffer, stco.payload.byteOffset, stco.payload.byteLength);
    expect(stcoView.getUint32(8)).toBe((mdat?.start ?? -1) + 8 + videoByteLength);

    const stsz = find(audioTrak?.payload ?? new Uint8Array(0), ["mdia", "minf", "stbl", "stsz"]);
    const stszView = new DataView(stsz.payload.buffer, stsz.payload.byteOffset, stsz.payload.byteLength);
    expect(stszView.getUint32(8)).toBe(audio.samples.length);
    audio.samples.forEach((sample, index) => {
      expect(stszView.getUint32(12 + index * 4)).toBe(sample.bytes?.length);
    });
  });

  it("uses the longer track for movie duration while keeping each track duration independent", () => {
    const longAudio = audioTrack(50); // about 1.16s; video is about 0.17s
    const withAudio = muxMp4({
      width: 320,
      height: 240,
      timescale,
      samples: frames,
      codecDescription: DESCRIPTION,
      audio: longAudio,
    });
    const mvhd = find(withAudio, ["moov", "mvhd"]);
    const mvhdView = new DataView(mvhd.payload.buffer, mvhd.payload.byteOffset, mvhd.payload.byteLength);
    expect(mvhdView.getUint32(16)).toBe(Math.round((50 * 1024 * 1000) / 44100));

    const [videoTrak, audioTrak] = tracks(withAudio);
    for (const [track, expected] of [
      [videoTrak, Math.round((frames.length * duration * 1000) / timescale)],
      [audioTrak, Math.round((50 * 1024 * 1000) / 44100)],
    ] as const) {
      const tkhd = find(track?.payload ?? new Uint8Array(0), ["tkhd"]);
      const tkhdView = new DataView(tkhd.payload.buffer, tkhd.payload.byteOffset, tkhd.payload.byteLength);
      expect(tkhdView.getUint32(20)).toBe(expected);
    }
  });

  it("writes an edit list that removes encoder priming and pins audible duration", () => {
    const audio = {
      ...audioTrack(4),
      mediaStart: 2112,
      presentationDuration: 1024,
    };
    const withAudio = muxMp4({
      width: 320,
      height: 240,
      timescale,
      samples: frames,
      codecDescription: DESCRIPTION,
      audio,
    });
    const audioTrak = tracks(withAudio)[1];
    const elst = find(audioTrak?.payload ?? new Uint8Array(0), ["edts", "elst"]);
    const view = new DataView(elst.payload.buffer, elst.payload.byteOffset, elst.payload.byteLength);
    expect(view.getUint32(8)).toBe(Math.round((1024 * 1000) / 44100));
    expect(view.getUint32(12)).toBe(2112);
  });

  it("rejects incomplete AAC track metadata", () => {
    const base = { width: 320, height: 240, timescale, samples: frames, codecDescription: DESCRIPTION };
    expect(() => muxMp4({ ...base, audio: { ...audioTrack(), samples: [] } })).toThrow(/no samples/i);
    expect(() => muxMp4({ ...base, audio: { ...audioTrack(), codecDescription: new Uint8Array(0) } })).toThrow(
      /AudioSpecificConfig/i,
    );
  });

  it("describes media beyond 4 GiB without allocating it and uses a 64-bit audio offset", () => {
    const videoBytes = 0x1_0000_0100;
    const parts = mp4StreamParts({
      width: 3840,
      height: 2160,
      timescale,
      samples: [{ byteLength: videoBytes, keyFrame: true, duration }],
      codecDescription: DESCRIPTION,
      audio: {
        ...audioTrack(1),
        samples: [{ byteLength: 2, duration: 1024 }],
      },
    });
    const mdat = new DataView(
      parts.mdatHeader.buffer,
      parts.mdatHeader.byteOffset,
      parts.mdatHeader.byteLength,
    );
    expect(mdat.getUint32(0)).toBe(1);
    expect(mdat.getBigUint64(8)).toBe(BigInt(16 + videoBytes + 2));

    const audioTrak = tracks(parts.moov)[1];
    const co64 = find(audioTrak?.payload ?? new Uint8Array(0), ["mdia", "minf", "stbl", "co64"]);
    const offsets = new DataView(co64.payload.buffer, co64.payload.byteOffset, co64.payload.byteLength);
    expect(offsets.getBigUint64(8)).toBe(BigInt(parts.ftyp.length + 16 + videoBytes));
  });

  it("builds an hour-scale AAC sample table without spreading one argument per packet", () => {
    const audioSamples = Array.from({ length: 170_000 }, () => ({ byteLength: 200, duration: 1024 }));
    const parts = mp4StreamParts({
      width: 1920,
      height: 1080,
      timescale,
      samples: [{ byteLength: 1_000, keyFrame: true, duration }],
      codecDescription: DESCRIPTION,
      audio: {
        sampleRate: 48_000,
        channelCount: 1,
        samples: audioSamples,
        codecDescription: AUDIO_DESCRIPTION,
      },
    });
    expect(parts.moov.byteLength).toBeGreaterThan(audioSamples.length * 4);
  });
});

/**
 * T1741b — the HEVC sample entry. The record below is the one Chrome 157's VideoToolbox
 * encoder reported for a 1920x1080 HEVC Main 10 take (`decoderConfig.description`, measured
 * 2026-11-08): profile_idc 2, compatibility flag 2, 4:2:0, 10-bit luma and chroma, VPS/SPS/PPS
 * arrays with array_completeness set. Its key frames carried SEI and IDR NAL units only, so
 * the parameter sets are in this record and nowhere else: what `hvc1` (not `hev1`) declares.
 */
const CHROME_HVCC = Uint8Array.from(
  ("010220000000b000000000007bf000fcfdfafa00000f03a00001001840010c01ffff022000000300b00000030000" +
    "03007b1b0240a10001002a420101022000000300b0000003000003007ba003c0801107cad881bb916452ffcb9fc4" +
    "fea6a020202010a2000100074401c072f05324").match(/../g)!.map((pair) => parseInt(pair, 16)),
);

describe("HEVC muxing (T1741b)", () => {
  const timescale = timescaleFor(60);
  const frames = samples(4, sampleDurationFor(60));
  const file = muxMp4({ width: 1920, height: 1080, timescale, samples: frames, codec: "hevc", codecDescription: CHROME_HVCC });

  it("reads the record the way a demuxer does: Main 10, 4:2:0, 10-bit", () => {
    // The facts a player takes from hvcC before it decodes a sample.
    expect(CHROME_HVCC[1]! & 0x1f).toBe(2); // general_profile_idc: Main 10
    expect(CHROME_HVCC[16]! & 0x03).toBe(1); // chroma_format_idc: 4:2:0
    expect((CHROME_HVCC[17]! & 0x07) + 8).toBe(10); // bit_depth_luma
    expect((CHROME_HVCC[18]! & 0x07) + 8).toBe(10); // bit_depth_chroma
    expect((CHROME_HVCC[21]! & 0x03) + 1).toBe(4); // NAL length size, which the samples use
  });

  it("writes an hvc1 sample entry carrying the encoder's hvcC record and the real dimensions", () => {
    const stsd = find(file, ["moov", "trak", "mdia", "minf", "stbl", "stsd"]);
    const sampleEntry = boxes(stsd.payload.subarray(8))[0];
    expect(sampleEntry?.type).toBe("hvc1");
    const entry = sampleEntry?.payload ?? new Uint8Array(0);
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(view.getUint16(24)).toBe(1920);
    expect(view.getUint16(26)).toBe(1080);
    const children = boxes(entry, 78);
    expect(children.map((box) => box.type)).toEqual(["hvcC"]);
    expect(children[0]?.payload).toEqual(CHROME_HVCC);
  });

  it("does not claim the avc1 brand in an HEVC file, and still does in an H.264 one", () => {
    const brands = (bytes: Uint8Array): string[] => {
      const ftyp = find(bytes, ["ftyp"]).payload;
      return Array.from({ length: (ftyp.length - 8) / 4 }, (_value, index) =>
        String.fromCharCode(...ftyp.subarray(8 + index * 4, 12 + index * 4)));
    };
    expect(brands(file)).toEqual(["isom", "iso2", "mp41"]);
    const avc = muxMp4({ width: 320, height: 240, timescale, samples: frames, codecDescription: DESCRIPTION });
    expect(brands(avc)).toEqual(["isom", "iso2", "avc1", "mp41"]);
    expect(boxes(avc).map((box) => box.type)).toEqual(["ftyp", "mdat", "moov"]);
  });

  it("streams the same moov for a disk-spooled take", () => {
    const parts = mp4StreamParts({
      width: 1920, height: 1080, timescale, codec: "hevc", codecDescription: CHROME_HVCC,
      samples: frames.map((frame) => ({ byteLength: frame.bytes!.length, keyFrame: frame.keyFrame, duration: frame.duration })),
    });
    const stsd = find(parts.moov, ["moov", "trak", "mdia", "minf", "stbl", "stsd"]);
    expect(boxes(stsd.payload.subarray(8))[0]?.type).toBe("hvc1");
    expect(boxes(parts.ftyp).map((box) => box.type)).toEqual(["ftyp"]);
  });

  it("derives the codec string from the record: the level the encoder wrote, not the one asked for", () => {
    expect(hevcCodecString(CHROME_HVCC)).toBe("hvc1.2.4.L123.B0");
    // A Main record (profile 1, compatible with Main and Main 10, level 3.1) for contrast.
    const main = Uint8Array.from(CHROME_HVCC);
    main[1] = 0x01;
    main.set([0x60, 0, 0, 0], 2);
    main[12] = 93;
    expect(hevcCodecString(main)).toBe("hvc1.1.6.L93.B0");
    // High tier with no constraint flags.
    const high = Uint8Array.from(CHROME_HVCC);
    high[1] = 0x22;
    high.fill(0, 6, 12);
    high[12] = 153;
    expect(hevcCodecString(high)).toBe("hvc1.2.4.H153");
  });

  it("refuses to mux without an hvcC record, or with something that is not one", () => {
    expect(() => muxMp4({ width: 8, height: 8, timescale, samples: frames, codec: "hevc", codecDescription: new Uint8Array(0) }))
      .toThrow(/hvcC/);
    // An avcC handed to the HEVC path: too short to be an HEVCDecoderConfigurationRecord.
    expect(() => muxMp4({ width: 8, height: 8, timescale, samples: frames, codec: "hevc", codecDescription: DESCRIPTION }))
      .toThrow(/not an HEVCDecoderConfigurationRecord/);
  });
});
