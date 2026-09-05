// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { openComponentSession } from "@domain/components/session.ts";
import type { ComponentSession } from "@domain/components/session.ts";
import {
  blurKnob,
  bloomComponent,
  createComponentHarness,
} from "@domain/components/test-support.ts";
import type { ComponentHarness } from "@domain/components/test-support.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { Inspector } from "@editor/inspector/index.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ComponentPage } from "./component-page.tsx";
import { InspectorSubjects } from "./inspector-subjects.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

/**
 * THE INSPECTOR INSIDE A COMPONENT HAS TWO SUBJECTS AND SHOWS ONE (T1192).
 *
 * What shipped: the component's parameter page and the selected node's inspector stacked
 * in one scroll box. Measured in the running app on E47's `DepthPoints_1` — nine
 * published parameters, the default docked inspector — **2092px of component page above
 * the selected node's first parameter in a 366px viewport**: 5.7 screens of scrolling to
 * reach the node you had just clicked. The owner: *"it's bulky, very confusing and super
 * shitty UX to have to scroll."*
 *
 * Half of that claim is easy and worthless on its own — "the published page is not
 * rendered while a node is selected" is satisfied by deleting the page. So every test
 * below asserts BOTH halves of the trade: the other subject is one click away, and when
 * you get there it states the truth about the graph.
 *
 * SENSITIVITY, red-verified by editing each of the three back:
 *
 *  - render the component page outside its `TabsContent` and "shows the node you clicked",
 *    "puts the published page back one click away" and "follows the selection in" redden;
 *  - put `defaultParameterValue` back into the published control and both value tests
 *    redden with the definition's 4 against the graph's 21 and 17;
 *  - mount the switch in `side-panes.tsx` under any other name and "the product mounts it"
 *    reddens, which is the check `composition-seams.test.ts` cannot make for a component.
 *
 * ⚠ ONE CLAIM THIS FILE CANNOT MAKE, stated rather than implied: that `node` is resolved
 * against the COMPONENT's graph rather than merely non-null. `mountPane` does that
 * resolution because the pane does; put a bare `nodeId !== null` in `side-panes.tsx` and
 * everything here still passes while diving in opens an empty node panel, because the
 * app's selection is still the instance one level out. What holds it today is that the
 * NAME has nowhere else to come from — the pane must look the node up to fill it in — and
 * the docblock on the prop says so. It is not a gate, and a gate for it would have to
 * mount the pane inside a real dive.
 */

async function setup(radius = 4) {
  const harness = createComponentHarness("subjects");
  harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
  const session = openComponentSession({
    components: harness.components,
    nodes: harness.nodes,
    componentId: "bloom",
    version: 1,
  });
  if (radius !== 4) {
    // Straight at ONE internal node, through the ordinary patch path — nothing here goes
    // near the published layer, so a knob that reads it back can only have read the graph.
    const applied = await session.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: session.store.view.getRevision(),
        label: "seed",
        operations: [
          { op: "setParameters", nodeId: "blurA" as NodeId, parameters: { radius } },
        ],
      },
      context,
    );
    expect(applied.status, applied.diagnostics.map((entry) => entry.message).join("; ")).toBe(
      "applied",
    );
  }
  return { harness, session };
}

/** The composition `side-panes.tsx` mounts, minus the pane chrome. */
function mountPane(
  harness: ComponentHarness,
  session: ComponentSession,
  selectedNodeId: NodeId | null,
) {
  const definition = harness.components.get("bloom", 1);
  if (definition === undefined) throw new Error("fixture component is not installed");
  const graph = session.store.view.getGraph();
  const node = selectedNodeId === null ? undefined : graph.nodes[selectedNodeId];
  return (
    <InspectorSubjects
      component={{ name: definition.name }}
      node={node === undefined ? null : { id: node.id, name: node.label ?? node.id }}
      componentPage={
        <ComponentPage
          bus={session.bus}
          context={context}
          definition={definition}
          components={harness.components}
          nodes={harness.nodes}
          selectedNodeId={selectedNodeId}
        />
      }
      nodeInspector={
        <Inspector
          bus={session.bus}
          context={context}
          nodeId={selectedNodeId}
          settings={{ outputResolution: { width: 1280, height: 720 }, workingFormat: "rgba16float" }}
        />
      }
    />
  );
}

const componentPage = () => screen.queryByTestId("component-page");
const nodePanel = (nodeId: string) => document.querySelector(`[data-node-id="${nodeId}"]`);

