// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { NodeId } from "@domain/types/ids.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import {
  bloomComponent,
  blurKnob,
  createComponentHarness,
  graphOf,
  instanceNode,
} from "@domain/components/test-support.ts";
import { DEFAULT_PROJECT_SETTINGS } from "@domain/types/graph.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

/**
 * T1065 — the Component section, gated where a HUMAN reaches it: through the generic
 * `Inspector`, the component the product's inspector pane mounts. Its predecessor
 * (`ComponentInspector`) carried eight green tests and zero product mounts — §V844's
 * lesson in full — so every gate here renders the REAL Inspector with the `components`
 * prop the app now threads, never the section in isolation.
 */

function setup(options: { registerV2?: boolean } = {}) {
  const harness = createComponentHarness(
    "c",
    graphOf([instanceNode("inst" as NodeId, "bloom", 1, { blur: 12 })]),
  );
  harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
  if (options.registerV2 === true) {
    harness.components.register(bloomComponent("bloom", 2, [blurKnob]));
  }
  render(
    <Inspector
      bus={harness.bus}
      context={context}
      nodeId={"inst" as NodeId}
      settings={DEFAULT_PROJECT_SETTINGS}
      components={harness.components.view()}
    />,
  );
  return harness;
}

describe("T1065 — the instance's Component section, reached through the product inspector", () => {
  it("states the PINNED version and offers no upgrade when there is none (§V84)", () => {
    setup();
    const section = screen.getByRole("region", { name: "Component" });
    expect(section.textContent).toContain("v1");
    expect(screen.queryByRole("button", { name: /Upgrade/ })).toBeNull();
  });

  it("offers an upgrade when v2 is installed, and never takes it on its own (§V84)", async () => {
    const harness = setup({ registerV2: true });
    // Offered, not taken: the instance still reads v1 until the click.
    expect(harness.store.view.getGraph().nodes["inst" as NodeId]?.definitionVersion).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Upgrade to v2/ }));
    await waitFor(() => {
      expect(harness.store.view.getGraph().nodes["inst" as NodeId]?.definitionVersion).toBe(2);
    });
  });

  it("DETACH goes through the bus and replaces the instance with an editable copy", async () => {
    const harness = setup();
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));
    await waitFor(() => {
      const nodes = harness.store.view.getGraph().nodes;
      // The instance node is gone; its internals stand in its place as plain nodes.
      expect(nodes["inst" as NodeId]).toBeUndefined();
      expect(Object.keys(nodes).length).toBeGreaterThan(0);
    });
    // §V29/§V30: through the command door, with the actor on the audit trail.
    expect(
      harness.bus.store.getAudit().some((entry) => entry.command === "component.detach"),
    ).toBe(true);
  });

  it("keeps an UNINSTALLED component inspectable and says what it is pinned to (§V10)", () => {
    const harness = createComponentHarness(
      "c",
      graphOf([instanceNode("inst" as NodeId, "ghost", 3)]),
    );
    render(
      <Inspector
        bus={harness.bus}
        context={context}
        nodeId={"inst" as NodeId}
        settings={DEFAULT_PROJECT_SETTINGS}
        components={harness.components.view()}
      />,
    );
    const section = screen.getByRole("region", { name: "Component" });
    expect(section.textContent).toContain("ghost v3");
    expect(section.textContent).toContain("not installed");
    // No definition = nothing to enter and nothing to detach INTO; both refuse to render
    // enabled rather than failing on click.
    expect((screen.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-renders when the definition is re-authored outside the document (§V79)", async () => {
    const harness = setup();
    expect(screen.queryByRole("button", { name: /Upgrade/ })).toBeNull();
    harness.components.register(bloomComponent("bloom", 2, [blurKnob]));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Upgrade to v2/ })).toBeTruthy();
    });
  });

  it("renders NO section for a plain node, and none when the app supplies no registry", () => {
    const harness = setup();
    void harness;
    cleanup();
    const plain = createComponentHarness("p", graphOf([instanceNode("inst" as NodeId, "bloom", 1)]));
    plain.components.register(bloomComponent("bloom", 1, [blurKnob]));
    render(
      <Inspector
        bus={plain.bus}
        context={context}
        nodeId={"inst" as NodeId}
        settings={DEFAULT_PROJECT_SETTINGS}
      />,
    );
    expect(screen.queryByRole("region", { name: "Component" })).toBeNull();
  });
});
