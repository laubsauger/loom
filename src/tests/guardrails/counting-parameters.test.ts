import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ParameterDefinition } from "@domain/types/parameters.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { declaredStep } from "@ui/controls/drag-math.ts";

/**
 * T1047 — A PARAMETER THAT COUNTS DECLARES A STEP OF 1.
 * T1054 — ...WHILE THE SELECTION IS DISCRETE, WHICH IS A PROPERTY OF THE INSTANCE.
 *
 * The owner: "index fields everywhere should be an integer by default. At least by
 * default have the sensitivity integer — we can always set it to something else to get
 * the automatic blending, that's all neat and cool. But let's at least have the
 * precision for index fields by default be 1."
 *
 * Why it matters mechanically, and why it only became true recently: T989 split the one
 * `stepFor` into `declaredStep` (the author's constraint, the ONLY step allowed to snap)
 * and `dragStepFor` (the drag ergonomic, which must never reach the document). So before
 * T989 declaring a step here would have been the same lattice that was destroying values;
 * after it, a declared 1 is exactly and only "this parameter counts".
 *
 * Without it a drag lands on 0.37 of an input. The node floors it, so the readout and the
 * picture disagree about which input is selected — the parameter says one thing and the
 * render does another, which is the class of lie this project spends most of its gates on.
 *
 * ## What T1054 changed, and why this is a STRONGER gate rather than a relaxed one
 *
 * "An index counts" is true while the selection is DISCRETE and false the moment crossfade
 * is on, because then the fraction IS the control and an integer rung makes the feature
 * unreachable by the one gesture anybody would use to reach it. The owner's own sentence
 * anticipated it — *we can always set it to something else to get the automatic blending*.
 *
 * The temptation was to drop `index` from `COUNTING_KEYS`, or to excuse the two switches.
 * Either would have retired the gate to let the feature through, and the thing T1047 was
 * written to catch — a counting parameter shipping with no step, which is how `switch` and
 * `cache` shipped in the first place — would have stopped being caught. So instead the gate
 * learned the CONDITIONAL, and now makes two assertions where it made one:
 *
 *   1. every counting parameter declares step 1 in its DISCRETE state (a fresh drop, which
 *      for the switches means crossfade off — its default, §V831);
 *   2. every counting parameter that CAN crossfade has that step FREED when it does.
 *
 * A node that quietly stopped honouring crossfade in its schema now fails (2); a node that
 * dropped its step altogether still fails (1). Neither was reachable before.
 *
 * DERIVED from the registry, never hand-listed (§V316, and §V855: a sweep over one axis is
 * not coverage of a second) — including WHICH nodes can crossfade, which is read off their
 * own schema rather than named here, so switch number three is covered by existing.
 *
 * Read through `effectiveParameterSchema` (§V814's funnel) because the whole subject is now
 * a schema that varies per instance; reading `definition.parameters` here would have been
 * looking at the one answer that cannot see the conditional.
 */

/** Keys whose value is a position in a sequence rather than a quantity of something. */
const COUNTING_KEYS = new Set(["index"]);

/** The key a node declares when its selection can become continuous (T1054). */
const CROSSFADE_KEY = "crossfade";

const schemaOf = (definition: NodeDefinition, stored: Record<string, unknown>) =>
  effectiveParameterSchema(definition, stored);

const stepOf = (spec: ParameterDefinition | undefined): number | null =>
  spec === undefined || spec.type !== "number" ? null : declaredStep(spec);

interface Counting {
  readonly type: string;
  readonly key: string;
  /** Does this node's own schema offer a crossfade toggle? Read, not listed. */
  readonly crossfades: boolean;
}

const counting: readonly Counting[] = allNodeDefinitions.flatMap((definition) => {
  const fresh = schemaOf(definition, {});
  return Object.entries(fresh)
    .filter(([key, spec]) => COUNTING_KEYS.has(key) && spec.type === "number")
    .map(([key]) => ({ type: definition.type, key, crossfades: CROSSFADE_KEY in fresh }));
});

const definitionOf = (type: string): NodeDefinition => {
  const found = allNodeDefinitions.find((definition) => definition.type === type);
  if (found === undefined) throw new Error(`no definition for "${type}"`);
  return found;
};

describe("T1047/T1054 — a parameter that counts declares a step of 1 while it counts", () => {
  it("finds the counting parameters, and BOTH kinds of them", () => {
    // Non-vacuity (§V854): a filter that matches nothing passes every assertion below, and
    // a split with an empty side leaves one of the two branches asserted about nobody.
    expect(counting.length).toBeGreaterThanOrEqual(3);
    expect(counting.filter((entry) => entry.crossfades).length).toBeGreaterThanOrEqual(2);
    expect(counting.filter((entry) => !entry.crossfades).length).toBeGreaterThanOrEqual(1);
  });

  it("every one of them declares step 1 in its DISCRETE state", () => {
    // T1047's original assertion, unchanged in strength: this is what a fresh drop gets,
    // and for a switch that means crossfade off, because off is the default (§V831).
    const offenders = counting
      .filter((entry) => stepOf(schemaOf(definitionOf(entry.type), {})[entry.key]) !== 1)
      .map((entry) => `${entry.type}.${entry.key} declares ${String(stepOf(schemaOf(definitionOf(entry.type), {})[entry.key]))}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("frees that step on the nodes that can crossfade, when they do", () => {
    // The other half of the conditional. A node that grew a crossfade toggle but kept the
    // integer rung would ship a feature nobody can drag to — the shape of failure T1054
    // exists to prevent, and the reason this gate could not simply be told to skip switches.
    const offenders = counting
      .filter((entry) => entry.crossfades)
      .filter((entry) => stepOf(schemaOf(definitionOf(entry.type), { [CROSSFADE_KEY]: true })[entry.key]) !== null)
      .map((entry) => `${entry.type}.${entry.key} still snaps with crossfade on`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("frees it for a DRIVEN or EXPRESSION crossfade too, which is when it is unknowable", () => {
    // §V107: every parameter takes every mode, so `crossfade` can be an expression, a bind
    // or a driven channel — and none of those has a value at schema time. A schema that
    // only looked at a stored `true` would leave the index snapping for exactly the users
    // who animated the toggle, which is the population most likely to want the fraction.
    const dynamic = [
      { mode: "expression", bindings: { expression: { kind: "expression", source: "time > 4" } } },
      { mode: "driven", bindings: { driven: { kind: "driven", channel: "audio:level" } } },
      { mode: "bind", bindings: { bind: { kind: "bind", ref: "parent.fade" } } },
    ];
    const offenders = counting
      .filter((entry) => entry.crossfades)
      .flatMap((entry) =>
        dynamic
          .filter((slot) => stepOf(schemaOf(definitionOf(entry.type), { [CROSSFADE_KEY]: slot })[entry.key]) !== null)
          .map((slot) => `${entry.type}.${entry.key} still snaps with a ${slot.mode} crossfade`),
      );
    expect(offenders, offenders.join("\n")).toEqual([]);

    // And the converse, so the rule above is not just "any envelope frees it": a crossfade
    // parked on a STATIC false is a promise that the selection is discrete, and it keeps
    // the rung. Without this the previous assertion would pass on a schema that freed the
    // step unconditionally, which is T1047 quietly repealed.
    const parked = { mode: "static", bindings: { static: { kind: "static", value: false } } };
    for (const entry of counting.filter((item) => item.crossfades)) {
      expect(stepOf(schemaOf(definitionOf(entry.type), { [CROSSFADE_KEY]: parked })[entry.key]), entry.type).toBe(1);
    }
  });
});
