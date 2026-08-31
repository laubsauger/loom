import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { buildStarterComponents } from "../../examples/starter-components.ts";
import { lfoNode } from "@nodes/definitions/values.ts";
import { decimalsFor, formatNumber, normalizeValue, quantize, resetValue, stepFor } from "@ui/controls/drag-math.ts";
import { STARTER_COMPONENT_SPECS } from "../../examples/starter-components.ts";
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

/**
 * T652 — THE OTHER TWO PATHS A DEFAULT TRAVELS, and the shape T648's walk cannot see.
 *
 * T648 landed the MANIFEST property: `normalizeValue(Number(formatNumber(default)))`
 * must equal the default, held at zero tolerance for the starter components and frozen
 * as a 27-entry ratchet for the catalogue (§V597). That gate is above and stays exactly
 * as it is. Two things sit outside it, and both are live data loss rather than manifest
 * hygiene:
 *
 * **1. RESET TO DEFAULT.** `onDoubleClick` ran the author's default through
 * `normalizeValue` before emitting it, so "reset" restored a grid point rather than the
 * number the author wrote: a Transform's Scale of 1 reset to 0.96, a Blur's 8px to 7.68,
 * a camera's 55° FOV to 54.4. Nothing gated this path at all. `resetValue` is the fix and
 * this is its gate — over EVERY numeric default, at zero tolerance, because the value
 * being restored was never a user entry and there is nothing about it to quantise.
 *
 * **2. VECTORS (§V461, one layer down).** T648's walks read `type === "number"` and stop,
 * and a `vector` parameter carries ONE spec for all of its components — so the same
 * derived grid misses each of them and none of it is visible to that gate. 19 of the 46
 * lossy defaults measured are vector components, INCLUDING inside the starter set the
 * gate above holds to zero tolerance: `FeedbackEcho.drift[1]` is -0.0008, displays
 * "-0.00" and commits 0. A guard whose walk cannot reach half the shapes it covers
 * reports zero and means nothing. The walk here reads both shapes.
 *
 * ## What this does NOT decide
 *
 * Whether a DERIVED step should be a quantisation grid at all remains T567's design call,
 * untouched: a TYPED value is still quantised, and the 27-entry ratchet above still owns
 * the inventory that decision is on the hook for. This only says the app must not damage
 * a number on a path where the user entered nothing.
 *
 * The sibling half — an unedited click-and-blur committing the re-parsed display string,
 * which is what actually destroys all 46 in the product — is a property of the FIELD
 * rather than of a manifest, and is gated in `controls.test.tsx` where the real component
 * can be clicked.
 */

interface NumericDefault {
  readonly where: string;
  readonly spec: NumericSpec;
  readonly value: number;
}

function numericDefaults(): NumericDefault[] {
  const found: NumericDefault[] = [];
  const push = (where: string, spec: NumericSpec, value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) found.push({ where, spec, value });
  };
  for (const definition of allNodeDefinitions) {
    for (const [key, parameter] of Object.entries(definition.parameters ?? {})) {
      const spec = parameter as NumericSpec;
      const stored = (parameter as { default?: unknown }).default;
      // A VECTOR is the same field repeated, and it carries ONE spec for every component
      // — which is why `transform.s` is here twice and why the same grid can miss both.
      if (parameter.type === "number") push(`${definition.type}.${key}`, spec, stored);
      else if (parameter.type === "vector" && Array.isArray(stored)) {
        stored.forEach((component, index) =>
          push(`${definition.type}.${key}[${String(index)}]`, spec, component),
        );
      }
    }
  }
  // §V94: a shipped component's published knobs are the same `NumberParameter` shape and
  // are edited through the same field, so a gate that stopped at the node catalogue would
  // leave the set every new user meets first ungated.
  for (const component of STARTER_COMPONENT_SPECS) {
    for (const published of component.publish) {
      const spec = published.definition as NumericSpec;
      const stored = (published.definition as { default?: unknown }).default;
      if (published.definition.type === "number") push(`${component.name}.${published.key}`, spec, stored);
      else if (published.definition.type === "vector" && Array.isArray(stored)) {
        stored.forEach((entry, index) =>
          push(`${component.name}.${published.key}[${String(index)}]`, spec, entry),
        );
      }
    }
  }
  return found;
}

describe("T652 — reset restores the author's number, on every shape", () => {
  it("resets every parameter to the number its author wrote", () => {
    const destroyed: string[] = [];
    for (const { where, spec, value } of numericDefaults()) {
      const after = resetValue(value, spec);
      if (after !== value) {
        destroyed.push(
          `${where}: default ${String(value)} resets to ${String(after)} — ` +
            `min ${String(spec.min)}, max ${String(spec.max)}, step ${String(stepFor(spec))}. ` +
            `Double-clicking this field to "reset" changes it.`,
        );
      }
    }
    expect(destroyed).toEqual([]);
  });

  it("has enough parameters under it to mean something (§V461)", () => {
    // NON-VACUITY. The walk above reads two shapes out of two sources; a refactor that
    // renamed `parameters` or `publish` would silently gate an empty list and stay green
    // forever. 300 when this was written.
    const all = numericDefaults();
    expect(all.length).toBeGreaterThan(250);
    expect(all.some((entry) => entry.where.startsWith("transform."))).toBe(true);
    expect(all.some((entry) => entry.where.includes("["))).toBe(true);
    // And the starter components really are in it — the half a node-only walk would miss.
    expect(all.some((entry) => entry.where.startsWith("Kaleidoscope."))).toBe(true);
  });

  it("still refuses to quantise a default onto a grid nobody declared", () => {
    // The mechanism, pinned on the measured instance so the gate above cannot pass by
    // accident if `resetValue` ever grows a call to `quantize` again. `transform.s` is a
    // 2-vector on -8..8 with no step: the derived grid is 0.16 anchored at -8, which
    // lands on 0.96 and 1.12 and never on 1.
    const scale: NumericSpec = { min: -8, max: 8, range: "soft" };
    expect(quantize(1, scale)).not.toBe(1);
    expect(resetValue(1, scale)).toBe(1);
    // Clamping is still real: a default outside its own range is a manifest bug, and the
    // field must not offer a value the parameter cannot hold.
    expect(resetValue(99, { min: 0, max: 1 })).toBe(1);
  });
});
