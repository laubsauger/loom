import type { Rgba8Image } from "./image.ts";

/**
 * A PNG encoder in ~100 lines, because the alternatives are worse here.
 *
 * `canvas.toDataURL` and `OffscreenCanvas.convertToBlob` are the obvious answers and both are
 * unusable: `src/runtime/**` is lint-banned from the DOM (§V63 / T92) so the whole runtime
 * stays movable into a worker, and neither exists in the headless Node path (§V47) that CI
 * renders through. A dependency would be a third option, but PNG's uncompressed profile is
 * small enough that owning it costs less than owning a supply-chain surface.
 *
 * The output is a real, spec-conformant PNG: 8-bit RGBA, no interlacing, one IDAT holding a
 * zlib stream of stored (uncompressed) deflate blocks. Stored blocks mean no compression —
 * a screenshot is a few megabytes — but they also mean no Huffman implementation to get
 * subtly wrong, and every decoder in the world reads them.
 */

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  // 5552 is the largest run that cannot overflow the 32-bit accumulator before a modulo.
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(start + 5552, bytes.length);
    for (let i = start; i < end; i += 1) {
      a += bytes[i] ?? 0;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib stream (RFC 1950) whose deflate payload is stored blocks only (RFC 1951 §3.2.4). */
function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX_BLOCK = 0xffff;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX_BLOCK));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let at = 0;
  out[at++] = 0x78; // CMF: deflate, 32K window
  out[at++] = 0x01; // FLG: no dictionary, fastest — checksum makes (0x78<<8|0x01) % 31 === 0
  for (let block = 0; block < blocks; block += 1) {
    const start = block * MAX_BLOCK;
    const length = Math.min(MAX_BLOCK, raw.length - start);
    out[at++] = block === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00 (stored)
    out[at++] = length & 0xff;
    out[at++] = (length >>> 8) & 0xff;
    out[at++] = ~length & 0xff;
    out[at++] = (~length >>> 8) & 0xff;
    out.set(raw.subarray(start, start + length), at);
    at += length;
  }
  new DataView(out.buffer).setUint32(at, adler32(raw));
  return out;
}

export interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png";
  readonly bytes: Uint8Array;
}

/** Encodes a tightly packed 8-bit RGBA image as a PNG. */
export function encodePng(image: Rgba8Image): PngImage {
  if (image.width <= 0 || image.height <= 0) {
    throw new Error(`Cannot encode a ${image.width}x${image.height} PNG.`);
  }
  const expected = image.width * image.height * 4;
  if (image.data.length !== expected) {
    throw new Error(
      `PNG encode expected ${expected} bytes for ${image.width}x${image.height} RGBA, got ${image.data.length}.`,
    );
  }

  const rowBytes = image.width * 4;
  // One filter byte per scanline. Filter 0 (None): filtering only pays off with real
  // compression, and there is none here.
  const raw = new Uint8Array((rowBytes + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(image.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, image.width);
  header.setUint32(4, image.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { width: image.width, height: image.height, mimeType: "image/png", bytes };
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 without `btoa` (browser-only) or `Buffer` (Node-only).
 *
 * An agent tool result is JSON (§V37), so a preview PNG has to cross as text; doing it here
 * keeps that from becoming a reason for the agent adapter to reach for a host global.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64[(triple >>> 18) & 63] ?? "";
    out += BASE64[(triple >>> 12) & 63] ?? "";
    out += i + 1 < bytes.length ? (BASE64[(triple >>> 6) & 63] ?? "") : "=";
    out += i + 2 < bytes.length ? (BASE64[triple & 63] ?? "") : "=";
  }
  return out;
}
