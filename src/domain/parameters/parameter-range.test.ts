import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { NumberParameter, ParameterDefinition, VectorParameter } from "../types/parameters.ts";
import { numericRangeOf } from "./expression-range.ts";
import { resolveParameterSchema } from "./resolve.ts";
import { validateParameterValue } from "./validate.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T537 / §B111 — A UI RANGE IS NOT A VALUE CLAMP, gated as a PROPERTY.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: "we need to make sure that rotations can continue on. right now they just
 * get clamped. not sure how td does it where we can just multiply something with abstime
 * and use that for rotation and it keeps going."
 *
 * `transform.r` declares `min: -360, max: 360` because one turn either way is a sensible
 * span to DRAG THROUGH, and `clampToDeclared` read those same two numbers as a hard limit
 * on every resolved value. So `abstime * 7` climbed for fifty-one seconds and then sat at
 * 360 forever. Two unrelated ideas were one pair of numbers.
 *
 * ## Why this file is a census and not four fixes
 *
 * §V437, for the seventh time: a requirement delivered SITE BY SITE is not delivered.
 * Un-clamping `transform.r` alone would have left `mirror.rotate`, `hsv.hueoffset`,
 * `slope.angle`, `ramp.phase` and `lfo.phase` pinned, and would have said nothing about
 * the rotation on node #N+1. So the shape here is §V453's, the one this project has now
 * paid for repeatedly: the enumeration is DERIVED FROM THE REGISTRY, and a numeric
 * parameter that declares bounds without declaring what they MEAN fails below until its
 * author decides.
 *
 * ## The four ways it fails (§V464)
 *
 *  (a) UNDECLARED — parameter N+1 arrives with a `min`/`max` and no `range`. This is the
 *      forcing function; everything else is a guard on it.
 *  (b) STALE — a `range` on a parameter with no `min`/`max` at all. §V421 rot: the
 *      declaration describes numbers that are no longer there, and reads as considered.
 *  (c) UNNAMED CYCLIC — the cyclic set is pinned BY NAME (§V458's census shape). A
 *      rotation cannot join it by nobody noticing, and — the direction that actually
 *      matters — an existing rotation cannot quietly be flipped back to `bounded`, which
 *      is B111 returning. A count would not catch a swap; the names do.
 *  (d) UNJUSTIFIED DEGREES — every parameter in degrees is `cyclic` unless it is in the
 *      stated exception list. `camera.fov` is the exception and the reason the whole
 *      thing must be DECLARED rather than inferred: an FOV of 725° is not a wide shot,
 *      it is a singular projection matrix. Writing the exception down is what stops the
 *      next author "simplifying" this into `unit === "degrees"`.
 */

type NumericParameter = NumberParameter | VectorParameter;

interface Entry {
  readonly id: string;
  readonly parameter: NumericParameter;
}

function numericParameters(): readonly Entry[] {
  const entries: Entry[] = [];
  for (const definition of allNodeDefinitions) {
    for (const [key, parameter] of Object.entries(definition.parameters ?? {})) {
      if (parameter.type !== "number" && parameter.type !== "vector") continue;
      entries.push({ id: `${definition.type}.${key}`, parameter });
    }
  }
  return entries;
}

const hasBounds = (parameter: NumericParameter): boolean =>
  parameter.min !== undefined || parameter.max !== undefined;

/**
 * THE CYCLIC SET, by name (§V458).
 *
 * A periodic quantity: a rotation, an angle, a hue, a unit phase. There is no maximum to
 * pin to, so none of these clamps, and none of them may report `parameter.expression.
 * clamped` — the diagnostic would be describing something that did not happen.
 *
 * `noise.r` is on this list and used to declare NO range at all, which is the shape of
 * the original defect seen from the other side: two Rotate parameters, two behaviours,
 * because neither was a decision. It now declares the same span as `transform.r` and the
 * same meaning, so it gains a slider and loses nothing.
 */
const CYCLIC = [
  // T706: a camera bank wraps — rolling past 180 is the same horizon from the other side.
  "camera.roll",
  // T704: same bank, same wrap, on the projector's throw axis.
  "projector.roll",
  "hsv.hueoffset",
  "lfo.phase",
  "mirror.rotate",
  "noise.r",
  "ramp.phase",
  "renderInstances.rotate",
  "slope.angle",
  "transform.r",
] as const;

/**
 * Degrees that are NOT cyclic, each with the reason it is not — the counter-examples that
 * prove the classification cannot be inferred from `unit`.
 */
const BOUNDED_DEGREES: Readonly<Record<string, string>> = {
  "camera.fov": "the projection matrix is singular at 0° and at 180°",
  "renderInstances.fov": "the projection matrix is singular at 0° and at 180°",
  "renderSurface.fov": "the projection matrix is singular at 0° and at 180°",
  "projector.keystoneH":
    "a keystone is a CORRECTION range, not an angle that wraps — ±30° covers real installs and tan() blows up toward 90°",
  "projector.keystoneV":
    "same as keystoneH: a correction range with a tan() in it, never a wrap",
};

describe("§B111 — every numeric parameter declares whether its bounds are a limit", () => {
  it("(a) a parameter with min/max declares a range kind, or fails here", () => {
    const undeclared = numericParameters()
      .filter((entry) => hasBounds(entry.parameter) && entry.parameter.range === undefined)
      .map((entry) => entry.id);
    expect(
      undeclared,
      `${undeclared.length} numeric parameter(s) declare min/max without saying whether those ` +
        `numbers are a LIMIT or the slider's travel (§B111). Add \`range: "bounded" | "cyclic" | ` +
        `"floor" | "soft"\` — see the doc on NumericRangeKind.`,
    ).toEqual([]);
  });

  it("(b) a range kind without min/max is stale and fails here", () => {
    const stale = numericParameters()
      .filter((entry) => !hasBounds(entry.parameter) && entry.parameter.range !== undefined)
      .map((entry) => entry.id);
    expect(
      stale,
      "a `range` describes which ends of min/max clamp; with neither present it describes " +
        "nothing and reads as a considered decision (§V421).",
    ).toEqual([]);
  });

  it("(c) the cyclic set is exactly the named one, in both directions", () => {
    const actual = numericParameters()
      .filter((entry) => entry.parameter.range === "cyclic")
      .map((entry) => entry.id)
      .sort();
    expect(actual).toEqual([...CYCLIC].sort());
  });

  it("(d) every parameter in degrees is cyclic, or is a NAMED exception with a reason", () => {
    const offenders = numericParameters()
      .filter((entry) => entry.parameter.type === "number" && entry.parameter.unit === "degrees")
      .filter((entry) => entry.parameter.range !== "cyclic" && BOUNDED_DEGREES[entry.id] === undefined)
      .map((entry) => entry.id);
    expect(
      offenders,
      "a degrees parameter is cyclic unless there is a reason it is not. Add the reason to " +
        "BOUNDED_DEGREES rather than deleting this test — the reason is the point (§V458).",
    ).toEqual([]);

    // The exceptions must still EXIST, or the list rots into a permanent excuse (§V421).
    for (const id of Object.keys(BOUNDED_DEGREES)) {
      expect(
        numericParameters().some((entry) => entry.id === id),
        `BOUNDED_DEGREES names ${id}, which the registry no longer has.`,
      ).toBe(true);
    }
  });

  it("the census is not empty and reaches real parameters — the gate can actually bite", () => {
    const entries = numericParameters();
    // Vacuity guard: a `numericParameters()` that silently returned [] would pass every
    // assertion above (§V461). These numbers are the shape of the catalogue, not a target.
    expect(entries.length).toBeGreaterThan(150);
    expect(entries.filter((entry) => hasBounds(entry.parameter)).length).toBeGreaterThan(120);
    expect(entries.some((entry) => entry.id === "transform.r")).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------
 * The BEHAVIOUR half. The census above says every parameter has an answer; this says the
 * answers do something.
 */

const CYCLIC_ROTATE: ParameterDefinition = {
  type: "number",
  label: "Rotate",
  default: 0,
  min: -360,
  max: 360,
  unit: "degrees",
  range: "cyclic",
};

/**
 * The SAME parameter with the ONLY difference being the declaration — which is what makes
 * the pair a fixture that can tell the fix from the bug (§V461). Before T537 both of these
 * resolved to 360 at the frame below, so a test written against the cyclic one alone would
 * have to have failed; and this one still resolving to 360 is the old behaviour, preserved
 * on purpose for everything that genuinely is bounded.
 */
const BOUNDED_ROTATE: ParameterDefinition = { ...CYCLIC_ROTATE, range: "bounded" };

/**
 * FRAME 6000 = t=100s, chosen so the clamp DEMONSTRABLY bit before the fix.
 *
 * §V461: `abstime * 7` does not reach 360 until t≈51.4s, so a fixture that ran for ten
 * frames — or for ten seconds — would have produced 1.17 and passed identically against
 * the bug. The assertion below is an EXACT value far past the limit (§V218), at a frame
 * where the old code produced exactly 360.
 */
const AT_100_SECONDS = { timeSeconds: 100, deltaSeconds: 1 / 60, frameIndex: 6000, mode: "offline" as const, randomSeed: 0 };

function resolveRoll(definition: ParameterDefinition): { value: unknown; clamped: boolean } {
  const resolved = resolveParameterSchema(
    {
      id: "roll1",
      type: "transform",
      parameters: { r: { mode: "expression", bindings: { expression: { kind: "expression", source: "abstime * 7" } } } },
    } as never,
    { r: definition },
    { frame: AT_100_SECONDS as never },
  );
  return {
    value: resolved.values.r,
    clamped: resolved.diagnostics.some((diagnostic) => diagnostic.code === "parameter.expression.clamped"),
  };
}

describe("§B111 — a cyclic parameter driven by a ramping expression keeps going", () => {
  it("resolves abstime * 7 to exactly 700 at frame 6000, a full turn past the declared max", () => {
    const { value, clamped } = resolveRoll(CYCLIC_ROTATE);
    // 100s * 7 = 700. Not "> 360": an inequality would pass on a wrap to 340 as happily
    // as on the value the user asked for, and a wrap is precisely what T537 did NOT do.
    expect(value).toBe(700);
    // And it must be SILENT. A cyclic parameter reporting "clamped to 360" would be
    // telling the user something untrue about their own graph.
    expect(clamped).toBe(false);
  });

  it("the same expression on a BOUNDED parameter still pins at 360 and still reports", () => {
    const { value, clamped } = resolveRoll(BOUNDED_ROTATE);
    expect(value).toBe(360);
    expect(clamped).toBe(true);
  });

  it("a stored value past the slider range is a VALID document on a cyclic parameter", () => {
    // The third clamp site. A resolver that produces 700 and a validator that rejects 700
    // would make the fix unsaveable.
    expect(validateParameterValue("r", CYCLIC_ROTATE, 725)).toBeNull();
    expect(validateParameterValue("r", BOUNDED_ROTATE, 725)?.code).toBe("parameter.range");
  });

  it("floor pins the minimum and frees the maximum — the blur-radius case", () => {
    const blur: ParameterDefinition = { type: "number", label: "Filter Size", default: 8, min: 0, max: 128, range: "floor", unit: "px" };
    expect(numericRangeOf(blur)).toEqual({ min: 0, max: null });
    expect(validateParameterValue("size", blur, 500)).toBeNull();
    expect(validateParameterValue("size", blur, -1)?.code).toBe("parameter.range");
  });

  it("soft pins neither end, and bounded pins both", () => {
    const translate: ParameterDefinition = { type: "vector", size: 2, label: "Translate", default: [0, 0], min: -4, max: 4, range: "soft" };
    expect(numericRangeOf(translate)).toBeNull();
    const opacity: ParameterDefinition = { type: "number", label: "Opacity", default: 1, min: 0, max: 1, range: "bounded" };
    expect(numericRangeOf(opacity)).toEqual({ min: 0, max: 1 });
  });
});
