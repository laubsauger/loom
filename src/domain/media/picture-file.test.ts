import { describe, expect, it } from "vitest";

import {
  PICTURE_FILE_ACCEPT,
  hdrPictureRefusal,
  isStillPictureFile,
  pictureFileExtension,
  pictureFileKind,
  pictureFileName,
  pictureFileUrl,
} from "./picture-file.ts";

/**
 * T1223 — the classification Movie File In's description already claimed.
 *
 * The node opened *"Plays a video or still image file"* while the loader built a `<video>`
 * and nothing else. These tests are about the DECISION that makes the claim true: what the
 * picker offers, which door a file opens, and which files are refused by name instead of
 * being decoded into a texture that cannot hold them.
 */

describe("what the picker offers (T1223)", () => {
  /**
   * The owner's symptom, at its source: the accept string must admit a still at all.
   * Asserted on the CONTENT rather than the exact string so adding a format is not a
   * two-file edit — but `video/*` is pinned because dropping it would silently turn the
   * movie node into an image node.
   */
  it("takes video AND the still formats the browser decodes", () => {
    const offered = PICTURE_FILE_ACCEPT.split(",");
    expect(offered).toContain("video/*");
    expect(offered).toContain("image/png");
    expect(offered).toContain("image/jpeg");
    expect(offered).toContain("image/webp");
  });

  /**
   * ⚑ THE CLAIM THAT MATTERS MORE THAN THE ONE ABOVE: `image/*` would have been the
   * one-word widening, and it OFFERS `.exr`. A dialog that admits a file the loader then
   * refuses is worse than one that never offered it, so the list is enumerated and this
   * asserts the enumeration is the reason rather than an accident of typing.
   */
  it("does NOT offer image/*, because that would offer EXR and EXR is refused", () => {
    expect(PICTURE_FILE_ACCEPT).not.toContain("image/*");
    expect(PICTURE_FILE_ACCEPT).not.toContain("exr");
    expect(PICTURE_FILE_ACCEPT).not.toContain("hdr");
  });
});

describe("which door a file opens (T1223)", () => {
  it("routes stills to the image door and videos to the video door", () => {
    expect(pictureFileKind("clip.mp4")).toBe("video");
    expect(pictureFileKind("clip.MOV")).toBe("video");
    expect(pictureFileKind("photo.png")).toBe("still");
    expect(pictureFileKind("photo.JPG")).toBe("still");
    expect(pictureFileKind("photo.webp")).toBe("still");
  });

  /**
   * The classifier is deliberately MORE generous than the accept list: a HEIC or a TIFF
   * that arrives from a saved project or an agent is ATTEMPTED, and `createImageBitmap`
   * refuses it by name if the engine cannot decode it. A static "unsupported" list would
   * be a lie in one engine or the other — Safari decodes HEIC, Chrome does not.
   */
  it("attempts stills it does not offer, rather than pre-judging them", () => {
    expect(pictureFileKind("photo.heic")).toBe("still");
    expect(pictureFileKind("scan.tiff")).toBe("still");
  });

  /**
   * §T1222's boundary, stated as a test: an HDR file is NOT quietly decoded into the
   * 8-bit path. Accepting a format and throwing away what makes it that format is the
   * failure mode this task exists to close.
   */
  it("names HDR stills as HDR, never as an ordinary still", () => {
    expect(pictureFileKind("ladybrand_heritage_house_4k.exr")).toBe("hdr");
    expect(pictureFileKind("ladybrand_heritage_house_4k.hdr")).toBe("hdr");
  });

  /**
   * Video is the DEFAULT for an unknown name, and it must be: it is the node's historical
   * behaviour and the element's own error event already reports a wrong guess. The
   * alternative — try video, silently retry as an image — would swallow the real failure.
   */
  it("falls back to the video door for a name that says nothing", () => {
    expect(pictureFileKind("")).toBe("video");
    expect(pictureFileKind("https://example.com/stream")).toBe("video");
    expect(pictureFileKind("archive.")).toBe("video");
  });
});

describe("reading the name off a picked file (T1223)", () => {
  /**
   * ⚑ THE LOAD-BEARING ONE. A `blob:` URL is opaque — the extension exists ONLY in the
   * fragment the picker appends (T434). If this regressed, every picked still would
   * classify as a video and open a `<video>` on a PNG, which is the bug being fixed.
   */
  it("reads the extension out of an object URL's fragment", () => {
    const url = `blob:http://localhost:5173/9b1d${"#"}${encodeURIComponent("holiday photo.png")}`;
    expect(pictureFileName(url)).toBe("holiday photo.png");
    expect(pictureFileExtension(url)).toBe("png");
    expect(pictureFileKind(url)).toBe("still");
  });

  it("falls back to the path when there is no fragment", () => {
    expect(pictureFileName("/media/clips/take 3.mp4")).toBe("take 3.mp4");
    expect(pictureFileExtension("https://example.com/a/b.PNG?v=2")).toBe("png");
  });

  it("reads the url out of whatever shape the parameter holds", () => {
    expect(pictureFileUrl("a.png")).toBe("a.png");
    expect(pictureFileUrl({ url: "b.png" })).toBe("b.png");
    expect(pictureFileUrl(undefined)).toBe("");
    expect(pictureFileUrl(7)).toBe("");
  });

  it("treats an unset file as neither still nor a reason to dim anything", () => {
    expect(isStillPictureFile("")).toBe(false);
    expect(isStillPictureFile(undefined)).toBe(false);
    expect(isStillPictureFile("photo.png")).toBe(true);
    expect(isStillPictureFile("clip.mp4")).toBe(false);
    // An EXR is not a still THIS NODE can show, so it must not dim the transport as
    // though it were working — it is refused, and the refusal is the message.
    expect(isStillPictureFile("env.exr")).toBe(false);
  });
});

describe("the refusal names the format and the fix (T1223, §V403)", () => {
  it("names the file, the format and what is missing", () => {
    const message = hdrPictureRefusal("blob:x#ladybrand_heritage_house_4k.exr");
    expect(message).not.toBeNull();
    expect(message).toContain("ladybrand_heritage_house_4k.exr");
    expect(message).toContain("OpenEXR");
    expect(message).toContain("8-bit");
    // §V403: an absence we report must name what would make it go away.
    expect(message).toContain("PNG");
  });

  it("names Radiance by its own name, not by its extension", () => {
    expect(hdrPictureRefusal("sky.hdr")).toContain("Radiance HDR");
  });

  it("says nothing about a file it is not about", () => {
    expect(hdrPictureRefusal("photo.png")).toBeNull();
    expect(hdrPictureRefusal("clip.mp4")).toBeNull();
  });
});
