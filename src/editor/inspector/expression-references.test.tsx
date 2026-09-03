// @vitest-environment jsdom
import { StrictMode } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * T990 — `op('…')` COMPLETION, MOUNTED ON THE REAL PANE.
 *
 * The owner: "we could really use autocomplete within the `op('')` construct. We know all
 * the node names. And then the sub-properties should also be autosuggested and completable
 * so we don't have to guess all the time."
 *
 * ## Why this file is here and not in the control kit
 *
 * The feature was BUILT and DEAD. `expression-completion.ts` handled `op('` explicitly and
 * `ParameterModePanel` took the node names as an OPTIONAL prop that no product call site
 * supplied — so the menu was fed `[]` and offered nothing, for its whole life, while
 * `expression-completion.dom.test.tsx` stayed green by passing the prop itself. That is
 * §V844 exactly: a test that supplies its own dependency cannot detect that the product
 * supplies none, and such a suite is green BECAUSE the seam is dead.
 *
 * So every assertion below is made through the real `Inspector`, which builds the
 * reference catalogue itself from the document it is already holding. Delete
 * `references={references}` at the `ParameterControl` call site and this file goes red;
 * the kit's own tests would not notice.
 *
 * §B170 is asserted rather than assumed: `op()` takes the LABEL. Two examples shipped dead
 * because something matched on the id, so the offered text is compared against the
 * document's label AND the id is asserted absent from the menu.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

/**
 * Two readable parameters and two unreadable ones, deliberately.
 *
 * §V150's rule is that a menu offering what the grammar rejects teaches a wrong API with
 * the tool's own authority — and `asNumber` refuses a string BY NAME, so a `title` in this
 * menu would be a suggestion whose only possible outcome is the error underneath it.
 */
const gainer: NodeDefinition = {
  type: "test.gainer",
  version: 1,
  title: "Gainer",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    gain: { type: "number", label: "Gain", default: 1, min: 0, max: 4 },
    tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" },
    caption: { type: "string", label: "Caption", default: "" },
    blend: {
      type: "enum",
      label: "Blend",
      default: "over",
      options: [
        { value: "over", label: "Over" },
        { value: "add", label: "Add" },
      ],
    },
  },
  compile: () => ({ passes: [] }),
};

/**
 * A SECOND TYPE, so the two auto-assigned labels do not share a prefix (§V129 numbers
 * within a type: two Gainers are `gainer1`/`gainer2`, and a menu narrowed by "gainer"
 * would still show both — which would make the narrowing assertion below prove nothing).
 */
const wobbler: NodeDefinition = { ...gainer, type: "test.wobbler", title: "Wobbler" };

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
};

const context = contextFor(alice);

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 32));
  });
}

/** Two nodes, so "the other node's name" is a real thing to complete to. */
async function setup(channelNames?: (nodeName: string) => readonly string[]) {
  // Ids that look NOTHING like the auto-assigned labels, so §B170's label-versus-id
  // question has a visible answer instead of two strings that happen to match.
  const store = createGraphStore({ ids: createSequentialIdFactory("addr") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([gainer, wobbler]).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$a", type: gainer.type, position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: wobbler.type, position: { x: 200, y: 0 } },
      ],
    },
    context,
  );
  const selected = created.output.createdIds["$a"] as NodeId;
  const other = created.output.createdIds["$b"] as NodeId;

  render(
    <StrictMode>
      <Inspector
        bus={bus}
        context={context}
        nodeId={selected}
        settings={settings}
        {...(channelNames === undefined ? {} : { channelNames })}
      />
    </StrictMode>,
  );

  /**
   * Opens the mode panel the way a user does — clicking the parameter NAME — and puts Gain
   * in Expression mode. Idempotent, so a test may ask the menu more than one question
   * without the second call re-collapsing the panel it needs.
   */
  async function openExpression(): Promise<HTMLElement> {
    const collapsed = screen.queryByRole("button", { name: "Gain", expanded: false });
    if (collapsed !== null) {
      fireEvent.click(collapsed);
      await settle();
    }
    const group = screen.getByRole("group", { name: "Gain mode" });
    const expression = [...group.querySelectorAll("button")].find((button) =>
      (button.getAttribute("aria-label") ?? "").startsWith("Expression"),
    );
    expect(expression, "the Expression mode button").toBeDefined();
    if (expression?.getAttribute("aria-pressed") !== "true") {
      fireEvent.click(expression as HTMLButtonElement);
      await settle();
    }
    return screen.getByLabelText("Gain expression");
  }

  /**
   * Types `source` into the expression field and reads back what the MENU offers.
   *
   * Scoped to the completion listbox rather than to the pane: an `<option>` element
   * carries the implicit role "option" too, so a document-wide query also collects the
   * rows of every enum select on the panel and the assertion would drift with the test
   * node's own parameter list.
   */
  async function offeredFor(source: string): Promise<string[]> {
    const field = await openExpression();
    fireEvent.change(field, { target: { value: source } });
    await settle();
    const menu = screen.queryByRole("listbox", { name: "Expression completions" });
    if (menu === null) return [];
    return within(menu)
      .getAllByRole("option")
      .map((option) => option.querySelector("span")?.textContent ?? "");
  }

  return {
    bus,
    labels: {
      selected: bus.store.getGraph().nodes[selected]?.label ?? "",
      other: bus.store.getGraph().nodes[other]?.label ?? "",
    },
    ids: { selected, other },
    offeredFor,
  };
}

