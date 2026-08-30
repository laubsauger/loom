import { describe, expect, it } from "vitest";
import type { ResourceDescriptor } from "@runtime/backend/plan.ts";
import { buildResources } from "@runtime/backend/vgpu/resources.ts";
import { mockGpuHost } from "@runtime/backend/vgpu/mock-gpu-host.ts";
import { createFrameGuard } from "@runtime/backend/frame-guard.ts";

/**
 * A webcam frame has to be able to LAND (B: media upload, §V135, §V240).
 *
 * The Webcam and Movie File In nodes declare an `externalTexture`; the backend uploads
 * into it. There are two upload paths and the product only ever takes one of them:
 *
 *  - `bytes` → `queue.writeTexture`, which needs `COPY_DST`. Every existing test takes
 *    this path, because a headless Dawn run has no `<video>` to hand over.
 *  - `image` → `queue.copyExternalImageToTexture`, which is what a real camera, video or
 *    canvas takes in a browser, and which the WebGPU spec requires the destination to
 *    have `COPY_DST | RENDER_ATTACHMENT` for — the implementation performs the copy as a
 *    draw, and that is what buys the colour-space conversion and the flip.
 *
 * The texture was created with `TEXTURE_BINDING | COPY_DST`, so every camera frame failed
 * validation. It failed the way §V240 warns about: `copyExternalImageToTexture` reports on
 * the device's UNCAPTURED-ERROR path rather than throwing, so the `try/catch` around the
 * upload never saw it, the "Media upload failed" diagnostic never fired, and the node
 * simply stayed black.
 *
 * This asserts the usage because the usage is the whole fault, and because the pixel-level
 * proof is unreachable here: Node has no `HTMLVideoElement`, so no headless test can drive
 * the image path at all. That gap is exactly how this shipped.
 */
describe("an externalTexture can receive a browser image (§V135)", () => {
  it("is created with RENDER_ATTACHMENT, which copyExternalImageToTexture requires", async () => {
    const session = await mockGpuHost().create({});
    const gpu = session.gpu;
    const created: Array<Record<string, unknown>> = [];
    const device = gpu.device as unknown as { createTexture(d: Record<string, unknown>): unknown };
    const original = device.createTexture.bind(device);
    device.createTexture = (descriptor) => {
      created.push(descriptor);
      return original(descriptor);
    };

    const resource: ResourceDescriptor = {
      kind: "externalTexture",
      id: "media",
      size: [640, 480],
      format: "rgba8unorm-srgb",
      sourceId: "media:webcam1",
    };
    const set = buildResources(gpu, [resource], [], createFrameGuard());

    expect(set.externalTextures.get("media")?.sourceId).toBe("media:webcam1");
    expect(created).toHaveLength(1);
    const usage = created[0]?.["usage"] as ReadonlyArray<string>;
    expect(usage).toContain("copy_dst");
    expect(usage).toContain("texture_binding");
    expect(usage).toContain("render_attachment");

    session.dispose();
  });
});
