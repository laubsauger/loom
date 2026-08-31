// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { readParentBindings } from "@domain/components/instance.ts";
import { openComponentSession } from "@domain/components/session.ts";
import type { ComponentSession } from "@domain/components/session.ts";
import {
  blurKnob,
  bloomComponent,
  createComponentHarness,
} from "@domain/components/test-support.ts";
import type { ComponentHarness } from "@domain/components/test-support.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ComponentPage } from "./component-page.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

/**
 * THE PARAMETER PAGE EDITOR, END TO END (T423, §V80, §V81, §V356).
 *
 * Every command exercised here — publish, unpublish, reorder, turn, expose, unexpose,
 * bind to parent — was on the bus and had NO invoker, listed by name in
 * `composition-seams.test.ts`'s `COMMANDS_WITH_NO_INVOKER` with the reason "the component
 * EDITOR does not exist". This file is why those five lines could be deleted, so it has to
 * assert the CONSEQUENCE of each gesture in the catalogue, not that a button rendered.
 *
 * SENSITIVITY: make `reorderPublishedParameter` a no-op and only the order test reddens;
 * make `publishParameter` filter-and-append again and only "re-authoring keeps its place"
 * reddens; drop the `parentBindings` write and only the binding test reddens.
 */

function mountPage(harness: ComponentHarness, session: ComponentSession, selectedNodeId: string | null) {
  const definition = harness.components.get("bloom", 1);
  if (definition === undefined) throw new Error("fixture component is not installed");
  return render(
    <ComponentPage
      bus={session.bus}
      context={context}
      definition={definition}
      components={harness.components}
      nodes={harness.nodes}
      selectedNodeId={selectedNodeId}
    />,
  );
}

function setup(published = [blurKnob]) {
  const harness = createComponentHarness("page");
  harness.components.register(bloomComponent("bloom", 1, published));
  const session = openComponentSession({
    components: harness.components,
    nodes: harness.nodes,
    componentId: "bloom",
    version: 1,
  });
  return { harness, session };
}

const pageKeys = (harness: ComponentHarness): string[] =>
  (harness.components.get("bloom", 1)?.parameters ?? []).map((published) => published.key);

describe("order is authored", () => {
  const gain = {
    key: "gain",
    definition: { type: "number", label: "Gain", default: 1, min: 0, max: 4 },
    targets: [{ nodeId: "blurB", key: "radius" }],
  } as const;

  it("moves a control up and down the page, and the catalogue follows", async () => {
    const { harness, session } = setup([blurKnob, gain]);
    mountPage(harness, session, null);

    expect(pageKeys(harness)).toEqual(["blur", "gain"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Gain earlier" }));
    });
    expect(pageKeys(harness)).toEqual(["gain", "blur"]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Gain later" }));
    });
    expect(pageKeys(harness)).toEqual(["blur", "gain"]);
    session.dispose();
  });

  it("disables the move that would run off the end, rather than refusing on click", () => {
    const { harness, session } = setup([blurKnob, gain]);
    mountPage(harness, session, null);
    expect(screen.getByRole("button", { name: "Move Blur earlier" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Move Gain later" }).hasAttribute("disabled")).toBe(
      true,
    );
    session.dispose();
  });

  it("re-authoring a LABEL keeps the control where its author put it", async () => {
    const { harness, session } = setup([blurKnob, gain]);
    mountPage(harness, session, null);

    const label = screen.getAllByDisplayValue("Blur")[0] as HTMLInputElement;
    await act(async () => {
      fireEvent.change(label, { target: { value: "Bloom size" } });
    });

    expect(pageKeys(harness)).toEqual(["blur", "gain"]);
    expect(harness.components.get("bloom", 1)?.parameters[0]?.definition.label).toBe("Bloom size");
    session.dispose();
  });
});

describe("ranges are re-authored for the component's user, not inherited (§V80)", () => {
  it("writes a narrower max onto the published definition", async () => {
    const { harness, session } = setup();
    mountPage(harness, session, null);

    const max = screen.getByLabelText("Max", { selector: "input" }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(max, { target: { value: "16" } });
    });

    const definition = harness.components.get("bloom", 1)?.parameters[0]?.definition;
    expect(definition?.type === "number" ? definition.max : null).toBe(16);
    session.dispose();
  });

  it("clearing a bound REMOVES it rather than pinning the slider to zero", async () => {
    const { harness, session } = setup();
    mountPage(harness, session, null);

    const min = screen.getByLabelText("Min", { selector: "input" }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(min, { target: { value: "" } });
    });

    const definition = harness.components.get("bloom", 1)?.parameters[0]?.definition;
    expect(definition?.type === "number" ? definition.min : "unset").toBeUndefined();
    session.dispose();
  });
});

