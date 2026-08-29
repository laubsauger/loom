import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A pane taller than its dock SCROLLS; it does not grow past it and get clipped.
 *
 * The bug this guards: the inspector ran past the bottom of the right dock and everything
 * below the fold was unreachable, which makes a node with many parameters uneditable.
 * The cause is one line of CSS in a chain of six — a flex child's `min-height` defaults to
 * `auto`, which refuses to shrink below the child's content, so the box grows and the
 * overflow is clipped by whatever is beneath it instead of producing a scrollbar.
 *
 * ## Why this is a CSS-source test and not a rendered one
 *
 * jsdom applies no stylesheets and computes no layout, so `getComputedStyle` and
 * `scrollHeight` are both zero there and a rendered assertion would pass against a
 * completely broken pane. The honest thing to check in this environment is the CONTRACT:
 * every box between the resizable panel and the pane's content declares `min-height: 0`,
 * and the pane's content region is the one that scrolls. That is exactly the invariant a
 * new pane type will break, and it holds for a floated pane too — the chain is the same,
 * only the height it is bounded by changes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function rulesOf(file: string, selector: string): string {
  const css = readFileSync(join(HERE, file), "utf8");
  const match = new RegExp(`(^|\\})[^{}]*\\${selector}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (match === null) throw new Error(`no \`${selector}\` rule in ${file}`);
  return match[2] ?? "";
}

function declares(file: string, selector: string, property: string, value: string): boolean {
  return new RegExp(`${property}\\s*:\\s*${value}\\s*;`).test(rulesOf(file, selector));
}

/** Every box between the resizable panel and the pane's content, in order. */
const CHAIN: ReadonlyArray<{ file: string; selector: string; what: string }> = [
  { file: "dock-zone.module.css", selector: ".zone", what: "the dock zone" },
  { file: "dock-zone.module.css", selector: ".panels", what: "the zone's panel stack" },
  { file: "dock-zone.module.css", selector: ".panel", what: "one pane's panel" },
  { file: "pane-portal.module.css", selector: ".outlet", what: "the outlet a pane is shown in" },
  { file: "pane-portal.module.css", selector: ".host", what: "the pane's permanent container" },
  { file: "panes.module.css", selector: ".scrollFill", what: "the pane's content region" },
];

describe("a pane is bounded by its dock, and scrolls rather than clipping", () => {
  it.each(CHAIN.map((link) => [link.selector, link] as const))(
    "%s can shrink below its content",
    (_selector, link) => {
      // `min-height: 0` is the whole fix. Without it on ANY link, the chain grows.
      expect(
        declares(link.file, link.selector, "min-height", "0") ||
          declares(link.file, link.selector, "overflow", "hidden"),
        `${link.what} (${link.selector}) neither shrinks nor clips, so the pane grows past its dock`,
      ).toBe(true);
    },
  );

  it("puts the scroll on the pane's content region, not on the zone", () => {
    // The zone must NOT scroll: a scroller further out carries the inspector's sticky
    // section headers away with the rows they label.
    expect(declares("panes.module.css", ".scrollFill", "overflow", "auto")).toBe(true);
    expect(declares("dock-zone.module.css", ".zone", "overflow", "auto")).toBe(false);
    expect(declares("dock-zone.module.css", ".panels", "overflow", "auto")).toBe(false);
  });

  it("uses the scrolling region for the inspector, which is the pane that overflows", () => {
    const source = readFileSync(join(HERE, "side-panes.tsx"), "utf8");
    const inspector = source.slice(source.indexOf("export function InspectorPane"));
    expect(inspector).toContain("styles.scrollFill");
    expect(inspector, "the inspector went back to a non-scrolling wrapper").not.toContain(
      "styles.fill",
    );
  });

  it("bounds a floated pane the same way, by the child window instead of the dock", () => {
    expect(declares("pane-window.module.css", ".root", "min-height", "0")).toBe(true);
    expect(declares("pane-window.module.css", ".body", "height", "100vh")).toBe(true);
  });
});
