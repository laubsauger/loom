// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { ProjectSettingsDialog } from "./project-settings.tsx";

/**
 * T390 — the settings page is MADE OF the control kit, not styled to resemble it.
 *
 * ## What was wrong, and what this can and cannot see
 *
 * The owner's complaint was visual: every field a different width for no reason, labels
 * and fields on no shared grid, `px`/`fps` floating at arbitrary distances from their
 * inputs, width and height — one value — presented as two unrelated rows, and section
 * headings the same weight as the labels beneath them.
 *
 * **§V339: jsdom paints nothing, and none of that is asserted here.** No test in this
 * repository establishes that the rows align, that the fields are a sensible width, or
 * that the headings out-rank the labels. Those are geometry and the owner's eye is the
 * only verification they have had.
 *
 * What IS assertable, and is the thing that actually keeps the page from drifting again,
 * is the CAUSE rather than the symptom: this page owned a private number field, a bare
 * `<select>` and its own input CSS — a second set of controls over the same kind of data,
 * which is exactly what T356 deleted a duplicate surface to prevent. So this asserts that
 * the fork is gone and cannot quietly come back: no input styling in the page's own
 * stylesheet, and the rendered controls are the kit's own components, identifiable by the
 * markup only the kit produces.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  fps: 60,
  limits: {
    maxResolution: 8192,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the page does not fork the control kit (T390, T356)", () => {
  it("declares no input, select or field styling of its own", () => {
    const css = read("./project-settings.module.css");
    // The four class names the fork was built on. A page that needs to style an input is
    // a page that has stopped using the shared one.
    for (const forked of [".input", ".select", ".field", ".unit"]) {
      expect(css.includes(`\n${forked}`), `${forked} is back in project-settings.module.css`).toBe(
        false,
      );
    }
    // Guards the guard: the file still exists and still styles the page's own grouping.
    expect(css).toContain(".group");
    expect(css).toContain(".groupTitle");
  });

  it("takes its number, enum and boolean controls from `ui/controls`", () => {
    const source = read("./project-settings.tsx");
    for (const control of ["NumberField", "EnumField", "BooleanField", "ControlRow"]) {
      expect(source, control).toMatch(
        new RegExp(`import\\s*\\{[^}]*\\b${control}\\b[^}]*\\}\\s*from\\s*"@ui/controls/`),
      );
    }
    // And defines none of them itself, which is how the fork got there the first time.
    expect(source).not.toMatch(/function NumberField\b/);
  });
});

describe("the rendered fields are the kit's controls (T390)", () => {
  function mount() {
    return render(
      <ProjectSettingsDialog
        settings={SETTINGS}
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />,
    );
  }

  /**
   * `role="spinbutton"` with `aria-valuenow` is markup only `ui/controls`'s `NumberField`
   * produces — the fork rendered `<input type="number">`. So this is evidence about WHICH
   * component is on screen, not merely that a number can be typed.
   */
  it("renders every numeric setting as the shared draggable NumberField", () => {
    mount();
    for (const [label, value] of [
      ["width", 1280],
      ["height", 720],
      ["target fps", 60],
      ["preview fps", 20],
      ["seed", 1],
    ] as const) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("role"), label).toBe("spinbutton");
      expect(field.getAttribute("aria-valuenow"), label).toBe(String(value));
    }
  });

  /**
   * The unit is INSIDE the field rather than a sibling of it in the row — which is the
   * structural half of "the units float": a `px` that is a child of the control cannot
   * drift away from it however the row is laid out.
   */
  it("attaches px to the dimension field rather than parking it in the row", () => {
    mount();
    const width = screen.getByLabelText("width");
    const host = width.parentElement;
    expect(host).not.toBeNull();
    expect(host?.textContent).toContain("px");
  });

  it("keeps the type-label switch on the same shared primitive", () => {
    mount();
    const toggle = screen.getByLabelText("Show each node's type beside its name");
    expect(toggle.getAttribute("role")).toBe("switch");
  });
});
