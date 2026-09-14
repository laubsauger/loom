// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor, patch } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { GraphCanvas } from "@editor/graph-canvas/graph-canvas.tsx";
import { createNodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { Inspector } from "@editor/inspector/inspector.tsx";
import type { InspectorProjectSettings } from "@editor/inspector/inspector.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";

/**
 * T987 — THE REFERENCE PARAMETER AND THE DASHED EDGE IT CAUSES ARE ONE THING ON SCREEN.
 *
 * The owner, on Render Instances: *"i cant see where the lfo reference is actually wired
 * to. we must have forgotten the ui param but actually have the plumbing in place since
 * the example works and we see the dashed reference line."* The parameter was there. It
 * was a `type: "string"` field, and a string field looks like text: no picker, nothing
 * naming what the name resolved to, and — the part this file exists for — NO SHARED
 * COLOUR WITH THE LINE IT CAUSES. Two surfaces describing one relationship and agreeing
 * about nothing a user can see.
 *
 * ## Why both surfaces are mounted in one test
 *
 * The claim is a RELATION between them, and a relation cannot be asserted from one side.
 * "The inspector shows violet" and "the canvas draws violet" are two facts that stay true
 * independently while somebody re-hues one of them; what must be true is that the two
 * READ THE SAME VALUE, and the only way to state that is to have both in the DOM and
 * compare. That is also why the expected colour is not spelled out here as a literal: a
 * gate that pins both sides to `var(--port-vector)` would go green on a document that
 * renders the wrong relationship in the right colour.
 *
 * ⚑ A CLAIM THAT MERELY ASSERTED "THE CAMERA PARAMETER EXISTS" WOULD HAVE PASSED AGAINST
 * THE BUG — it did exist, and rendered, the whole time.
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
  /** The node whose parameter names another node. */
  consumer: NodeId;
  /** The node it names, and the name it is named by. */
  target: NodeId;
  targetName: string;
}

/**
 * A camera and a Render Instances far enough apart that the line between them has extent,
 * built through the real registry and the real bus — never a fixture graph.
 */
async function buildScene(
  consumerType: string,
  targetType: string,
  parameterKey: string,
  extraNodes: readonly string[] = [],
): Promise<Scene> {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  const { bus } = createDomainBus({
    store,
    registry: createNodeRegistry(allNodeDefinitions).view(),
  });
  const seeded = await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [
      { op: "addNode", ref: "$target", type: targetType, position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$consumer", type: consumerType, position: { x: 700, y: 420 } },
      ...extraNodes.map((type, index) => ({
        op: "addNode" as const,
        ref: `$extra${index}`,
        type,
        position: { x: 0, y: 300 + index * 300 },
      })),
    ]),
    invocation,
  );
  const consumer = seeded.output.createdIds["$consumer"] as NodeId;
  const target = seeded.output.createdIds["$target"] as NodeId;
  const targetName = bus.store.getGraph().nodes[target]?.label ?? "";
  expect(targetName).not.toBe("");
  await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [
      { op: "setParameters", nodeId: consumer, parameters: { [parameterKey]: targetName } },
    ]),
    invocation,
  );
  return { bus, consumer, target, targetName };
}

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
      `[data-testid="reference-line-${scene.target}-${scene.consumer}"] line`,
    );
    if (found === null) throw new Error("the canvas drew no reference line");
    return found;
  });
  return line.getAttribute("stroke") ?? "";
}

/** The colour the inspector's reference control marks the same relationship with. */
function controlColor(container: HTMLElement, noun: string): string {
  const control = container.querySelector<HTMLElement>(`[data-reference-noun="${noun}"]`);
  if (control === null) throw new Error(`the inspector rendered no reference control for ${noun}`);
  return control.style.getPropertyValue("--reference-hue").trim();
}

