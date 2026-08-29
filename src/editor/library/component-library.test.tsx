// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { componentInstances } from "@domain/components/instance.ts";
import {
  blurKnob,
  bloomComponent,
  createComponentHarness,
  graphOf,
  instanceNode,
  node,
} from "@domain/components/test-support.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ComponentLibrary } from "./component-library.tsx";

/**
 * The component library (T188, §V93, §V79, §V84).
 *
 * What these defend is that the pane is a VIEW, not a second implementation: every row
 * comes from `component.list` and every action leaves through the bus, so a component
 * placed from here is indistinguishable from one placed by an agent or a menu (§V29).
 *
 * The two that matter most:
 *  - linked and detached are DIFFERENT placements and both are reachable. A pane that
 *    only offered one would make §V79's choice invisible;
 *  - a pinned version is shown and an upgrade is offered per instance, never applied in
 *    bulk and never silently (§V84, §V10).
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

function setup(options: { registerV2?: boolean; withInstance?: boolean } = {}) {
  const harness = createComponentHarness(
    "c",
    options.withInstance === true
      ? graphOf([instanceNode("inst", "bloom", 1, { blur: 12 })])
      : graphOf([]),
  );
  harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
  if (options.registerV2 === true) harness.components.register(bloomComponent("bloom", 2, [blurKnob]));
  return harness;
}

describe("ComponentLibrary (T188)", () => {
  it("lists what the bus says is installed, with its version", async () => {
    const harness = setup();
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    const row = await screen.findByRole("button", { name: /^Bloom/ });
    expect(within(row).getByText("v1")).toBeDefined();
    // The row is the query's answer, not a literal: nothing else was registered.
    expect(screen.queryByRole("button", { name: /Kaleidoscope/ })).toBeNull();
  });

  it("instantiates LINKED through the bus — one instance node pinning the version (§V79, §V84)", async () => {
    const harness = setup();
    const execute = vi.spyOn(harness.bus, "execute");
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Bloom/ }));

    await waitFor(() => {
      expect(componentInstances(harness.bus.store.getGraph())).toHaveLength(1);
    });
    expect(execute).toHaveBeenCalledWith(
      "component.instantiate",
      expect.objectContaining({ componentId: "bloom", mode: "linked" }),
      context,
    );
    // Linked means ONE node that points at the definition, not a copy of its three blurs.
    expect(Object.keys(harness.bus.store.getGraph().nodes)).toHaveLength(1);
    expect(componentInstances(harness.bus.store.getGraph())[0]?.state.version).toBe(1);
  });

  it("instantiates DETACHED as an independent copy of the internals (§V79)", async () => {
    const harness = setup();
    const execute = vi.spyOn(harness.bus, "execute");
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Copy Bloom" }));

    await waitFor(() => {
      // Bloom's three internal blurs, copied in; no instance node at all.
      expect(Object.keys(harness.bus.store.getGraph().nodes)).toHaveLength(3);
    });
    expect(componentInstances(harness.bus.store.getGraph())).toHaveLength(0);
    expect(execute).toHaveBeenCalledWith(
      "component.instantiate",
      expect.objectContaining({ mode: "detached" }),
      context,
    );
  });

  it("shows an instance's pinned version and the upgrade waiting for it (§V84)", async () => {
    const harness = setup({ registerV2: true, withInstance: true });
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );

    const upgrades = await screen.findByRole("region", { name: "Upgrades" });
    // Both numbers: what it is pinned to, and what it could move to. Neither implied.
    expect(within(upgrades).getByText("v1 → v2")).toBeDefined();

    fireEvent.click(within(upgrades).getByRole("button", { name: /Upgrade Bloom/ }));

    await waitFor(() => {
      expect(componentInstances(harness.bus.store.getGraph())[0]?.state.version).toBe(2);
    });
  });

  it("offers no upgrade while the pinned version IS the latest", async () => {
    const harness = setup({ withInstance: true });
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );
    await screen.findByRole("button", { name: /^Bloom/ });
    expect(screen.queryByRole("region", { name: "Upgrades" })).toBeNull();
  });

  it("saves the selection as a component and instances it (§V79)", async () => {
    // A real node to capture, of a type the harness's registry actually carries.
    const harness = createComponentHarness("c", graphOf([node("soften", "test.blur", { radius: 4 })]));

    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
        selection={["soften"]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Component name"), { target: { value: "Softener" } });
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));

    await waitFor(() => {
      expect(harness.components.list().map((definition) => definition.name)).toContain("Softener");
    });
    // Saving replaces the selection with an instance of what was saved.
    expect(componentInstances(harness.bus.store.getGraph())).toHaveLength(1);
  });

  it("cannot save with nothing selected", () => {
    const harness = setup();
    render(
      <ComponentLibrary
        bus={harness.bus}
        context={context}
        components={harness.components.view()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save selection" }).hasAttribute("disabled")).toBe(true);
  });
});
