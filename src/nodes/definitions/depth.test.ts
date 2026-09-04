import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { depthNode, depthProvidersFor, depthSettingsFor } from "./depth.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { DEPTH_ACCURATE, DEPTH_LIVE } from "../../runtime/models/model-catalogue.ts";
import type { EnumParameter } from "../../domain/types/parameters.ts";

/**
 * T965 — THE DEPTH NODE'S PARAMETER SURFACE.
 *
 * Read through `effectiveParameterSchema` and never off `depthNode.parameters`, because
 * §T903's funnel is the whole reason the hook works at all: §B166 and §B167 were both a
 * surface reading the STATIC schema while the node had computed a different one, and both
 * rendered correctly and behaved wrongly. A test that read the static field would be a
 * fourth such surface.
 */
const schemaFor = (stored: Record<string, unknown>) =>
  effectiveParameterSchema(depthNode, stored);

const enumOf = (stored: Record<string, unknown>, key: string): EnumParameter => {
  const found = schemaFor(stored)[key];
  if (found === undefined || found.type !== "enum") throw new Error(`${key} is not an enum`);
  return found;
};

describe("§T965(b)/§V827(1) — the chooser names the model, the size AND the licence", () => {
  it("labels each option with the catalogue's own name and its MEASURED megabytes", () => {
    const labels = enumOf({}, "model").options.map((option) => option.label);
    // The owner's complaint was `fast` / `accurate`: which model, and how big? Composed
    // from `descriptor.bytes` by §V827's shared chooser, so the number in the option is
    // the number that will be downloaded and cannot be a stale hand-written copy.
    expect(labels).toContain("Depth Anything V2 Small (94.5 MB)");
    // And the 4-bit variant is named by its QUANTISATION, not by "small download" —
    // §T753 measured it 1.44x SLOWER, so "small" was the one word that could mislead.
    expect(labels).toContain("Depth Anything V2 Small 4-bit (18.2 MB)");
  });

  it("states the LICENCE, which the hand-built chooser did not", () => {
    // A 94 MB artefact under an unstated licence is a decision made with half the
    // information. The seam puts it in the description of the control that chooses it.
    expect(schemaFor({})["model"]?.description).toContain("Apache-2.0");
    expect(schemaFor({})["model"]?.description).toContain("Licence:");
  });

  it("says WHICH model and its size at the moment of choosing, not in a notice after", () => {
    const chosen = enumOf({}, "model").options.find(
      (option) => option.value === DEPTH_ACCURATE.id,
    );
    // Both halves. The label this replaced — "Accurate (94 MB)" — already carried a size;
    // what it hid was WHICH weights, which is half the owner's complaint.
    expect(chosen?.label).toContain("94.5 MB");
    expect(chosen?.label).toContain("Depth Anything V2");
  });

  it("⚠ KEEPS the legacy value as an OPTION for the document standing on it (§V813)", () => {
    // E44 Sounding and E47 Hologram hold `"model": "accurate"` on disk right now. An enum
    // whose stored value is missing from its own options resolves to the DEFAULT — so
    // dropping it would silently switch a document that chose the 4-bit variant onto the
    // 94 MB one the moment it opened: a migration that looks complete and spends 94 MB of
    // someone else's bandwidth.
    expect(enumOf({ model: "accurate" }, "model").options.map((o) => o.value)).toContain("accurate");
    expect(enumOf({ model: "fast" }, "model").options.map((o) => o.value)).toContain("fast");
  });

  it("...and shows it to NOBODY ELSE — a shim is invisible to whoever it is not migrating", () => {
    // Offering both legacy rows to everyone showed FOUR options for TWO models, and the
    // old pair carried hand-written megabytes (94) against the seam's measured ones
    // (94.5), so one model appeared twice at two different sizes. That reads as two
    // different downloads.
    const fresh = enumOf({}, "model").options;
    expect(fresh.map((option) => option.value)).toEqual([DEPTH_ACCURATE.id, DEPTH_LIVE.id]);
    // And where it IS shown it wears its twin's label, so the sizes cannot disagree.
    const shown = enumOf({ model: "accurate" }, "model").options.find((o) => o.value === "accurate");
    expect(shown?.label).toContain("94.5 MB");
    expect(shown?.label).toContain("as saved");
  });

  it("resolves BOTH spellings to the same weights, so nothing changed under a document", () => {
    expect(depthSettingsFor({ model: "accurate" }).modelId).toBe(DEPTH_ACCURATE.id);
    expect(depthSettingsFor({ model: DEPTH_ACCURATE.id }).modelId).toBe(DEPTH_ACCURATE.id);
    expect(depthSettingsFor({ model: "fast" }).modelId).toBe(DEPTH_LIVE.id);
    expect(depthSettingsFor({ model: DEPTH_LIVE.id }).modelId).toBe(DEPTH_LIVE.id);
  });
});

