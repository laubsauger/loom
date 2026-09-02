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
 *
 * ## T890/§V808 — IN THE TABLE, not merely in the file
 *
 * The original check was `readme.includes("](./E45-Pulse.md)")`, and §T886 is what that
 * misses: a BLANK LINE had been left above the E45 row. A blank line ENDS a markdown
 * table, so the row had fallen out of the index and rendered as a loose paragraph — while
 * the link still matched the grep, so the gate stayed green over an index that no longer
 * listed it. The row still began with `|` too, which is why "starts with a pipe" is not
 * the fix either.
 *
 * §V808's shape: a grep proves a string EXISTS, not that it is in the right PLACE. So the
 * corpus is narrowed first — contiguous runs of `|` lines, and a run counts as a table
 * only if it carries a separator row (`| --- | --- |`) — and the links are looked for
 * inside THAT. An orphaned row is a run of one with no separator, and fails.
 *
 * Blind spot, stated: this proves the row is in A table, not that it is in the RIGHT
 * table or in any sensible order. A second table elsewhere in the file would satisfy it.
 */
describe("examples/README.md index (T349)", () => {
  const readme = readFileSync(join(process.cwd(), "examples", "README.md"), "utf8");
  const shipped = listExamples().map((file) => file.fileName.replace(/\.loom\.json$/, ""));

  /** Lines belonging to a contiguous `|` run that carries a separator row. */
  function tableRows(markdown: string): readonly string[] {
    const rows: string[] = [];
    let run: string[] = [];
    const flush = (): void => {
      if (run.some((line) => /^\s*\|[\s|:-]+\|\s*$/.test(line))) rows.push(...run);
      run = [];
    };
    for (const line of markdown.split("\n")) {
      if (line.trimStart().startsWith("|")) run.push(line);
      else flush();
    }
    flush();
    return rows;
  }

  const indexRows = tableRows(readme).join("\n");

  it("is reading a real table, or it is reading nothing", () => {
    // A run-detector that broke would make the next assertion vacuously strict rather
    // than vacuously loose, but say the floor out loud anyway (§V739).
    expect(tableRows(readme).length).toBeGreaterThan(shipped.length);
  });

  it("lists every shipped example, linking its concept doc FROM INSIDE THE TABLE", () => {
    const missing = shipped.filter((slug) => !indexRows.includes(`](./${slug}.md)`));
    expect(
      missing,
      "add a table row for each — and if the link is already in the file, check no blank line has split it out of the table (T886)",
    ).toEqual([]);
  });

  it("links no example that does not ship", () => {
    const linked = [...readme.matchAll(/\]\(\.\/(E\d+[^)]*)\.md\)/g)].map((match) => match[1]);
    const ghosts = linked.filter((slug) => !shipped.includes(slug as string));
    expect(ghosts, "remove rows for examples that no longer exist").toEqual([]);
  });
});
