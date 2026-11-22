import { describe, expect, it } from "vitest";
import { focalLength35FromJpeg, horizontalFieldOfView } from "./exif-focal.ts";

/**
 * T1817b: Depth Pro 2 scales every metre by the photo's focal length, so a wrong field of
 * view is a wrong distance. These build the JPEG bytes by hand, in both TIFF byte orders,
 * because the reader's job is to find ONE tag through two pointers, and every miss must
 * come back as "no suggestion" rather than a number or an exception.
 */

interface Entry { readonly tag: number; readonly type: number; readonly value: number }

function tiff(little: boolean, exifEntries: readonly Entry[]): Uint8Array {
  // header (8) · IFD0 with one entry (2 + 12 + 4) · Exif IFD
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 12 + 4;
  const bytes = new Uint8Array(exifIfd + 2 + exifEntries.length * 12 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, ifd0, little);
  view.setUint16(ifd0, 1, little);
  view.setUint16(ifd0 + 2, 0x8769, little);
  view.setUint16(ifd0 + 4, 4, little);
  view.setUint32(ifd0 + 6, 1, little);
  view.setUint32(ifd0 + 10, exifIfd, little);
  view.setUint16(exifIfd, exifEntries.length, little);
  exifEntries.forEach((entry, index) => {
    const at = exifIfd + 2 + index * 12;
    view.setUint16(at, entry.tag, little);
    view.setUint16(at + 2, entry.type, little);
    view.setUint32(at + 4, 1, little);
    view.setUint16(at + 8, entry.value, little);
  });
  return bytes;
}

function jpeg(body: Uint8Array): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new TextEncoder().encode("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app1Length = 2 + 6 + body.length;
  const app1 = [0xff, 0xe1, app1Length >> 8, app1Length & 0xff, ...new TextEncoder().encode("Exif"), 0, 0, ...body];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

const FOCAL_35 = { tag: 0xa405, type: 3, value: 26 };
const EXPOSURE = { tag: 0x829a, type: 5, value: 0 };

describe("the 35 mm equivalent focal length of a JPEG (T1817b)", () => {
  it("reads it through IFD0's Exif pointer, in either byte order, past other tags", () => {
    expect(focalLength35FromJpeg(jpeg(tiff(true, [EXPOSURE, FOCAL_35])))).toBe(26);
    expect(focalLength35FromJpeg(jpeg(tiff(false, [EXPOSURE, FOCAL_35])))).toBe(26);
  });

  it("gives no suggestion when the photo records none, records 0 (unknown), or stores another type", () => {
    expect(focalLength35FromJpeg(jpeg(tiff(true, [EXPOSURE])))).toBeUndefined();
    expect(focalLength35FromJpeg(jpeg(tiff(true, [{ ...FOCAL_35, value: 0 }])))).toBeUndefined();
    expect(focalLength35FromJpeg(jpeg(tiff(true, [{ ...FOCAL_35, type: 4 }])))).toBeUndefined();
  });

  it("gives no suggestion for a file that is not a JPEG, or one cut short, and never throws", () => {
    const whole = jpeg(tiff(true, [FOCAL_35]));
    expect(focalLength35FromJpeg(new TextEncoder().encode("\x89PNG\r\n\x1a\n"))).toBeUndefined();
    for (let length = 0; length < whole.length; length += 1) {
      expect(() => focalLength35FromJpeg(whole.subarray(0, length))).not.toThrow();
    }
    // Cut inside the Exif IFD: the tag's bytes are gone, so there is nothing to read.
    expect(focalLength35FromJpeg(whole.subarray(0, whole.length - 20))).toBeUndefined();
  });
});

describe("the horizontal field of view of a 35 mm equivalent focal length", () => {
  it("is the full frame's 36 mm width for a 3:2 landscape, by the diagonal equivalence", () => {
    // 18 mm across a 36 mm width: tan(θ/2) = 1, exactly 90°.
    expect(horizontalFieldOfView(18, 6000, 4000)).toBeCloseTo(90, 10);
  });

  it("follows the photo's own aspect: a portrait's horizontal is its short side", () => {
    expect(horizontalFieldOfView(18, 4000, 6000)).toBeCloseTo(2 * Math.atan(24 / 36) * 180 / Math.PI, 10);
    // A 4:3 frame's width is 4/5 of the 43.27 mm diagonal: 34.6 mm, narrower than 3:2's.
    const fourThirds = horizontalFieldOfView(26, 4032, 3024);
    expect(fourThirds).toBeCloseTo(2 * Math.atan((Math.hypot(36, 24) * 0.8) / 52) * 180 / Math.PI, 10);
    expect(fourThirds).toBeLessThan(horizontalFieldOfView(26, 6000, 4000));
  });
});