describe("§T965(c) — the schema is COMPUTED FROM THE CHOSEN MODEL", () => {
  it("is a different schema for a different model, not one schema with dead knobs", () => {
    const accurate = schemaFor({ model: "accurate" });
    const fast = schemaFor({ model: "fast" });
    // §T965 rules OUT the union-behind-`inactiveWhen` shape, so the difference has to be
    // in what the schema SAYS about the model that is actually selected.
    expect(accurate["model"]?.description).toContain(DEPTH_ACCURATE.label);
    expect(fast["model"]?.description).toContain(DEPTH_LIVE.label);
    // The MEASURED cost of the model that is actually selected — a number belonging to
    // the other model standing under this control would be worse than none.
    expect(accurate["model"]?.description).toContain("2.7 s");
    expect(fast["model"]?.description).toContain("3.8 s");
  });

  it("carries the CHOSEN model's measured cost into the controls it is a choice about", () => {
    // §T753's measurement: fp32 is 2.7 s a run and the 4-bit variant is 3.8 s — SLOWER,
    // which is the fact that stops anyone picking it for speed. A description naming the
    // other model's number would be worse than none.
    expect(schemaFor({ model: "accurate" })["inputSide"]?.description).toContain("2.7 s");
    expect(schemaFor({ model: "fast" })["inputSide"]?.description).toContain("3.8 s");
    expect(schemaFor({ model: "accurate" })["rateLimit"]?.description).toContain("2.7 s");
    expect(schemaFor({ model: "fast" })["rateLimit"]?.description).toContain("3.8 s");
  });

  it("offers Input Size only because the WEIGHTS leave height and width symbolic", () => {
    // Read from `MODEL_SIGNATURES`, extracted from the real .onnx. A model whose graph
    // pins its input must get NO such knob — a control that cannot take is worse than an
    // absent one (§V146), and here it would be refused by the session at run time.
    const options = enumOf({}, "inputSide").options.map((option) => Number(option.value));
    expect(options).toContain(518);
    // Every option is a multiple of the ViT's 14-pixel patch; anything else is refused.
    for (const side of options) expect(side % 14).toBe(0);
    expect(schemaFor({})["inputSide"]?.label).toBe("Input Size");
    expect(
      enumOf({}, "inputSide").options.find((option) => option.value === "518")?.label,
    ).toContain("exported");
  });

  it("SHIPS 266, not the export size — the live-webcam default (T976, owner)", () => {
    // Four times fewer pixels. The export size is one click away and still labelled as
    // the export size, so the trade is visible at the moment of choosing rather than
    // being a number someone has to know.
    expect(enumOf({}, "inputSide").default).toBe("266");
    expect(depthSettingsFor({}).inputSide).toBe(266);
    expect(266 % 14).toBe(0);
  });

  it("makes Input Size a REBUILD, never a uniform write (§V5)", () => {
    // The scratch buffer and the dispatch are sized from it. Classified cheap, a change
    // would resize nothing and the model would be fed a buffer of the wrong length.
    expect(schemaFor({})["inputSide"]?.compileTime).toBe(true);
    // And the knobs that are only uniform writes must NOT be marked structural, or every
    // drag of the output range rebuilds a pipeline.
    expect(schemaFor({})["nearIsBright"]?.compileTime).toBeUndefined();
    expect(schemaFor({})["outputRange"]?.compileTime).toBeUndefined();
  });

  it("gives §T384's freshness a REAL control rather than a hidden constant", () => {
    const schema = schemaFor({});
    expect(schema["refresh"]?.type).toBe("enum");
    expect(enumOf({}, "refresh").options.map((option) => option.value)).toEqual([
      "continuous",
      "held",
    ]);
    const rate = schema["rateLimit"];
    expect(rate?.type).toBe("number");
    // 0 is no cap, and below zero is not a rate: the floor CLAMPS, the ceiling is travel.
    expect(rate?.type === "number" && rate.range).toBe("floor");
    expect(rate?.type === "number" && rate.default).toBe(0);
  });

  it("keeps every static key reachable, so a fresh drop's values have a home (§T880)", () => {
    // The static schema is the fallback for the palette and for type-only contexts. If it
    // held a key the computed one does not, a stored value would have nowhere to resolve.
    for (const key of Object.keys(depthNode.parameters)) {
      expect(Object.keys(schemaFor({ model: "fast" }))).toContain(key);
    }
  });
});

