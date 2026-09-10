// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { attachNativeOutput } from "./native-output.ts";

describe("native output surface ownership", () => {
  function fixture() {
    const doc = document.implementation.createHTMLDocument();
    const canvas = doc.createElement("canvas");
    const presentation = { setOutput: vi.fn(), dispose: vi.fn() };
    const present = vi.fn(() => presentation);
    const backend = { present } as unknown as LoomBackend;
    const attached = attachNativeOutput(backend, { resourceId: "a", size: [1920, 1080] }, canvas);
    return { attached, doc, canvas, present, presentation };
  }
  it("uses the supplied surface at exact output size and reuses one backend presentation", () => {
    const h = fixture();
    const canvas = h.canvas;
    expect(canvas.ownerDocument).toBe(h.doc);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    expect(h.present).toHaveBeenCalledWith(canvas, { outputId: "a", label: "native-sdr-output" });
    h.attached.update({ resourceId: "b", size: [1280, 720] });
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(h.presentation.setOutput).toHaveBeenCalledWith("b");
    expect(h.present).toHaveBeenCalledTimes(1);
    h.attached.dispose();
  });
  it("close retires the presentation once and prevents stale updates", () => {
    const h = fixture();
    h.attached.dispose();
    h.attached.dispose();
    expect(h.presentation.dispose).toHaveBeenCalledTimes(1);
    expect(() => h.attached.update({ resourceId: "b", size: [1, 1] })).toThrow("closed");
  });
});
