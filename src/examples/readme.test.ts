import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listExamples } from "./catalogue.ts";

/**
 * T349: the README's index is CHECKED, the way `sync.test.ts` checks the files.
 *
 * An index nobody generates goes stale — E7 shipped without a row and nothing said so
 * until a person noticed. This does not prescribe prose; it demands exactly that every
 * shipped example has a row linking its concept doc, and that no row points at an
 * example that no longer ships.
 */
describe("examples/README.md index (T349)", () => {
  const readme = readFileSync(join(process.cwd(), "examples", "README.md"), "utf8");
  const shipped = listExamples().map((file) => file.fileName.replace(/\.loom\.json$/, ""));

  it("lists every shipped example, linking its concept doc", () => {
    const missing = shipped.filter((slug) => !readme.includes(`](./${slug}.md)`));
    expect(missing, "add a table row for each").toEqual([]);
  });

  it("links no example that does not ship", () => {
    const linked = [...readme.matchAll(/\]\(\.\/(E\d+[^)]*)\.md\)/g)].map((match) => match[1]);
    const ghosts = linked.filter((slug) => !shipped.includes(slug as string));
    expect(ghosts, "remove rows for examples that no longer exist").toEqual([]);
  });
});