describe("§T978 — the reset pulse", () => {
  it("is a PULSE, so it lands on the parameter page by being a parameter (§T960)", () => {
    const reset = schemaFor({})["reset"];
    expect(reset?.type).toBe("pulse");
    // `pulse` is already a parameter type that is a gesture rather than a value, so this
    // needs no new control kind and no Depth pane — and it takes every parameter mode,
    // so an expression crossing zero fires it too.
    expect(reset?.type === "pulse" ? reset.fires : undefined).toBe("runtime.resetInference");
    expect(reset?.type === "pulse" ? reset.input : undefined).toEqual({ nodeIds: ["$node"] });
  });

  it("SAYS the scope, including the half it does NOT touch", () => {
    // ⚠ 94 MB re-downloaded by a misread button is worse than the stuck state it clears.
    // The copy has to rule that out where the button is, not in a docblock.
    const said = schemaFor({})["reset"]?.description ?? "";
    expect(said).toContain("worker");
    expect(said).toContain("session");
    expect(said).toContain("never re-downloads");
    expect(said).toContain("KEPT");
    // It is also honest that the thread is shared, rather than implying per-node scope.
    expect(said).toContain("shared");
  });

  it("fires a command that is NOT the feedback reset — a button that lies is worse than none", () => {
    // §V123: the pulse must reach the thing it names. `runtime.resetFeedback` clears
    // temporal history and knows nothing about a model session, so naming it here would
    // have been a reset that silently did nothing to the state that was stuck.
    const reset = schemaFor({})["reset"];
    expect(reset?.type === "pulse" ? reset.fires : undefined).not.toBe("runtime.resetFeedback");
  });
});

describe("§T965 — the backend is SHOWN and PICKABLE, and worded honestly", () => {
  it("offers what this machine reports, computed rather than hard-coded", () => {
    const values = enumOf({}, "backend").options.map((option) => option.value);
    // The CPU floor is always reachable and automatic is always meaningful.
    expect(values).toContain("auto");
    expect(values).toContain("wasm");
    // WebGPU appears only where `navigator.gpu` does. Under vitest's node environment it
    // does not, which is precisely the "differs per machine" property being asserted.
    const probed = typeof navigator !== "undefined" && (navigator as { gpu?: unknown }).gpu !== undefined;
    expect(values.includes("webgpu")).toBe(probed);
  });

  it("keeps an UNREACHABLE stored choice in the list rather than rewriting the document", () => {
    // Dropping it would silently resolve the node to something its author did not pick.
    const values = enumOf({ backend: "webgpu" }, "backend").options.map((o) => o.value);
    expect(values).toContain("webgpu");
    const label = enumOf({ backend: "webgpu" }, "backend").options.find(
      (option) => option.value === "webgpu",
    )?.label;
    if (typeof navigator === "undefined" || (navigator as { gpu?: unknown }).gpu === undefined) {
      expect(label).toContain("not available");
    }
  });

  it("NEVER names a chip on any surface (§T715's banned vocabulary)", () => {
    // The WebNN specification deliberately defines no device enumeration and no way to
    // observe which device was chosen, so any of these would be an unverifiable claim.
    // T1107 — the acronyms match on a WORD; `NPU` as a bare substring fires on `INPUT`
    // and `ANE` on `PLANE`. Rationale in full in `inference-node.test.ts`.
    const surface = JSON.stringify(schemaFor({ backend: "webgpu" })) + depthNode.description;
    for (const banned of [/\bANEs?\b/, /\bNPUs?\b/]) {
      expect(surface, `depth names ${banned.source}`).not.toMatch(banned);
    }
    for (const banned of ["Neural Engine", "hardware-accelerated", "the browser chose the device"]) {
      expect(surface).not.toContain(banned);
    }
  });

  it("PINS when pinned — a picker that silently falls back has removed the choice", () => {
    expect(depthProvidersFor({ backend: "wasm" })).toEqual(["wasm"]);
    expect(depthProvidersFor({ backend: "webgpu" })).toEqual(["webgpu"]);
    // Automatic is the ladder narrowed to what is reachable, and the CPU floor is last.
    expect(depthProvidersFor({}).at(-1)).toBe("wasm");
    expect(depthProvidersFor({ backend: "auto" }).at(-1)).toBe("wasm");
  });
});

