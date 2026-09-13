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

  it("T1319b — a live file node offers the measured floor, and says it IS a floor", () => {
    mockDevices([]);
    render(
      <AudioSection
        nodeId={"nd_1" as never}
        nodeType="audioFileIn"
        device=""
        status={{
          kind: "live",
          latency: { outputSeconds: 0.021, baseSeconds: 0.005, frameSeconds: 1 / 60, suggestedSeconds: 0.0427 },
        }}
        editor={editorStub()}
      />,
    );
    // "At least", and the part the browser cannot see — the sentence that stops someone who
    // is still late from concluding the feature is broken (§V985).
    expect(screen.getByText(/At least/)).toBeDefined();
    expect(screen.getByText(/display/i)).toBeDefined();
  });

  it("T1319b — applying the measurement writes syncOffset as one commit", () => {
    mockDevices([]);
    const editor = editorStub();
    render(
      <AudioSection
        nodeId={"nd_1" as never}
        nodeType="audioFileIn"
        device=""
        status={{
          kind: "live",
          latency: { outputSeconds: 0.021, baseSeconds: 0.005, frameSeconds: 1 / 60, suggestedSeconds: 0.0427 },
        }}
        editor={editor}
      />,
    );
    screen.getByRole("button", { name: "Use 43 ms" }).click();
    // The same write path the device picker uses: one value, one commit, one undo entry.
    expect(editor.calls).toEqual([["nd_1", "syncOffset", 0.043, "commit"]]);
  });

  it("T1319b(b) — the value in effect is shown, so the click has something to change", () => {
    mockDevices([]);
    render(
      <AudioSection
        nodeId={"nd_1" as never}
        nodeType="audioFileIn"
        device=""
        syncOffset={0}
        status={{
          kind: "live",
          latency: { outputSeconds: 0.021, baseSeconds: 0.005, frameSeconds: 1 / 60, suggestedSeconds: 0.0427 },
        }}
        editor={editorStub()}
      />,
    );
    // The owner's report: "we don't really feel like is this applied now?" The value in
    // effect is on screen, and the button NAMES the number it will write — so the click has
    // a visible before and after rather than a silent one.
    expect(screen.getByText(/Sync Offset 0 ms/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Use 43 ms" })).toBeDefined();
  });

  it("T1319b(b) — once applied, the button is replaced by the applied mark", () => {
    mockDevices([]);
    render(
      <AudioSection
        nodeId={"nd_1" as never}
        nodeType="audioFileIn"
        device=""
        syncOffset={0.043}
        status={{
          kind: "live",
          latency: { outputSeconds: 0.021, baseSeconds: 0.005, frameSeconds: 1 / 60, suggestedSeconds: 0.0427 },
        }}
        editor={editorStub()}
      />,
    );
    // State, not a flash: this still reads "applied" an hour after the click, which a toast
    // cannot do. And there is nothing left to press, because there is nothing left to apply.
    expect(screen.getByText(/— applied/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("T1319b — a microphone is offered nothing: live analysis cannot look ahead", () => {
    mockDevices([]);
    render(
      <AudioSection
        nodeId={"nd_1" as never}
        nodeType="audioIn"
        device=""
        status={{
          kind: "live",
          latency: { outputSeconds: 0.021, baseSeconds: 0.005, frameSeconds: 1 / 60, suggestedSeconds: 0.0427 },
        }}
        editor={editorStub()}
      />,
    );
    // Absent, not disabled: the sound has not happened yet, so there is no number to apply.
    expect(screen.queryByText(/At least/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("T1319b — an unmeasurable browser says so and offers NO value to apply (§V91)", () => {
    mockDevices([]);
    render(
      <AudioSection
        nodeId={"nd_1" as never}
        nodeType="audioFileIn"
        device=""
        status={{ kind: "live", latency: null }}
        editor={editorStub()}
      />,
    );
    expect(screen.getByText(/no audio output latency/)).toBeDefined();
    // A confident 0 ms is the one thing that must never be offered here.
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
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
