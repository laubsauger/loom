import { describe, expect, it } from "vitest";
import type { PreviewHostHandle } from "../backend/backend-types.ts";
import { createPreviewSystem } from "./system.ts";
import type { PreviewFrameCommand, PreviewProgram, PreviewRuntimeHost } from "./types.ts";

/**
 * Drift guard for the T87 seam.
 *
 * `backend.previewHost(canvas)` returns `PreviewHostHandle`, which the backend declares as
 * `PreviewRuntimeHost & { dispose() }` by importing this directory's type. The two sides never
 * edit each other's files, so the ONLY thing keeping them in step is that interface — and a
 * change to it on either side must fail here rather than at runtime in a browser.
 *
 * These assertions are structural (they compile or they do not); the runtime `expect`s exist so
 * the file is a test rather than a lint-silenced type exercise.
 */

/** Fails to compile if the backend's handle stops satisfying the seam. */
type HandleSatisfiesSeam = PreviewHostHandle extends PreviewRuntimeHost ? true : never;

/** Fails to compile if the seam grows a member the backend does not implement. */
type SeamHasNoExtraMembers = Exclude<keyof PreviewRuntimeHost, keyof PreviewHostHandle> extends never
  ? true
  : never;

describe("T87 — the backend's preview host satisfies this directory's seam", () => {
  it("is assignable in both directions the wiring depends on", () => {
    const assignable: HandleSatisfiesSeam = true;
    const complete: SeamHasNoExtraMembers = true;
    expect([assignable, complete]).toEqual([true, true]);
  });

  it("a handle-shaped object drives the system with no adapter in between", () => {
    // If this ever needs a shim, the seam has drifted and the shim is the bug.
    const programs: PreviewProgram[] = [];
    const commands: PreviewFrameCommand[] = [];
    const handle: PreviewHostHandle = {
      setPreviewProgram(program) {
        programs.push(program);
      },
      presentPreviews(command) {
        commands.push(command);
      },
      dispose() {},
    };

    const system = createPreviewSystem({ host: handle, capacity: 4 });
    system.update({
      requests: [
        {
          ref: { nodeId: "a", portId: "out" },
          source: { resourceId: "target/a", size: [1280, 720], format: "rgba16float" },
          rect: { x: 0, y: 0, width: 192, height: 108 },
          area: { width: 192, height: 108 },
          visible: true,
          pinned: false,
          collapsed: false,
          occluded: false,
          view: {
            mode: "color",
            channel: "r",
            channels: { r: true, g: true, b: true, a: true },
            exposureStops: 0,
            tonemap: false,
            checkerSize: 8,
            signedScale: 1,
          },
        },
      ],
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 1 },
      surface: { x: 0, y: 0, width: 800, height: 600 },
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });

    expect(programs).toHaveLength(1);
    expect(commands).toHaveLength(1);
    // The program the backend receives references the MAIN plan's output as an external
    // binding; the preview system never invents a source resource of its own.
    expect(programs[0]?.passes[0]?.textures?.[0]?.resourceId).toBe("target/a");
  });
});
