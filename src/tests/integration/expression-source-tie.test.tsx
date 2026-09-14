// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor, patch } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { GraphCanvas } from "@editor/graph-canvas/graph-canvas.tsx";
import { createNodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { Inspector } from "@editor/inspector/inspector.tsx";
import type { InspectorProjectSettings } from "@editor/inspector/inspector.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";

/**
 * T1336b — AN EXPRESSION'S SOURCE IS NAMED ON THE ROW, IN THE HUE OF THE LINE IT DRAWS.
 *
 * The owner, on Render Instances: *"i cant see where the lfo reference is actually wired
 * to. we must have forgotten the ui param but actually have the plumbing in place since
 * the example works and we see the dashed [edge]."*
 *
 * ⚑ THE DOCUMENT THEY WERE LOOKING AT — E10 Instanced Torus — HAS NO CAMERA REFERENCE AT
 * ALL. Its only reference is `renderInstances.rotate.y`, an expression slot holding
 * `op('lfo1').chan.value`. §T987 made a NAME-reference parameter read as a reference, and
 * that was correct work, but it answers a different question: the line the owner cannot
 * trace is the EXPRESSION, and at rest that row showed an amber `expr` badge and a
 * one-letter `E` mark on the Y axis while NEVER NAMING `lfo1`. The source sat behind the
 * mode-panel disclosure, so the canvas drew a dashed line to a node the inspector would
 * not name without a click.
 *
 * ## Why this is one file with both surfaces in it
 *
 * The same reason `reference-parameter-tie.test.tsx` gives: the claim is a RELATION. "The
 * panel says lfo1" and "the canvas draws a line to lfo1" are two facts that stay true
 * independently while one of them is re-hued; what must hold is that the two READ THE SAME
 * VALUE, which cannot be stated from one side. The expected colour is therefore never
 * spelled as a literal here — pinning both sides to `var(--text-dim)` would go green on a
 * panel rendering the wrong relationship in the right colour.
 *
 * ⚑ §V974 — THE DEFECT'S OWN SIGNATURE IS "THE INSPECTOR NEVER NAMES `lfo1`". A claim that
 * merely asserted an expression caption exists would have passed against the bug: the `expr`
 * badge and the `E` mark were both there, the whole time, saying nothing about WHO.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const invocation = contextFor(alice);

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
  limits: { maxResolution: 4096 },
};

interface Scene {
  bus: LoomBus;
  /** The node whose parameter reads another node. */
  consumer: NodeId;
  /** The node it reads, and the name the expression addresses it by. */
  source: NodeId;
  sourceName: string;
}

/**
 * E10's shape, built through the real registry and the real bus: an LFO, a Render
 * Instances far enough away that the line between them has extent, and one slot on the
 * consumer whose binding names the LFO. `slotFor` is handed the generated label because
 * `op()` takes the LABEL (§B170) and the store mints it.
 */
async function buildScene(
  parameterKey: string,
  slotFor: (sourceName: string) => StoredParameter,
): Promise<Scene> {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  const { bus } = createDomainBus({
    store,
    registry: createNodeRegistry(allNodeDefinitions).view(),
  });
  const seeded = await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [
      { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$draw", type: "renderInstances", position: { x: 700, y: 420 } },
    ]),
    invocation,
  );
  const source = seeded.output.createdIds["$lfo"] as NodeId;
  const consumer = seeded.output.createdIds["$draw"] as NodeId;
  const sourceName = bus.store.getGraph().nodes[source]?.label ?? "";
  expect(sourceName).not.toBe("");
  await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [
      { op: "setParameters", nodeId: consumer, parameters: { [parameterKey]: slotFor(sourceName) } },
    ]),
    invocation,
  );
  return { bus, consumer, source, sourceName };
}

/** E10's own slot, verbatim in shape. */
const expressionSlot =
  (retained: number) =>
  (sourceName: string): StoredParameter => ({
    mode: "expression",
    bindings: {
      static: { kind: "static", value: retained },
      expression: { kind: "expression", source: `op('${sourceName}').chan.value` },
    },
  });

/** The other binding that names a node: a channel address (§V143). */
const drivenSlot =
  (retained: number) =>
  (sourceName: string): StoredParameter => ({
    mode: "driven",
    bindings: {
      static: { kind: "static", value: retained },
      driven: { kind: "driven", channel: sourceName },
    },
  });

