import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "./index.ts";
import { inferenceModelSchema, letterboxPreprocessWgsl } from "./inference-node.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { ALL_MODELS } from "../../runtime/models/model-catalogue.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";

/**
 * §V827 — WHAT EVERY MODEL-RUNNING NODE OWES, AS A PROPERTY RATHER THAN THREE HABITS.
 *
 * The owner's rule: "make it a rule that these things expose all the relevant bits as we
 * did for depth. We can't just swallow that — it will be needed anyway."
 *
 * Depth built the obligations by hand (§T965/§T978). Pose repeated depth's OMISSIONS and
 * earned §T985 — an opaque chooser and no recovery gesture at all. The matte was the third
 * instance and the moment the seam existed. That is the §V437 shape three times over: a
 * property delivered site by site is not delivered.
 *
 * So this is not a list of the three nodes. It is the property, DERIVED from the registry:
 * model node number four fails here until its author decides, and it cannot pass by
 * copying a neighbour's paragraph — the assertions are about facts (a measured byte count,
 * a licence, a command name), not about wording.
 */

/**
 * A model-running node, found rather than listed: it declares a `reset` pulse firing the
 * inference reset, OR a `model` enum whose values name catalogue artefacts. Either half
 * alone is enough to be caught — a node that has the chooser and skipped the pulse is
 * precisely §T985, and it must not escape by lacking the thing it omitted.
 */
function isInferenceNode(definition: NodeDefinition): boolean {
  const schema = effectiveParameterSchema(definition, {});
  const model = schema["model"];
  const reset = schema["reset"];
  if (reset?.type === "pulse" && reset.fires === "runtime.resetInference") return true;
  if (model?.type !== "enum") return false;
  const ids = new Set(ALL_MODELS.map((entry) => entry.id));
  return model.options.some((option) => ids.has(option.value));
}

const inferenceNodes = allNodeDefinitions.filter(isInferenceNode);

