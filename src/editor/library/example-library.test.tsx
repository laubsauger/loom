// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createComponentHarness, graphOf } from "@domain/components/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { runtimeRequirement } from "@domain/types/requirements.ts";
import { capabilityOf, listExampleProjects } from "./example-catalogue.ts";
import { ExampleLibrary } from "./example-library.tsx";
import { readExampleLink, resolveExampleLink } from "./example-link.ts";

/**
 * The example library (T189, §V93, §V88).
 *
 * The invariant under test is the asymmetry §V93 names: OPEN replaces the document, so
 * it asks when there is work to lose — and asks ONLY then, because a confirmation that
 * fires on a clean document is a confirmation people learn to click through.
 *
 * The catalogue itself is checked against the shipped directory rather than a fixture:
 * §V88 makes the example a real `.loom.json`, and a browser list built from anything
 * else would stop proving the file loads.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

const EXAMPLE = {
  fileName: "E9-Test.loom.json",
  name: "E9 Test",
  nodeCount: 3,
  text: "{}",
  description: "A fire front, breathing out of phase.",
  category: "points",
  // T1162: the category is the first medium tag, and `wgsl` is a technique tag with no
  // category counterpart — so this row exercises both halves of the card's badge strip.
  tags: ["points", "feedback", "wgsl"],
  requirements: [],
  thumbnailUrl: "/examples/thumbs/E9-Test.png",
} as const;

/** A second row, in another category, so the filter has something to exclude. */
const OTHER = {
  fileName: "E12-Other.loom.json",
  name: "E12 Other",
  nodeCount: 8,
  text: "{}",
  description: "A velocity field carrying a dye.",
  category: "feedback",
  tags: ["feedback"],
  requirements: [],
} as const;

/** A bus that answers `project.open` — the composition root registers the real one. */
function busWithOpen(): { bus: LoomBus; opened: Array<{ text?: string; fileName?: string }> } {
  const harness = createComponentHarness("e", graphOf([]));
  const opened: Array<{ text?: string; fileName?: string }> = [];
  harness.bus.registerCommand({
    name: "project.open",
    description: "Test double for the composition root's open (T43).",
    handler: (input, commandContext) => {
      opened.push(input);
      return {
        status: "applied" as const,
        revision: commandContext.store.getRevision(),
        output: { opened: true, fileName: input.fileName ?? null },
      };
    },
    rejectionOutput: () => ({ opened: false, fileName: null }),
  });
  return { bus: harness.bus, opened };
}

describe("example catalogue (§V88)", () => {
  it("reads the shipped `.loom.json` files, named by the project inside them", () => {
    const examples = listExampleProjects();
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const example of examples) {
      expect(example.fileName.endsWith(".loom.json")).toBe(true);
      // The name comes out of the file; a list that invented one would drift on rename.
      expect(JSON.parse(example.text).name).toBe(example.name);
      expect(example.nodeCount).toBeGreaterThan(0);
      // T846: description and category come out of the same directory read — never a
      // registration step someone can forget for the 39th example. The message names the
      // missing FILE, because "expected '' not to be ''" is a gate nobody can act on.
      const stem = example.fileName.replace(/\.loom\.json$/, "");
      expect(example.description, `examples/${stem}.md is missing or has no prose`).not.toBe("");
      expect(example.category, example.fileName).not.toBe("");
      expect(example.requirementsError, example.fileName).toBeUndefined();
    }
  });
});

