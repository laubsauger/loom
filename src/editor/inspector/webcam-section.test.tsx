// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { WebcamSection } from "./webcam-section.tsx";
import { NO_CAMERA_REQUEST, type CameraStatus } from "@/app/camera-request.ts";
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
    render(<WebcamSection nodeId={"cam" as never} device="" status={null} editor={editorStub()} />);
    await waitFor(() => {
      expect(screen.getByText("Grant camera access to see device names.")).toBeTruthy();
    });
    // And the options still render, positionally named, so a user CAN pick blind.
    expect(screen.getByText("Camera 1")).toBeTruthy();
  });

  it("picking a camera writes the node's device parameter as one commit", async () => {
    mockDevices([{ deviceId: "usb-cam-3", label: "External USB Camera" }]);
    const editor = editorStub();
    render(<WebcamSection nodeId={"cam" as never} device="" status={null} editor={editor} />);
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
    render(<WebcamSection nodeId={"cam" as never} device="" status={null} editor={editorStub()} />);
    await waitFor(() => expect(screen.getByText("FaceTime HD")).toBeTruthy());
    expect(screen.queryByText("Microphone")).toBeNull();
  });
});

/**
 * T1043 — THE READOUT, and it is the half that decides whether the Capture knobs are
 * worth having. `getUserMedia` substitutes silently, so what a user can SEE about the
 * substitution is the feature; the knobs alone would be a control that reads back a
 * number that is not true of the picture (§V827(2), §B172's shape).
 */
describe("WebcamSection's camera readout (T1043)", () => {
  const liveStatus = (overrides: Partial<CameraStatus> = {}): CameraStatus => ({
    kind: "live",
    requested: NO_CAMERA_REQUEST,
    granted: null,
    limits: null,
    ...overrides,
  });

  it("shows the GRANTED size beside the requested one when the camera declined", async () => {
    mockDevices([]);
    render(
      <WebcamSection
        nodeId={"cam" as never}
        device=""
        status={liveStatus({
          requested: { ...NO_CAMERA_REQUEST, width: 1920, height: 1080 },
          granted: { width: 1280, height: 720, frameRate: 30 },
          limits: { maxWidth: 1280, maxHeight: 720 },
        })}
        editor={editorStub()}
      />,
    );
    // Both numbers, in two separate rows, because the whole point is that they differ.
    await waitFor(() => expect(screen.getByLabelText("Camera request").textContent).toContain("1920 x 1080"));
    expect(screen.getByLabelText("Camera grant").textContent).toContain("1280 x 720");
    // And the difference said in words, so nobody has to spot it by comparing two rows.
    expect(screen.getByText(/Asked for 1920 px wide, got 1280/)).toBeTruthy();
    // §V985: what this camera CAN do, beside the field that asks for it.
    expect(screen.getByText("This camera reports up to 1280 x 720.")).toBeTruthy();
  });

  /**
   * §V986 — a browser that reports nothing must read as ABSENT. A confident "0 x 0" here
   * is indistinguishable from a real measurement of a camera producing no pixels, and it
   * is the number a reader would believe.
   */
  it("a browser that reports no settings says so, and prints no zeros", async () => {
    mockDevices([]);
    render(
      <WebcamSection
        nodeId={"cam" as never}
        device=""
        status={liveStatus({ requested: { ...NO_CAMERA_REQUEST, width: 1920 } })}
        editor={editorStub()}
      />,
    );
    const grant = await screen.findByLabelText("Camera grant");
    expect(grant.textContent).toContain("not reported by this browser");
    expect(grant.textContent).not.toContain("0");
    // An unreported grant is an UNKNOWN, not a decline: no shortfall sentence appears.
    expect(screen.queryByText(/Asked for/)).toBeNull();
  });

  it("a refused camera says WHY, where the user is already looking", async () => {
    mockDevices([]);
    render(
      <WebcamSection
        nodeId={"cam" as never}
        device=""
        status={{
          kind: "error",
          message: 'The camera for "cam" cannot do the REQUIRED 3840 x 2160.',
          requested: { ...NO_CAMERA_REQUEST, width: 3840, height: 2160, exact: true },
          granted: null,
          limits: null,
        }}
        editor={editorStub()}
      />,
    );
    expect(await screen.findByText(/cannot do the REQUIRED 3840 x 2160/)).toBeTruthy();
  });
});
