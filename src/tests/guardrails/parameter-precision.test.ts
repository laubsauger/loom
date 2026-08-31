import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { buildStarterComponents } from "../../examples/starter-components.ts";
import { lfoNode } from "@nodes/definitions/values.ts";
import { decimalsFor, formatNumber, normalizeValue } from "@ui/controls/drag-math.ts";
import type { NumericSpec } from "@ui/controls/types.ts";

/**
 * B80 — A PARAMETER THAT DECLARES ONLY A RANGE MUST NOT BECOME AN INTEGER CONTROL.
 *
 * ## The bug
 *
 * `lfo.frequency` was declared `{ min: 0, max: 100, unit: "hz" }` with no `step` and no
 * `precision`. `stepFor` derives a step of 1/100 of the declared range when the author
 * gives none — a good default for a drag, and for THIS range it is exactly `1`. That one
 * number is then reused for three different jobs: the drag granularity, the DISPLAY
 * decimals (`decimalsFor` -> `0`), and the QUANTISATION grid (`quantize`). So E7's 0.25 Hz
 * oscillator showed `0` in the inspector, and — the half that destroys work — clicking the
 * field and clicking away committed that `0` back into the document through `commitText`,
 * flattening the sine to a straight line. Measured in the running app, not inferred.
 *
 * ## Why this gate and not a fixed manifest
 *
 * Fixing `lfo.frequency` alone fixes one node. The reusable mistake is writing a plausible
 * range and letting a derived step decide, silently, that the parameter is discrete — and
 * nothing anywhere says which parameters are continuous. So the rule is stated instead:
 *
 *   an integer parameter SAYS SO (`step: 1` or `precision: 0`);
 *   a parameter that says nothing is continuous, and must be able to show a fraction.
 *
 * Measured when this was written: 35 of 195 numeric parameters in the catalogue display
 * zero decimals, and 34 of them DECLARE it (`count`, `cols`, `rows`, `seed`, `substeps`,
 * `frames`, `harmonics` — all genuinely discrete). Exactly one reached it by derivation,
 * and that one was the bug. The SPEC's "every fractional parameter in the app is affected"
 * is therefore an overstatement, corrected here by counting.
 *
 * ## What it does not prove
 *
 * Nothing here renders anything (§V339). It is a statement about manifests and the control
 * kit's maths, not evidence that any field is legible on screen. It also cannot catch the
 * opposite error — a parameter that declares `step: 1` and is really continuous — because
 * a declaration is exactly what this file agrees to trust.
 */

const declares = (spec: NumericSpec): boolean =>
  spec.step !== undefined || spec.precision !== undefined;

describe("B80 — a continuous parameter can show a fraction", () => {
  it("gives the LFO's frequency back its decimals, in both directions", () => {
    const frequency = lfoNode.parameters?.["frequency"];
    expect(frequency?.type).toBe("number");
    const spec = frequency as NumericSpec;

    // The symptom, verbatim: E7 stores 0.25 Hz and the inspector printed "0".
    expect(formatNumber(0.25, spec)).toBe("0.25");
    // The half that destroyed the document: the field's own commit path quantised it away.
    expect(normalizeValue(0.25, spec)).toBe(0.25);
    // And the sub-tenth frequencies the other examples actually use (E3/E13 0.05, E8 0.1).
    expect(formatNumber(0.05, spec)).toBe("0.05");
    expect(normalizeValue(0.05, spec)).toBe(0.05);
  });

  it("refuses a DERIVED integer grid anywhere in the catalogue", () => {
    const accidents: string[] = [];
    for (const definition of allNodeDefinitions) {
      for (const [key, parameter] of Object.entries(definition.parameters ?? {})) {
        if (parameter.type !== "number") continue;
        const spec = parameter as NumericSpec;
        if (declares(spec)) continue;
        if (decimalsFor(spec) > 0) continue;
        accidents.push(
          `${definition.type}.${key} (min ${String(spec.min)}, max ${String(spec.max)}) — ` +
            `no step and no precision, so the derived step is ${String(spec.max)}/100 and the ` +
            `field shows 0 decimals: 0.25 renders as "${formatNumber(0.25, spec)}" and commits ` +
            `as ${String(normalizeValue(0.25, spec))}. Declare step: 1 if it is discrete, or a ` +
            `real step if it is not.`,
        );
      }
    }
    expect(accidents).toEqual([]);
  });
});

