import { describe, expect, it } from "vitest";

import { createComponentSystem } from "../domain/components/index.ts";
import { loadProject } from "../domain/project/index.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import {
  STRUCTURE_KEY_SEPARATORS,
  planStructureKeys,
  planStructureSignature,
  passStructureKey,
  resourceStructureKey,
} from "../runtime/backend/plan.ts";
import { listExamples } from "../examples/catalogue.ts";
import { compileGraph } from "./compile.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";

/**
 * T1176 — the plan's structure keys are built ONCE, and the whole-plan signature is
 * joined from the per-entry ones instead of re-serialising every descriptor.
 *
 * `CompiledGraph` carries per-entry keys AND a whole-plan signature, and the signature
 * was `JSON.stringify` over the same key parts a second time — so `compileGraph` walked
 * and serialised every resource and every pass twice, on every commit and on every
 * animated frame. Measured on E55/E33/E13 in one process in rotating order, the key block
 * halves, which is 8–12% of a whole compile.
 *
 * ## What has to be true for the join to be sound, and what this file checks
 *
 * §V5 hangs off these keys: `isUniformOnlyChange` IS a signature comparison, and the
 * uniform-only push that keeps a knob turn off the pipeline-rebuild path is gated on it.
 * A signature that could collide would not fail loudly — it would silently push uniforms
 * into a program whose structure had moved.
 *
 *  1. **UNFORGEABLE.** The join separates keys with U+0000 and the two sections with
 *     U+0001. `JSON.stringify` never emits a raw control character, so no key can contain
 *     one — checked here against every key of every shipped example's real plan, not
 *     argued from the spec.
 *  2. **INJECTIVE across real documents.** Two shipped examples whose key lists differ
 *     must not share a signature.
 *  3. **WIRED.** What `compileGraph` puts on the plan is what these functions produce —
 *     the "built, tested, never wired" class this project keeps meeting.
 *  4. **STILL VALUE-BLIND.** The per-entry keys are `passStructureKey` /
 *     `resourceStructureKey` verbatim, which exclude uniform VALUES by construction, so
 *     recompiling the same document twice gives the same signature.
 *
 * Derived from `examples/`: dropping a `.loom.json` in adds a case.
 */

const registryBase = createNodeRegistry(allNodeDefinitions).view();

function compileOf(text: string): ReturnType<typeof compileGraph> | null {
  const system = createComponentSystem(registryBase);
  const loaded = loadProject(text, { nodes: system.nodes });
  if (!loaded.ok) return null;
  for (const definition of loaded.components) system.components.register(definition);
  return compileGraph({
    graph: loaded.document.graph,
    settings: loaded.document.settings,
    registry: system.nodes,
    capabilities: TIER_B_CAPABILITIES,
    components: system.components.view(),
  });
}

const files = listExamples();
const plans = files
  .map((file) => {
    const plan = compileOf(file.text);
    return plan === null ? null : { fileName: file.fileName, text: file.text, plan };
  })
  .filter(
    (entry): entry is { fileName: string; text: string; plan: ReturnType<typeof compileGraph> } =>
      entry !== null,
  );

describe("T1176: one pass over the descriptors, and a join that cannot be forged", () => {
  it("has plans to compare — the derivation is not silently empty", () => {
    expect(plans.length).toBeGreaterThan(20);
    expect(plans.some((entry) => entry.plan.passes.length > 0)).toBe(true);
  });

  it("no separator can appear inside a key, on any shipped example (soundness of the join)", () => {
    const offenders: string[] = [];
    for (const { fileName, plan } of plans) {
      for (const key of [
        ...plan.resources.map(resourceStructureKey),
        ...plan.passes.map(passStructureKey),
      ]) {
        for (const separator of STRUCTURE_KEY_SEPARATORS) {
          if (key.includes(separator)) offenders.push(`${fileName}: ${key.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("distinct plans get distinct signatures across the whole catalogue", () => {
    const bySignature = new Map<string, string[]>();
    for (const { fileName, plan } of plans) {
      const list = bySignature.get(plan.signature);
      if (list === undefined) bySignature.set(plan.signature, [fileName]);
      else list.push(fileName);
    }
    // Two documents MAY legitimately compile to the same plan (two empty ones do), so a
    // collision is only a defect when the key LISTS differ.
    const collisions: string[] = [];
    for (const [, names] of bySignature) {
      if (names.length < 2) continue;
      const keysOf = (name: string): string => {
        const plan = plans.find((entry) => entry.fileName === name)?.plan;
        return JSON.stringify([
          plan?.resources.map(resourceStructureKey),
          plan?.passes.map(passStructureKey),
        ]);
      };
      const first = keysOf(names[0] as string);
      for (const name of names.slice(1)) {
        if (keysOf(name) !== first) collisions.push(`${names[0]} vs ${name}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  for (const { fileName, text, plan } of plans) {
    it(`${fileName}: the plan carries exactly what the key functions produce`, () => {
      const keys = planStructureKeys(plan.resources, plan.passes);

      expect(keys.signature).toBe(planStructureSignature(plan.resources, plan.passes));
      expect(keys.resourceSignatures).toEqual(
        plan.resources
          .map((resource) => ({ id: resource.id, signature: resourceStructureKey(resource) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(keys.passSignatures).toEqual(
        plan.passes
          .map((pass) => ({ id: pass.id, signature: passStructureKey(pass) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );

      // Wired: `compileGraph` publishes that answer, not one of its own.
      expect(plan.signature).toBe(keys.signature);
      expect(plan.resourceSignatures).toEqual(keys.resourceSignatures);
      expect(plan.passSignatures).toEqual(keys.passSignatures);

      // Value-blind and stable: the same document compiled twice is the same signature.
      expect(compileOf(text)?.signature).toBe(plan.signature);
    });
  }
});