/** Both surfaces over one document: the canvas that draws the line, the panel that causes it. */
function mountBoth(scene: Scene) {
  const runtime = createNodeRuntimeStore({ intervalMs: 0 });
  return render(
    <>
      <GraphCanvas bus={scene.bus} invocation={invocation} runtime={runtime} />
      <Inspector bus={scene.bus} context={invocation} nodeId={scene.consumer} settings={settings} />
    </>,
  );
}

/** The colour the canvas actually strokes the relationship's dashed line with. */
async function lineColor(container: HTMLElement, scene: Scene): Promise<string> {
  const line = await waitFor(() => {
    const found = container.querySelector(
      `[data-testid="reference-line-${scene.source}-${scene.consumer}"] line`,
    );
    if (found === null) throw new Error("the canvas drew no reference line");
    return found;
  });
  return line.getAttribute("stroke") ?? "";
}

/** The mark the inspector names that same source with, on the parameter row. */
function sourceMark(container: HTMLElement, scene: Scene): HTMLElement {
  const mark = container.querySelector<HTMLElement>(
    `[data-parameter-source="${scene.sourceName}"]`,
  );
  if (mark === null) {
    throw new Error(`the inspector never named ${scene.sourceName} on the parameter row`);
  }
  return mark;
}

describe("T1336b — an expression names the node it reads, where the dashed line lands", () => {
  it("names the LFO on the Rotate row, at rest, with the mode panel still shut", async () => {
    const scene = await buildScene("rotate.y", expressionSlot(0));
    const { container } = mountBoth(scene);

    // AT REST is half the claim: the disclosure that hides the expression text is closed,
    // and the source is named anyway. Nothing here clicks, types or expands.
    expect(screen.getByRole("button", { name: "Rotate" }).getAttribute("aria-expanded")).toBe(
      "false",
    );

    const mark = sourceMark(container, scene);
    // The defect, stated positively (§V997): the row NAMES `lfo1` and says what it IS.
    // "No unnamed source appears" would have been satisfied by the `expr` badge alone.
    expect(within(mark).getByText(scene.sourceName)).toBeTruthy();
    expect(within(mark).getByText("lfo")).toBeTruthy();
    // …and WHICH channel of the compound reads it, because `rotate` has three and only
    // one of them is wired (§V113).
    expect(mark.getAttribute("data-parameter-channel")).toBe("y");
  });

  it("marks it in the SAME colour as the dashed line that expression causes", async () => {
    const scene = await buildScene("rotate.y", expressionSlot(0));
    const { container } = mountBoth(scene);

    const drawn = await lineColor(container, scene);
    const shown = sourceMark(container, scene).style.getPropertyValue("--reference-hue").trim();

    // STRUCTURAL FIRST (§V1009): both sides must actually carry a colour, or "they match"
    // is two empty strings agreeing. A token reference, never a literal (§V17).
    expect(drawn).toMatch(/^var\(--[a-z0-9-]+\)$/);
    expect(shown).toMatch(/^var\(--[a-z0-9-]+\)$/);
    // THE TIE — the thing the owner went looking for and could not find.
    expect(shown).toBe(drawn);
  });

  it("a CHANNEL binding is a different relationship, and both surfaces move together", async () => {
    // The guard against a tie that is only a coincidence: a panel hard-coding one hue
    // would match the expression line and miss here; a panel reading a private copy of
    // the table would differ from the line it is supposed to echo.
    const expression = await buildScene("rotate.y", expressionSlot(0));
    const { container: expressionDom } = mountBoth(expression);
    const expressionHue = sourceMark(expressionDom, expression)
      .style.getPropertyValue("--reference-hue")
      .trim();
    cleanup();

    const channel = await buildScene("rotate.y", drivenSlot(0));
    const { container } = mountBoth(channel);
    const shown = sourceMark(container, channel).style.getPropertyValue("--reference-hue").trim();

    expect(shown).toBe(await lineColor(container, channel));
    expect(shown).not.toBe(expressionHue);
  });

  it("names the source on a whole-parameter expression too, with no channel to name", async () => {
    // `rotate.y` is a COMPONENT key and `scale` is a bare one; the grouping that puts a
    // component's source on its parent's row must not swallow the ordinary case.
    const scene = await buildScene("scale", expressionSlot(0.05));
    const { container } = mountBoth(scene);

    const mark = sourceMark(container, scene);
    expect(within(mark).getByText(scene.sourceName)).toBeTruthy();
    expect(mark.getAttribute("data-parameter-channel")).toBeNull();
    expect(mark.closest("[data-parameter-sources]")?.getAttribute("data-parameter-sources")).toBe(
      "Scale",
    );
  });
});
