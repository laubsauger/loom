import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIDEO_FORMAT,
  HEVC_TEN_BIT_CHROME_SWITCH,
  VIDEO_FORMATS,
  VIDEO_FORMAT_IDS,
  h264CodecFor,
  unsupportedVideoFormatReason,
  videoCodecFor,
  videoFormatSourceRefusal,
} from "./video-format.ts";

/**
 * T1741b — which codec string each recording format asks the browser for, and why a format
 * is refused. The codec string is what `VideoEncoder.isConfigSupported` answers about, so a
 * wrong profile or level is a format that silently is not the one the dialog names.
 */

const HD60 = { width: 1920, height: 1080, fps: 60 };
const HD30 = { width: 1920, height: 1080, fps: 30 };
const UHD60 = { width: 3840, height: 2160, fps: 60 };
const UHD30 = { width: 3840, height: 2160, fps: 30 };
const PORTRAIT_UHD60 = { width: 2160, height: 3840, fps: 60 };

describe("the compatible default is the H.264 every take used before formats existed", () => {
  it("defaults to h264, and h264 asks for exactly the codec the pre-T1741b selector did", () => {
    expect(DEFAULT_VIDEO_FORMAT).toBe("h264");
    // Baseline 4.2 through 1080p and High 5.2 above it: the strings T111 shipped.
    expect(videoCodecFor("h264", HD60)).toBe("avc1.42002a");
    expect(videoCodecFor("h264", UHD60)).toBe("avc1.640034");
    for (const config of [HD60, HD30, UHD60, UHD30, PORTRAIT_UHD60]) {
      expect(videoCodecFor("h264", config)).toBe(h264CodecFor(config));
    }
  });

  it("offers each format once, in the order the picker shows, with the ids the command accepts", () => {
    expect(VIDEO_FORMATS.map((format) => format.id)).toEqual([...VIDEO_FORMAT_IDS]);
    expect(VIDEO_FORMATS.map((format) => format.bitDepth)).toEqual([8, 8, 10]);
  });
});

describe("H.264 High is High profile at the lowest level that holds the take (Table A-1)", () => {
  it("is High profile (0x64) at every size, never Baseline", () => {
    for (const config of [HD60, HD30, UHD60, UHD30, PORTRAIT_UHD60, { width: 640, height: 360, fps: 30 }]) {
      expect(videoCodecFor("h264-high", config)).toMatch(/^avc1\.6400[0-9a-f]{2}$/);
    }
  });

  it("picks the level from frame size and macroblock rate", () => {
    // 1080p is 8160 macroblocks: 30 fps is 244,800 MB/s (4.0 holds 245,760), 60 fps needs 4.2.
    expect(videoCodecFor("h264-high", HD30)).toBe("avc1.640028");
    expect(videoCodecFor("h264-high", HD60)).toBe("avc1.64002a");
    // UHD is 32,400 macroblocks: 30 fps fits 5.1, 60 fps needs 5.2 — portrait included.
    expect(videoCodecFor("h264-high", UHD30)).toBe("avc1.640033");
    expect(videoCodecFor("h264-high", UHD60)).toBe("avc1.640034");
    expect(videoCodecFor("h264-high", PORTRAIT_UHD60)).toBe("avc1.640034");
  });
});

describe("HEVC Main 10 asks for Main 10 and only Main 10", () => {
  it("is profile 2 with compatibility digit 4, not 6 (which Chrome reads as 8-bit Main)", () => {
    // Measured, Chrome 157: `hvc1.2.6` passes isConfigSupported where `hvc1.2.4` does not,
    // and encodes yuv420p profile Main. A 6 here would be an 8-bit file under a 10-bit name.
    for (const config of [HD60, UHD60, PORTRAIT_UHD60]) {
      expect(videoCodecFor("hevc-main10", config)).toMatch(/^hvc1\.2\.4\.L\d+\.B0$/);
    }
  });

  it("picks the Main tier level from picture size and luma sample rate (Table A.8)", () => {
    expect(videoCodecFor("hevc-main10", { width: 640, height: 360, fps: 30 })).toBe("hvc1.2.4.L93.B0");
    expect(videoCodecFor("hevc-main10", HD30)).toBe("hvc1.2.4.L120.B0");
    expect(videoCodecFor("hevc-main10", HD60)).toBe("hvc1.2.4.L123.B0");
    expect(videoCodecFor("hevc-main10", UHD30)).toBe("hvc1.2.4.L150.B0");
    expect(videoCodecFor("hevc-main10", UHD60)).toBe("hvc1.2.4.L153.B0");
  });
});

describe("a refusal says what to do about it", () => {
  it("names the Chrome switch that enables the HEVC 10-bit encoder, and the 8-bit alternative", () => {
    const reason = unsupportedVideoFormatReason("hevc-main10", HD60);
    expect(reason).toContain("1920x1080 at 60 fps");
    expect(reason).toContain(HEVC_TEN_BIT_CHROME_SWITCH);
    expect(HEVC_TEN_BIT_CHROME_SWITCH).toBe("--enable-features=PlatformHEVCHbdEncoderSupport");
    expect(reason).toContain("H.264 High");
  });

  it("keeps the default's sentence as it was", () => {
    expect(unsupportedVideoFormatReason("h264", UHD60)).toBe("No H.264 encoder supports 3840x2160 at 60 fps.");
  });
});

describe("a 10-bit format refuses an Output that holds 8 bits", () => {
  it("refuses both 8-bit formats by name and accepts the float ones", () => {
    for (const output of ["rgba8unorm", "rgba8unorm-srgb"] as const) {
      const refusal = videoFormatSourceRefusal("hevc-main10", output);
      expect(refusal).toContain(output);
      expect(refusal).toContain("rgba16float");
    }
    expect(videoFormatSourceRefusal("hevc-main10", "rgba16float")).toBeNull();
    expect(videoFormatSourceRefusal("hevc-main10", "r32float")).toBeNull();
  });

  it("never refuses an 8-bit format: an 8-bit file of an 8-bit Output is exactly what it says", () => {
    for (const format of ["h264", "h264-high"] as const) {
      expect(videoFormatSourceRefusal(format, "rgba8unorm-srgb")).toBeNull();
      expect(videoFormatSourceRefusal(format, "rgba16float")).toBeNull();
    }
  });
});
