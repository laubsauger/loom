// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePreparedMap } from "@runtime/media/prepared-map.ts";
import type { FloatMap } from "@runtime/media/float-map.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { PhotoDepthWorkspace, type MaskEditing } from "./photo-depth-workspace.tsx";
import type { PreparationPhoto } from "./photo-preparation.ts";
import { depthPaletteLut } from "./photo-depth-palette.ts";

const photo: PreparationPhoto = { bitmap: { width: 4, height: 2 } as ImageBitmap, sha256: "a".repeat(64), name: "facade.png" };
let maps: { native: FloatMap | null; depth: FloatMap | null; mask: FloatMap | null };
let draw: ReturnType<typeof vi.fn>;
let put: ReturnType<typeof vi.fn>;
function prepared(kind: "depth" | "mask", values: Float32Array, width: number, height: number, letterbox = false) {
  return makePreparedMap(values, width, height, { kind, source: { sha256: photo.sha256, width: 4, height: 2 },
    model: { id: kind, url: `https://models.test/${kind}` }, inputSide: 518, registration: letterbox ? "letterbox" : "stretch" });
}
beforeEach(() => {
  installDomStubs();
  vi.stubGlobal("PointerEvent", MouseEvent);
  draw = vi.fn(); put = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage: draw, putImageData: put,
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(120) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  maps = {
    native: prepared("depth", new Float32Array([1000, 1000, 1000, 1000, 0, 1, 2, 3, 4, 5, 6, 7, 1000, 1000, 1000, 1000]), 4, 4, true),
    depth: prepared("depth", new Float32Array([0, 0.1, 0.3, 0.5, 0.6, 0.7, 0.9, 1]), 4, 2),
    mask: prepared("mask", new Float32Array([1, 0, 1, 1, 1, 1, 1, 1]), 4, 2),
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const readMaps = () => maps;
const select = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const pixelSample = () => screen.getByLabelText("Pixel sample");

describe("registered photo depth inspection", () => {
  it("keeps all float32 source samples unchanged across inspection, zoom and comparison", () => {
    const originals = [maps.native!, maps.depth!, maps.mask!].map(map => map.values.slice());
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    for (const view of ["Native depth", "Refined depth", "Surface mask", "Photo"]) {
      select(view); select("Zoom in"); select("Fit image");
    }
    select("Native depth"); fireEvent.click(screen.getByRole("checkbox", { name: "Compare depth stages" }));
    fireEvent.change(screen.getByRole("slider", { name: "Native and refined comparison split" }), { target: { value: "75" } });
    expect([maps.native!, maps.depth!, maps.mask!].map(map => map.values)).toEqual(originals);
    expect(screen.getByText("Native · resampled")).toBeDefined();
    expect(screen.getByText("Refined", { exact: true })).toBeDefined();
  });

  it("samples and pins the registered occupied band rather than the native letterbox bars", () => {
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="native" />);
    const canvas = screen.getByLabelText("Native depth display; numerical samples are shown below") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([4, 2]);
    const viewport = screen.getByRole("group", { name: "Native depth viewport" });
    fireEvent.pointerMove(viewport, { clientX: 256, clientY: 384 });
    expect(pixelSample().textContent).toContain("Photo (1, 1)");
    expect(pixelSample().textContent).toContain("Map (1, 2) · Raw 5.00000 · Near level 71.4%");
    const renders = put.mock.calls.length;
    fireEvent.pointerDown(viewport, { button: 0, clientX: 256, clientY: 384 });
    fireEvent.pointerUp(viewport, { button: 0, clientX: 256, clientY: 384 });
    fireEvent.pointerMove(viewport, { clientX: 768, clientY: 20 });
    expect(pixelSample().textContent).toContain("Map (1, 2)");
    expect(put).toHaveBeenCalledTimes(renders);
    expect(document.activeElement).toBe(viewport);
    select("Clear sample");
    expect(pixelSample().textContent).toContain("Map (3, 1)");
  });

  it("uses a focusable native range to change the comparison without changing map data", () => {
    // Grey, so a pixel's level is the sample this test reads; colour is the next test's.
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="depth" palette="grayscale" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare depth stages" }));
    const slider = screen.getByRole("slider", { name: "Native and refined comparison split" }) as HTMLInputElement;
    slider.focus();
    expect(document.activeElement).toBe(slider);
    expect(slider.type).toBe("range");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider.value).toBe("0");
    expect(screen.getByText("0%", { exact: true })).toBeDefined();
    const image = put.mock.calls.at(-1)![0] as ImageData;
    expect(image.data[4]).toBe(26);
    fireEvent.change(slider, { target: { value: "100" } });
    const nativeImage = put.mock.calls.at(-1)![0] as ImageData;
    expect(nativeImage.data[4]).toBe(36);
  });

  it("offers keyboard panning and resets framing and samples when view or reference changes", () => {
    const result = render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    const canvas = screen.getByLabelText("Photo display; numerical samples are shown below");
    const frame = canvas.parentElement!;
    const initial = frame.style.transform;
    const viewport = screen.getByRole("group", { name: "Photo viewport" });
    viewport.focus(); fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(frame.style.transform).not.toBe(initial);
    select("Native depth");
    const nativeFrame = screen.getByLabelText("Native depth display; numerical samples are shown below").parentElement!;
    expect(nativeFrame.style.transform).toBe(initial);
    const nativeViewport = screen.getByRole("group", { name: "Native depth viewport" });
    fireEvent.pointerDown(nativeViewport, { button: 0, clientX: 512, clientY: 384 });
    fireEvent.pointerUp(nativeViewport, { button: 0, clientX: 512, clientY: 384 });
    fireEvent.keyDown(nativeViewport, { key: "ArrowDown" });
    result.rerender(<PhotoDepthWorkspace photo={{ ...photo, name: "another.png" }} readMaps={readMaps} active="native" />);
    expect(screen.getByLabelText("Native depth display; numerical samples are shown below").parentElement!.style.transform).toBe(initial);
    expect(pixelSample().textContent).toContain("Hover for a sample");
  });

  it("disables unavailable maps and reports stale photo registration explicitly", () => {
    maps.depth = null; maps.mask = null;
    const result = render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="native" />);
    expect((screen.getByRole("button", { name: "Refined depth" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Surface mask" }) as HTMLButtonElement).disabled).toBe(true);
    result.rerender(<PhotoDepthWorkspace photo={{ ...photo, sha256: "b".repeat(64) }} readMaps={readMaps} active="native" />);
    expect(screen.getByRole("alert").textContent).toMatch(/different reference photo/);
    expect(screen.queryByLabelText("Native depth display; numerical samples are shown below")).toBeNull();
  });

  it("reports missing canvas support instead of silently showing an empty preview", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    expect(screen.getByRole("alert").textContent).toMatch(/requires a 2D canvas.*unavailable/);
  });

  it("identifies capped photograph previews and works without a ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<PhotoDepthWorkspace photo={{ ...photo, bitmap: { width: 8192, height: 2048 } as ImageBitmap }} readMaps={readMaps} />);
    expect(screen.getByText(/4096 × 1024 display · preview capped at 4096 px/)).toBeDefined();
    expect(screen.getByRole("button", { name: "100% working preview pixels" })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(draw).toHaveBeenCalledOnce();
  });

  it("offers all colour choices before prediction and retains the choice across views", () => {
    maps = { native: null, depth: null, mask: null };
    const result = render(<PhotoDepthWorkspace photo={null} readMaps={readMaps} />);
    const palette = screen.getByRole("combobox", { name: "Depth colours" }) as HTMLSelectElement;
    expect(palette.disabled).toBe(false);
    // Owner 2026-11-22: the shared maps first, Turbo (red near, blue far) the default.
    expect([...palette.options].map(option => option.text)).toEqual(["Turbo", "Spectral", "Viridis", "Inferno", "Grayscale", "Ocean", "Heat"]);
    expect(palette.value).toBe("turbo");
    fireEvent.change(palette, { target: { value: "spectral" } });
    result.rerender(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    expect(palette.value).toBe("spectral");
    maps.native = prepared("depth", new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]), 4, 2);
    result.rerender(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    select("Native depth"); select("Photo"); select("Native depth");
    expect(palette.value).toBe("spectral");
    expect(screen.getByRole("img", { name: "Relative depth colours from far to near" })).toBeDefined();
    expect(screen.queryByText(/brighter means nearer/)).toBeNull();
  });

  it("changes display colours while preserving float32 bits and pinned numerical samples", () => {
    const originals = [maps.native!, maps.depth!, maps.mask!].map(map => new Uint32Array(map.values.buffer).slice());
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="native" />);
    const viewport = screen.getByRole("group", { name: "Native depth viewport" });
    fireEvent.pointerDown(viewport, { button: 0, clientX: 256, clientY: 384 });
    fireEvent.pointerUp(viewport, { button: 0, clientX: 256, clientY: 384 });
    const sample = pixelSample().textContent;
    const grayscale = (put.mock.calls.at(-1)![0] as ImageData).data.slice();
    fireEvent.change(screen.getByRole("combobox", { name: "Depth colours" }), { target: { value: "ocean" } });
    const coloured = (put.mock.calls.at(-1)![0] as ImageData).data;
    expect(coloured).not.toEqual(grayscale);
    expect(pixelSample().textContent).toBe(sample);
    expect((screen.getByRole("button", { name: "Clear sample" }) as HTMLButtonElement).disabled).toBe(false);
    expect([maps.native!, maps.depth!, maps.mask!].map(map => new Uint32Array(map.values.buffer))).toEqual(originals);
    fireEvent.pointerMove(viewport, { clientX: 768, clientY: 20 });
    expect(pixelSample().textContent).toBe(sample);
  });

  it("applies one selected palette to both comparison halves without recolouring masks", () => {
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    select("Native depth"); fireEvent.click(screen.getByRole("checkbox", { name: "Compare depth stages" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Depth colours" }), { target: { value: "grayscale" } });
    const grayscale = (put.mock.calls.at(-1)![0] as ImageData).data.slice();
    fireEvent.change(screen.getByRole("combobox", { name: "Depth colours" }), { target: { value: "heat" } });
    const coloured = (put.mock.calls.at(-1)![0] as ImageData).data;
    const table = depthPaletteLut("heat");
    for (let pixel = 0; pixel < 8; pixel++) {
      const level = grayscale[pixel * 4]!;
      expect([...coloured.slice(pixel * 4, pixel * 4 + 3)]).toEqual([...table.slice(level * 3, level * 3 + 3)]);
    }
    select("Surface mask");
    const maskDisplay = (put.mock.calls.at(-1)![0] as ImageData).data.slice();
    fireEvent.change(screen.getByRole("combobox", { name: "Depth colours" }), { target: { value: "spectral" } });
    expect((put.mock.calls.at(-1)![0] as ImageData).data).toEqual(maskDisplay);
    select("Refined depth");
    expect((screen.getByRole("combobox", { name: "Depth colours" }) as HTMLSelectElement).value).toBe("spectral");
  });

  it("reports controlled palette changes and redraws when the host supplies the next choice", () => {
    const onPaletteChange = vi.fn();
    const result = render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="depth" palette="ocean" onPaletteChange={onPaletteChange} />);
    const original = (put.mock.calls.at(-1)![0] as ImageData).data.slice();
    fireEvent.change(screen.getByRole("combobox", { name: "Depth colours" }), { target: { value: "spectral" } });
    expect(onPaletteChange).toHaveBeenCalledWith("spectral");
    expect((screen.getByRole("combobox", { name: "Depth colours" }) as HTMLSelectElement).value).toBe("ocean");
    result.rerender(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="depth" palette="spectral" onPaletteChange={onPaletteChange} />);
    expect((put.mock.calls.at(-1)![0] as ImageData).data).not.toEqual(original);
    expect((screen.getByRole("combobox", { name: "Depth colours" }) as HTMLSelectElement).value).toBe("spectral");
  });

  function editor(change: Partial<MaskEditing> = {}): MaskEditing {
    return { enabled: true, mode: "erase", radius: 1, canUndo: true, canRedo: true, busy: false,
      onMode: vi.fn(), onRadius: vi.fn(), onPaint: vi.fn(), onFinish: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...change };
  }

  it("transports normalized brush gestures through the actual zoomed canvas without pan or sample pins", () => {
    const editing = editor(), original = [maps.native!, maps.depth!, maps.mask!].map(map => new Uint32Array(map.values.buffer).slice());
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="mask" maskEditing={editing} />);
    select("Zoom in");
    const canvas = screen.getByLabelText("Surface mask editor");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 100, top: 200, width: 800, height: 400 } as DOMRect);
    const frame = canvas.parentElement!, transform = frame.style.transform;
    const viewport = screen.getByRole("group", { name: "Surface mask viewport" });
    fireEvent.pointerDown(viewport, { button: 0, clientX: 300, clientY: 400 });
    fireEvent.pointerMove(viewport, { clientX: 700, clientY: 500 });
    fireEvent.pointerUp(viewport, { button: 0, clientX: 700, clientY: 500 });
    fireEvent.lostPointerCapture(viewport);
    expect(editing.onPaint).toHaveBeenNthCalledWith(1, { x: 0.25, y: 0.5 }, true);
    expect(editing.onPaint).toHaveBeenNthCalledWith(2, { x: 0.75, y: 0.75 }, false);
    expect(editing.onFinish).toHaveBeenCalledTimes(1);
    expect(frame.style.transform).toBe(transform);
    expect((screen.getByRole("button", { name: "Clear sample" }) as HTMLButtonElement).disabled).toBe(true);
    expect([maps.native!, maps.depth!, maps.mask!].map(map => new Uint32Array(map.values.buffer))).toEqual(original);
  });

  it("finishes cancelled, lost-capture, switched-view and unmounted strokes exactly once", () => {
    for (const ending of ["cancel", "lost", "view", "unmount"]) {
      const editing = editor();
      const result = render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} maskEditing={editing} />);
      select("Surface mask");
      const viewport = screen.getByRole("group", { name: "Surface mask viewport" });
      fireEvent.pointerDown(viewport, { button: 0, clientX: 512, clientY: 384 });
      if (ending === "cancel") { fireEvent.pointerCancel(viewport); fireEvent.lostPointerCapture(viewport); }
      if (ending === "lost") { fireEvent.lostPointerCapture(viewport); fireEvent.pointerCancel(viewport); }
      if (ending === "view") select("Photo");
      result.unmount();
      expect(editing.onFinish).toHaveBeenCalledTimes(1);
    }
  });

  it("shows controlled painting tools, adjustable brush footprint and undo/redo shortcuts", () => {
    const editing = editor();
    const result = render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="mask" maskEditing={editing} />);
    expect(screen.getByRole("button", { name: "Erase mask" }).getAttribute("aria-pressed")).toBe("true");
    select("Restore mask"); expect(editing.onMode).toHaveBeenCalledWith("restore");
    select("Pan mask"); expect(editing.onMode).toHaveBeenCalledWith("pan");
    fireEvent.change(screen.getByRole("slider", { name: "Mask brush radius" }), { target: { value: "24" } });
    expect(editing.onRadius).toHaveBeenCalledWith(24);
    const viewport = screen.getByRole("group", { name: "Surface mask viewport" });
    fireEvent.pointerMove(viewport, { clientX: 512, clientY: 384 });
    const before = screen.getByLabelText("Mask brush footprint").style.width;
    result.rerender(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="mask" maskEditing={{ ...editing, radius: 2 }} />);
    expect(screen.getByLabelText("Mask brush footprint").style.width).not.toBe(before);
    select("Undo mask stroke"); select("Redo mask stroke");
    fireEvent.keyDown(viewport, { key: "z", ctrlKey: true });
    fireEvent.keyDown(viewport, { key: "Z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(viewport, { key: "y", ctrlKey: true });
    expect(editing.onUndo).toHaveBeenCalledTimes(2); expect(editing.onRedo).toHaveBeenCalledTimes(3);
  });

  it("keeps Pan mode's normal viewport gestures and sampling without painting", () => {
    const editing = editor({ mode: "pan" });
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="mask" maskEditing={editing} />);
    const viewport = screen.getByRole("group", { name: "Surface mask viewport" });
    const frame = screen.getByLabelText("Surface mask editor").parentElement!;
    const initial = frame.style.transform;
    fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(viewport, { clientX: 250, clientY: 230 });
    fireEvent.pointerUp(viewport, { button: 0, clientX: 250, clientY: 230 });
    expect(frame.style.transform).not.toBe(initial); expect(editing.onPaint).not.toHaveBeenCalled();
    fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(viewport, { button: 0, clientX: 200, clientY: 200 });
    expect((screen.getByRole("button", { name: "Clear sample" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByLabelText("Mask brush footprint")).toBeNull();
  });

  it.each([{ busy: true }, { enabled: false }])("blocks painting and tool actions when editing is unavailable: %j", change => {
    const editing = editor(change);
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="mask" maskEditing={editing} />);
    for (const name of ["Erase mask", "Restore mask", "Pan mask", "Undo mask stroke", "Redo mask stroke"])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("slider", { name: "Mask brush radius" }) as HTMLInputElement).disabled).toBe(true);
    const viewport = screen.getByRole("group", { name: "Surface mask viewport" });
    fireEvent.pointerDown(viewport, { button: 0, clientX: 256, clientY: 384 });
    fireEvent.pointerMove(viewport, { clientX: 600, clientY: 400 }); fireEvent.pointerUp(viewport, { button: 0, clientX: 600, clientY: 400 });
    fireEvent.keyDown(viewport, { key: "z", ctrlKey: true }); fireEvent.keyDown(viewport, { key: "y", metaKey: true });
    expect(editing.onPaint).not.toHaveBeenCalled(); expect(editing.onFinish).not.toHaveBeenCalled();
    expect(editing.onUndo).not.toHaveBeenCalled(); expect(editing.onRedo).not.toHaveBeenCalled();
  });

  it("hosts the projection effect only in its selected large stage without map or brush tools", () => {
    const editing = editor(), selected = vi.fn();
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} maskEditing={editing}
      effectPreview={<div role="img" aria-label="Actual projection render" />} onSelect={selected} />);
    expect(screen.queryByRole("img", { name: "Actual projection render" })).toBeNull();
    expect(screen.getByLabelText("Photo display; numerical samples are shown below")).toBeDefined();
    select("Projection effect");
    expect(selected).toHaveBeenCalledWith("effect");
    const viewport = screen.getByRole("group", { name: "Projection effect viewport" });
    expect(screen.getByRole("img", { name: "Actual projection render" })).toBeDefined();
    expect(viewport.querySelector("canvas")).toBeNull();
    expect(screen.queryByLabelText("Pixel sample")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Compare depth stages" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Mask painting tools" })).toBeNull();
    expect(screen.getByRole("group", { name: "Viewport zoom" })).toBeDefined();
    fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(viewport, { clientX: 600, clientY: 400 }); fireEvent.pointerUp(viewport, { clientX: 600, clientY: 400 });
    expect(editing.onPaint).not.toHaveBeenCalled();
    select("Surface mask");
    expect(screen.queryByRole("img", { name: "Actual projection render" })).toBeNull();
    expect(screen.getByRole("img", { name: "Surface mask editor" })).toBeDefined();
  });

  it("makes effect selection available only when both the reference and renderer content exist", () => {
    const result = render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    expect((screen.getByRole("button", { name: "Projection effect" }) as HTMLButtonElement).disabled).toBe(true);
    result.rerender(<PhotoDepthWorkspace photo={null} readMaps={readMaps} effectPreview={<span>GPU effect</span>} />);
    expect((screen.getByRole("button", { name: "Projection effect" }) as HTMLButtonElement).disabled).toBe(true);
    result.rerender(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="effect" effectPreview={<span>GPU effect</span>} />);
    expect((screen.getByRole("button", { name: "Projection effect" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("GPU effect")).toBeDefined();
    expect(screen.queryByLabelText("Pixel sample")).toBeNull();
  });

  it("updates both depth comparison halves with the live range while retaining native bits and raw pins", () => {
    const original = [maps.native!, maps.depth!].map(map => new Uint32Array(map.values.buffer).slice());
    const result = render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="native"
      depthRange={{ low: 0, high: 1, softness: 0.02 }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare depth stages" }));
    const before = (put.mock.calls.at(-1)![0] as ImageData).data.slice();
    const viewport = screen.getByRole("group", { name: "Native depth viewport" });
    fireEvent.pointerDown(viewport, { button: 0, clientX: 256, clientY: 384 });
    fireEvent.pointerUp(viewport, { button: 0, clientX: 256, clientY: 384 });
    const raw = pixelSample().textContent!.match(/Raw ([^ ]+)/)![1];
    result.rerender(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="native"
      depthRange={{ low: 0.3, high: 0.7, softness: 0.02 }} />);
    const after = (put.mock.calls.at(-1)![0] as ImageData).data;
    const sides = [0, 1].map(side => Array.from({ length: 4 }, (_, index) => (Math.floor(index / 2) * 4 + index % 2 + side * 2) * 4));
    for (const offsets of sides) expect(offsets.some(offset => after[offset] !== before[offset])).toBe(true);
    expect(pixelSample().textContent).toContain(`Raw ${raw}`);
    expect(pixelSample().textContent).toContain("Preview near");
    expect((screen.getByRole("button", { name: "Clear sample" }) as HTMLButtonElement).disabled).toBe(false);
    expect([maps.native!, maps.depth!].map(map => new Uint32Array(map.values.buffer))).toEqual(original);
    expect(screen.getByText(/native samples are unchanged/)).toBeDefined();
  });

  it("zooms and pans the effect with buttons, wheel and keyboard while omitting numerical sampling", () => {
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} active="effect"
      effectPreview={<div role="img" aria-label="Actual projection render" />} />);
    const frame = screen.getByRole("img", { name: "Actual projection render" }).parentElement!;
    const viewport = screen.getByRole("group", { name: "Projection effect viewport" });
    const original = frame.style.width;
    select("Zoom in"); expect(frame.style.width).not.toBe(original);
    select("Fit image"); expect(frame.style.width).toBe(original);
    fireEvent.wheel(viewport, { deltaY: -120, clientX: 512, clientY: 384 });
    expect(frame.style.width).not.toBe(original);
    const initial = frame.style.transform;
    fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(viewport, { clientX: 500, clientY: 400 }); fireEvent.pointerUp(viewport, { button: 0, clientX: 500, clientY: 400 });
    expect(frame.style.transform).not.toBe(initial);
    const dragged = frame.style.transform;
    fireEvent.keyDown(viewport, { key: "ArrowRight" }); expect(frame.style.transform).not.toBe(dragged);
    select("100% map pixels"); expect(screen.getByLabelText("Preview scale").textContent).toBe("100%");
    expect(screen.queryByLabelText("Pixel sample")).toBeNull(); expect(viewport.querySelector("canvas")).toBeNull();
  });

  it("supports wheel zoom across photo, depth and surface mask tabs without mutating source maps", () => {
    const original = [maps.native!, maps.depth!, maps.mask!].map(map => new Uint32Array(map.values.buffer).slice());
    render(<PhotoDepthWorkspace photo={photo} readMaps={readMaps} />);
    for (const name of ["Photo", "Native depth", "Refined depth", "Surface mask"]) {
      select(name);
      const viewport = screen.getByRole("group", { name: `${name} viewport` });
      const before = screen.getByLabelText("Preview scale").textContent;
      fireEvent.wheel(viewport, { deltaY: -120, clientX: 512, clientY: 384 });
      expect(screen.getByLabelText("Preview scale").textContent).not.toBe(before);
    }
    expect([maps.native!, maps.depth!, maps.mask!].map(map => new Uint32Array(map.values.buffer))).toEqual(original);
  });
});