describe("publishing and unpublishing from the selected node", () => {
  it("publishes an internal parameter and points it at that node", async () => {
    const { harness, session } = setup([]);
    mountPage(harness, session, "blurA");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Publish Radius to the parameter page" }),
      );
    });

    const published = harness.components.get("bloom", 1)?.parameters ?? [];
    expect(published).toHaveLength(1);
    expect(published[0]?.definition.type).toBe("number");
    expect(published[0]?.targets).toEqual([{ nodeId: "blurA", key: "radius" }]);
    session.dispose();
  });

  it("removes a control from the page", async () => {
    const { harness, session } = setup();
    mountPage(harness, session, null);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unpublish Blur" }));
    });
    expect(pageKeys(harness)).toEqual([]);
    session.dispose();
  });
});

describe("turning a published knob writes every target in ONE patch (§V80, §V34)", () => {
  it("drives all three internal radii from the page's own control", async () => {
    const { harness, session } = setup();
    mountPage(harness, session, null);

    const before = session.store.view.getRevision();
    const control = screen.getByLabelText("Blur", { selector: "input" }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(control, { target: { value: "12" } });
      fireEvent.blur(control);
    });

    const graph = session.store.view.getGraph();
    const written = graph.nodes["blurA"]?.parameters.radius;
    // Not a literal: the control is a slider and the exact landing value is its business.
    // What has to hold is that it MOVED off the fixture's 4 and that all three targets got
    // the SAME value — a partial fan-out or a no-op both fail this, which is the point.
    expect(written).not.toBe(4);
    expect(typeof written).toBe("number");
    for (const nodeId of ["blurB", "blurC"]) {
      expect(graph.nodes[nodeId]?.parameters.radius, nodeId).toBe(written);
    }
    // ONE revision step for three writes: the fan-out is a single patch, so one undo puts
    // the component back where it was rather than half-way (§V32, §V34).
    expect(graph.revision).toBe(before + 1);
    session.dispose();
  });
});

describe("the component boundary is authored from the same page (T131)", () => {
  it("exposes a selected node's port and takes it off again", async () => {
    const { harness, session } = setup();
    mountPage(harness, session, "blurB");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Expose Source on the component boundary" }),
      );
    });
    const exposed = harness.components.get("bloom", 1)?.inputs ?? [];
    expect(exposed.some((port) => port.nodeId === "blurB" && port.portId === "source")).toBe(true);

    await act(async () => {
      // The fixture already exposes `source` from blurA; exposing blurB's re-authors the
      // SAME external id, so there is exactly one row to remove.
      fireEvent.click(screen.getByRole("button", { name: "Unexpose Source" }));
    });
    expect(harness.components.get("bloom", 1)?.inputs).toEqual([]);
    session.dispose();
  });
});

describe("parent bindings are authored, not only resolvable (§V81)", () => {
  it("binds an internal parameter to a published key and writes it into node state", async () => {
    const { harness, session } = setup();
    mountPage(harness, session, "blurB");

    const select = screen.getByLabelText("Bind Radius to a parent parameter") as HTMLSelectElement;
    // The options are the component's OWN published page — the only keys `parent.<key>`
    // can name from one level in.
    expect([...select.options].map((option) => option.value)).toEqual(["", "parent.blur"]);

    await act(async () => {
      fireEvent.change(select, { target: { value: "parent.blur" } });
    });

    expect(readParentBindings(session.store.view.getGraph().nodes["blurB"] as never)).toEqual({
      radius: "parent.blur",
    });

    await act(async () => {
      fireEvent.change(select, { target: { value: "" } });
    });
    expect(readParentBindings(session.store.view.getGraph().nodes["blurB"] as never)).toEqual({});
    session.dispose();
  });
});
