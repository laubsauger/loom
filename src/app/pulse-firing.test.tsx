// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { componentNodeType } from "@domain/components/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import {
  ANIMATED_COMPONENT_ID,
  PULSE_CROSSES_AT_SECONDS,
  animatedComponentDefinition,
} from "../tests/fixtures/animated-component.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { usePulseFiring } from "./pulse-firing.ts";

/**
 * Expression-fired pulses reach a node INSIDE a component (T615, T214, §V125).
 *
 * `usePulseFiring` had no test at all, which is how it stayed on the raw document: on a
 * root-level graph the raw and flattened documents are the same nodes with the same ids,
 * so nothing could tell. Inside a component the watcher saw no pulse to watch, and
 * TouchDesigner's whole reset idiom stopped working the moment a Feedback was packaged.
 *
 * Both halves are asserted here because the second is the one a text scan cannot reach:
 * the watcher must SEE the pulse (flattening), and `parameter.pulse` must be able to
 * DISPATCH it (the flat id is not a document node, so the bus needs the flattening too).
 * Two instances, so a fire scoped to the wrong one is a failure rather than a coincidence.
 */

afterEach(cleanup);

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 1,
});

describe("usePulseFiring — a pulse inside a component fires, and lands on ITS instance", () => {
  it("fires once per instance, scoped to that instance's own flat node", async () => {
    const runtime = newRuntime();
    runtime.components.register(animatedComponentDefinition());

    // The command the fixture's pulse declares. Registered here rather than mocked, so the
    // whole dispatch path — `parameter.pulse` resolving the node, substituting `$node`,
    // executing the target — is the one the app runs.
    const cleared: string[][] = [];
    runtime.bus.registerCommand({
      name: "runtime.resetFeedback",
      description: "Test double for the feedback reset a pulse fires.",
      handler: (input) => {
        cleared.push([...(input.nodeIds ?? [])]);
        return { status: "applied", output: { cleared: 1 }, diagnostics: [] };
      },
      rejectionOutput: () => ({ cleared: 0 }),
    });

    let one = "";
    let two = "";
    await act(async () => {
      const result = await seed(runtime, [
        {
          op: "addNode",
          ref: "$one",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 0, y: 0 },
          parameters: { rate: 0.5 },
        },
        {
          op: "addNode",
          ref: "$two",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 240, y: 0 },
          parameters: { rate: 2 },
        },
      ]);
      expect(result.status).toBe("applied");
      one = result.output.createdIds["$one"] ?? "";
      two = result.output.createdIds["$two"] ?? "";
    });

    // The bus needs the flattening to resolve a flat id; in the app `useGraphCompile`
    // attaches it. Attached directly here so this file tests the pulse path and not the
    // compile hook.
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current().graph);

    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation));
    await act(async () => {
      for (let frameIndex = 0; frameIndex < 40; frameIndex += 1) {
        result.current.observe(frameAt(frameIndex));
      }
      // The dispatch is a promise; let it settle before asserting.
      await Promise.resolve();
    });

    // TWO fires, each naming its OWN instance. One fire would mean the two instances
    // shared an armed state — the failure a single-instance fixture cannot see (§V461).
    expect(cleared.map((entry) => entry.join(",")).sort()).toEqual([`${one}/fb`, `${two}/fb`]);
    expect(PULSE_CROSSES_AT_SECONDS).toBeGreaterThan(0);
    runtime.dispose();
  });
});