describe("one subject at a time, and the other one click away", () => {
  it("opens on the component when nothing inside is selected", async () => {
    const { harness, session } = await setup();
    await act(async () => {
      render(mountPane(harness, session, null));
    });

    expect(componentPage()).not.toBeNull();
    expect(nodePanel("blurA")).toBeNull();
    // The node segment names the state rather than offering an empty panel (§V91).
    const nodeTab = screen.getByRole("tab", { name: /No node selected/ });
    expect(nodeTab.hasAttribute("disabled")).toBe(true);
    session.dispose();
  });

  it("shows the node you clicked, with nothing stacked above it", async () => {
    const { harness, session } = await setup();
    await act(async () => {
      render(mountPane(harness, session, "blurA" as NodeId));
    });

    // The whole complaint: the node's own panel, and no parameter page above it.
    expect(nodePanel("blurA")).not.toBeNull();
    expect(componentPage()).toBeNull();
    session.dispose();
  });

  it("puts the published page back one click away, showing what the targets HOLD", async () => {
    // 21 is nowhere in the fixture's published definition (default 4): a knob still
    // rendering its authored default cannot show it.
    const { harness, session } = await setup(21);
    await act(async () => {
      render(mountPane(harness, session, "blurA" as NodeId));
    });
    expect(componentPage()).toBeNull();

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Bloom/ }), { button: 0 });
    });

    expect(componentPage()).not.toBeNull();
    expect(nodePanel("blurA")).toBeNull();
    const knob = screen.getByLabelText("Blur", { selector: "input" }) as HTMLInputElement;
    expect(Number(knob.value)).toBe(21);
    session.dispose();
  });

  it("turning the published knob leaves it reading the value it just wrote", async () => {
    const { harness, session } = await setup();
    await act(async () => {
      render(mountPane(harness, session, null));
    });

    const knob = screen.getByLabelText("Blur", { selector: "input" }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(knob, { target: { value: "17" } });
      fireEvent.blur(knob);
    });

    // The write landed on every target (§V80) AND the control reports it. Before T1192
    // the field snapped back to the definition's 4 while the graph held 17 — B8's shape
    // with both sides inside one file.
    const graph = session.store.view.getGraph();
    expect(graph.nodes["blurA"]?.parameters.radius).toBe(17);
    expect(Number((screen.getByLabelText("Blur", { selector: "input" }) as HTMLInputElement).value)).toBe(
      17,
    );
    session.dispose();
  });
});

describe("selection is the gesture, the trail is the override", () => {
  it("follows the selection in, and back to the component when it clears", async () => {
    const { harness, session } = await setup();
    const view = render(mountPane(harness, session, null));
    expect(componentPage()).not.toBeNull();

    await act(async () => {
      view.rerender(mountPane(harness, session, "blurB" as NodeId));
    });
    expect(nodePanel("blurB")).not.toBeNull();
    expect(componentPage()).toBeNull();

    // Clicking empty canvas is how you ask "what am I standing inside?".
    await act(async () => {
      view.rerender(mountPane(harness, session, null));
    });
    expect(componentPage()).not.toBeNull();
    session.dispose();
  });

  it("moves to the newly selected node even while the component page is showing", async () => {
    const { harness, session } = await setup();
    const view = render(mountPane(harness, session, "blurA" as NodeId));
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Bloom/ }), { button: 0 });
    });
    expect(componentPage()).not.toBeNull();

    await act(async () => {
      view.rerender(mountPane(harness, session, "blurC" as NodeId));
    });
    expect(nodePanel("blurC")).not.toBeNull();
    session.dispose();
  });
});

/**
 * §V844 / "built, tested, never wired" — this project's dominant bug class, and the one
 * `composition-seams.test.ts` cannot see here because a React component is not a `create*`
 * factory. The same source assertion `expression-references.test.tsx` uses for the
 * inspector's own mount.
 */
describe("the product mounts it", () => {
  it("composes the two subjects in the inspector pane rather than stacking them", () => {
    const source = readFileSync("src/app/side-panes.tsx", "utf8");
    expect(source).toContain("<InspectorSubjects");
    // The stack is gone, not merely wrapped: `ComponentPage` reaches the pane only as the
    // subject switch's own panel.
    const pane = source.slice(source.indexOf("export function InspectorPane"));
    expect(pane.indexOf("<InspectorSubjects")).toBeLessThan(pane.indexOf("<ComponentPage"));
  });
});
