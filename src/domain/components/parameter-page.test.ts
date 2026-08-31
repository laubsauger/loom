import { describe, expect, it } from "vitest";
import { alice, contextFor } from "../commands/test-support.ts";
import type { PublishedParameter } from "../types/components.ts";
import type { ParameterDefinition } from "../types/parameters.ts";
import { componentNodeDefinition } from "./definition.ts";
import { exposePort, publishParameter, reorderPublishedParameter } from "./published-parameter.ts";
import { openComponentSession } from "./session.ts";
import { bloomComponent, blurKnob, createComponentHarness } from "./test-support.ts";

/**
 * THE PARAMETER PAGE IS AUTHORED, INCLUDING ITS ORDER (T423, §V80).
 *
 * A component's page is its public interface. Three properties have to hold, and until
 * T423 the first two were assumed rather than gated, because nothing could edit a page:
 *
 *  1. re-authoring a knob KEEPS ITS PLACE. `publishParameter` filtered-and-appended, so
 *     renaming the label of the first control dropped it to the bottom — a page that
 *     reshuffles itself every time its author touches it;
 *  2. the same for a boundary PORT, where the consequence is worse: the order of
 *     `inputs`/`outputs` is the order the ports are drawn on every instance, with wires
 *     already attached to them;
 *  3. order is MOVABLE, because it cannot be derived (alphabetical ignores what the
 *     component does; insertion order records only who published first).
 *
 * SENSITIVITY: revert `publishParameter` to filter-then-push and (1) reddens; revert
 * `exposePort`'s `replace` and (2) reddens; delete `reorderPublishedParameter` and (3)
 * cannot compile. Each break moves exactly one of the three.
 */

const gain: PublishedParameter = {
  key: "gain",
  definition: { type: "number", label: "Gain", default: 1, min: 0, max: 4 },
  targets: [{ nodeId: "blurA", key: "radius" }],
};

const mix: PublishedParameter = {
  key: "mix",
  definition: { type: "number", label: "Mix", default: 0.5, min: 0, max: 1 },
  targets: [{ nodeId: "blurB", key: "radius" }],
};

describe("re-authoring keeps a knob where its author put it", () => {
  it("replaces in place rather than moving the edited control to the end", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob, gain, mix]);
    const relabelled = publishParameter(definition, {
      ...blurKnob,
      definition: { ...blurKnob.definition, label: "Bloom size", max: 32 } as ParameterDefinition,
    });

    expect(relabelled.parameters.map((published) => published.key)).toEqual([
      "blur",
      "gain",
      "mix",
    ]);
    expect(relabelled.parameters[0]?.definition.label).toBe("Bloom size");
  });

  it("still appends a genuinely NEW key — there is no other honest place for it", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    expect(publishParameter(definition, gain).parameters.map((p) => p.key)).toEqual([
      "blur",
      "gain",
    ]);
  });

  it("keeps an exposed port's position, because that is where its wire is attached", () => {
    const definition = bloomComponent("bloom", 1);
    const extra = exposePort(definition, "input", {
      externalId: "mask",
      label: "Mask",
      nodeId: "blurB",
      portId: "source",
    });
    const relabelled = exposePort(extra, "input", {
      externalId: "source",
      label: "Image",
      nodeId: "blurA",
      portId: "source",
    });

    expect(relabelled.inputs.map((port) => port.externalId)).toEqual(["source", "mask"]);
    expect(relabelled.inputs[0]?.label).toBe("Image");
  });
});

describe("order is movable, and the manifest follows it", () => {
  it("moves a knob to the position asked for", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob, gain, mix]);
    expect(reorderPublishedParameter(definition, "mix", 0).parameters.map((p) => p.key)).toEqual([
      "mix",
      "blur",
      "gain",
    ]);
    expect(reorderPublishedParameter(definition, "blur", 2).parameters.map((p) => p.key)).toEqual([
      "gain",
      "mix",
      "blur",
    ]);
  });

  it("clamps rather than refusing, so 'move the first one up' is not an error", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob, gain]);
    expect(reorderPublishedParameter(definition, "blur", -1).parameters.map((p) => p.key)).toEqual([
      "blur",
      "gain",
    ]);
    expect(reorderPublishedParameter(definition, "gain", 99).parameters.map((p) => p.key)).toEqual([
      "blur",
      "gain",
    ]);
  });

  it("reaches the INSTANCE: the synthesized manifest lists the page in page order", () => {
    const harness = createComponentHarness("order");
    const definition = bloomComponent("bloom", 1, [blurKnob, gain, mix]);
    harness.components.register(definition);

    const before = componentNodeDefinition(definition, harness.nodes);
    expect(Object.keys(before.parameters)).toEqual(["blur", "gain", "mix"]);

    const moved = reorderPublishedParameter(definition, "mix", 0);
    harness.components.register(moved);
    const after = componentNodeDefinition(moved, harness.nodes);
    // Object key order is the insertion order of a string-keyed record, and it is what
    // the inspector iterates. If this ever stops being true the page order is decorative.
    expect(Object.keys(after.parameters)).toEqual(["mix", "blur", "gain"]);
  });
});

describe("`component.reorderParameter` on a session bus (T423, §V29)", () => {
  const context = contextFor(alice);

  it("moves the knob in the CATALOGUE, so every linked instance follows (§V79)", async () => {
    const harness = createComponentHarness("cmd");
    harness.components.register(bloomComponent("bloom", 1, [blurKnob, gain, mix]));
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });

    const result = await session.bus.execute(
      "component.reorderParameter",
      { key: "mix", toIndex: 0 },
      context,
    );
    expect(result.status).toBe("applied");
    expect(
      harness.components.get("bloom", 1)?.parameters.map((published) => published.key),
    ).toEqual(["mix", "blur", "gain"]);
    session.dispose();
  });

  it("refuses a key the page does not hold, BY NAME (§V288)", async () => {
    const harness = createComponentHarness("cmd2");
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });

    const result = await session.bus.execute(
      "component.reorderParameter",
      { key: "nope", toIndex: 0 },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "component.parameter.unknown",
    );
    session.dispose();
  });

  it("refuses an INCOMPLETE publish rather than throwing (B60's shape, third instance)", async () => {
    const harness = createComponentHarness("cmd4");
    harness.components.register(bloomComponent("bloom", 1, []));
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "bloom",
      version: 1,
    });

    // Exactly what the parameter context menu's "Publish to component" row resolves:
    // `parameterRef` gives a TARGET, not a publish. Before the guard this threw
    // "Cannot read properties of undefined (reading 'map')" on the click.
    const result = await session.bus.execute(
      "component.publishParameter",
      { nodeId: "blurA", parameterKey: "radius" } as never,
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "component.parameter.incomplete",
    );
    expect(harness.components.get("bloom", 1)?.parameters).toEqual([]);
    session.dispose();
  });

  it("refuses outside a component: the root bus has no page to reorder", async () => {
    const harness = createComponentHarness("cmd3");
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const result = await harness.bus.execute(
      "component.reorderParameter",
      { key: "blur", toIndex: 0 },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "component.notInsideComponent",
    );
  });
});