describe("T990 — the pane supplies the node names it has always had (§V272)", () => {
  it("offers every node in the document inside op('…')", async () => {
    const harness = await setup();
    const offered = await harness.offeredFor("op('");
    expect(offered).toEqual([harness.labels.selected, harness.labels.other].sort());
  });

  it("offers the LABEL and never the id (§B170)", async () => {
    const harness = await setup();
    const offered = await harness.offeredFor("op('");
    // Both facts, because either alone is satisfiable by an accident: the label is
    // present, and the id — a string that also uniquely names the node and that two
    // examples once shipped dead by matching on — is not.
    expect(offered).toContain(harness.labels.other);
    expect(offered).not.toContain(String(harness.ids.other));
    expect(harness.labels.other).not.toBe(String(harness.ids.other));
  });

  it("narrows as the name is typed, exactly as the variable menu does", async () => {
    const harness = await setup();
    expect(harness.labels.other).toBe("wobbler1");
    const offered = await harness.offeredFor("op('w");
    expect(offered).toEqual(["wobbler1"]);
  });
});

describe("T990 — the sub-properties, which is the half that did not exist", () => {
  it("offers the two namespaces after the closing paren", async () => {
    const harness = await setup();
    expect(await harness.offeredFor(`op('${harness.labels.other}').`)).toEqual(["chan", "par"]);
  });

  it("offers the target's READABLE parameters under .par, and no others (§V150)", async () => {
    const harness = await setup();
    const offered = await harness.offeredFor(`op('${harness.labels.other}').par.`);
    // `gain` is a number and `tint` is a compound with numeric components. `caption` is a
    // string and `blend` an enum: an expression reads a number, so the reader refuses both
    // BY NAME and offering them would teach an API that does not exist.
    expect(offered).toEqual(["gain", "tint"]);
  });

  it("narrows a parameter key as it is typed", async () => {
    const harness = await setup();
    expect(await harness.offeredFor(`op('${harness.labels.other}').par.ti`)).toEqual(["tint"]);
  });

  it("offers a compound's COMPONENTS one level deeper (§V113)", async () => {
    const harness = await setup();
    const offered = await harness.offeredFor(`op('${harness.labels.other}').par.tint.`);
    // ALPHABETICAL, not channel order: `finish` sorts every menu the same way, and this
    // asserts the shipped behaviour rather than a preference. All four are present, which
    // is the property that matters — `op('x').par.tint` alone is refused with "name a
    // component", and this is the menu that answers that refusal.
    expect(offered).toEqual(["a", "b", "g", "r"]);
  });

  it("offers the channels the node is publishing right now under .chan", async () => {
    const harness = await setup((name) => (name === "wobbler1" ? ["value", "low"] : []));
    const offered = await harness.offeredFor(`op('${harness.labels.other}').chan.`);
    expect(harness.labels.other).toBe("wobbler1");
    // The NAME is what reaches the enumerator, not the id — the same §B170 fact one
    // namespace deeper, and the reason the stub above keys on a label.
    expect(offered).toEqual(["low", "value"]);
  });

  it("offers nothing under a channel — a channel is a leaf, and the reader says so", async () => {
    const harness = await setup((name) => (name === "wobbler1" ? ["value"] : []));
    expect(await harness.offeredFor(`op('${harness.labels.other}').chan.value.`)).toEqual([]);
  });

  it("offers nothing for a name that is not in the document", async () => {
    const harness = await setup();
    expect(await harness.offeredFor("op('nosuchnode').par.")).toEqual([]);
  });

  it("still completes the NAMESPACES with no channel source attached", async () => {
    // The `chan` namespace is real whether or not anything can enumerate it, and a caller
    // with no value graph (a component editor, a layout test) must not lose `par` too.
    const harness = await setup();
    expect(await harness.offeredFor(`op('${harness.labels.other}').chan.`)).toEqual([]);
    expect(await harness.offeredFor(`op('${harness.labels.other}').par.`)).toEqual(["gain", "tint"]);
  });
});

/**
 * THE OTHER HALF OF §V272, WHICH NO MOUNTED TEST CAN REACH.
 *
 * `references` is built inside the pane, so the mount above is a real gate on it. But
 * `channelNames` arrives from the composition root through `InspectorPane`, and the mount
 * above supplies its own — which is §V844's trap word for word: a test that supplies its
 * own dependency cannot detect that the product supplies none. So the supply chain is
 * asserted at the source, the way `composition-seams` asserts the channel merge.
 *
 * Comments are stripped first for the reason that gate strips them: the prose in these
 * files names `channelNames` at length, and a whole-file scan would go green on a version
 * where the docblock survived and the prop was deleted.
 */
describe("§V272/§V844 — the app actually feeds the channel enumerator", () => {
  const sourceOf = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const app = sourceOf("../../app/app.tsx");
  const panes = sourceOf("../../app/side-panes.tsx");

  it("is reading the real composition root, or it is measuring nothing", () => {
    expect(app).toContain("<InspectorPane");
    expect(panes).toContain("<Inspector");
  });

  it("passes the value graph's enumerator from app.tsx into the pane", () => {
    // The VALUE, not the name: `channelNames` also appears in this file's own prop list,
    // and matching on the identifier alone would go green on a version that declared the
    // prop and passed nothing — which is the exact state this task was filed about.
    expect(app).toContain("channelNames={valueGraph.channelNames}");
  });

  it("forwards it from the pane into the Inspector", () => {
    expect(panes).toContain("{ channelNames }");
  });
});
