import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * §V11 belt-and-braces (T15). The eslint rule (T8) already blocks react/react-dom/
 * @xyflow/react imports under `src/nodes/definitions/**`; this proves the same thing at
 * run time so a lint-config regression can't silently reintroduce one. Scans every
 * non-test `.ts` file in this directory and in `src/nodes/shaders/`, so it keeps covering
 * track K's additions (T70, T40) without needing an update.
 */

function collectSourceFiles(dirUrl: URL): string[] {
  const dir = fileURLToPath(dirUrl);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => `${dir}/${entry.name}`);
}

describe("src/nodes/definitions and src/nodes/shaders are headless (§V11)", () => {
  it("import nothing from react, react-dom, or @xyflow/react", () => {
    const files = [
      ...collectSourceFiles(new URL(".", import.meta.url)),
      ...collectSourceFiles(new URL("../shaders/", import.meta.url)),
    ];
    // Guards against the scan itself silently finding nothing (e.g. a moved directory).
    expect(files.length).toBeGreaterThanOrEqual(9);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'](react|react-dom|@xyflow\/react)/);
    }
  });
});
