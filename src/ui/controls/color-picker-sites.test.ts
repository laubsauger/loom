import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * T896 gate (c) — ONE picker, mounted at every colour site.
 *
 * The behavioural tests in `color-picker.test.tsx` would all still pass if someone
 * COPIED the picker into a second file, and that copy is exactly the drift §T886 names:
 * *"reuse the same base component instead of duplicating it and then having stuff become
 * inconsistent"*. Only a source-level guard can catch it, so this reads the tree: one
 * file in `src` may declare `<input type="color">`, and every colour-editing control
 * must import that file rather than growing its own.
 *
 * This lives in a `.test.ts` (the headless project) because the browser project runs
 * under jsdom, where `import.meta.url` is not a file URL and `node:fs` cannot walk.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every control through which a user edits a colour value, as surveyed for T896. */
const COLOUR_SITES = [
  // The inspector's colour rows AND T880's reflected `vec4f` knobs: a reflected
  // `lightColor: vec4f` becomes `{ type: "color", space: "display" }` (custom-wgsl.ts),
  // so it reaches this same control rather than being a fourth surface.
  "controls/color-field.tsx",
  // The ramp stop / gradient editor.
  "controls/stops-field.tsx",
] as const;

describe("§T886 — one colour picker, reused at every colour site", () => {
  const files = walk(SRC);

  it("scans a non-trivial number of files", () => {
    // Guards the guard: a broken walker must not silently pass.
    expect(files.length).toBeGreaterThan(20);
  });

  it("only `color-picker.tsx` declares a colour input", () => {
    const declaring = files
      .filter((file) => /type="color"/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length));
    expect(declaring).toEqual(["controls/color-picker.tsx"]);
  });

  it.each(COLOUR_SITES)("%s mounts the shared ColorPicker", (site) => {
    const source = readFileSync(join(SRC, site), "utf8");
    expect(source).toContain('from "./color-picker.tsx"');
    expect(source).toContain("<ColorPicker");
  });

  it("every control that renders a colour swatch is a listed site", () => {
    // If a new surface starts painting a colour swatch, it is a colour-editing surface
    // and this list has to grow with it — otherwise the next picker gets forked instead.
    const swatches = files
      .filter((file) => /styles\.swatchFill/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length));
    expect(swatches.sort()).toEqual([...COLOUR_SITES].sort());
  });
});
