// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ComponentPath } from "@domain/types/components.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import {
  blurKnob,
  bloomComponent,
  createComponentHarness,
  graphOf,
  instanceNode,
} from "@domain/components/test-support.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { BreadcrumbTrail } from "./breadcrumb-trail.tsx";
import { ComponentInspector } from "./component-inspector.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

// Module-level so the identity is stable across renders: the pane keys its editor to it.
const context = contextFor(alice);

describe("BreadcrumbTrail (T130, §V19)", () => {
  const crumbs = [
    { label: "Main", path: [] as ComponentPath },
    { label: "Bloom_1", path: ["a"] as ComponentPath },
    { label: "Blur_1", path: ["a", "b"] as ComponentPath },
  ];

  it("renders one focusable control per level and marks where you are", () => {
    render(<BreadcrumbTrail breadcrumbs={crumbs} onNavigate={() => {}} />);
    const trail = screen.getByRole("navigation", { name: "Component path" });
    // Real buttons, so the trail is tab-reachable and Enter/Space activated (§V19).
    expect(within(trail).getAllByRole("button")).toHaveLength(3);
    expect(within(trail).getByRole("button", { name: "Blur_1" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("navigates to the clicked level, not merely one step out", () => {
    const onNavigate = vi.fn();
    render(<BreadcrumbTrail breadcrumbs={crumbs} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Main" }));
    expect(onNavigate).toHaveBeenCalledWith([]);
    fireEvent.click(screen.getByRole("button", { name: "Bloom_1" }));
    expect(onNavigate).toHaveBeenCalledWith(["a"]);
  });

  it("does not offer an exit at the root, where there is nothing to leave", () => {
    const { rerender } = render(
      <BreadcrumbTrail breadcrumbs={crumbs} onNavigate={() => {}} onExit={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Exit component" })).not.toBeNull();
    rerender(
      <BreadcrumbTrail breadcrumbs={[crumbs[0]!]} onNavigate={() => {}} onExit={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Exit component" })).toBeNull();
  });
});

function setup(options: { registerV2?: boolean } = {}) {
  const harness = createComponentHarness(
    "c",
    graphOf([instanceNode("inst", "bloom", 1, { blur: 12 })]),
  );
  harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
  if (options.registerV2 === true) {
    harness.components.register(bloomComponent("bloom", 2, [blurKnob]));
  }
  return harness;
}

describe("ComponentInspector (T137)", () => {
  it("shows the component's parameter page, not the internal parameters it drives (§V80)", () => {
    const harness = setup();
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    // "Blur", the re-authored knob — never "Radius", the three internals behind it.
    expect(screen.getByRole("spinbutton", { name: "Blur" })).toBeDefined();
    expect(screen.queryByRole("spinbutton", { name: "Radius" })).toBeNull();
  });

  it("lists the exposed ports so the boundary is legible without entering", () => {
    const harness = setup();
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    const ports = screen.getByRole("region", { name: "Exposed ports" });
    expect(within(ports).getByText("Source")).toBeDefined();
    expect(within(ports).getByText(/blurA\.source/)).toBeDefined();
    expect(within(ports).getByText(/blurC\.out/)).toBeDefined();
  });

  it("shows the PINNED version and offers no upgrade when there is none", () => {
    const harness = setup();
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    expect(screen.getByText("v1")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Upgrade/ })).toBeNull();
  });

  it("offers an upgrade without ever taking it on its own (§V84)", async () => {
    const harness = setup({ registerV2: true });
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    // A newer version exists, and the instance has not moved.
    expect(harness.bus.store.getGraph().nodes.inst?.type).toBe(componentNodeType("bloom", 1));
    const button = screen.getByRole("button", { name: "Upgrade to v2" });

    fireEvent.click(button);
    await waitFor(() =>
      expect(harness.bus.store.getGraph().nodes.inst?.type).toBe(componentNodeType("bloom", 2)),
    );
    expect(harness.bus.store.getGraph().nodes.inst?.definitionVersion).toBe(2);
  });

  it("writes a published value through the bus, not into the node (§V29)", async () => {
    const harness = setup();
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Blur" }), { key: "End" });
    await waitFor(() => expect(harness.bus.store.getGraph().nodes.inst?.parameters.blur).toBe(64));
    expect(harness.bus.store.getAudit().at(-1)?.command).toBe("graph.applyPatch");
  });

  it("detaches through the bus when asked", async () => {
    const harness = setup();
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Detach copy" }));
    await waitFor(() => expect(harness.bus.store.getGraph().nodes.inst).toBeUndefined());
    expect(Object.keys(harness.bus.store.getGraph().nodes)).toHaveLength(3);
  });

  it("keeps an uninstalled component inspectable rather than blank (§V10)", () => {
    const harness = createComponentHarness(
      "c",
      graphOf([instanceNode("inst", "missing", 1, { blur: 12 })]),
    );
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    expect(screen.getByText(/not installed/)).toBeDefined();
    expect(screen.getByText("v1")).toBeDefined();
  });

  it("re-renders when the definition is re-authored outside the document (§V79)", async () => {
    const harness = setup();
    render(
      <ComponentInspector
        bus={harness.bus}
        context={context}
        nodeId="inst"
        components={harness.components.view()}
      />,
    );
    expect(screen.getByText("Bloom")).toBeDefined();
    harness.components.register({ ...bloomComponent("bloom", 1, [blurKnob]), name: "Glow" });
    await waitFor(() => expect(screen.getByText("Glow")).toBeDefined());
  });
});
