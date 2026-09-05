import { describe, expect, it } from "vitest";

import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { defaultParameterValue } from "../../domain/parameters/validate.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterDefinition, ParameterValue } from "../../domain/types/parameters.ts";
import { allNodeDefinitions } from "./index.ts";
import { extractParamsStruct, reflectParamsStruct } from "./params-reflection.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §T1210 — THE `struct Params` IS THERE BEFORE ANYBODY TYPES
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: *"we need to instruct for it to write struct params so we get our parameter
 * bindings and all that. This needs to become something that ideally is INHERENT. For both
 * user and agents."*
 *
 * The reflection (§T880, §T900) is what turns a shader field into a KNOB. A starter source
 * with no `struct Params` is therefore A DEAD END THAT LOOKS FINE — the node compiles, it
 * renders, and there is nothing to turn — and silent success is the failure mode nobody
 * reports. Shipping the block IN THE DEFAULT is what makes the shape inherent: it reaches
 * the user and the agent identically, where a sentence in a tool description reaches only
 * the agents that read it, and only sometimes.
 *
 * ## WHY THE SUBJECTS ARE DERIVED (§V453, §V316)
 *
 * A list of "the nodes with starter shaders" goes stale at the fourth one, silently, because
 * a list that forgot a member still passes. So the subjects come out of the MANIFESTS: every
 * registered definition's `code`/`wgsl` parameter that ships a NON-EMPTY default. That
 * derivation is exactly the authoring surface and nothing else — `pointKernel.group` and
 * `pointKernelAdvanced.spawn` are `wgsl` too and ship EMPTY, because an opt-in predicate
 * with no default text is not a starter shader and must not be forced to declare knobs.
 *
 * ## THE CLAIM IS READ OFF THE SCHEMA A CONSUMER READS BACK
 *
 * Not "the source contains the substring `struct Params`" — that is true of a block whose
 * fields reflect to nothing, and of one whose name the node already owns (§T1059 drops those
 * on the floor). The assertion runs the definition through the REAL creation path
 * (`addNode` builds a creation schema, stores its defaults, and every later reader resolves
 * through `effectiveParameterSchema`) and asks the resulting schema what controls the node
 * has. Same function the inspector, the compiler and the agent surface all call.
 *
 * ⚠ AND THE EMPTY STATE HAS TO STAY HONEST, which is the second claim below. The default is
 * a STARTING POINT, not an enforcement: a user who deletes the block must not be silently
 * re-given one. That is a real hazard here rather than a hypothetical, because both node
 * families fall back to their shipped default when the stored value is not a string — so if
 * deleting the text left `undefined` behind rather than an edited string, the block would
 * grow back and fight the author.
 */

/** One shipped starter shader: the definition it belongs to, its key, and its text. */
interface StarterShader {
  readonly definition: NodeDefinition;
  readonly key: string;
  readonly source: string;
}

function starterShaders(): StarterShader[] {
  const found: StarterShader[] = [];
  for (const definition of allNodeDefinitions) {
    for (const [key, parameter] of Object.entries(definition.parameters)) {
      if (parameter.type !== "code" || parameter.language !== "wgsl") continue;
      const source = parameter.default;
      if (typeof source !== "string" || source.trim() === "") continue;
      found.push({ definition, key, source });
    }
  }
  return found;
}

/**
 * The parameters a freshly created node of this type stores, exactly as `addNode` builds
 * them: a creation schema resolved with no provided values, then that schema's own defaults.
 */
function freshlyCreatedParameters(
  definition: NodeDefinition,
  overrides: Readonly<Record<string, ParameterValue>> = {},
): Record<string, ParameterValue> {
  const creation = effectiveParameterSchema(definition, overrides as never);
  const stored: Record<string, ParameterValue> = {};
  for (const [key, parameter] of Object.entries(creation)) {
    stored[key] = defaultParameterValue(parameter);
  }
  return { ...stored, ...overrides };
}

/** The controls a node has that its MANIFEST does not — i.e. the ones reflection produced. */
function reflectedControls(
  definition: NodeDefinition,
  stored: Readonly<Record<string, ParameterValue>>,
): Array<[string, ParameterDefinition]> {
  return Object.entries(effectiveParameterSchema(definition, stored as never)).filter(
    ([key]) => definition.parameters[key] === undefined,
  );
}

const STARTERS = starterShaders();

describe("§T1210 — a freshly created node already has knobs", () => {
  /*
   * §V854/§V910: every claim below is an "every starter …", vacuously true of an empty list.
   * An instrument that reports "nothing wrong" has to prove it can find anything at all — so
   * this fails HERE if the derivation stops finding starter shaders (a manifest renamed, a
   * default moved behind a function), rather than passing green with nothing in it.
   */
  it("finds the shipped starter shaders at all", () => {
    expect(STARTERS.map((starter) => `${starter.definition.type}.${starter.key}`).sort()).toEqual(
      expect.arrayContaining(["customWgsl.source", "pointKernel.kernel", "pointKernelAdvanced.kernel"]),
    );
    // The empty-defaulted `wgsl` parameters are NOT subjects: `group` and `spawn` are opt-in
    // predicates. If the filter ever stopped excluding them this count would move.
    expect(STARTERS).toHaveLength(3);
  });

  it.each(STARTERS.map((starter) => [starter.definition.type, starter] as const))(
    "%s: the node has reflected controls the moment it is created",
    (_type, starter) => {
      const stored = freshlyCreatedParameters(starter.definition);
      const controls = reflectedControls(starter.definition, stored);
      // THE CLAIM. Not "the source mentions Params" — the schema a consumer reads back.
      expect(controls.length).toBeGreaterThan(0);
    },
  );

  it.each(STARTERS.map((starter) => [starter.definition.type, starter] as const))(
    "%s: every one of those controls carries the AUTHOR'S default and the AUTHOR'S sentence",
    (_type, starter) => {
      const stored = freshlyCreatedParameters(starter.definition);
      const controls = reflectedControls(starter.definition, stored);
      const declared = new Map(
        reflectParamsStruct(extractParamsStruct(starter.source).declaration || starter.source).map(
          (field) => [field.name, field],
        ),
      );
      for (const [key, control] of controls) {
        const field = declared.get(key);
        /* A knob whose default is the WGSL TYPE's (§T1184's bug) resets to 0 rather than to
           anything anybody wrote, and a knob described as "reaches the kernel as
           `ctx.params.x`" tells the user what they could already see in the struct. The
           starter is the source everyone copies, so it has to demonstrate both conventions
           it wants copied — that is the whole reason the annotation and the trailing
           sentence exist (§T1184, §T1053). */
        expect(field?.declaredDefault, `${key} declares no // @default`).toBeDefined();
        expect(field?.note, `${key} carries no description comment`).toBeTruthy();
        expect((control as { description?: string }).description).toBe(field?.note);
      }
    },
  );

  it.each(STARTERS.map((starter) => [starter.definition.type, starter] as const))(
    "%s: deleting the block takes the knobs with it — nothing grows back",
    (_type, starter) => {
      const withoutBlock = extractParamsStruct(starter.source).rest;
      // The precondition: the strip actually removed something, or the claim is about the
      // same text twice and cannot fail.
      expect(withoutBlock).not.toBe(starter.source);
      expect(withoutBlock).not.toContain("struct Params");

      const stored = freshlyCreatedParameters(starter.definition, { [starter.key]: withoutBlock });
      expect(reflectedControls(starter.definition, stored)).toEqual([]);
    },
  );
});
