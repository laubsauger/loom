import { describe, expect, it } from "vitest";
import { defaultParameters } from "@domain/parameters/index.ts";
import { webcamNode } from "@nodes/definitions/index.ts";
import {
  NO_CAMERA_REQUEST,
  cameraConstraints,
  cameraGrantOf,
  cameraLimitsOf,
  cameraRequestOf,
  cameraShortfall,
  requiredFormatText,
  type CameraRequest,
} from "./camera-request.ts";

/**
 * T1043 — the request/grant split, at the level where it is pure arithmetic.
 *
 * `use-media-sources.test.tsx` proves the WIRING: that the parameters reach the camera
 * door, that the grant reaches the inspector, and that nothing echoes. This file proves
 * the rules those claims rest on, and every one of them is a §V986 rule: an absence stays
 * an absence, all the way from `getSettings()` to the sentence a person reads.
 */

function request(overrides: Partial<CameraRequest> = {}): CameraRequest {
  return { ...NO_CAMERA_REQUEST, ...overrides };
}

describe("cameraRequestOf — the document, read statically (T1043)", () => {
  /**
   * THE COMPATIBILITY CLAIM, and the reason this file imports the node definition.
   *
   * `cameraRequestOf` reads STORED values, not the schema, so a declared default and the
   * absent-key answer are two independently authored facts that could silently disagree —
   * a `fit` default of "require" would show Require in the inspector while the hook
   * negotiated Prefer. Pinning them equal is what keeps the parameters' own descriptions
   * true, and it is also the "nothing changed for old documents" claim: a webcam node that
   * stored nothing negotiates exactly what a freshly created one does.
   */
  it("the shipped defaults and an empty parameter bag ask for the SAME thing", () => {
    const fresh = defaultParameters(webcamNode.parameters);
    expect(cameraRequestOf(fresh)).toEqual(cameraRequestOf({}));
    expect(cameraRequestOf({})).toEqual(NO_CAMERA_REQUEST);
  });

  it("reads every Capture knob, and rounds a size to whole pixels", () => {
    expect(
      cameraRequestOf({
        device: "usb-7",
        width: 1280.4,
        height: 720,
        frameRate: 30,
        facing: "user",
        fit: "require",
      }),
    ).toEqual({
      device: "usb-7",
      width: 1280,
      height: 720,
      frameRate: 30,
      facing: "user",
      exact: true,
    });
  });

  it("a nonsense value is UNASKED, never a constraint nobody wrote", () => {
    // A negative, a NaN, a string where a number belongs, an unknown facing: each one
    // reaching `getUserMedia` would narrow the negotiation on a request the user never
    // made, which is worse than ignoring it — the camera would refuse or substitute and
    // nothing would say why.
    expect(
      cameraRequestOf({ width: -100, height: Number.NaN, frameRate: "60", facing: "sideways" }),
    ).toEqual(NO_CAMERA_REQUEST);
  });
});

describe("cameraConstraints — a request, expressed as a negotiation (T1043)", () => {
  it("asks for nothing when nothing is asked, which is the pre-T1043 `video: true`", () => {
    expect(cameraConstraints(NO_CAMERA_REQUEST)).toBe(true);
  });

  it("PREFER asks with `ideal`; REQUIRE asks with `exact`", () => {
    expect(cameraConstraints(request({ width: 1920, height: 1080, frameRate: 60 }))).toEqual({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    });
    expect(
      cameraConstraints(request({ width: 1920, height: 1080, frameRate: 60, exact: true })),
    ).toEqual({
      width: { exact: 1920 },
      height: { exact: 1080 },
      frameRate: { exact: 60 },
    });
  });

  /**
   * FACING IS ALWAYS A PREFERENCE, EVEN UNDER REQUIRE — the parameter's own description
   * says so, and this is the claim behind it. Most desktop webcams report no facing mode
   * at all, so `facingMode: { exact: "user" }` would refuse to open the only camera on the
   * machine: a knob that bricks the node on the most common hardware there is.
   */
  it("facing is `ideal` under Require too", () => {
    expect(cameraConstraints(request({ facing: "user", exact: true })).valueOf()).toEqual({
      facingMode: { ideal: "user" },
    });
  });

  it("a chosen device is exact, and it silences the facing preference", () => {
    // The device decides which camera this is; a facing alongside it is a second, weaker
    // answer to the same question, and handing the browser both invites it to pick.
    expect(cameraConstraints(request({ device: "usb-7", facing: "environment" }))).toEqual({
      deviceId: { exact: "usb-7" },
    });
  });

  it("one axis alone is a legal request — a height with any width", () => {
    expect(cameraConstraints(request({ height: 720 }))).toEqual({ height: { ideal: 720 } });
  });
});

