import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ReadbackImage } from "../../domain/types/backend.ts";
import { boundedSize, toRgba8 } from "./image.ts";
import { encodeBase64, encodePng } from "./png.ts";

/**
 * The PNG is checked by taking it apart again — chunk lengths, CRCs, and the zlib stream fed
 * to Node's real inflater. A hand-written encoder that is "probably fine" is worth nothing;
 * either a decoder that did not write it can read it, or it is broken.
 */

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** An independent PNG reader. Verifies the signature, every chunk CRC, and the pixel data. */
function decodePng(bytes: Uint8Array): {
  width: number;
  height: number;
  pixels: Uint8Array;
  chunks: Chunk[];
} {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let at = 8;
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    const declared = view.getUint32(at + 8 + length);
    expect(crc32(bytes.subarray(at + 4, at + 8 + length))).toBe(declared);
    chunks.push({ type, data });
    at += 12 + length;
  }

  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr) throw new Error("no IHDR");
  const header = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  expect(ihdr.data[8]).toBe(8); // bit depth
  expect(ihdr.data[9]).toBe(6); // RGBA

  const idat = chunks.find((chunk) => chunk.type === "IDAT");
  if (!idat) throw new Error("no IDAT");
  // Node's zlib, not ours: this is the claim that the stream is a real zlib stream.
  const raw = new Uint8Array(inflateSync(idat.data));
  expect(raw.length).toBe((width * 4 + 1) * height);

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width * 4 + 1)]).toBe(0); // filter: None
    pixels.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, pixels, chunks };
}

function readback(
  width: number,
  height: number,
  fill: (x: number, y: number) => readonly [number, number, number, number],
): ReadbackImage {
  const rowStride = width * 4 + 12; // deliberately padded
  const bytes = new Uint8Array(rowStride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      bytes.set(fill(x, y), y * rowStride + x * 4);
    }
  }
  return { width, height, format: "rgba8unorm", rowStride, bytes };
}

describe("PNG encoding", () => {
  it("produces an image a decoder that did not write it can read", () => {
    const source = readback(3, 2, (x, y) => [x * 40, y * 90, 12, 255]);
    const png = encodePng(toRgba8(source));
    const decoded = decodePng(png.bytes);
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect(decoded.chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([...decoded.pixels.subarray(0, 4)]).toEqual([0, 0, 12, 255]);
    // Pixel (2,1): the padded source stride must not have shifted it.
    expect([...decoded.pixels.subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)]).toEqual([
      80, 90, 12, 255,
    ]);
  });

  it("round-trips rgba8unorm byte-exactly", () => {
    // The screenshot claim: what the GPU produced is what lands in the file. A decode/encode
    // round trip would be within a rounding error, which is not the same as within zero.
    const source = readback(4, 4, (x, y) => [x * 17, y * 31, (x + y) * 5, 255 - x]);
    const decoded = decodePng(encodePng(toRgba8(source)).bytes);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect([...decoded.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)]).toEqual([
          x * 17,
          y * 31,
          (x + y) * 5,
          255 - x,
        ]);
      }
    }
  });

  it("encodes at a bounded size, preserving aspect", () => {
    const source = readback(64, 32, () => [200, 100, 50, 255]);
    const png = encodePng(toRgba8(source, { maxWidth: 16, maxHeight: 16 }));
    const decoded = decodePng(png.bytes);
    expect([decoded.width, decoded.height]).toEqual([16, 8]);
    expect(decoded.pixels.length).toBe(16 * 8 * 4);
    expect([...decoded.pixels.subarray(0, 4)]).toEqual([200, 100, 50, 255]);
  });

  it("never upscales — an export that invents pixels is not a capture", () => {
    expect(boundedSize(8, 8, 64, 64)).toEqual([8, 8]);
  });

  it("survives a payload larger than one deflate stored block", () => {
    // Stored blocks cap at 65535 bytes; the block-splitting loop is exactly the sort of code
    // that works until the first image bigger than a thumbnail.
    const source = readback(200, 200, (x, y) => [x & 0xff, y & 0xff, 0, 255]);
    const decoded = decodePng(encodePng(toRgba8(source)).bytes);
    expect(decoded.pixels.length).toBe(200 * 200 * 4);
    expect([...decoded.pixels.subarray((199 * 200 + 199) * 4, (199 * 200 + 199) * 4 + 4)]).toEqual([
      199, 199, 0, 255,
    ]);
  });

  it("refuses an empty image instead of writing a malformed one", () => {
    expect(() => encodePng({ width: 0, height: 4, data: new Uint8Array(0) })).toThrow();
  });
});

describe("base64 (agent tool results are JSON, §V37)", () => {
  it("matches a reference implementation across every padding case", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 255]) {
      const bytes = Uint8Array.from({ length }, (_value, index) => (index * 37) & 0xff);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});
