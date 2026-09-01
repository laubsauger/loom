import { describe, expect, it } from "vitest";

import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { allNodeDefinitions, coreNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { minimalGraphFor } from "../../../nodes/definitions/test-support.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T751 — EVERY NODE TYPE REACHES A REAL SHADER COMPILER, by construction.
 *
 * §B146 is the third §B39-shaped instance of the same hole: the mirror node's shader
 * contained `vec2f(bool)` — not a WGSL constructor — and had therefore NEVER compiled
 * on any device since it shipped, while every suite stayed green, because no example
 * carried the node and `examples.gpu.test.ts` compiles every shipped EXAMPLE, not every
 * TYPE. Coverage-by-example is coverage by accident: a type reaches Dawn only if some
 * example happens to want it — and loading examples with that duty would pressure weak
 * examples into existence against §V471.
 *
 * So this sweep does the accidental thing on purpose: the SAME minimal graph the
 * headless catalogue sweep proves compiles (catalogue-chain.test.ts, shared via
 * test-support) is rendered for two real frames on Dawn, per type. A shader that a
 * device's compiler rejects fails HERE, by name, the day it is written — not the day
 * an example first wants the node.
 *
 * Value sources are skipped for catalogue-chain's own reason: no ports, no passes,
 * nothing for a device to compile (§V143). Everything else runs — including the types
 * no example carries, which is the entire point.
 */

const SWEPT = coreNodeDefinitions.filter(
  (definition) => definition.valueChannel === undefined && definition.valueEvaluate === undefined,
);

describe("every catalogue type compiles and steps on Dawn (T751, §B146)", () => {
  it("sweeps a real population", () => {
    // The guard on the guard (§V337): a filter change that quietly emptied this sweep
    // would re-open the hole while staying green.
    expect(SWEPT.length).toBeGreaterThan(60);
    expect(SWEPT.map((definition) => definition.type)).toContain("mirror");
  });

  const registry = createNodeRegistry(allNodeDefinitions).view();

  it.each(SWEPT.map((definition) => [definition.type, definition] as const))(
    "%s",
    async (_type, definition) => {
      const probe = await probeDawn();
      if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: minimalGraphFor(definition, registry) as unknown as GraphDocument,
        frames: 2,
        capture: [1],
        outputNodeId: definition.outputs.length > 0 ? "sink" : "subject",
      });
      expect(
        result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((d) => d.message),
      ).toEqual([]);
    },
    60_000,
  );
});