describe("cameraGrantOf / cameraLimitsOf — §V986, absence stays absence", () => {
  it("no settings at all is NULL, not a grant full of zeros", () => {
    expect(cameraGrantOf(undefined)).toBeNull();
    // A browser that answers with nothing this node reads: `{ width: 0, height: 0 }` would
    // be a measurement of a camera producing no pixels, which is a different and much more
    // alarming fact than "this browser did not say".
    expect(cameraGrantOf({})).toBeNull();
    expect(cameraGrantOf({ width: 0, height: 0, frameRate: 0 })).toBeNull();
  });

  it("a PARTIAL report keeps what was said and drops what was not", () => {
    expect(cameraGrantOf({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(cameraGrantOf({ width: 1280, height: 720 })).not.toHaveProperty("frameRate");
  });

  it("carries the facing and device the track reports", () => {
    expect(cameraGrantOf({ facingMode: "environment", deviceId: "usb-7" })).toEqual({
      facing: "environment",
      deviceId: "usb-7",
    });
  });

  it("a browser with no getCapabilities reports NO limits, not unlimited ones", () => {
    expect(cameraLimitsOf(undefined)).toBeNull();
    expect(cameraLimitsOf({})).toBeNull();
    expect(cameraLimitsOf({ width: { max: 1920 }, height: { max: 1080 } })).toEqual({
      maxWidth: 1920,
      maxHeight: 1080,
    });
  });
});

describe("cameraShortfall — the sentence that stops the knob from lying", () => {
  it("names every axis the camera declined", () => {
    const asked = request({ width: 1920, height: 1080, frameRate: 60 });
    const said = cameraShortfall(asked, { width: 1280, height: 720, frameRate: 30 });
    expect(said).toContain("1920 px wide, got 1280");
    expect(said).toContain("1080 px high, got 720");
    expect(said).toContain("60 fps, got 30");
  });

  /** §V968's known negative: a detector that always fires is not a detector. */
  it("says NOTHING when the camera met the request", () => {
    const asked = request({ width: 1280, height: 720, frameRate: 30 });
    expect(cameraShortfall(asked, { width: 1280, height: 720, frameRate: 30 })).toBeNull();
  });

  /**
   * An UNREPORTED grant is an unknown, not a decline. Calling it a shortfall would put a
   * warning under every camera on a browser that keeps quiet — §V986's failure mode
   * ("cannot see" rendered as "something is wrong") from the other direction.
   */
  it("says nothing about a member the browser did not report, and nothing at all for a null grant", () => {
    expect(cameraShortfall(request({ width: 1920, frameRate: 60 }), { width: 1920 })).toBeNull();
    expect(cameraShortfall(request({ width: 1920 }), null)).toBeNull();
  });

  /**
   * A camera asked for 30 reports 29.97 or 30.000030517578125 as readily as 30. Calling
   * that a declined request would cry wolf on the most ordinary case there is, while the
   * substitution this exists to surface — 30 asked, 15 granted — is a whole frame away.
   */
  it("tolerates a frame rate that is the one you asked for in a camera's arithmetic", () => {
    expect(cameraShortfall(request({ frameRate: 30 }), { frameRate: 29.97 })).toBeNull();
    expect(cameraShortfall(request({ frameRate: 30 }), { frameRate: 15 })).toContain("got 15");
  });

  it("a facing the camera did not honour is a shortfall; a chosen device makes it moot", () => {
    expect(cameraShortfall(request({ facing: "environment" }), { facing: "user" })).toContain(
      "the environment camera, got user",
    );
    // With a device named, the facing was never sent, so it cannot have been declined.
    expect(
      cameraShortfall(request({ device: "usb-7", facing: "environment" }), { facing: "user" }),
    ).toBeNull();
  });
});

describe("requiredFormatText — what a Require refusal names", () => {
  it("names the numbers, because the browser's constraint token names nothing actionable", () => {
    expect(requiredFormatText(request({ width: 3840, height: 2160, frameRate: 60 }))).toBe(
      "3840 x 2160 at 60 fps",
    );
    expect(requiredFormatText(request({ height: 720 }))).toBe("720 px height");
    expect(requiredFormatText(request({ frameRate: 120 }))).toBe("120 fps");
  });
});
