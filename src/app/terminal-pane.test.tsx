import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TERMINAL_PANE_HINT, TERMINAL_PANE_RUN, TERMINAL_UNPAIRED_REFUSAL } from "@devices/helper.ts";
import type { TerminalClient, TerminalPaneRequest } from "@devices/terminal-client.ts";
import { AppShell } from "./app-shell.tsx";
import { DEFAULT_SHELL_LAYOUT, PANE_HOME, PANE_IDS, PANE_TITLES } from "./layout-storage.ts";
import { DEFAULT_PANE_TREE, allTabs } from "./pane-tree.ts";
import { TerminalPane } from "./terminal-pane.tsx";

/**
 * T1263 — the `terminal` PANE KIND, and what a pane says when there is no shell to show.
 *
 * The dock is generic over `PANE_IDS`, so "registered everywhere" is one list plus the
 * shell's slot map; these tests pin the list, the title, the home zone, that the default
 * layout carries the tab LAST and NOT active, and that the layout menu offers it. The
 * pane's own contract — no shell until "Open shell" is clicked (the dock mounts hidden
 * tabs too, so a mount is not consent), one `open()` per click, one `close()` per
 * unmount, the hint sentence from `helper.ts` before asking and when nothing is paired —
 * is proven on a fake client, because xterm has no cell grid to build in jsdom and the
 * hint is what a user without a helper reads.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

interface FakeClient extends TerminalClient {
  readonly requests: TerminalPaneRequest[];
  readonly closed: number[];
}

function fakeClient(answer: (request: TerminalPaneRequest) => void): FakeClient {
  const requests: TerminalPaneRequest[] = [];
  const closed: number[] = [];
  return {
    requests,
    closed,
    open(request) {
      const index = requests.push(request) - 1;
      answer(request);
      return {
        write: () => undefined,
        resize: () => undefined,
        close: () => {
          closed.push(index);
        },
      };
    },
    sessionCount: () => requests.length - closed.length,
    dispose: () => undefined,
  };
}

/** What the real client answers an unpaired tab with, by the constant it uses (B213). */
const unpaired = (request: TerminalPaneRequest): void => {
  request.onRefused(TERMINAL_UNPAIRED_REFUSAL, "unpaired");
};

describe("T1263 — the terminal pane kind", () => {
  it("is a pane the dock knows, homed in the bottom dock, last in the default layout and not the open tab", () => {
    expect(PANE_IDS).toContain("terminal");
    expect(PANE_TITLES.terminal).toBe("terminal");
    expect(PANE_HOME.terminal).toBe("bottom");
    const bottom = DEFAULT_SHELL_LAYOUT.zones.bottom;
    expect(bottom[bottom.length - 1]).toBe("terminal");
    expect(DEFAULT_SHELL_LAYOUT.active.bottom).not.toBe("terminal");
    expect(allTabs(DEFAULT_PANE_TREE).filter((tab) => tab.role === "terminal")).toEqual([
      { key: "terminal-11", role: "terminal" },
    ]);
  });

  it("mounted in the default dock it asks for NOTHING; the tab's own button asks, exactly once", async () => {
    const user = userEvent.setup();
    const client = fakeClient(unpaired);
    render(<AppShell storage={createMemoryStorage()} terminal={<TerminalPane client={client} />} />);
    // The tab is there (hidden behind Examples), its content mounted — and no shell asked
    // for: a boot of a paired tab must not spawn a shell nobody is looking at.
    expect(screen.getByRole("tab", { name: "terminal" })).toBeDefined();
    expect(client.requests).toHaveLength(0);

    await user.click(screen.getByRole("tab", { name: "terminal" }));
    expect(client.requests).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Open shell" }));
    expect(client.requests).toHaveLength(1);
  });

  it("is offered by the layout menu after being closed, and restoring it mounts a fresh idle pane", async () => {
    const user = userEvent.setup();
    const client = fakeClient(unpaired);
    render(<AppShell storage={createMemoryStorage()} terminal={<TerminalPane client={client} />} />);
    await user.click(screen.getByRole("tab", { name: "terminal" }));
    await user.click(screen.getByRole("button", { name: "Open shell" }));
    expect(client.requests).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Close terminal" }));
    // Closing the tab closed its shell request; nothing survives the pane.
    expect(client.closed).toEqual([0]);
    expect(screen.queryByRole("tab", { name: "terminal" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Layout" }));
    await user.click(screen.getByRole("button", { name: "Restore terminal" }));
    expect(screen.getByRole("tab", { name: "terminal" })).toBeDefined();
    // A restore is a NEW instance: idle again, nothing re-attached, nothing asked.
    expect(client.requests).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open shell" })).toBeDefined();
  });

  it("shows the hint from helper.ts before asking, the command in the refusal when nothing is paired, and a way to try again", async () => {
    const user = userEvent.setup();
    const client = fakeClient(unpaired);
    render(<TerminalPane client={client} />);
    expect(screen.getByText((text) => text.includes(TERMINAL_PANE_HINT))).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Open shell" }));
    expect(client.requests).toHaveLength(1);
    // B213: the reader furthest from a working shell is the one who must be told what to
    // run, and the refusal is all they are left looking at.
    expect(screen.getByText(TERMINAL_UNPAIRED_REFUSAL)).toBeDefined();
    expect(TERMINAL_UNPAIRED_REFUSAL).toContain(TERMINAL_PANE_RUN);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    // A retry is a NEW request, and the old one was closed first — never a second shell
    // for one pane.
    expect(client.requests).toHaveLength(2);
    expect(client.closed).toEqual([0]);
  });

  it("closes its shell when unmounted, and two panes are two shells", async () => {
    const user = userEvent.setup();
    const client = fakeClient(() => undefined);
    const first = render(<TerminalPane client={client} />);
    const second = render(<TerminalPane client={client} />);
    expect(client.requests).toHaveLength(0);
    for (const button of screen.getAllByRole("button", { name: "Open shell" })) await user.click(button);
    expect(client.requests).toHaveLength(2);
    expect(client.sessionCount()).toBe(2);

    act(() => first.unmount());
    expect(client.closed).toEqual([0]);
    expect(client.sessionCount()).toBe(1);
    act(() => second.unmount());
    expect(client.closed).toEqual([0, 1]);
  });

  it("reports a shell that exited, and offers a new one", async () => {
    const user = userEvent.setup();
    const client = fakeClient(() => undefined);
    render(<TerminalPane client={client} />);
    await user.click(screen.getByRole("button", { name: "Open shell" }));
    act(() => client.requests[0]?.onExit(0));
    expect(screen.getByText("The shell exited (0).")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "New shell" }));
    expect(client.requests).toHaveLength(2);
  });
});
