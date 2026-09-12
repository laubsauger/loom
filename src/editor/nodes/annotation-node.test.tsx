// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { ANNOTATE_TYPE, DEFAULT_ANNOTATION_COLOR } from "@nodes/definitions/annotate.ts";
import { CanvasFixture } from "@editor/graph-canvas/canvas-fixture.tsx";
import { fixtureContext, installFlowStubs, nodeProps } from "@editor/graph-canvas/testing.tsx";
import { ANNOTATION_NODE_TYPE } from "@editor/graph-canvas/derive.ts";
import { AnnotationNode } from "./annotation-node.tsx";

/**
 * The annotation box's chrome (T1262), mounted against a real store and a real bus so
 * the one edit it can make — retitling in place — leaves through the only mutation path
 * there is (§V29) and lands as the parameter the inspector and the save file read.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const invocation = contextFor(alice);
const registry = createNodeRegistry(allNodeDefinitions).view();

function annotation(parameters: GraphNode["parameters"], extra: Partial<GraphNode> = {}): GraphDocument {
  return {
    revision: 1,
    nodes: {
      note: {
        id: "note",
        type: ANNOTATE_TYPE,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters,
        ...extra,
      },
    },
    edges: {},
    groups: {},
  };
}

function mount(graph: GraphDocument, selected = false) {
  const store = createGraphStore({ ids: createSequentialIdFactory("a"), initialGraph: graph });
  const { bus } = createDomainBus({ store, registry });
  const dispatched: { operations: GraphPatchOperation[]; label: string | undefined }[] = [];
  const { value } = fixtureContext({
    store: bus.store,
    registry: bus.registry,
    dispatch: (operations, label) => {
      dispatched.push({ operations: [...operations], label });
      void bus.execute(
        "graph.applyPatch",
        { baseRevision: bus.store.getRevision(), operations, label },
        invocation,
      );
    },
  });
  const view = render(
    <CanvasFixture value={value}>
      <AnnotationNode {...nodeProps("note", { type: ANNOTATION_NODE_TYPE, selected })} />
    </CanvasFixture>,
  );
  const box = () => view.container.querySelector<HTMLElement>('[data-testid="annotation-note"]');
  const title = () => bus.store.getGraph().nodes["note"]?.parameters["title"];
  return { ...view, bus, dispatched, box, title };
}

describe("the annotation box shows what the document stores", () => {
  it("renders the title and the body, with the body's newlines kept", () => {
    mount(annotation({ title: "Chemistry", body: "Gray-Scott plate\nseeded on onsets", color: "filter" }));
    expect(screen.getByTestId("annotation-title-note").textContent).toBe("Chemistry");
    // The DOM keeps the newline; the stylesheet's `pre-wrap` is what shows it as a break.
    expect(screen.getByTestId("annotation-body-note").textContent).toBe("Gray-Scott plate\nseeded on onsets");
  });

  it("carries the colour NAME on the box, so the stylesheet maps it to the token (§V17)", () => {
    const { box } = mount(annotation({ title: "t", color: "points" }));
    expect(box()?.dataset["color"]).toBe("points");
    // No hue is spelled inline: the token, not a literal, is the colour.
    expect(box()?.getAttribute("style")).toBeNull();
  });

  it("falls back to the default hue for a colour no token knows, and for none at all", () => {
    const { box } = mount(annotation({ title: "t", color: "#ff0000" }));
    expect(box()?.dataset["color"]).toBe(DEFAULT_ANNOTATION_COLOR);
    cleanup();
    const bare = mount(annotation({}));
    expect(bare.box()?.dataset["color"]).toBe(DEFAULT_ANNOTATION_COLOR);
  });

  it("draws no body element for an empty body, so the title alone fills a fresh box", () => {
    const { container } = mount(annotation({ title: "t", body: "" }));
    expect(container.querySelector('[data-testid="annotation-body-note"]')).toBeNull();
  });

  it("marks a box with a stored size as sized (§V116) and an unsized one as not", () => {
    const sized = mount(annotation({ title: "t" }, { size: { width: 400, height: 300 } }));
    expect(sized.box()?.dataset["sized"]).toBe("true");
    cleanup();
    const unsized = mount(annotation({ title: "t" }));
    expect(unsized.box()?.dataset["sized"]).toBe("false");
  });

  it("offers its resize grips only while selected, like a graph node", () => {
    const idle = mount(annotation({ title: "t" }));
    expect(idle.container.querySelector(".react-flow__resize-control")).toBeNull();
    cleanup();
    const chosen = mount(annotation({ title: "t" }), true);
    expect(chosen.container.querySelectorAll(".react-flow__resize-control.handle").length).toBeGreaterThan(0);
  });
});

describe("retitling in place goes through the bus (§V29)", () => {
  it("double-click, type, Enter: ONE setParameters patch, and the store reads the new title", async () => {
    const { bus, dispatched, title } = mount(annotation({ title: "Old" }));
    const revision = bus.store.getRevision();
    fireEvent.doubleClick(screen.getByTestId("annotation-title-note"));
    const input = screen.getByTestId("annotation-title-input-note") as HTMLInputElement;
    expect(input.value).toBe("Old");
    fireEvent.change(input, { target: { value: "  Chemistry " } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(dispatched).toEqual([
      {
        operations: [{ op: "setParameters", nodeId: "note", parameters: { title: "Chemistry" } }],
        label: "Edit annotation title",
      },
    ]);
    expect(storedStaticValue(title())).toBe("Chemistry");
    expect(bus.store.getRevision()).toBe(revision + 1);
    // The field closed and the text is back in place.
    expect(screen.queryByTestId("annotation-title-input-note")).toBeNull();
    expect(screen.getByTestId("annotation-title-note").textContent).toBe("Chemistry");
  });

  it("Escape abandons the draft: nothing dispatched, the revision untouched", async () => {
    const { bus, dispatched, title } = mount(annotation({ title: "Old" }));
    const revision = bus.store.getRevision();
    fireEvent.doubleClick(screen.getByTestId("annotation-title-note"));
    const input = screen.getByTestId("annotation-title-input-note");
    fireEvent.change(input, { target: { value: "Draft" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    // Escape closes the field, which blurs it — and the blur must not commit the draft.
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(dispatched).toEqual([]);
    expect(storedStaticValue(title())).toBe("Old");
    expect(bus.store.getRevision()).toBe(revision);
    expect(screen.getByTestId("annotation-title-note").textContent).toBe("Old");
  });

  it("an unchanged title on blur is no edit — no patch, no undo entry (§V33)", async () => {
    const { bus, dispatched } = mount(annotation({ title: "Same" }));
    const revision = bus.store.getRevision();
    fireEvent.doubleClick(screen.getByTestId("annotation-title-note"));
    await act(async () => {
      fireEvent.blur(screen.getByTestId("annotation-title-input-note"));
    });
    expect(dispatched).toEqual([]);
    expect(bus.store.getRevision()).toBe(revision);
  });

  it("Enter then the blur it causes commit ONCE, not twice", async () => {
    const { dispatched } = mount(annotation({ title: "Old" }));
    fireEvent.doubleClick(screen.getByTestId("annotation-title-note"));
    const input = screen.getByTestId("annotation-title-input-note");
    fireEvent.change(input, { target: { value: "New" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    });
    expect(dispatched).toHaveLength(1);
  });
});
