import type { TextureFormat } from "../../../domain/types/node-definition.ts";
import type { EncoderConfig } from "./types.ts";

/**
 * The recording formats a take can be written in (T1741b), and the codec each one asks for.
 *
 * Pure policy, no WebCodecs: the probe, the encoder and the render dialog all read this one
 * table, so the format a user picks, the codec string the browser is asked about and the
 * sentence that explains a refusal cannot drift into three answers.
 *
 * - `h264` is the compatible default and is exactly what every take used before this
 *   table existed: Baseline 4.2 through 1080p, High 5.2 above it (`h264CodecFor`).
 * - `h264-high` is H.264 High at every size, still 8-bit 4:2:0: the better 8-bit file.
 * - `hevc-main10` is HEVC Main 10, 10-bit 4:2:0. It is the only one that changes what the
 *   file can hold, and it is only honest from a source that holds more than 8 bits, so it
 *   reads the Output back at full precision instead of capturing the 8-bit canvas
 *   (`./yuv10.ts`) and refuses an 8-bit Output by name (`videoFormatSourceRefusal`).
 *
 * The default stays H.264 because it is the one every player and browser decodes, and
 * because Chrome ships its HEVC 10-bit encoder disabled (measured: Chrome 157 and Chromium
 * 151 on macOS refuse `hvc1.2.4` unless launched with the switch named below).
 */

export type VideoFormatId = "h264" | "h264-high" | "hevc-main10";

export type VideoCodecFamily = "avc" | "hevc";

export interface VideoFormatInfo {
  readonly id: VideoFormatId;
  /** Short name for sentences: "H.264 ready (…)", "HEVC Main 10 unavailable: …". */
  readonly name: string;
  /** What the picker shows. */
  readonly label: string;
  readonly family: VideoCodecFamily;
  /** Bits per sample in the FILE. 10 is only written from a source that has them. */
  readonly bitDepth: 8 | 10;
}

export const VIDEO_FORMATS: readonly VideoFormatInfo[] = [
  { id: "h264", name: "H.264", label: "H.264 · 8-bit · plays everywhere", family: "avc", bitDepth: 8 },
  { id: "h264-high", name: "H.264 High", label: "H.264 High · 8-bit", family: "avc", bitDepth: 8 },
  { id: "hevc-main10", name: "HEVC Main 10", label: "HEVC Main 10 · 10-bit", family: "hevc", bitDepth: 10 },
];

export const VIDEO_FORMAT_IDS = ["h264", "h264-high", "hevc-main10"] as const satisfies readonly VideoFormatId[];

export const DEFAULT_VIDEO_FORMAT: VideoFormatId = "h264";

/** The Chrome launch switch that enables its HEVC Main 10 encoder. */
export const HEVC_TEN_BIT_CHROME_SWITCH = "--enable-features=PlatformHEVCHbdEncoderSupport";

export function videoFormatInfo(format: VideoFormatId): VideoFormatInfo {
  const found = VIDEO_FORMATS.find((entry) => entry.id === format);
  if (found === undefined) throw new RangeError(`Unknown video format "${String(format)}".`);
  return found;
}

/**
 * H.264 policy for Loom's two production size classes (the `h264` format).
 *
 * Baseline level 4.2 covers the ordinary 1080p path. UHD needs a profile/level that can
 * describe 3840x2160 at 60 fps, so it uses High level 5.2. This is selected before probing;
 * an unavailable hardware/software encoder is reported, never replaced silently.
 */
export function h264CodecFor(config: EncoderConfig): string {
  return config.width > 1920 || config.height > 1080 ? "avc1.640034" : "avc1.42002a";
}

/** H.264 levels (Table A-1): level_idc, MaxFS in macroblocks, MaxMBPS. */
const AVC_LEVELS: ReadonlyArray<readonly [number, number, number]> = [
  [0x1f, 3_600, 108_000], // 3.1
  [0x28, 8_192, 245_760], // 4.0
  [0x2a, 8_704, 522_240], // 4.2
  [0x33, 36_864, 983_040], // 5.1
  [0x34, 36_864, 2_073_600], // 5.2
  [0x3c, 139_264, 4_177_920], // 6.0
  [0x3d, 139_264, 8_355_840], // 6.1
  [0x3e, 139_264, 16_711_680], // 6.2
];

