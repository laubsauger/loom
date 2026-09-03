import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatFps, formatMs } from "./format-metrics.ts";

/**
 * THE HEADER'S NUMBERS LIVE IN BOXES THAT DO NOT RESIZE (T1010/B).
 *
 * The owner, the day per-pass GPU timings started working: *"the header bar, the top bar,
 * the timeline is now jumping around like crazy because of the GPU time changing — all of
 * these numbers there for time, fps, GPU and whatnot, they need to be in a stable box that
 * doesn't shift layout whatsoever, otherwise we get nasty problems."*
 *
 * Two separate things were wrong and only one of them was already handled:
 *
 *  - DIGIT WIDTH. `font-variant-numeric: tabular-nums` was already on every readout, so a
 *    `3` and a `7` have always had the same advance. That half was fine.
 *  - STRING LENGTH, which tabular figures cannot help with. `8.06 ms` is seven characters
 *    and `12.34 ms` is eight; `1.20s` is five and `120.00s` is seven. Reserved at `5ch`,
 *    both fields grew with their contents and shoved their neighbours sideways ten times a
 *    second. It had never shown before because these readouts had never shown a moving
 *    number: `gpuMs` was an em dash on every machine until T1011 wired
 *    `attachTimingSource`, so the layout was never exercised (§V844's shape again — a
 *    surface nothing fed cannot reveal how it behaves when something does).
 *
 * ## Why this reads the stylesheet
 *
 * jsdom does no layout, so there is no width to measure and no honest way to assert this
 * from a render. What CAN be asserted, and is the actual invariant, is that the reservation
 * is at least as wide as the WIDEST STRING ITS OWN FORMATTER CAN PRODUCE — and both halves
 * of that come from the product: the number from `format-metrics.ts`, the reservation from
 * the CSS module the component imports. Change the format to something longer and this
 * fails; shrink the reservation and this fails. Neither is restating the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function reservedCh(cssFile: string, className: string): number {
  const css = readFileSync(join(HERE, cssFile), "utf8");
  const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`No .${className} rule in ${cssFile}.`);
  const width = /min-width:\s*([\d.]+)ch/.exec(rule[1] ?? "");
  if (width === null) {
    throw new Error(`.${className} in ${cssFile} reserves no ch width — a number in it will shift its neighbours.`);
  }
  return Number.parseFloat(width[1] ?? "0");
}

function tabular(cssFile: string, className: string): boolean {
  const css = readFileSync(join(HERE, cssFile), "utf8");
  const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(css);
  return /font-variant-numeric:\s*tabular-nums/.test(rule?.[1] ?? "");
}

describe("the top bar's metrics sit in fixed boxes", () => {
  it("reserves at least the widest string formatMs can render", () => {
    // A stalled frame is the widest honest reading this field can hold. It is not a
    // hypothetical: a device-lost recovery or a first compile easily costs hundreds of ms,
    // and that is precisely the moment someone is staring at this number.
    const widest = formatMs(999.99);
    expect(widest).toBe("999.99 ms");
    expect(reservedCh("top-bar.module.css", "metricValue")).toBeGreaterThanOrEqual(widest.length);
  });

  it("reserves enough for the live reading that started the jumping", () => {
    // The owner's actual case: the number that appeared the day T1011 landed.
    expect(reservedCh("top-bar.module.css", "metricValue")).toBeGreaterThanOrEqual(
      formatMs(12.34).length,
    );
    expect(formatFps(59.5).length).toBeLessThanOrEqual(
      reservedCh("top-bar.module.css", "metricValue"),
    );
  });

  it("keeps tabular figures, which is the other half and was already right", () => {
    expect(tabular("top-bar.module.css", "metricValue")).toBe(true);
  });
});

describe("the timeline readout's fields sit in fixed boxes", () => {
  it("reserves enough for an hour of timeline, which gains two characters on the way", () => {
    // `${timeSeconds.toFixed(2)}s` — the exact expression `timeline-readout.tsx` renders.
    // It is 5 characters at 1.20s and 8 at 3600.00s, so a reservation sized to the short
    // form guarantees a shove at 10 s and again at 100 s.
    const atStart = `${(1.2).toFixed(2)}s`;
    const atAnHour = `${(3600).toFixed(2)}s`;
    expect(atStart.length).toBe(5);
    expect(atAnHour.length).toBe(8);
    expect(reservedCh("timeline-readout.module.css", "value")).toBeGreaterThanOrEqual(
      atAnHour.length,
    );
  });

  it("keeps tabular figures on both the value and the editable frame field", () => {
    expect(tabular("timeline-readout.module.css", "value")).toBe(true);
    expect(tabular("timeline-readout.module.css", "input")).toBe(true);
  });
});