describe("the run settings the app reads are the schema's own defaults", () => {
  it("resolves an empty bag to the shipped default, the ladder and no cap", () => {
    const settings = depthSettingsFor({});
    expect(settings.modelId).toBe(DEPTH_ACCURATE.id);
    expect(settings.inputSide).toBe(266);
    expect(settings.minIntervalSeconds).toBe(0);
    expect(settings.hold).toBe(false);
  });

  it("turns a rate limit in HERTZ into the gap in SECONDS the seam actually applies", () => {
    // The parameter is the number a person thinks in; the seam needs its reciprocal, and
    // exactly one place may do that conversion or the two will disagree.
    expect(depthSettingsFor({ rateLimit: 4 }).minIntervalSeconds).toBeCloseTo(0.25);
    expect(depthSettingsFor({ rateLimit: 0.5 }).minIntervalSeconds).toBeCloseTo(2);
    // 0 is no cap, not an infinite gap.
    expect(depthSettingsFor({ rateLimit: 0 }).minIntervalSeconds).toBe(0);
  });

  it("REFUSES an input size the model would refuse, and falls back rather than failing", () => {
    // §T715's degrade rule: an illegal stored value must leave a renderable document. 500
    // is not a multiple of 14 and the session would reject the tensor outright.
    expect(depthSettingsFor({ inputSide: "500" }).inputSide).toBe(266);
    expect(depthSettingsFor({ inputSide: "518" }).inputSide).toBe(518);
  });

  it("reads Hold as the freshness policy the seam binds on", () => {
    expect(depthSettingsFor({ refresh: "held" }).hold).toBe(true);
    expect(depthSettingsFor({ refresh: "continuous" }).hold).toBe(false);
  });
});

/**
 * §B171 — THE WIRING GUARD.
 *
 * `inference.worker.ts` cannot be unit-tested: it is a worker entry that dynamically
 * imports onnxruntime and compiles a 94 MB model. So the one line that made the feature
 * run at all is guarded by reading the file, which is the same shape §T497's shipped-clock
 * audit uses for text it cannot execute. §V220's dominant bug is "built, tested, never
 * wired", and this fix is ONE assignment whose absence is invisible until a user tries it.
 */
describe("§B171 — the worker points onnxruntime at a wasm URL this build serves", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("../../runtime/models/inference.worker.ts", import.meta.url)),
    "utf8",
  );
  /*
   * COMMENTS STRIPPED FIRST, and the strip is load-bearing rather than tidy: the docblock
   * above this fix explains §B171 at length and therefore says `wasmPaths` several times.
   * A scan of the whole file would go green on a version where the docblock survived and
   * the ASSIGNMENT was deleted — which is a guard that passes over the exact bug it exists
   * to catch, and is how a wiring test becomes decoration.
   */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("sets `wasmPaths` at all — it was set NOWHERE, which is the whole bug", () => {
    expect(source).toContain("wasm.wasmPaths =");
  });

  it("takes the URL from Vite's `?url` import rather than guessing a path", () => {
    // A hard-coded "/ort/" would be right in dev, wrong under `--base=/loom/`, and wrong
    // again for a content-hashed build asset. Asking the bundler is the only answer that
    // is right in all three.
    expect(source).toContain('onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url');
    expect(source).toMatch(/wasmPaths\s*=\s*\{\s*wasm:/);
  });

  it("absolutises it, because ORT re-resolves the path inside a blob-URL worker", () => {
    expect(source).toContain("new URL(wasmUrl, self.location.href)");
  });
});
