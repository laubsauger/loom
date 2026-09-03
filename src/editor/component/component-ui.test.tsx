// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ComponentPath } from "@domain/types/components.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { BreadcrumbTrail } from "./breadcrumb-trail.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

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

/* The ComponentInspector pane is gone (T1065): it was never mounted in the product,
   and its live claims moved to the generic inspector's Component section —
   see editor/inspector/component-section.test.tsx, which also gates the mount. */