/** HEVC Main tier levels (Table A.8): general_level_idc, MaxLumaPs, MaxLumaSr. */
const HEVC_LEVELS: ReadonlyArray<readonly [number, number, number]> = [
  [93, 983_040, 33_177_600], // 3.1
  [120, 2_228_224, 66_846_720], // 4
  [123, 2_228_224, 133_693_440], // 4.1
  [150, 8_912_896, 267_386_880], // 5
  [153, 8_912_896, 534_773_760], // 5.1
  [156, 8_912_896, 1_069_547_520], // 5.2
  [180, 35_651_584, 1_069_547_520], // 6
  [183, 35_651_584, 2_139_095_040], // 6.1
  [186, 35_651_584, 4_278_190_080], // 6.2
];

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** The lowest H.264 level whose frame size, macroblock rate and frame edge hold this take. */
function avcLevelFor(config: EncoderConfig): number {
  const widthMbs = Math.ceil(config.width / 16);
  const heightMbs = Math.ceil(config.height / 16);
  const frameMbs = widthMbs * heightMbs;
  const rate = frameMbs * config.fps;
  const fits = AVC_LEVELS.find(([, maxFs, maxMbps]) =>
    frameMbs <= maxFs && rate <= maxMbps && Math.max(widthMbs, heightMbs) <= Math.sqrt(8 * maxFs));
  return (fits ?? AVC_LEVELS[AVC_LEVELS.length - 1]!)[0];
}

/** The lowest HEVC Main tier level whose picture size, sample rate and edge hold this take. */
function hevcLevelFor(config: EncoderConfig): number {
  const pictureSize = config.width * config.height;
  const rate = pictureSize * config.fps;
  const fits = HEVC_LEVELS.find(([, maxPs, maxSr]) =>
    pictureSize <= maxPs && rate <= maxSr && Math.max(config.width, config.height) <= Math.sqrt(8 * maxPs));
  return (fits ?? HEVC_LEVELS[HEVC_LEVELS.length - 1]!)[0];
}

/** H.264 High profile (`avc1.64…`, no constraint flags), at the lowest level that describes the take. */
export function h264HighCodecFor(config: EncoderConfig): string {
  return `avc1.6400${hex2(avcLevelFor(config))}`;
}

/**
 * HEVC Main 10 (`hvc1.2.4.L…`): profile_idc 2, compatible with Main 10 only (flag 2, so
 * `4` reversed), Main tier, progressive frame-only constraints (`B0`).
 *
 * The compatibility digit matters: `hvc1.2.6` also claims Main compatibility, and Chrome
 * reads that string as plain 8-bit Main (measured: it encodes `yuv420p`, profile Main).
 */
export function hevcMain10CodecFor(config: EncoderConfig): string {
  return `hvc1.2.4.L${String(hevcLevelFor(config))}.B0`;
}

export function videoCodecFor(format: VideoFormatId, config: EncoderConfig): string {
  switch (format) {
    case "h264":
      return h264CodecFor(config);
    case "h264-high":
      return h264HighCodecFor(config);
    case "hevc-main10":
      return hevcMain10CodecFor(config);
  }
}

/** The family a codec string belongs to, so an explicit `codec` override still muxes right. */
export function codecFamilyOf(codec: string): VideoCodecFamily {
  return codec.startsWith("hvc1") || codec.startsWith("hev1") ? "hevc" : "avc";
}

/** The sentence a user reads when the browser has no encoder for this format at this size. */
export function unsupportedVideoFormatReason(format: VideoFormatId, config: EncoderConfig): string {
  const at = `${String(config.width)}x${String(config.height)} at ${String(config.fps)} fps`;
  switch (format) {
    case "h264":
      return `No H.264 encoder supports ${at}.`;
    case "h264-high":
      return `No H.264 High encoder supports ${at}.`;
    case "hevc-main10":
      return (
        `This browser has no HEVC Main 10 encoder for ${at}. Chrome keeps its 10-bit HEVC ` +
        `encoder behind a launch switch: quit Chrome and start it with ${HEVC_TEN_BIT_CHROME_SWITCH}. ` +
        "Until then, H.264 High is the best 8-bit file."
      );
  }
}

/** Output formats whose samples hold more than 8 bits of a colour channel. */
function carriesMoreThanEightBits(format: TextureFormat): boolean {
  return format === "rgba16float" || format === "r32float";
}

/**
 * Why this Output cannot feed this format, or null when it can.
 *
 * A 10-bit file of an 8-bit Output is 8-bit data with two zero bits under it: it bands
 * exactly like the H.264 file, and calling it 10-bit is the lie this refuses.
 */
export function videoFormatSourceRefusal(format: VideoFormatId, output: TextureFormat): string | null {
  const info = videoFormatInfo(format);
  if (info.bitDepth === 8 || carriesMoreThanEightBits(output)) return null;
  return (
    `${info.name} needs an Output with more than 8 bits per channel, and this Output is ` +
    `${output}. Set the project's working format to rgba16float to render 10-bit.`
  );
}
