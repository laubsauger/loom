// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createComponentHarness, graphOf } from "@domain/components/test-support.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
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
} as const;

/** A bus that answers `project.open` — the composition root registers the real one. */
function busWithOpen(): { bus: ShaderloomBus; opened: Array<{ text?: string; fileName?: string }> } {
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
