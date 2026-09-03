import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { defaultParameters } from "../../domain/parameters/validate.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { codeParametersOf } from "../../domain/parameters/code.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterSchema, ParameterValue } from "../../domain/types/parameters.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §T1052 — THE CODE EDITOR IS THE LAST THING ON A NODE, ON EVERY NODE THAT HAS ONE
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: *"the derived values and all of this kind of stuff should be ABOVE the code
 * segments, so that you don't have to scroll past a bunch of code to be able to access any
 * of the derived or exposed parameters — for kernels, or anywhere where there's a WGSL."*
 *
 * `parameter-groups.ts` is explicit that `group` is the only grouping input and MANIFEST
 * ORDER is the only ordering one, so a schema that lists its editor first renders it first.
 * The fix is therefore in the manifests (`codeParametersLast`), and this is the gate that
 * keeps it there.
 *
 * ## Why the set is DERIVED and not listed (§V316, §V855)
 *
 * The two nodes anybody would name are `customWgsl` and the point kernel. The catalogue
 * carries four — `pointKernelAdvanced` has a spawn hook and `midiIn` a learned JSON mapping,
 * and `attributes` is a code parameter on both kernels. A rule stated over a CATEGORY but
 * checked over the members somebody remembered narrows silently the moment member #5 lands,
 * which is exactly §V316's shape. So the subject list comes out of `allNodeDefinitions` and
 * the count is asserted, because a shrinking gate is a passing gate.
 *
 * ## Both schemas, because a node has two
 *
 * The DECLARED block is what the palette, the library and the help page document. The
 * EFFECTIVE one is what a placed node's inspector renders, and for the three reflecting
 * nodes it is a different object built by `parametersFor` — which is where the defect
 * actually lived: §T880/§T900 APPENDED the reflected knobs after the text they were read
 * out of, so the controls the reflection exists to give you were the ones below the editor.
 * Checking only the declared block would pass against that bug.
 *
 * §V854's precondition, met deliberately: the reflected probe below asserts that
 * `probeKnob` is PRESENT before asserting where the code sorts. Without that, a reflector
 * that silently stopped reflecting would leave a schema with nothing but code parameters in
 * it, and "the code sorts last" would be vacuously true.
 */

/** A WGSL source that declares one reflectable knob — and the uniform block `customWgsl` requires. */
const PROBE_SOURCE = `
struct Params { probeKnob: f32 };
@group(0) @binding(3) var<uniform> params: Params;
fn probe() -> f32 { return params.probeKnob; }
`;

/** The reflected control that source must produce, on any node whose editor reflects at all. */
const PROBE_KNOB = "probeKnob";

/** Keys whose parameter is code, and the whole ordered key list, for one schema. */
function order(schema: ParameterSchema): { keys: string[]; code: Set<string> } {
  return {
    keys: Object.keys(schema),
    code: new Set(codeParametersOf(schema).map((entry) => entry.key)),
  };
}

/**
 * The claim, stated once: every code parameter sorts after every parameter that is not one.
 * Reported as the offending pair rather than as a boolean, so a failure names which knob got
 * buried under which editor instead of saying that something did.
 */
function buriedControls(schema: ParameterSchema): string[] {
  const { keys, code } = order(schema);
  const firstCode = keys.findIndex((key) => code.has(key));
  if (firstCode < 0) return [];
  return keys.filter((key, index) => index > firstCode && !code.has(key));
}

/** A stored bag that makes a reflecting node reflect: the probe source in every WGSL slot. */
function reflectingStore(definition: NodeDefinition): Record<string, ParameterValue> {
  const stored: Record<string, ParameterValue> = { ...defaultParameters(definition.parameters) };
  for (const { key, definition: parameter } of codeParametersOf(definition.parameters)) {
    if (parameter.language === "wgsl") stored[key] = PROBE_SOURCE;
  }
  return stored;
}

/** Every node type in the shipped catalogue that declares a code parameter at all. */
const WITH_CODE = allNodeDefinitions.filter((definition) => codeParametersOf(definition.parameters).length > 0);

/** Of those, the ones whose editor feeds a reflected schema — where §T880/§T900's append lived. */
const REFLECTING = WITH_CODE.filter(
  (definition) =>
    definition.parametersFor !== undefined &&
    codeParametersOf(definition.parameters).some((entry) => entry.definition.language === "wgsl"),
);

describe("T1052 — a node's code editors sort last", () => {
  it("covers every node type in the catalogue that declares one", () => {
    expect(WITH_CODE.map((definition) => definition.type).sort()).toEqual([
      "customWgsl",
      "midiIn",
      "pointKernel",
      "pointKernelAdvanced",
    ]);
    expect(REFLECTING.map((definition) => definition.type).sort()).toEqual([
      "customWgsl",
      "pointKernel",
      "pointKernelAdvanced",
    ]);
  });

  it.each(WITH_CODE.map((definition) => definition.type))(
    "%s declares its editors below its controls",
    (type) => {
      const definition = WITH_CODE.find((entry) => entry.type === type);
      expect(definition).toBeDefined();
      expect(buriedControls(definition?.parameters ?? {})).toEqual([]);
    },
  );

  it.each(WITH_CODE.map((definition) => definition.type))(
    "%s renders its editors below its controls on a placed node",
    (type) => {
      const definition = WITH_CODE.find((entry) => entry.type === type);
      expect(definition).toBeDefined();
      const stored = defaultParameters(definition?.parameters ?? {});
      expect(buriedControls(effectiveParameterSchema(definition, stored))).toEqual([]);
    },
  );

  /**
   * The one that would have caught the bug. A node whose shader declares knobs must show
   * them ABOVE the shader — and the presence assertion is what stops this passing on a
   * schema that reflected nothing at all.
   */
  it.each(REFLECTING.map((definition) => definition.type))(
    "%s sorts a knob reflected out of its own shader above that shader",
    (type) => {
      const definition = REFLECTING.find((entry) => entry.type === type);
      expect(definition).toBeDefined();
      const schema = effectiveParameterSchema(definition, reflectingStore(definition as NodeDefinition));
      expect(Object.keys(schema), "the probe source must actually reflect a control").toContain(PROBE_KNOB);
      expect(buriedControls(schema)).toEqual([]);
      // and it is the KNOB that moved up, not the editor that vanished.
      expect(codeParametersOf(schema).length).toBeGreaterThan(0);
    },
  );
});