/**
 * T648 — THE DEFAULT MUST SURVIVE BEING LOOKED AT.
 *
 * The property: displaying a value and committing the display back preserves it —
 * `normalizeValue(Number(formatNumber(v, spec)), spec) === v` for the manifest default,
 * the one value every user starts from. B80's gate above only refused a DERIVED ZERO
 * decimals, and `(360 − (−360)) / 100 = 7.2` derives ONE — so the starter components'
 * Spin (default 0.25°) displayed "0.3" and a click-and-blur committed 0. A guard with a
 * hole shaped like every one-decimal parameter (§V461).
 *
 * Starter components are held to ZERO failures: they are the shipped surface a user
 * clicks first, and every published numeric now declares its step. The CATALOGUE holds
 * 27 known-lossy parameters — one number doing three jobs (drag rate, grid, decimals)
 * across the whole manifest is T567's design call, deliberately not folded in here — so
 * they are a RATCHET, §V541-style: each listed entry must STILL be lossy (fix one and
 * this gate makes you take it off the list), and nothing unlisted may join them.
 */
const roundTrips = (value: number, spec: NumericSpec): boolean =>
  normalizeValue(Number(formatNumber(value, spec)), spec) === value;

/** T567's written inventory. Every entry is a default that display+commit damages. */
const KNOWN_LOSSY_DEFAULTS: ReadonlySet<string> = new Set([
  "noise.spread", "noise.exp", "noise.amp", "ramp.period", "circle.softness",
  "rectangle.softness", "level.blacklevel", "level.gamma1", "level.contrast",
  "level.brightness", "limit.high", "limit.steps", "lookup.scale", "blur.size",
  "slope.angle", "cache.frames", "cache.scale", "renderPoints.sizePixels",
  "text.size", "text.linespacing", "valueFilter.cutoff", "audioPattern.bpm",
  "camera.fov", "render.aoRadius", "materialPhong.shininess",
  "renderInstances.fov", "renderSurface.fov",
]);

describe("T648 — display-then-commit preserves the default", () => {
  it("the reported instance, pinned: Spin's 0.25 degrees survives the field", async () => {
    const components = await buildStarterComponents();
    const echo = components.find((entry) => entry.definition.componentId === "feedbackEcho");
    const spin = echo?.definition.parameters.find((entry) => entry.key === "spin");
    expect(spin).toBeDefined();
    const spec = spin?.definition as NumericSpec;
    // The symptom, verbatim: 0.25 displayed "0.3" and committed 0 — a click destroyed it.
    expect(formatNumber(0.25, spec)).toBe("0.25");
    expect(normalizeValue(Number(formatNumber(0.25, spec)), spec)).toBe(0.25);
  });

  it("every starter component's published default survives — zero tolerance", async () => {
    const lossy: string[] = [];
    for (const component of await buildStarterComponents()) {
      for (const published of component.definition.parameters) {
        const definition = published.definition as { type?: string };
        if (definition.type !== "number") continue;
        const spec = published.definition as NumericSpec;
        const fallback = (published.definition as { default?: unknown }).default;
        if (typeof fallback !== "number") continue;
        if (!roundTrips(fallback, spec)) {
          lossy.push(
            `${component.definition.componentId}.${published.key}: default ${String(fallback)} ` +
              `displays "${formatNumber(fallback, spec)}" and commits ` +
              `${String(normalizeValue(Number(formatNumber(fallback, spec)), spec))}`,
          );
        }
      }
    }
    expect(lossy, lossy.join("\n")).toEqual([]);
  });

  it("the catalogue ratchet: the 27 known-lossy stay listed, and nobody joins them", () => {
    const lossyNow = new Set<string>();
    for (const definition of allNodeDefinitions) {
      for (const [key, parameter] of Object.entries(definition.parameters ?? {})) {
        if (parameter.type !== "number") continue;
        const spec = parameter as NumericSpec;
        const fallback = (parameter as { default?: unknown }).default;
        if (typeof fallback !== "number") continue;
        if (!roundTrips(fallback, spec)) lossyNow.add(`${definition.type}.${key}`);
      }
    }
    const newcomers = [...lossyNow].filter((name) => !KNOWN_LOSSY_DEFAULTS.has(name)).sort();
    expect(
      newcomers,
      `New parameters whose default does not survive display+commit — declare a step that ` +
        `holds the default (T648): ${newcomers.join(", ")}`,
    ).toEqual([]);
    const healed = [...KNOWN_LOSSY_DEFAULTS].filter((name) => !lossyNow.has(name)).sort();
    expect(
      healed,
      `These are no longer lossy — take them off KNOWN_LOSSY_DEFAULTS so the ratchet holds (§V541): ${healed.join(", ")}`,
    ).toEqual([]);
  });
});
