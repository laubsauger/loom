// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useReducedMotion } from "../hooks/use-reduced-motion.ts";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { Button } from "./button.tsx";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./context-menu.tsx";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "./dialog.tsx";
import { Tooltip, TooltipProvider } from "./tooltip.tsx";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "./tabs.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

/**
 * V19 — the restyled Radix primitives must keep the behaviour that makes them
 * accessible. Restyling is where that usually gets lost, so it is tested here.
 */
describe("V19 — restyled primitives keep their keyboard contract", () => {
  it("dialog: opens from the keyboard, names itself, closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <DialogRoot>
        <DialogTrigger asChild>
          <Button>open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Grant capability</DialogTitle>
          <DialogDescription>Allow this agent to write a local file?</DialogDescription>
          <DialogClose asChild>
            <Button>cancel</Button>
          </DialogClose>
        </DialogContent>
      </DialogRoot>,
    );

    const trigger = screen.getByRole("button", { name: "open" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Grant capability" });
    expect(dialog).toBeDefined();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("tooltip: appears on keyboard focus, not only on hover", async () => {
    render(
      <TooltipProvider>
        <Tooltip label="Reset time">
          <Button aria-label="Reset time">R</Button>
        </Tooltip>
      </TooltipProvider>,
    );

    screen.getByRole("button", { name: "Reset time" }).focus();
    expect(await screen.findByRole("tooltip")).toBeDefined();
  });

  it("context menu: arrow keys highlight items, Enter runs one", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <div>canvas</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onSelect}>
            Add node
            <ContextMenuShortcut>Tab</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem danger>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>,
    );

    fireEvent.contextMenu(screen.getByText("canvas"));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(2);

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("tabs: one tab stop for the list, arrow keys move selection", async () => {
    const user = userEvent.setup();
    render(
      <TabsRoot defaultValue="a">
        <TabsList aria-label="Dock">
          <TabsTrigger value="a">a</TabsTrigger>
          <TabsTrigger value="b">b</TabsTrigger>
        </TabsList>
        <TabsContent value="a">panel a</TabsContent>
        <TabsContent value="b">panel b</TabsContent>
      </TabsRoot>,
    );

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "a" }));

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "b" }));
    expect(screen.getByText("panel b")).toBeDefined();
  });

  it("reduced motion: the hook reports the user's preference to script-driven animation", () => {
    const query = "(prefers-reduced-motion: reduce)";
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (media: string) => ({
        matches: media === query,
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });

    try {
      // V19: edge flow, preview tickers and any other JS animation must be able
      // to go static without asking the DOM themselves.
      expect(renderHook(() => useReducedMotion()).result.current).toBe(true);
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });

  it("button: disabled buttons are inert, toggles report pressed state", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button disabled onClick={onClick}>
          off
        </Button>
        <Button aria-pressed onClick={onClick}>
          on
        </Button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "off" }));
    expect(onClick).not.toHaveBeenCalled();

    const toggle = screen.getByRole("button", { name: "on" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
