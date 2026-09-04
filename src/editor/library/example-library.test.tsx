// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createComponentHarness, graphOf } from "@domain/components/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { listExampleProjects } from "./example-catalogue.ts";
import { ExampleLibrary } from "./example-library.tsx";

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
    }
  });
});

describe("ExampleLibrary (T189, §V93)", () => {
  it("opens immediately when the document is clean — no confirmation to click through", async () => {
    const { bus, opened } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /E9 Test/ }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The file's own bytes, handed to the same command a picked file goes through.
    expect(opened[0]).toEqual({ text: EXAMPLE.text, fileName: EXAMPLE.fileName });
  });

  it("confirms first when the document is dirty, and opens nothing until confirmed", async () => {
    const { bus, opened } = busWithOpen();
    render(<ExampleLibrary bus={bus} context={context} dirty examples={[EXAMPLE]} />);

    fireEvent.click(screen.getByRole("button", { name: /E9 Test/ }));

    const dialog = await screen.findByRole("dialog");
    expect(opened).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(opened).toHaveLength(1));
  });

  it("cancelling leaves the document alone", async () => {
    const { bus, opened } = busWithOpen();
    render(<ExampleLibrary bus={bus} context={context} dirty examples={[EXAMPLE]} />);

    fireEvent.click(screen.getByRole("button", { name: /E9 Test/ }));
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
    expect(screen.getByRole("button", { name: /E9 Test/ }).hasAttribute("disabled")).toBe(true);
  });

  it("filters the list as you type, and says so when nothing matches", () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    const search = screen.getByRole("searchbox", { name: "Search examples" });
    fireEvent.change(search, { target: { value: "other" } });
    expect(screen.queryByRole("button", { name: /E9 Test/ })).toBeNull();
    expect(screen.getByRole("button", { name: /E12 Other/ })).toBeDefined();

    // The description is searchable, which is what keeps a one-category-per-example
    // taxonomy unnecessary: prose carries the words the category cannot.
    fireEvent.change(search, { target: { value: "breathing" } });
    expect(screen.getByRole("button", { name: /E9 Test/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /E12 Other/ })).toBeNull();

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
    expect(within(points).getByRole("button", { name: /E9 Test/ })).toBeDefined();
    expect(within(points).queryByRole("button", { name: /E12 Other/ })).toBeNull();
    expect(within(points).getByRole("heading", { name: /points/ }).textContent).toContain("1");

    expect(
      within(screen.getByRole("region", { name: "feedback" })).getByRole("button", {
        name: /E12 Other/,
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
    await waitFor(() => expect(screen.queryByRole("button", { name: /E9 Test/ })).toBeNull());
    expect(screen.getByRole("button", { name: /E12 Other/ })).toBeDefined();
    // The trigger answers "what am I looking at" (§V90).
    expect(screen.getByRole("button", { name: "Filter examples by category: feedback" })).toBeDefined();
  });

  it("shows the description on FOCUS, not only on hover (§V19)", async () => {
    const { bus } = busWithOpen();
    render(
      <ExampleLibrary bus={bus} context={context} dirty={false} examples={[EXAMPLE, OTHER]} />,
    );

    screen.getByRole("button", { name: /E9 Test/ }).focus();

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

  it("renders no image at all for an example with no thumbnail — never a broken one", async () => {
    const { bus } = busWithOpen();
    render(<ExampleLibrary bus={bus} context={context} dirty={false} examples={[OTHER]} />);

    screen.getByRole("button", { name: /E12 Other/ }).focus();

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
    fireEvent.click(screen.getByRole("button", { name: /E9 Test/ }));
    expect(await screen.findByText("not a project")).toBeDefined();
  });
});
