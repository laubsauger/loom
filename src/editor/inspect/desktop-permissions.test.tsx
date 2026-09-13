// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPermissions } from "@devices/desktop-permissions.ts";
import { DesktopPermissionsPanel } from "./desktop-permissions.tsx";

vi.mock("@devices/desktop-permissions.ts", () => ({ desktopPermissions: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("desktop permission status", () => {
  it("renders nothing without the desktop bridge", () => {
    vi.mocked(desktopPermissions).mockReturnValue(undefined);
    expect(render(<DesktopPermissionsPanel />).container.textContent).toBe("");
  });

  it("shows device and NDI permissions with separate app and OS decisions", async () => {
    const list = vi.fn().mockResolvedValue([
      { id: "camera", decision: "allowed", system: "denied" },
      { id: "microphone", decision: "not-requested", system: "not-determined" },
      { id: "speaker", decision: "pending", system: "managed-by-browser" },
      { id: "ndi", decision: "denied", system: "managed-by-os" },
    ]);
    vi.mocked(desktopPermissions).mockReturnValue({ list, openSystemSettings: vi.fn().mockResolvedValue(undefined), subscribe: () => () => {} });
    render(<DesktopPermissionsPanel />);
    await screen.findByText("App: allowed · OS: denied");
    expect(screen.getByText("Camera")).toBeTruthy();
    expect(screen.getByText("Microphone")).toBeTruthy();
    expect(screen.getByText("Speaker selection")).toBeTruthy();
    expect(screen.getByText("NDI network")).toBeTruthy();
    expect(screen.getByText("App: denied · OS: managed by os")).toBeTruthy();
    expect(screen.getByText("App: not requested · OS: not determined")).toBeTruthy();
    expect(screen.getByText("App: pending · OS: managed by browser")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not offer device privacy settings for OS-managed NDI alone", async () => {
    vi.mocked(desktopPermissions).mockReturnValue({
      list: vi.fn().mockResolvedValue([{ id: "ndi", decision: "allowed", system: "managed-by-os" }]),
      openSystemSettings: vi.fn(), subscribe: () => () => {},
    });
    render(<DesktopPermissionsPanel />);
    await screen.findByText("NDI network");
    expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();
  });

  it("shows errors and refreshes on focus, removing the listener on unmount", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("Bridge disconnected"));
    vi.mocked(desktopPermissions).mockReturnValue({ list, openSystemSettings: vi.fn().mockResolvedValue(undefined), subscribe: () => () => {} });
    const view = render(<DesktopPermissionsPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("Bridge disconnected");
    list.mockResolvedValue([{ id: "camera", decision: "denied", system: "granted" }]);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("App: denied · OS: granted")).toBeTruthy();
    view.unmount();
    window.dispatchEvent(new Event("focus"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("surfaces failure to open system privacy settings", async () => {
    vi.mocked(desktopPermissions).mockReturnValue({
      list: vi.fn().mockResolvedValue([{ id: "camera", decision: "allowed", system: "denied" }]),
      openSystemSettings: vi.fn().mockRejectedValue(new Error("System Settings unavailable")),
      subscribe: () => () => {},
    });
    render(<DesktopPermissionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open System Settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("System Settings unavailable");
  });

  it("refreshes a completion arriving during an in-flight status read", async () => {
    let finish!: (value: unknown) => void;
    let changed!: () => void;
    const list = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue([{ id: "camera", decision: "allowed", system: "granted" }]);
    const unsubscribe = vi.fn();
    vi.mocked(desktopPermissions).mockReturnValue({ list, openSystemSettings: vi.fn(),
      subscribe: listener => { changed = listener; return unsubscribe; } });
    const view = render(<DesktopPermissionsPanel />);
    await act(async () => {
      changed();
      finish([{ id: "camera", decision: "pending", system: "not-determined" }]);
    });
    expect(await screen.findByText("App: allowed · OS: granted")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