describe("ExampleLibrary (T189, §V93)", () => {
  it("opens immediately when the document is clean — no confirmation to click through", async () => {
    const { bus, opened } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^E9 Test/ }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The file's own bytes, handed to the same command a picked file goes through.
    expect(opened[0]).toEqual({ text: EXAMPLE.text, fileName: EXAMPLE.fileName });
  });

  it("confirms first when the document is dirty, and opens nothing until confirmed", async () => {
    const { bus, opened } = busWithOpen();
    render(<ExampleLibrary bus={bus} context={context} dirty examples={[EXAMPLE]} />);

    fireEvent.click(screen.getByRole("button", { name: /^E9 Test/ }));

    const dialog = await screen.findByRole("dialog");
    expect(opened).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(opened).toHaveLength(1));
  });

  it("cancelling leaves the document alone", async () => {
    const { bus, opened } = busWithOpen();
    render(<ExampleLibrary bus={bus} context={context} dirty examples={[EXAMPLE]} />);

    fireEvent.click(screen.getByRole("button", { name: /^E9 Test/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opened).toHaveLength(0);
  });

  it("disables its rows when nothing has registered the open command", () => {
    const harness = createComponentHarness("e", graphOf([]));
    render(
      <ExampleLibrary bus={harness.bus} context={context} dirty={false} examples={[EXAMPLE]} />,
    );
    expect(screen.getByRole("button", { name: /^E9 Test/ }).hasAttribute("disabled")).toBe(true);
  });

  it("filters the list as you type, and says so when nothing matches", () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    const search = screen.getByRole("searchbox", { name: "Search examples" });
    fireEvent.change(search, { target: { value: "other" } });
    expect(screen.queryByRole("button", { name: /^E9 Test/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^E12 Other/ })).toBeDefined();

    // The description is searchable, which is what keeps a one-category-per-example
    // taxonomy unnecessary: prose carries the words the category cannot.
    fireEvent.change(search, { target: { value: "breathing" } });
    expect(screen.getByRole("button", { name: /^E9 Test/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^E12 Other/ })).toBeNull();

    fireEvent.change(search, { target: { value: "zzzznotathing" } });
    expect(screen.getByText("No example matches that search.")).toBeDefined();
    // Distinct from "nothing shipped" — the two states have different causes (§V288).
    expect(screen.queryByText("No example ships with this build.")).toBeNull();
  });

  it("SHOWS the categories as group headers, not only in the filter (§T863)", () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    // A header per category, each naming its own section, and each carrying its size —
    // which is the thing a per-row badge could not have said.
    const points = screen.getByRole("region", { name: "points" });
    expect(within(points).getByRole("button", { name: /^E9 Test/ })).toBeDefined();
    expect(within(points).queryByRole("button", { name: /^E12 Other/ })).toBeNull();
    expect(within(points).getByRole("heading", { name: /points/ }).textContent).toContain("1");

    expect(
      within(screen.getByRole("region", { name: "feedback" })).getByRole("button", {
        name: /^E12 Other/,
      }),
    ).toBeDefined();

    // Categories alphabetical, so the shelf never reshuffles between renders.
    const headers = screen.getAllByRole("heading").map((node) => node.textContent ?? "");
    expect(headers[0]?.startsWith("feedback")).toBe(true);
    expect(headers[1]?.startsWith("points")).toBe(true);
  });

  it("keeps the search field OUT of the scrolling list (§T876)", () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    // The sticky headers can only be safe at `top: 0` if nothing that is not a row lives
    // in the scroller with them. This is the structural half of the fix, and it is the
    // half a refactor could quietly undo — the CSS half (no top padding on the scroller)
    // jsdom cannot see, so this pins what it can: the search box is a SIBLING of the
    // scrolling list, never a descendant of it.
    const search = screen.getByRole("searchbox", { name: "Search examples" });
    const scroller = screen.getByRole("region", { name: "points" }).parentElement;
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(search)).toBe(false);
    // ...and the headers really are inside it, or the assertion above proves nothing.
    expect(scroller?.contains(screen.getByRole("heading", { name: /points/ }))).toBe(true);
  });

  it("stays grouped while searching, with the ranking kept inside each group", () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search examples" }), {
      target: { value: "e" },
    });
    // Both still match; a search does not flatten the shelf into an unlabelled list.
    expect(screen.getByRole("region", { name: "points" })).toBeDefined();
    expect(screen.getByRole("region", { name: "feedback" })).toBeDefined();
  });

  it("offers the categories the catalogue actually has, and filters to one", async () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter examples by category" }));
    const menu = await screen.findByRole("dialog");
    // Derived, not hand-listed: both categories present in the fixture, and nothing else.
    expect(within(menu).getByRole("button", { name: "points" })).toBeDefined();
    expect(within(menu).getByRole("button", { name: "feedback" })).toBeDefined();
    expect(within(menu).queryByRole("button", { name: "audio" })).toBeNull();

    fireEvent.click(within(menu).getByRole("button", { name: "feedback" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^E9 Test/ })).toBeNull());
    expect(screen.getByRole("button", { name: /^E12 Other/ })).toBeDefined();
    // The trigger answers "what am I looking at" (§V90).
    expect(screen.getByRole("button", { name: "Filter examples by category: feedback" })).toBeDefined();
  });

  it("shows the description on FOCUS, not only on hover (§V19)", async () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    screen.getByRole("button", { name: /^E9 Test/ }).focus();

    const card = await screen.findByRole("tooltip");
    expect(within(card).getByText(EXAMPLE.description)).toBeDefined();
    expect(within(card).getByText("3 nodes")).toBeDefined();
    // The thumbnail is the example's own, joined on the loom's stem (§T847).
    expect(card.querySelector("img")?.getAttribute("src")).toBe(EXAMPLE.thumbnailUrl);

    // §T862: BESIDE the row, never over it. `data-side` is the side Radix RESOLVED, so
    // asserting "right" would assert jsdom's zero-size viewport — it collides there and
    // flips to "left", which is the collision handling working. What is layout-
    // independent, and what the owner actually asked for, is that the card stays on the
    // horizontal axis: "top" or "bottom" is a card sitting on the row it describes.
    expect(["left", "right"]).toContain(card.getAttribute("data-side"));
  });

  it("says WHAT THE EXAMPLE DEMONSTRATES on the card, labelled and defined (T1162)", async () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    screen.getByRole("button", { name: /^E9 Test/ }).focus();
    const card = await screen.findByRole("tooltip");

    // The label, not the tag id: `3d` renders "3D" and `wgsl` renders "WGSL", and a card
    // showing the raw union member would be the jargon the tags exist to replace.
    for (const tag of EXAMPLE.tags) {
      expect(within(card).getByText(capabilityOf(tag).label)).toBeDefined();
    }

    // And the DEFINITION travels with it. Read from the table rather than repeated here:
    // a copy of the sentence in this file is a second place for it to be edited (§V487).
    expect(
      within(card).getByText(capabilityOf("wgsl").label).getAttribute("title"),
    ).toBe(capabilityOf("wgsl").meaning);

    // Tags now appear in the list too; discovering capabilities needs no hover.
    expect(
      within(screen.getByRole("button", { name: /^E9 Test/ })).queryByText(
        capabilityOf("wgsl").label,
      ),
    ).not.toBeNull();
  });

  it("shows runtime requirements and tags before opening or hovering an example", () => {
    const { bus, opened } = busWithOpen();
    // T1340b: the REAL table, not a hand-written pair. A fixture that spells its own
    // labels and descriptions is the drift this row deleted — it would keep passing after
    // the shipped words changed underneath it.
    const desktop = runtimeRequirement("desktop");
    const silicon = runtimeRequirement("apple-silicon");
    const example = { ...EXAMPLE, requirements: [desktop, silicon] };
    render(<ExampleLibrary bus={bus} context={context} dirty={false} examples={[example, OTHER]} />);
    const row = within(screen.getByRole("button", { name: /^E9 Test/ }));
    expect(row.getByText(desktop.label).getAttribute("title")).toBe(desktop.description);
    expect(row.getByText(silicon.label)).toBeDefined();
    for (const tag of EXAMPLE.tags) expect(row.getByText(capabilityOf(tag).label)).toBeDefined();
    expect(within(screen.getByRole("button", { name: /^E12 Other/ })).queryByText(desktop.label)).toBeNull();
    expect(opened).toHaveLength(0);
  });

  /**
   * T1340b — the COLOUR, asserted as the thing that carries it rather than as a
   * screenshot: every requirement badge declares its CATEGORY, and `node-identity.module.css`
   * keys the hue off that one attribute. The three actionable categories and the
   * unsatisfiable one must never arrive wearing the same word, because the stylesheet has
   * no other way to tell them apart — and a `not-implemented` tag painted like "Device
   * helper" sends the reader looking for a machine that would fix it.
   */
  it("tags each requirement with its category, and never files the unsatisfiable one with the actionable ones", () => {
    const { bus } = busWithOpen();
    const requirements = [
      runtimeRequirement("helper"),
      runtimeRequirement("windows"),
      runtimeRequirement("ndi-sdk"),
      runtimeRequirement("not-implemented"),
    ];
    render(<ExampleLibrary bus={bus} context={context} dirty={false}
      examples={[{ ...EXAMPLE, requirements }]} />);
    const row = within(screen.getByRole("button", { name: /^E9 Test/ }));
    const categoryOf = (label: string) => row.getByText(label).getAttribute("data-category");
    expect(categoryOf("Device helper")).toBe("host");
    expect(categoryOf("Windows")).toBe("platform");
    expect(categoryOf("NDI SDK")).toBe("external");
    expect(categoryOf("Not implemented")).toBe("unsupported");
    // The capability tags share the badge and must stay UNTINTED: they say what the file
    // demonstrates, not what your machine is missing.
    expect(row.getByText(capabilityOf(EXAMPLE.tags[0]!).label).getAttribute("data-category")).toBeNull();
  });

  it("marks unresolved requirements instead of implying browser compatibility", () => {
    const { bus } = busWithOpen();
    render(<ExampleLibrary bus={bus} context={context} dirty={false}
      examples={[{ ...EXAMPLE, requirementsError: "Unavailable component definition" }]} />);
    const badge = within(screen.getByRole("button", { name: /^E9 Test/ })).getByText("Requirements unknown");
    expect(badge.getAttribute("title")).toBe("Unavailable component definition");
  });

  it("finds an example by a capability its name and its description never mention", () => {
    // The reason the tags are worth more than a badge. Neither "E9 Test" nor "A fire
    // front, breathing out of phase." contains the string "wgsl"; the derived tag is the
    // only thing in the record that does, so a hit here is the TAG tier firing and
    // nothing else. Before T1162 the field was empty and this query returned no rows.
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    const search = screen.getByRole("searchbox", { name: "Search examples" });
    fireEvent.change(search, { target: { value: "wgsl" } });

    expect(screen.getByRole("button", { name: /^E9 Test/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^E12 Other/ })).toBeNull();
  });

  it("renders no image at all for an example with no thumbnail — never a broken one", async () => {
    const { bus } = busWithOpen();
    render(<ExampleLibrary bus={bus} context={context} dirty={false} examples={[OTHER]} />);

    screen.getByRole("button", { name: /^E12 Other/ }).focus();

    const card = await screen.findByRole("tooltip");
    // The card still carries its prose; what is absent is the `<img>`, not the row.
    expect(within(card).getByText(OTHER.description)).toBeDefined();
    expect(card.querySelector("img")).toBeNull();
  });

  it("reports what the loader said rather than swallowing it", async () => {
    const harness = createComponentHarness("e", graphOf([]));
    harness.bus.registerCommand({
      name: "project.open",
      description: "Test double that refuses (T43).",
      handler: (_input, commandContext) => ({
        status: "rejected" as const,
        revision: commandContext.store.getRevision(),
        diagnostics: [
          { severity: "error" as const, code: "project.open.rejected", message: "not a project" },
        ],
        output: { opened: false, fileName: null },
      }),
      rejectionOutput: () => ({ opened: false, fileName: null }),
    });

    render(
      <ExampleLibrary bus={harness.bus} context={context} dirty={false} examples={[EXAMPLE]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^E9 Test/ }));
    expect(await screen.findByText("not a project")).toBeDefined();
  });
});

