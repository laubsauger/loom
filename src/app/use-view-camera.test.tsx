// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewOrbitStore } from "@editor/viewer/preview-orbit-store.ts";
import type { UniformUpdate } from "@runtime/backend/backend-types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { ResolvedOutput } from "@compiler/types.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { useViewCameraOverride } from "./use-view-camera.ts";

/**
 * §T1311b(a) — the DELIVERY half of the view-camera contract.
 *
 * The compiler publishes a viewport row and a pass to write; this hook is what turns the
 * viewer's orbit — which has existed since §T379 and had nowhere to land for a marcher —
 * into the uniforms that pass actually reads. Three things it has to get right, and each
 * of them is a way the feature could ship looking finished and do nothing:
 *
 *  1. it writes an EYE, a TARGET and an ANGLE. Not a `viewProjection`: a marcher builds a
 *     ray per pixel and has no vertices to transform, which is the measured reason this
 *     contract exists rather than a second gate on the scene path's push;
 *  2. it writes them to the VIEWPORT pass and to nothing else. That is the view-only
 *     ruling expressed as the only pass id in scope;
 *  3. a row with NO view camera gets no push at all — the refusal, as an absence of
 *     traffic rather than a guard that runs and declines.
 */

const NODE = "temple" as NodeId;
const VIEWPORT_PASS = "temple#viewport:out";

function recordingBackend() {
  const updates: UniformUpdate[] = [];
  const backend = {
    updateUniforms(update: UniformUpdate) {
      updates.push(update);
    },
  } as unknown as LoomBackend;
  return { backend, updates };
}

const viewportRow = (): ResolvedOutput =>
  ({
    nodeId: NODE,
    portId: "out#view",
    resourceId: "viewport:temple:out",
    resourceKind: "target",
    size: [960, 540],
    format: "rgba8unorm",
    space: "linear",
    temporal: false,
    viewCamera: {
      passId: VIEWPORT_PASS,
      eye: [0, 1.62, -5.2],
      lookAt: [0, 1.9, 6],
      fovY: 1.0638,
      aspect: 960 / 540,
    },
  }) as unknown as ResolvedOutput;

/** The same node's ORDINARY output row: a real texture, and no view camera on it. */
const authoredRow = (): ResolvedOutput =>
  ({
    nodeId: NODE,
    portId: "out",
    resourceId: "target:temple:out",
    resourceKind: "target",
    size: [1280, 720],
    format: "rgba8unorm",
    space: "linear",
    temporal: false,
  }) as unknown as ResolvedOutput;

function Harness(props: {
  backend: LoomBackend;
  output: ResolvedOutput;
  orbits: ReturnType<typeof createPreviewOrbitStore>;
}) {
  useViewCameraOverride({ backend: props.backend, output: props.output, orbits: props.orbits });
  return null;
}

afterEach(cleanup);

describe("the viewer's inspection camera reaches a shader that declared one", () => {
  it("pushes the HOME framing on mount — an eye, a target and an angle, never a matrix", () => {
    const { backend, updates } = recordingBackend();
    const orbits = createPreviewOrbitStore();
    render(<Harness backend={backend} output={viewportRow()} orbits={orbits} />);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.passId).toBe(VIEWPORT_PASS);
    // Identity deltas reproduce the author's own numbers exactly — that is what makes
    // "home" honest rather than approximately where you started.
    expect(updates[0]?.values).toEqual({
      viewEye: [0, 1.62, -5.2],
      viewTarget: [0, 1.9, 6],
      viewFov: 1.0638,
      viewOverride: 1,
    });
    expect(Object.keys(updates[0]?.values ?? {})).not.toContain("viewProjection");
  });

  it("moves the eye when the camera is orbited, and puts it back when the camera goes home", () => {
    const { backend, updates } = recordingBackend();
    const orbits = createPreviewOrbitStore();
    render(<Harness backend={backend} output={viewportRow()} orbits={orbits} />);
    const home = updates[0]?.values;

    /*
     * `apply` is silent by design (the preview system reads the orbit when it builds each
     * frame's request), so the hook polls while adjustable. Entering the mode DOES notify,
     * which is what starts the poll — and this is the assertion that the poll exists: with
     * no frame reader the drag below would move nothing at all.
     */
    act(() => {
      orbits.setMode(NODE, "adjustable");
      orbits.apply(NODE, { azimuth: 0.6 });
    });
    act(() => {
      // One animation frame is all the poll needs; jsdom's rAF fires on a timer.
      window.dispatchEvent(new Event("resize"));
    });
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const moved = updates[updates.length - 1]?.values;
          expect(moved).not.toEqual(home);
          expect(updates[updates.length - 1]?.passId).toBe(VIEWPORT_PASS);
          // Leaving adjustable is the way back to the baked framing, and it has to PUSH:
          // the pass still holds the last drag's values, so a mode change that only
          // stopped polling would leave the viewport wherever the user let go.
          act(() => {
            orbits.setMode(NODE, "home");
          });
          expect(updates[updates.length - 1]?.values).toEqual(home);
          resolve();
        });
      });
    });
  });

  it("pushes NOTHING for an output that declared no view camera — the refusal, as silence", () => {
    const { backend, updates } = recordingBackend();
    const orbits = createPreviewOrbitStore();
    render(<Harness backend={backend} output={authoredRow()} orbits={orbits} />);
    act(() => {
      orbits.setMode(NODE, "adjustable");
      orbits.apply(NODE, { azimuth: 0.6 });
    });
    // The authored pass is not addressable from here and this is the proof: a marcher's
    // own output row carries no pass id, so there is nothing for a drag to write to.
    expect(updates).toEqual([]);
  });
});
