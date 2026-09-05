import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  MEDIA_TEXTURE_KEY,
  mediaNodeDefinitions,
  mediaSourceIdFor,
  movieFileInNode,
  textNode,
  webcamNode,
} from "./media.ts";
import { compileContext, readNodePlan } from "./test-support.ts";
import { PICTURE_FILE_ACCEPT, pictureFileKind } from "../../domain/media/picture-file.ts";

/**
 * The external-texture family: Movie File In, Webcam, Text (T263, T243, §V135).
 *
 * All three have the same graph side — declare an external scratch, blit it — and differ
 * only in what the app registers behind the sourceId. These tests are about that seam,
 * because it is the half that has shipped unwired twice (§V193).
 */

function firstPass(definition: (typeof mediaNodeDefinitions)[number]) {
  const compiled = definition.compile(compileContext({ inputs: [] }));
  // The external texture is a node-private scratch the COMPILER materializes (T262), so
  // the fixture declares it exactly as the compiler would before reading the plan back.
  const read = readNodePlan(compiled.passes, { inputs: [], scratch: [MEDIA_TEXTURE_KEY] });
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const pass = read.passes[0];
  if (pass?.kind !== "effect") throw new Error(`${definition.type} emitted no effect pass.`);
  return { compiled, pass };
}

describe("external-texture nodes (T263, T243)", () => {
  it("register together with no manifest diagnostics", () => {
    for (const definition of mediaNodeDefinitions) {
      expect(validateNodeDefinition(definition), definition.type).toEqual([]);
    }
    expect(createNodeRegistry(mediaNodeDefinitions).list().map((d) => d.type)).toEqual([
      "movieFileIn",
      "text",
      "webcam",
    ]);
  });

  it("all key their source on the NODE, by the one function the app registers with", () => {
    // The registry key is the entire contract between a node and whatever produces its
    // pixels. If a node minted its own scheme, the app would register a source under one
    // name and the backend would look for another — a node that renders black while every
    // test passes, which is the exact failure §V193 exists for.
    for (const definition of [movieFileInNode, webcamNode, textNode]) {
      const { compiled, pass } = firstPass(definition);
      expect(compiled.scratch, definition.type).toEqual([
        {
          key: MEDIA_TEXTURE_KEY,
          kind: "external",
          sourceId: mediaSourceIdFor("n1"),
          // The canvas and the decoder both hand over DISPLAY-encoded pixels, and an
          // `-srgb` texture decodes them to the linear working space in hardware at sample
          // time (§V56). Any other format would need a curve in a shader, applied once per
          // node and wrong in a different way each time.
          format: "rgba8unorm-srgb",
        },
      ]);
      expect(pass.textures, definition.type).toEqual([
        { binding: "mediaTexture", resourceId: scratchResourceId("n1", MEDIA_TEXTURE_KEY) },
      ]);
    }
  });
});

describe("Text (T243)", () => {
  it("carries no uniforms at all — its parameters describe a RASTER, not a shader", () => {
    // The thing to understand about this node. Changing the string is not a §V5 uniform
    // write: it is a new frame from the source, exactly as a video advancing is, and it
    // uploads only when the content actually changed (§V136). A pass with a uniform block
    // here would imply the string reaches the GPU as a value, which it never does.
    const { pass } = firstPass(textNode);
    expect(pass.uniforms).toBeUndefined();
    expect(pass.uniformBinding).toBeUndefined();
  });

  it("defaults to a visible string", () => {
    // A freshly dropped Text node has to show that it works. Defaulting to empty would be
    // indistinguishable from a node whose font failed to load or whose source never
    // registered — the two states this node can actually be broken in.
    const parameter = textNode.parameters["text"];
    expect(parameter?.type === "string" ? parameter.default : "").toBe("Text");
    expect(parameter?.type === "string" ? parameter.multiline : false).toBe(true);
  });

  it("declares its colours in DISPLAY space, like every other picker-driven parameter", () => {
    // The canvas paints sRGB, so the app reads these in the space the user picked
    // (`entries[].value`, §V61) and hands them to the canvas unconverted. Declaring them
    // linear would make the picker and the rendered string disagree, and decoding them on
    // the way to the canvas would decode twice — B8's shape.
    for (const key of ["color", "bgcolor"]) {
      const parameter = textNode.parameters[key];
      expect(parameter?.type, key).toBe("color");
      expect(parameter?.type === "color" ? parameter.space : "", key).toBe("display");
    }
  });

  it("is a generator, and sizes itself from the project like one", () => {
    // It makes pixels from parameters and is reproducible from the document alone — no
    // permission, no device, no file. The browser's font stack is the only thing it does
    // not carry, and a missing family falls back rather than failing.
    expect(textNode.category).toBe("generator");
    expect(textNode.resolutionPolicy).toEqual({ kind: "project" });
  });
});

/**
 * ⚑ T1223 — THE DESCRIPTION IS A CLAIM, AND THIS IS THE CLAIM'S GATE.
 *
 * `movieFileIn` opened with *"Plays a video or still image file"* from T493 until T1223,
 * while `use-media-sources` built a `<video>` and nothing else. It was the fourth
 * overclaiming description found in one day, and the worst kind: it names a capability
 * that is not there, so someone who tries it gets black and assumes they held it wrong.
 *
 * So the text is not checked for wording — it is checked for TRUTH, by deriving the format
 * names out of the sentence and asking the code whether it honours each one. Add "TIFF" to
 * the description and this reddens until the classifier and the picker agree; drop a format
 * from the accept list and it reddens the other way.
 */
describe("Movie File In's description is true of the code (T1223)", () => {
  const description = movieFileInNode.description ?? "";

  it("names the still formats it can actually show, and the picker offers each one", () => {
    const named = ["PNG", "JPEG", "WebP", "AVIF", "GIF", "BMP"].filter((format) =>
      description.includes(format),
    );
    // The sentence must name SOME stills, or this test passes by describing nothing.
    expect(named.length).toBeGreaterThan(3);

    for (const format of named) {
      const extension = format === "JPEG" ? "jpg" : format.toLowerCase();
      expect(pictureFileKind(`photo.${extension}`), format).toBe("still");
      expect(PICTURE_FILE_ACCEPT, format).toContain(
        format === "JPEG" ? "image/jpeg" : `image/${format.toLowerCase()}`,
      );
    }
  });

  /**
   * The other half of honesty: what it says it CANNOT do must also be true, or the refusal
   * is the next stale claim. EXR must classify as `hdr` — refused by name — and must not
   * be quietly offered by the picker.
   */
  it("says EXR is refused, and EXR is refused", () => {
    expect(description).toContain("EXR");
    expect(description).toContain("REFUSED BY NAME");
    expect(pictureFileKind("env.exr")).toBe("hdr");
    expect(pictureFileKind("sky.hdr")).toBe("hdr");
    expect(PICTURE_FILE_ACCEPT).not.toContain("exr");
  });

  /**
   * The file slot has to be the kind whose accept string the picker reads, or every claim
   * above is true of a dialog the user cannot reach (the owner's actual symptom).
   */
  it("declares the file slot as the kind that takes either", () => {
    const file = movieFileInNode.parameters?.["file"];
    expect(file?.type).toBe("asset");
    expect((file as { kind?: string }).kind).toBe("picture");
  });
});
