// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { attachNativeOutput, desktopOutputBridge, nativeOutputEncodes, type DesktopOutputBridge } from "./native-output.ts";
import { DEFAULT_COLOR_POLICY } from "@domain/types/graph.ts";

afterEach(() => { delete (window as Window & { loomDesktop?: unknown }).loomDesktop; });

describe("explicit native output transport capability", () => {
  const completeBridge = (): DesktopOutputBridge => ({ nativeOutput: true,
    open: vi.fn(async () => {}), close: vi.fn(async () => {}), resize: vi.fn(async () => {}),
    status: vi.fn(async () => ({ copied: 0, dropped: 0, error: null })) });
  const install = (desktop: unknown) => { (window as Window & { loomDesktop?: unknown }).loomDesktop = desktop; };

  it("does not advertise outputs in browser, preparation-only or lifecycle-only shells", () => {
    for (const desktop of [undefined, {}, { preparation: {} }, { lifecycle: {} },
      { preparation: {}, lifecycle: {}, nativeOutput: false }, { nativeOutput: "true" }]) {
      install(desktop);
      for (const transport of ["syphon", "ndi", "spout"] as const) expect(desktopOutputBridge(transport)).toBeUndefined();
    }
  });

  it("returns complete marked bridges by identity for exactly their own transport", () => {
    const syphon = completeBridge(), ndi = completeBridge(), spout = completeBridge();
    install({ ...syphon, ndiOutput: ndi, spoutOutput: spout });
    const desktop = (window as Window & { loomDesktop?: unknown }).loomDesktop;
    expect(desktopOutputBridge()).toBe(desktop);
    expect(desktopOutputBridge("ndi")).toBe(ndi);
    expect(desktopOutputBridge("spout")).toBe(spout);
    expect(syphon.open).not.toHaveBeenCalled();
    expect(ndi.open).not.toHaveBeenCalled();
    expect(spout.open).not.toHaveBeenCalled();
  });

  it("never substitutes a different native transport when the requested one is absent", () => {
    const ndi = completeBridge();
    install({ preparation: {}, lifecycle: {}, ndiOutput: ndi });
    expect(desktopOutputBridge("syphon")).toBeUndefined();
    expect(desktopOutputBridge("ndi")).toBe(ndi);
    expect(desktopOutputBridge("spout")).toBeUndefined();
    install({ ...completeBridge(), ndiOutput: { nativeOutput: false }, spoutOutput: {} });
    expect(desktopOutputBridge("ndi")).toBeUndefined();
    expect(desktopOutputBridge("spout")).toBeUndefined();
  });

  it.each(["syphon", "ndi", "spout"] as const)("rejects an incomplete advertised %s output", transport => {
    const partial = { nativeOutput: true, open: vi.fn() };
    install(transport === "syphon" ? partial : { [transport === "ndi" ? "ndiOutput" : "spoutOutput"]: partial });
    expect(() => desktopOutputBridge(transport)).toThrow(new RegExp(`Invalid ${transport} native output bridge`));
  });
});

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
    expect(h.present).toHaveBeenCalledWith(canvas, { outputId: "a", label: "native-sdr-output", displayEncode: false });
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

/*
 * VNB25: the Output node's decision (`sinkDisplayTransform`, tone map `none`), read against
 * the space the compiler published for the source a native output is wired to.
 */
describe("native output display encode", () => {
  const none = { workingSpace: "linear", displayTransform: "none" } as const;
  it.each([
    ["rgba16float", "linear", DEFAULT_COLOR_POLICY, true],
    ["rgba8unorm", "linear", DEFAULT_COLOR_POLICY, true],
    // Presented through a non-decoding view (T1307): the bytes are already display values.
    ["rgba8unorm-srgb", "linear", DEFAULT_COLOR_POLICY, false],
    ["rgba16float", "encoded", DEFAULT_COLOR_POLICY, false],
    ["rgba8unorm", "encoded", DEFAULT_COLOR_POLICY, false],
    ["rgba16float", "data", DEFAULT_COLOR_POLICY, false],
    ["rgba16float", "linear", none, false],
  ] as const)("%s %s under %o encodes: %s", (format, space, policy, expected) => {
    expect(nativeOutputEncodes({ format, space }, policy)).toBe(expected);
  });
  it("presents with the encode and refuses to change it in place", () => {
    const presentation = { setOutput: vi.fn(), dispose: vi.fn() };
    const present = vi.fn(() => presentation);
    const canvas = { width: 0, height: 0, getContext: () => null };
    const attached = attachNativeOutput({ present } as unknown as LoomBackend, { resourceId: "a", size: [4, 4], encode: true }, canvas);
    expect(present).toHaveBeenCalledWith(canvas, { outputId: "a", label: "native-sdr-output", displayEncode: true });
    attached.update({ resourceId: "b", size: [4, 4], encode: true });
    expect(presentation.setOutput).toHaveBeenCalledWith("b");
    expect(() => attached.update({ resourceId: "b", size: [4, 4], encode: false })).toThrow("cannot change in place");
  });
});
