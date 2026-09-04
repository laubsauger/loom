import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "./index.ts";
import { inferenceModelSchema, letterboxPreprocessWgsl } from "./inference-node.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { ALL_MODELS, MEASUREMENT_MACHINE } from "../../runtime/models/model-catalogue.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";

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
    //
    // T1107 — the ACRONYMS match on a WORD, not as bare substrings. Spelled `toContain`
    // they are three letters looking for themselves anywhere: `NPU` fires on `INPUT RANGE`
    // (reported, in good faith, as "matte names NPU"), and `ANE` would fire on `PLANE` and
    // `ANEW` — all words a compositor's copy legitimately carries. That matters more than a
    // lost cycle: a guard that cries wolf on correct copy teaches the next author to route
    // around it, which is how a real §T715 violation eventually ships. The bans themselves
    // are NOT weakened — `s?` keeps the plural inside rather than opening a hole beside it,
    // and every spelling a violation would actually use ("the ANE", "ANE-backed", "NPUs",
    // "Apple Neural Engine (ANE)") still fails. The two PHRASES stay literal: no English
    // word contains them, so a boundary would buy nothing.
    for (const definition of inferenceNodes) {
      const surface =
        JSON.stringify(effectiveParameterSchema(definition, {})) + (definition.description ?? "");
      for (const banned of [/\bANEs?\b/, /\bNPUs?\b/]) {
        expect(surface, `${definition.type} names ${banned.source}`).not.toMatch(banned);
      }
      for (const banned of ["Neural Engine", "hardware-accelerated"]) {
        expect(surface, `${definition.type} names ${banned}`).not.toContain(banned);
      }
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §V899 — A PERFORMANCE NUMBER TRAVELS WITH THE MACHINE IT CAME OFF
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner, ruling that `MATTE_FAST` stays: "keep viable options. Never know if it may be
 * different on Windows or different GPU architecture so options are good." He was
 * correcting a framing the coordinator had written — §T1085 recorded that the quantized
 * MODNet **IS** slower on WebGPU (400 ms against 311 ms on threaded wasm), and the true
 * sentence is that it MEASURED slower on ONE GPU, on one day. A quantized build losing on
 * Apple's Metal path is exactly the result that can invert on NVIDIA or AMD, where the
 * 8-bit kernels are not the same silicon.
 *
 * Every performance figure in this repository came off that one machine, so the drift is
 * not one row's: `DEPTH_PROVIDERS` wrote its provenance out by hand and the newer rows
 * stopped doing it. This gate is the discipline made non-optional — a time or a speed
 * ratio anywhere a USER reads it must carry `MEASUREMENT_MACHINE`.
 *
 * It is deliberately about the copy rather than about the comments: a doc block is read by
 * whoever is already editing the file, and a parameter description is read by the person
 * deciding what to run on hardware nobody here has ever touched. That person is the one
 * who inherits the wrong conclusion.
 */
/*
 * A duration, a rate, or a speed ratio — the three shapes a cost is written in here.
 *
 * `per second` is in the list because the FIRST version of this gate missed the matte
 * node's own description ("around one per second on the GPU provider"), which spells its
 * number as a word: the gate passed that sentence with the machine deleted, so it was
 * proving nothing about the surface it exists for. `times|x faster` carries no digit
 * requirement for the same reason — pose wrote "roughly three times slower".
 *
 * It over-reaches slightly: "runs per second" as a bare UNIT is not a claim. That is the
 * safe direction, because naming the machine beside a number is never wrong.
 */
const PERFORMANCE_CLAIM =
  /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds)\b|\b\d+(?:\.\d+)?\s+s\b|\bper second\b|\b(?:x|times)\s+(?:faster|slower)\b/i;

/**
 * Every schema this node can show, one per model it offers — because the numbers live on
 * the PER-ARTEFACT knobs (`downsampleRatio` exists only under RVM, and the Backend chooser
 * does not exist under MediaPipe at all), and a scan of the default bag alone would walk
 * past them.
 */
function everySchemaOf(definition: NodeDefinition): readonly ParameterSchema[] {
  const model = effectiveParameterSchema(definition, {})["model"];
  const bags: Array<Record<string, unknown>> =
    model?.type === "enum" ? model.options.map((option) => ({ model: option.value })) : [];
  return [{}, ...bags].map((stored) => effectiveParameterSchema(definition, stored));
}

describe("§V899 — a time or a speed ratio in a model node's copy names its machine", () => {
  it("holds for every parameter of every model node, under every model it offers", () => {
    for (const definition of inferenceNodes) {
      for (const schema of everySchemaOf(definition)) {
        for (const [key, parameter] of Object.entries(schema)) {
          const said = [
            parameter.label,
            parameter.description ?? "",
            ...(parameter.type === "enum" ? parameter.options.map((option) => option.label) : []),
          ].join(" ");
          if (!PERFORMANCE_CLAIM.test(said)) continue;
          expect(
            said,
            `${definition.type}.${key} states a measured cost without naming the machine ` +
              `it came off — §V899. Compose it with measuredOn(date).`,
          ).toContain(MEASUREMENT_MACHINE);
        }
      }
    }
  });

  it("holds for the node's own description, which the library and help both show", () => {
    for (const definition of inferenceNodes) {
      const said = definition.description ?? "";
      if (!PERFORMANCE_CLAIM.test(said)) continue;
      expect(said, `${definition.type}'s description states a cost with no machine`).toContain(
        MEASUREMENT_MACHINE,
      );
    }
  });

  it("is looking at copy that really does quote numbers, or it proves nothing", () => {
    // A regex that matched nothing would pass this file forever. The matte node is the
    // reason the invariant exists and its copy is dense with milliseconds; if a rewrite
    // ever strips every number out of it, this fails and someone re-reads the rule rather
    // than inheriting a gate that stopped gating.
    const matte = inferenceNodes.find((definition) => definition.type === "matte");
    const quoted = everySchemaOf(matte as NodeDefinition)
      .flatMap((schema) => Object.values(schema))
      .filter((parameter) =>
        PERFORMANCE_CLAIM.test(
          `${parameter.description ?? ""} ` +
            (parameter.type === "enum" ? parameter.options.map((o) => o.label).join(" ") : ""),
        ),
      );
    expect(quoted.length).toBeGreaterThan(0);
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
