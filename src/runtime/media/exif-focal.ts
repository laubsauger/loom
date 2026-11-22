/**
 * T1817b — the one EXIF field photo preparation reads: a JPEG's 35 mm equivalent focal
 * length (tag 0xA405, `FocalLengthIn35mmFilm`), so Depth Pro 2's field of view can start
 * from the camera instead of a guess.
 *
 * Only that tag. A focal length in millimetres (0x920A) needs the sensor width as well,
 * which EXIF records only indirectly and many cameras omit, so a photo without 0xA405
 * gets no suggestion and the person sets the field of view. HEIC, PNG and WebP are not
 * read either; their photos also get no suggestion. Nothing here throws on a malformed
 * file: a photo whose metadata cannot be read is still a photo.
 */

const SOI = 0xffd8;
const APP1 = 0xffe1;
const EXIF_IFD_POINTER = 0x8769;
const FOCAL_LENGTH_35MM = 0xa405;
const SHORT = 3;

/** A JPEG's 35 mm equivalent focal length in millimetres, or undefined when it records none. */
export function focalLength35FromJpeg(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== SOI) return undefined;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return undefined;
    // Start of scan: the metadata segments are all before it.
    if (marker === 0xffda) return undefined;
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    if (marker === APP1 && offset + 10 <= view.byteLength && exifHeader(view, offset + 4)) {
      return readTiff(view, offset + 10, Math.min(view.byteLength, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return undefined;
}

function exifHeader(view: DataView, at: number): boolean {
  // "Exif\0\0"
  return view.getUint32(at) === 0x45786966 && view.getUint16(at + 4) === 0;
}

function readTiff(view: DataView, start: number, end: number): number | undefined {
  if (start + 8 > end) return undefined;
  const order = view.getUint16(start);
  if (order !== 0x4949 && order !== 0x4d4d) return undefined;
  const little = order === 0x4949;
  const u16 = (at: number) => (at + 2 <= end ? view.getUint16(at, little) : undefined);
  const u32 = (at: number) => (at + 4 <= end ? view.getUint32(at, little) : undefined);
  if (u16(start + 2) !== 42) return undefined;
  const entry = (ifd: number, tag: number): number | undefined => {
    const count = u16(start + ifd);
    if (count === undefined) return undefined;
    for (let index = 0; index < count; index += 1) {
      const at = start + ifd + 2 + index * 12;
      if (u16(at) === tag) return at;
    }
    return undefined;
  };
  const ifd0 = u32(start + 4);
  if (ifd0 === undefined) return undefined;
  const pointer = entry(ifd0, EXIF_IFD_POINTER);
  const exifIfd = pointer === undefined ? undefined : u32(pointer + 8);
  if (exifIfd === undefined) return undefined;
  const focal = entry(exifIfd, FOCAL_LENGTH_35MM);
  if (focal === undefined || u16(focal + 2) !== SHORT) return undefined;
  const value = u16(focal + 8);
  // 0 is EXIF's "unknown".
  return value === undefined || value === 0 ? undefined : value;
}

/** The diagonal of a 36 × 24 mm frame, which a 35 mm equivalent focal length is defined against. */
const FULL_FRAME_DIAGONAL = Math.hypot(36, 24);

/**
 * The horizontal field of view, in degrees, of a `width × height` photo shot at a 35 mm
 * equivalent focal length. The equivalence is by DIAGONAL (the photo's diagonal stands for
 * the 43.3 mm one), so the photo's own aspect decides how much of it is horizontal: a 3:2
 * landscape gets the full 36 mm, a 4:3 one 34.6 mm, a portrait its short side.
 */
export function horizontalFieldOfView(focalLength35: number, width: number, height: number): number {
  const horizontal = FULL_FRAME_DIAGONAL * (width / Math.hypot(width, height));
  return 2 * Math.atan(horizontal / (2 * focalLength35)) * (180 / Math.PI);
}
