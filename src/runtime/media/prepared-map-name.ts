import { linearToSrgb } from "../export/pixel-format.ts";
import type { FloatMap } from "./float-map.ts";
import { PREPARED_MAP_EXTENSION } from "./prepared-map-file.ts";
import { preparedMetadata, depthRecipeOf } from "./prepared-map.ts";
import { facadeMaskSettings } from "./facade-mask.ts";

/** Portable filename parts, with a UTF-8 byte budget rather than a character count. */
function part(value: string, budget: number): string {
  const safe = value.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[._-]+|[._-]+$/g, "");
  const encoder = new TextEncoder();
  let result = "", bytes = 0;
  for (const character of safe) {
    const length = encoder.encode(character).byteLength;
    if (bytes + length > budget) break;
    result += character; bytes += length;
  }
  if (result === "") throw new Error("Artifact filename needs a nonempty name.");
  return result;
}

const numberPart = (value: number) => Number(value.toPrecision(4)).toString().replace(/\./g, "p");

/** Settings identify variants; a fingerprint of the complete file distinguishes corrections. */
export function preparedMapFilename(map: FloatMap, name: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Artifact filename requires a SHA-256 fingerprint.");
  const base = part(name.replace(/^(.+)\.[^./]+$/, "$1"), 64);
  const settings: string[] = [];
  if (Object.hasOwn(map.metadata ?? {}, "preparation")) {
    const metadata = preparedMetadata(map);
    settings.push(metadata.kind, part(metadata.model.id, 52), `in${metadata.inputSide}`);
    if (metadata.kind === "depth") {
      const recipe = depthRecipeOf(map);
      settings.push(recipe.backend);
      if (recipe.version === 2) settings.push(`seed${recipe.seed}`);
      if (recipe.version === 3) settings.push(`fov${numberPart(recipe.fieldOfView)}`);
      if (metadata.version === 2 && metadata.stage === "refined") {
        const refinement = recipe.refinement!;
        settings.push("refined", `${map.width}x${map.height}`, `r${refinement.radius}`,
          `s${numberPart(refinement.spatialSigma)}`, `c${numberPart(refinement.colorSigma)}`);
      } else settings.push("native");
    } else {
      const facade = facadeMaskSettings(map);
      settings.push(`${map.width}x${map.height}`);
      if (facade !== undefined) settings.push(`detail${facade.detailSide}`, `open${Math.round(linearToSrgb(facade.darkCutoff) * 100)}`,
        `feather${numberPart(facade.feather)}`, `glass-${facade.excludeBlueGlass ? "exclude" : "keep"}`);
    }
  } else settings.push("data", `${map.width}x${map.height}`);
  const prefix = part([base, ...settings].join("-"), 220);
  return `${prefix}-${sha256.slice(0, 12)}${PREPARED_MAP_EXTENSION}`;
}