describe("§V827 — every model-running node meets the seam's obligations", () => {
  it("is finding the real nodes, or it is measuring nothing", () => {
    // Depth, Pose, Matte. A scan that found none would assert the property vacuously,
    // which is how a derived gate quietly stops deriving anything.
    const types = inferenceNodes.map((definition) => definition.type).sort();
    expect(types).toEqual(["depth", "matte", "pose"]);
  });

  it("(1) every model option names its artefact AND its measured download", () => {
    for (const definition of inferenceNodes) {
      const model = effectiveParameterSchema(definition, {})["model"];
      expect(model?.type, `${definition.type} has no model chooser`).toBe("enum");
      if (model?.type !== "enum") continue;
      for (const option of model.options) {
        // The size is composed from `descriptor.bytes`, so a size in the label is the
        // size that will be downloaded. `Accurate (9 MB)` named neither the model nor a
        // number anything measured, and that is exactly what §T985 was raised for.
        expect(option.label, `${definition.type}: "${option.label}" states no size`).toMatch(
          /\(\d+(\.\d+)? MB\)/,
        );
        expect(
          option.label.replace(/\s*\(.*\)$/, "").length,
          `${definition.type}: "${option.label}" is a size with no artefact name`,
        ).toBeGreaterThan(3);
      }
    }
  });

  it("(1) every model chooser states the LICENCE", () => {
    // The coordinator's own note on §T957: "I hadn't asked for the licence and should
    // have." A large artefact under an unstated licence is a decision made with half the
    // information, and it is a fact the catalogue already holds.
    for (const definition of inferenceNodes) {
      const model = effectiveParameterSchema(definition, {})["model"];
      expect(model?.description, `${definition.type}'s chooser omits the licence`).toContain(
        "Licence:",
      );
    }
  });

  it("(5) every one carries the reset pulse, scoped to the SESSION", () => {
    for (const definition of inferenceNodes) {
      const reset = effectiveParameterSchema(definition, {})["reset"];
      expect(reset?.type, `${definition.type} has no reset pulse`).toBe("pulse");
      if (reset?.type !== "pulse") continue;
      // It must reach the thing it names. `runtime.resetFeedback` clears temporal history
      // and knows nothing about a model session, so naming it would be a button that lies.
      expect(reset.fires).toBe("runtime.resetInference");
      expect(reset.input).toEqual({ nodeIds: ["$node"] });
      // ⚠ THE SENTENCE THAT MATTERS. 94 MB re-downloaded by a misread button is worse
      // than the stuck state it was clearing, so the scope has to be at the button.
      expect(reset.description, `${definition.type}'s reset does not say the weights are kept`)
        .toContain("KEPT");
      expect(reset.description).toContain("never re-downloads");
    }
  });

  it("(2)/(3) are NOT claimed by any schema — a description naming a backend is the echo bug", () => {
    /*
     * §T381/§B171's lesson, as a gate. What RAN and what it COST are measurements: the
     * worker walks the provider ladder one rung at a time and the node-info readout
     * reports whichever answered. A schema string naming a backend would be echoing the
     * REQUEST, and would confidently name WebGPU while the CPU did the work.
     *
     * Depth's Backend parameter is the one legitimate mention — it IS the request — so it
     * is excluded by key rather than by hoping no wording collides.
     */
    for (const definition of inferenceNodes) {
      const schema = effectiveParameterSchema(definition, {});
      for (const [key, parameter] of Object.entries(schema)) {
        if (key === "backend") continue;
        const said = `${parameter.label} ${parameter.description ?? ""}`;
        expect(said, `${definition.type}.${key} claims a backend`).not.toMatch(
          /\b(is running on|ran on|runs on) (webgpu|the gpu|webnn)\b/i,
        );
      }
    }
  });

  it("NEVER names a chip, on any model node's surface (§T715)", () => {
    // The WebNN specification deliberately defines no device enumeration and no way to
    // observe which device was chosen, so any of these would be unverifiable.
    for (const definition of inferenceNodes) {
      const surface =
        JSON.stringify(effectiveParameterSchema(definition, {})) + (definition.description ?? "");
      for (const banned of ["Neural Engine", "ANE", "NPU", "hardware-accelerated"]) {
        expect(surface, `${definition.type} names ${banned}`).not.toContain(banned);
      }
    }
  });
});

describe("§V827 — the shared chooser composes from the catalogue, never from a constant", () => {
  it("takes the megabytes from `descriptor.bytes`", () => {
    const schema = inferenceModelSchema(
      [{ id: "x", label: "Fixture", url: "u", bytes: 10 * 1_048_576, license: "MIT" }],
      { what: "A fixture." },
    );
    expect(schema.options[0]?.label).toBe("Fixture (10.0 MB)");
    expect(schema.description).toContain("Licence: MIT");
  });

  it("strips a size the label already carried, so it is never stated twice", () => {
    const schema = inferenceModelSchema(
      [{ id: "x", label: "Fixture (9 MB)", url: "u", bytes: 10 * 1_048_576, license: "MIT" }],
      { what: "A fixture." },
    );
    // A hand-written 9 beside a measured 10 is the drift this composition exists to stop.
    expect(schema.options[0]?.label).toBe("Fixture (10.0 MB)");
  });
});

describe("§V827 — one letterbox, in one language pair", () => {
  it("is the T974 rule and every image-input node takes THIS copy", () => {
    const wgsl = letterboxPreprocessWgsl();
    expect(wgsl).toContain("aspect");
    expect(wgsl).toContain("occ");
    // The aspect rule is stated in WGSL here and in float64 as `occOf`; those two must
    // agree. A third copy pasted into a node is a third chance for them to disagree
    // silently, and a squeezed frame degrades an estimator plausibly.
    expect(wgsl).toContain("select(vec2f(aspect, 1.0), vec2f(1.0, 1.0 / aspect), aspect >= 1.0)");
  });
});
