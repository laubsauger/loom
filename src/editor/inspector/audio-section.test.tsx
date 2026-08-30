import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { AudioSection } from "./audio-section.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";

/**
 * T434(b)/T432: the audio capture surface.
 *
 * The three faces of one status — denied permission, failed URL, vanished device — all
 * land here, and the LABEL TRAP is pinned: `enumerateDevices()` hands back empty labels
 * until mic permission is granted, and a list of blanks must read as a permissions
 * state, never as broken hardware (§V288).
 */

afterEach(cleanup);

const editorStub = (): ParameterEditor & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    setParameter: (...args: unknown[]) => void calls.push(args),
  } as never;
};

function mockDevices(devices: Array<{ deviceId: string; label: string }>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () => Promise.resolve(devices.map((entry) => ({ ...entry, kind: "audioinput" }))),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

describe("AudioSection (T434/T432)", () => {
  it("says WHY everything reads zero: the error status carries its message", () => {
    mockDevices([]);
    render(
      <AudioSection
        nodeId={"a" as never}
        nodeType="audioIn"
        device=""
        status={{ kind: "error", message: "Permission denied" }}
        editor={editorStub()}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Capture failed");
    expect(status.textContent).toContain("Permission denied");
  });

  it("blank device labels name the PERMISSIONS state, not broken hardware", async () => {
    mockDevices([
      { deviceId: "d1", label: "" },
      { deviceId: "d2", label: "" },
    ]);
    render(
      <AudioSection
        nodeId={"a" as never}
        nodeType="audioIn"
        device=""
        status={{ kind: "idle" }}
        editor={editorStub()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Grant microphone access to see device names.")).toBeTruthy();
    });
    // And the options still render, positionally named, so a user CAN pick blind.
    expect(screen.getByText("Microphone 1")).toBeTruthy();
  });

  it("picking a device writes the node's device parameter as one commit", async () => {
    mockDevices([{ deviceId: "usb-7", label: "USB Interface" }]);
    const editor = editorStub();
    render(
      <AudioSection nodeId={"mic" as never} nodeType="audioIn" device="" status={{ kind: "live" }} editor={editor} />,
    );
    await waitFor(() => expect(screen.getByText("USB Interface")).toBeTruthy());
    const select = screen.getByLabelText("Microphone device") as HTMLSelectElement;
    select.value = "usb-7";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(editor.calls).toEqual([["mic", "device", "usb-7", "commit"]]);
  });

  it("the file node shows status only — there is no device to pick for a file", () => {
    mockDevices([{ deviceId: "d1", label: "Mic" }]);
    render(
      <AudioSection
        nodeId={"f" as never}
        nodeType="audioFileIn"
        device=""
        status={{ kind: "live" }}
        editor={editorStub()}
      />,
    );
    expect(screen.queryByLabelText("Microphone device")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Capturing");
  });
});
