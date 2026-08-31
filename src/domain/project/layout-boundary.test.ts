import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * T591 — §V18, GATED: the document never carries the shell layout.
 *
 * "Layout is per-machine chrome state, not project data, and must not travel with a
 * document" (layout-storage.ts's own header) is the invariant that makes "opening an
 * example keeps my layout" true — a `.loom.json` opened on another machine must not
 * rearrange that machine's panes. It was stated in a comment and enforced by nothing:
 * the day someone adds a layout field to the project serializer, no test reddens.
 *
 * The gate is the cheapest kind: no file in `src/domain/project` may import the shell
 * layout modules. A project feature that WANTS layout data has to argue with this test,
 * which is the conversation §V18 exists to force.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN = [/layout-storage/, /pane-tree/];

describe("T591/§V18 — src/domain/project cannot reach the shell layout", () => {
  it("no project module imports layout-storage or pane-tree*", () => {
    const files = readdirSync(HERE).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    // Non-vacuous: the walk really sees the serializers this gate protects.
    expect(files).toContain("project-file.ts");
    expect(files).toContain("serialize.ts");
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(HERE, name), "utf8");
      for (const line of source.split("\n")) {
        if (!/^\s*(import|export)\b/.test(line)) continue;
        if (FORBIDDEN.some((pattern) => pattern.test(line))) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "a project module imports shell-layout code — §V18 says layout is per-machine chrome, never document data",
    ).toEqual([]);
  });

  it("the serialized document shape carries no layout key", () => {
    // The other direction: even without the import, a hand-rolled `layout` field on the
    // saved root would smuggle chrome into the file. The serializer module's source must
    // not name one.
    const source = readFileSync(join(HERE, "project-file.ts"), "utf8");
    expect(/["']layout["']\s*:/.test(source)).toBe(false);
    expect(source.includes("paneTree")).toBe(false);
  });
});
