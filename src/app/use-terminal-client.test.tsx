import { StrictMode, useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { TerminalClientOptions } from "@devices/terminal-client.ts";
import type { BridgeSocket, PairingMemory } from "@devices/transport/bridge-socket.ts";
import { TerminalPane } from "./terminal-pane.tsx";
import { useTerminalClient } from "./use-terminal-client.ts";

/**
 * B213 — THE TAB THAT WAS ALREADY GOING AWAY BEFORE ANYONE ASKED FOR A SHELL.
 *
 * The owner paired the helper, opened the terminal tab, pressed "Open shell" and read
 * "This tab is going away." every time. `dispose()` is a one-way door — it latches
 * `disposed`, and `open()` refuses with that sentence afterwards — and the app owned the
 * client with a `[]`-memo disposed from an effect cleanup. `main.tsx` renders inside
 * `<StrictMode>`, which mounts, runs the cleanups and re-runs the effects: the cleanup
 * disposed the one instance the memo would ever hand out, and the memo did not re-run.
 * The terminal had never worked in a dev build. Same shape as B96 and the B172 follow-up,
 * for the third time — a resource whose lifetime is a memo and whose teardown is an
 * effect.
 *
 * So the claim here is the owner's gesture through the real parts: the real hook, the
 * real pane, the real client, under `<StrictMode>`, with only the socket and the pairing
 * memory faked. A single-mount render of any of it passes against the broken code, which
 * is why this shipped.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

interface FakeSocket extends BridgeSocket {
  readonly sent: Record<string, unknown>[];
  closed: boolean;
  hear(message: Record<string, unknown>): void;
}

function fakeSockets(): { readonly factory: (url: string) => BridgeSocket; readonly opened: FakeSocket[] } {
  const opened: FakeSocket[] = [];
  return {
    opened,
    factory: () => {
      const socket: FakeSocket = {
        sent: [],
        closed: false,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => {
          socket.sent.push(JSON.parse(data) as Record<string, unknown>);
        },
        close: () => {
          socket.closed = true;
        },
        hear: (message) => socket.onmessage?.({ data: JSON.stringify(message) }),
      };
      opened.push(socket);
      // Open on the next tick, as a real socket would — never inside the factory call.
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
  };
}

function memoryWith(code: string | null): PairingMemory {
  let held = code;
  return {
    read: () => held,
    write: (next) => {
      held = next;
    },
    forget: () => {
      held = null;
    },
  };
}

/** How many times React mounted the effects under the tab: StrictMode makes it two. */
const mounts: string[] = [];

function TerminalTab({ options }: { options: TerminalClientOptions }) {
  const client = useTerminalClient(options);
  useEffect(() => {
    mounts.push("mount");
  }, []);
  return client === null ? null : <TerminalPane client={client} />;
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("B213 — the terminal tab under StrictMode", () => {
  it("opens a shell on the owner's first click instead of refusing 'This tab is going away.'", async () => {
    mounts.length = 0;
    const user = userEvent.setup();
    const sockets = fakeSockets();
    const options: TerminalClientOptions = {
      socketFactory: sockets.factory,
      memory: memoryWith("ABCD-1234"),
    };
    render(
      <StrictMode>
        <TerminalTab options={options} />
      </StrictMode>,
    );
    await settle();
    // Non-vacuity: without the double mount this test passes against the broken code.
    expect(mounts.length, "StrictMode did not double-mount the tab").toBeGreaterThan(1);

    await user.click(screen.getByRole("button", { name: "Open shell" }));
    await settle();

    expect(screen.queryByText("This tab is going away.")).toBeNull();
    // The click reached the wire: one socket, attached with the code the tab remembers.
    expect(sockets.opened).toHaveLength(1);
    expect(sockets.opened[0]?.sent[0]).toMatchObject({ type: "terminalAttach", code: "ABCD-1234" });

    act(() => {
      sockets.opened[0]?.hear({ type: "terminalAttached", shell: "/bin/zsh", cwd: "/tmp" });
    });
    // And the helper granting the role is answered with a request for THIS pane's shell.
    expect(sockets.opened[0]?.sent.map((message) => message["type"])).toContain("terminalOpen");
  });

  it("still kills the tab's shells when the tab really goes away", async () => {
    const user = userEvent.setup();
    const sockets = fakeSockets();
    const options: TerminalClientOptions = {
      socketFactory: sockets.factory,
      memory: memoryWith("ABCD-1234"),
    };
    const view = render(
      <StrictMode>
        <TerminalTab options={options} />
      </StrictMode>,
    );
    await settle();
    await user.click(screen.getByRole("button", { name: "Open shell" }));
    await settle();
    act(() => {
      sockets.opened[0]?.hear({ type: "terminalAttached", shell: "/bin/zsh", cwd: "/tmp" });
    });

    act(() => {
      view.unmount();
    });

    // A real unmount is the tab going away, and the tab's socket goes with it: the host
    // releases the terminal role and kills every shell that rode it when the socket
    // closes (`bridge-host.ts`, "every shell the terminal socket opened dies with it").
    // Surviving StrictMode must not cost that.
    expect(sockets.opened[0]?.closed, "the tab's terminal socket outlived the tab").toBe(true);
  });
});