describe("T987 — a name reference reads as a reference, and reads as the line it draws", () => {
  it("the camera parameter is a PICKER over the cameras in the document, not a text box", async () => {
    const scene = await buildScene("renderInstances", "camera", "camera");
    mountBoth(scene);

    // The defect, stated positively (§V997): the control over this field is a SELECT whose
    // value is the referenced node. Asserting "it is not a text box" would have been
    // satisfied by a disabled div, a readonly input, or nothing at all.
    const picker = screen.getByLabelText("Camera");
    expect(picker.tagName).toBe("SELECT");
    expect((picker as HTMLSelectElement).value).toBe(scene.targetName);
    // …and it OFFERS the camera by name and by what it is, which is the fact a bare name
    // in a text box never carried.
    expect(
      [...(picker as HTMLSelectElement).options].map((option) => option.textContent),
    ).toContain(`${scene.targetName} — camera`);
  });

  it("the control's mark is the SAME colour as the dashed line that parameter causes", async () => {
    const scene = await buildScene("renderInstances", "camera", "camera");
    const { container } = mountBoth(scene);

    const drawn = await lineColor(container, scene);
    const shown = controlColor(container, "camera");

    // STRUCTURAL FIRST (§V1009): both sides must actually have a colour, or "they match"
    // is two empty strings agreeing. A token reference, never a literal (§V17).
    expect(drawn).toMatch(/^var\(--[a-z0-9-]+\)$/);
    expect(shown).toMatch(/^var\(--[a-z0-9-]+\)$/);
    // THE TIE. This is what the owner went looking for and could not find.
    expect(shown).toBe(drawn);
  });

  it("a different relationship is a different colour on BOTH surfaces, still agreeing", async () => {
    // The guard against a tie that is only a coincidence: if the panel hard-coded one hue
    // it would match the camera line and miss here, and if it read the wrong table it
    // would differ from the line. Render's `scenes` is a LIST and a different kind.
    const scene = await buildScene("render", "geometry", "scenes");
    const { container } = mountBoth(scene);

    const drawn = await lineColor(container, scene);
    const shown = controlColor(container, "scene");
    expect(shown).toBe(drawn);
    // A camera and a scene are different relationships; they must not read the same.
    expect(shown).not.toBe(controlColor(container, "camera"));
  });

  it("a list names every reference it holds, each removable, and the picker ADDS", async () => {
    const scene = await buildScene("render", "geometry", "scenes", ["geometry"]);
    const { container } = mountBoth(scene);

    const chip = container.querySelector<HTMLElement>(
      `[data-reference-target="${scene.targetName}"]`,
    );
    expect(chip).not.toBeNull();
    // The chip RESOLVES the name: what it is called, and what it is.
    expect(within(chip as HTMLElement).getByText("geometry")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Remove ${scene.targetName} from Scenes` }),
    ).toBeTruthy();

    // The list's picker is an ADD, and it does not offer what is already named.
    const add = screen.getByLabelText("Add to Scenes") as HTMLSelectElement;
    const offered = [...add.options].map((option) => option.value);
    expect(offered).not.toContain(scene.targetName);
    expect(offered.filter((value) => value !== "")).toHaveLength(1);
  });

  it("a name nothing is called SAYS SO, rather than looking like a working reference", async () => {
    const scene = await buildScene("renderInstances", "camera", "camera");
    await act(async () => {
      await scene.bus.execute(
        "graph.applyPatch",
        patch(scene.bus.store.getRevision(), [
          { op: "setParameters", nodeId: scene.consumer, parameters: { camera: "ghost" } },
        ]),
        invocation,
      );
    });
    mountBoth(scene);

    // §V369's refusal, at the control: the document holds `ghost`, the panel keeps showing
    // it (never snapping the document to something else), and says what is wrong with it.
    const picker = screen.getByLabelText("Camera");
    expect(picker.tagName).toBe("SELECT");
    expect((picker as HTMLSelectElement).value).toBe("ghost");
    expect((picker as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "ghost — no such node",
    );
  });
});