/**
 * T1278 — THE LINK A PERSON SENDS.
 *
 * The owner's ask is a round trip between two people: one copies a link out of this pane,
 * the other opens it and lands on that example. This end owns the copy; `example-link.ts`
 * owns the contract and `app/example-link-boot.test.tsx` owns what a boot does with it.
 * The assertions here are on the STRING that leaves the app, fed back through the reader
 * the recipient's browser will actually use — never on the fact that a handler ran.
 */
describe("copying a link to an example (T1278)", () => {
  it("copies a URL the boot reader resolves back to that same example", () => {
    const copied: string[] = [];
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary
        bus={bus}
        context={context}
        dirty={false}
        examples={[EXAMPLE, OTHER]}
        copyLink={(text) => copied.push(text)}
        linkOrigin="https://host.example"
        linkBase="/loom/"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy a link to E12 Other" }));

    /*
     * THE GATE on producer/consumer drift, and the reason it is asserted here rather than
     * against a literal: nothing in this file tells `exampleLinkUrl` what spelling to use,
     * and nothing tells `resolveExampleLink` what to expect. If either end changes its
     * mind about the query key, the extension, or the case, this goes red — while two
     * literals would simply have been edited to match.
     */
    expect(copied).toHaveLength(1);
    const url = new URL(copied[0] as string);
    expect(url.origin + url.pathname).toBe("https://host.example/loom/");
    const requested = readExampleLink(url.search);
    expect(requested).not.toBeNull();
    expect(resolveExampleLink(requested as string, [EXAMPLE, OTHER])).toEqual({
      kind: "match",
      example: OTHER,
    });
  });

  it("says which link was copied, because a clipboard write is otherwise invisible", () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary
        bus={bus}
        context={context}
        dirty={false}
        examples={[EXAMPLE]}
        copyLink={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy a link to E9 Test" }));
    expect(screen.getByText("Link to E9 Test copied.")).toBeDefined();
  });

  it("says what it does before the click and what happened after it (T1281)", () => {
    /*
     * The owner could not tell the control was a copy button, or that a copy had happened:
     * the label was the noun "link", and the pane's notice renders BELOW the list, off
     * screen for any row but the last. Both halves are asserted here because both were
     * the complaint — the verb, and a receipt where the eye already is.
     */
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary
        bus={bus}
        context={context}
        dirty={false}
        examples={[EXAMPLE]}
        copyLink={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Copy a link to E9 Test" });
    expect(button.textContent).toBe("copy link");
    fireEvent.click(button);
    expect(button.textContent).toBe("copied");
  });

  it("copies without opening — the row's two actions are not one action (§V93)", () => {
    // The destructive verb and the harmless one sit on the same row; the harmless one must
    // not carry the destructive one along with it, dirty document or not.
    const { bus, opened } = busWithOpen();
    render(
      <ExampleLibrary
        bus={bus}
        context={context}
        dirty
        examples={[EXAMPLE]}
        copyLink={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy a link to E9 Test" }));
    expect(opened).toEqual([]);
    // …and no confirmation dialog either: nothing was at risk.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
