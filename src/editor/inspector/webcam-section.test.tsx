// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { WebcamSection } from "./webcam-section.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";

/**
 * T810: the webcam's camera picker, mirroring the microphone's (T434) so the two are one
 * convention. The LABEL TRAP is pinned here exactly as `audio-section.test.tsx` pinned it
 * for audio: `enumerateDevices()` hands back empty labels until camera permission is
 * granted, and a list of blanks must read as a permissions state, never as broken
 * hardware (§V288). §V721 is structural in the component — it calls `enumerateDevices`
 * and nothing else, so drawing the inspector can never prompt; the mock below would
 * throw on any `getUserMedia` because it does not define one.
 */

afterEach(cleanup);

const editorStub = (): ParameterEditor & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    setParameter: (...args: unknown[]) => void calls.push(args),
  } as never;
};

function mockDevices(devices: Array<{ deviceId: string; label: string; kind?: string }>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () =>
        Promise.resolve(devices.map((entry) => ({ kind: "videoinput", ...entry }))),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

describe("WebcamSection (T810)", () => {
  it("blank device labels name the PERMISSIONS state, not broken hardware", async () => {
    mockDevices([
      { deviceId: "c1", label: "" },
      { deviceId: "c2", label: "" },
    ]);
    render(<WebcamSection nodeId={"cam" as never} device="" editor={editorStub()} />);
    await waitFor(() => {
      expect(screen.getByText("Grant camera access to see device names.")).toBeTruthy();
    });
    // And the options still render, positionally named, so a user CAN pick blind.
    expect(screen.getByText("Camera 1")).toBeTruthy();
  });

  it("picking a camera writes the node's device parameter as one commit", async () => {
    mockDevices([{ deviceId: "usb-cam-3", label: "External USB Camera" }]);
    const editor = editorStub();
    render(<WebcamSection nodeId={"cam" as never} device="" editor={editor} />);
    await waitFor(() => expect(screen.getByText("External USB Camera")).toBeTruthy());
    const select = screen.getByLabelText("Camera device") as HTMLSelectElement;
    select.value = "usb-cam-3";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(editor.calls).toEqual([["cam", "device", "usb-cam-3", "commit"]]);
  });

  it("lists only cameras — microphones are the other picker's business", async () => {
    mockDevices([
      { deviceId: "mic-1", label: "Microphone", kind: "audioinput" },
      { deviceId: "cam-1", label: "FaceTime HD", kind: "videoinput" },
    ]);
    render(<WebcamSection nodeId={"cam" as never} device="" editor={editorStub()} />);
    await waitFor(() => expect(screen.getByText("FaceTime HD")).toBeTruthy());
    expect(screen.queryByText("Microphone")).toBeNull();
  });
});
