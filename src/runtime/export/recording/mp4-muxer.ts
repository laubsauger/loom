/**
 * A minimal, progressive MP4 muxer for H.264 (T111).
 *
 * `VideoEncoder` produces H.264 access units; it does not produce a file. Something has to
 * write the container, and the locked decision is WebCodecs → mp4 with no MediaRecorder
 * stopgap (§C recording), so the container is ours.
 *
 * Layout is `ftyp` / `mdat` / `moov`, in that order. That ordering is what makes this
 * tractable: `stco` chunk offsets have to point into `mdat`, so writing `mdat` first means
 * every offset is known before `moov` is built. A `moov`-first file needs either a second
 * pass or fragmentation, and both are more machinery for no benefit here — the whole take is
 * already buffered in memory by the time the encoder flushes.
 *
 * DOM-free and dependency-free, so it runs in a worker, in Node, and in a unit test.
 */

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function u16(value: number): Uint8Array {
  return u8((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  return u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.length + 8), ascii(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...payload);
}

const UNITY_MATRIX = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

export interface Mp4Sample {
  readonly bytes: Uint8Array;
  readonly keyFrame: boolean;
  /** In media timescale units. */
  readonly duration: number;
}

export interface Mp4MuxInput {
  readonly width: number;
  readonly height: number;
  /** Media timescale. `fps * 1000` keeps every per-frame duration an exact integer. */
  readonly timescale: number;
  readonly samples: ReadonlyArray<Mp4Sample>;
  /** `avcC` payload from the encoder's `decoderConfig.description`. */
  readonly codecDescription: Uint8Array;
}

const MOVIE_TIMESCALE = 1000;

/** Media timescale that keeps a per-frame duration integral for any integer-ish fps. */
export function timescaleFor(fps: number): number {
  return Math.round(fps * 1000);
}

export function sampleDurationFor(fps: number): number {
  return Math.round(timescaleFor(fps) / fps);
}

export function muxMp4(input: Mp4MuxInput): Uint8Array {
  const { samples, timescale } = input;
  if (samples.length === 0) throw new Error("Cannot mux an MP4 with no samples.");
  if (input.codecDescription.length === 0) {
    throw new Error(
      "Cannot mux an MP4 without an avcC decoder description. The encoder must be configured " +
        'with avc: { format: "avc" } so it reports one — annex-B output has no avcC and would ' +
        "produce a file no player can decode.",
    );
  }

  const mediaDuration = samples.reduce((total, sample) => total + sample.duration, 0);
  const movieDuration = Math.round((mediaDuration * MOVIE_TIMESCALE) / timescale);

  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
  const mediaBytes = concat(samples.map((sample) => sample.bytes));
  const mdat = box("mdat", mediaBytes);
  // Samples are written back to back in one chunk, so the chunk offset is simply where
  // `mdat`'s payload starts.
  const chunkOffset = ftyp.length + 8;

  // stts: one entry per distinct duration run. Constant-fps takes collapse to a single entry.
  const sttsEntries: Array<[number, number]> = [];
  for (const sample of samples) {
    const last = sttsEntries[sttsEntries.length - 1];
    if (last && last[1] === sample.duration) last[0] += 1;
    else sttsEntries.push([1, sample.duration]);
  }
  const stts = fullBox(
    "stts",
    0,
    0,
    u32(sttsEntries.length),
    ...sttsEntries.map((entry) => concat([u32(entry[0]), u32(entry[1])])),
  );

  const stsz = fullBox(
    "stsz",
    0,
    0,
    u32(0),
    u32(samples.length),
    ...samples.map((sample) => u32(sample.bytes.length)),
  );

  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
  const stco = fullBox("stco", 0, 0, u32(1), u32(chunkOffset));

  // stss lists sync samples, 1-based. Omitted entirely when every sample is a sync sample —
  // which is what "no stss" means, and writing one listing all of them is equivalent but
  // larger.
  const syncSamples = samples
    .map((sample, index) => (sample.keyFrame ? index + 1 : 0))
    .filter((index) => index > 0);
  const stss =
    syncSamples.length === samples.length
      ? []
      : [fullBox("stss", 0, 0, u32(syncSamples.length), ...syncSamples.map(u32))];

  const avcC = box("avcC", input.codecDescription);
  const avc1 = box(
    "avc1",
    u8(0, 0, 0, 0, 0, 0), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    u32(0),
    u32(0),
    u32(0), // pre_defined[3]
    u16(input.width),
    u16(input.height),
    u32(0x00480000), // 72dpi horizontal
    u32(0x00480000), // 72dpi vertical
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    avcC,
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  const stbl = box("stbl", stsd, stts, ...stss, stsc, stsz, stco);

  const dref = fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1));
  const dinf = box("dinf", dref);
  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const minf = box("minf", vmhd, dinf, stbl);

  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    ascii("vide"),
    u32(0),
    u32(0),
    u32(0),
    ascii("Shaderloom\0"),
  );
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0));
  const mdia = box("mdia", mdhd, hdlr, minf);

  const tkhd = fullBox(
    "tkhd",
    0,
    0x000003, // track enabled + in movie
    u32(0),
    u32(0),
    u32(1), // track_ID
    u32(0), // reserved
    u32(movieDuration),
    u32(0),
    u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume (0 for video)
    u16(0), // reserved
    UNITY_MATRIX,
    u32(input.width << 16),
    u32(input.height << 16),
  );
  const trak = box("trak", tkhd, mdia);

  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(movieDuration),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), // reserved
    u32(0),
    u32(0), // reserved
    UNITY_MATRIX,
    new Uint8Array(24), // pre_defined
    u32(2), // next_track_ID
  );
  const moov = box("moov", mvhd, trak);

  return concat([ftyp, mdat, moov]);
}

/**
 * `avc1.PPCCLL` from the SPS inside an avcC record: profile_idc, constraint flags, level_idc
 * are bytes 1..3. Reported rather than hardcoded so the mime type describes the file that was
 * actually produced.
 */
export function avcCodecString(description: Uint8Array): string {
  if (description.length < 4) return "avc1";
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  return `avc1.${hex(description[1] ?? 0)}${hex(description[2] ?? 0)}${hex(description[3] ?? 0)}`;
}
