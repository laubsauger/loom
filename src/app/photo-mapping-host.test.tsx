// @vitest-environment jsdom
import { StrictMode } from "react";
import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { compileGraph } from "@compiler/compile.ts";
import { testCapabilities } from "@compiler/test-support.ts";
import { createFileReference } from "@domain/media/file-reference.ts";
import type { CommandInputSchema } from "@domain/commands/input-schema.ts";
import { type FloatMap } from "@runtime/media/float-map.ts";
import { encodeDepthExr } from "@runtime/media/depth-exr.ts";
import { makePreparedMap, preparedMetadata, withDepthRecipe } from "@runtime/media/prepared-map.ts";
import { FACADE_MASK_DEFAULTS, facadeMaskSettings, type FacadeMaskSettings } from "@runtime/media/facade-mask.ts";
import { depthRangeMaskSettings } from "@runtime/media/depth-tools.ts";
import { linearToSrgb, srgbToLinear } from "@runtime/export/pixel-format.ts";
import { DEPTH_ACCURATE, PHOTO_DEPTH_LARGE_Q4F16, PHOTO_FACADE, PHOTO_MASK, PHOTO_MASK_PERSON } from "@runtime/models/model-catalogue.ts";
import { DEFAULT_PHOTO_DEPTH_RECIPE, DEFAULT_DEPTH_REFINEMENT, depthRecipeParameters } from "@domain/media/photo-depth-recipe.ts";
import type { PhotoDepthRecipe } from "@domain/media/photo-depth-recipe.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { PHOTO_MAPPING_SHADER } from "./photo-mapping-effects.ts";
import { PhotoMappingHost } from "./photo-mapping-host.tsx";
import type { PreparationPhoto, PreparationProgress, PhotoPreparationRequest } from "./photo-preparation.ts";

const mocks = vi.hoisted(() => ({ broker: vi.fn(), decode: vi.fn(), create: vi.fn(), run: vi.fn(), refine: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), save: vi.fn() }));
vi.mock("@ui/files/retained-files.ts", async importOriginal => ({
  ...await importOriginal<typeof import("@ui/files/retained-files.ts")>(), retainedFiles: mocks.broker,
}));
vi.mock("./photo-preparation.ts", () => ({ createPhotoPreparer: mocks.create,
  decodePreparationPhoto: mocks.decode, savePreparedMap: mocks.save }));
// Host tests cover editing/asset ownership; the renderer's separate real-GPU tests
// prove pixels. Keep the actual preview component and its retirement lifecycle.
vi.mock("./photo-effect-renderer.ts", () => ({ createPhotoEffectRenderer: async () => ({
  draw: vi.fn(), present: vi.fn(() => ({ dispose: vi.fn() })), dispose: vi.fn(),
}) }));

const photoRef = createFileReference("photo", "image", "sculpture.png");
const nightRef = createFileReference("preview-photo", "image", "night.png");
const depthRef = createFileReference("depth-original", "binary", "depth.loom.exr");
const maskRef = createFileReference("mask-original", "binary", "mask.loom.exr");
const sha256 = "a".repeat(64);
const maps = new Map<string, FloatMap>();
const runtimes: AppRuntime[] = [];
let photo: PreparationPhoto;
let nightPhoto: PreparationPhoto;

function map(kind: "depth" | "mask", side = kind === "depth" ? 518 : 1024): FloatMap {
  return makePreparedMap(kind === "depth" ? Float32Array.from({ length: 16 }, (_, i) => i + 0.125) : new Float32Array(8).fill(1),
    4, kind === "depth" ? 4 : 2, { kind, source: { sha256, width: 4, height: 2 },
      model: kind === "depth" ? { id: DEPTH_ACCURATE.id, url: DEPTH_ACCURATE.url } : { id: kind, url: `https://models.test/${kind}` }, inputSide: side,
      registration: kind === "depth" ? "letterbox" : "stretch" });
}

function facadeMap(detailSide = 1024, settings: FacadeMaskSettings = FACADE_MASK_DEFAULTS, source = photo): FloatMap {
  const prepared = makePreparedMap(new Float32Array(detailSide * 4).fill(1), detailSide, 4, {
    kind: "mask", source: { sha256: source.sha256, width: source.bitmap.width, height: source.bitmap.height },
    model: { id: "facade-surfaces-v1", url: PHOTO_FACADE.url }, inputSide: 512, registration: "stretch",
  });
  return { ...prepared, metadata: { ...prepared.metadata, facade: { version: 1, detailSide,
    envelopeWidth: 64, envelopeHeight: 64, ...settings } } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  installDomStubs();
  sessionStorage.clear();
  maps.clear(); maps.set(depthRef, map("depth")); maps.set(maskRef, map("mask"));
  photo = { bitmap: { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap, sha256, name: "sculpture.png" };
  nightPhoto = { bitmap: { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap, sha256: "b".repeat(64), name: "night.png" };
  mocks.decode.mockImplementation(async (url: string) => url.includes(encodeURIComponent(nightRef)) ? nightPhoto : photo);
  mocks.create.mockReturnValue({ run: mocks.run, refine: mocks.refine, cancel: mocks.cancel, dispose: mocks.dispose });
  mocks.run.mockImplementation(async (request: PhotoPreparationRequest) => {
    if (request.kind === "mask") return request.facade === undefined ? map("mask", request.inputSide) : facadeMap(request.inputSide, request.facade, request.photo);
    if (request.recipe.version === 3) {
      // T1817b: Depth Pro 2's map is its box, letterboxed, in inverse metres.
      const box = request.recipe.inputSide === 640 ? [640, 480] : [672, 384];
      const metric = makePreparedMap(new Float32Array(box[0]! * box[1]!).fill(0.25), box[0]!, box[1]!, { kind: "depth",
        source: { sha256, width: 4, height: 2 }, model: { id: request.recipe.modelId, url: "https://models.test/dp2" },
        inputSide: request.recipe.inputSide, registration: "letterbox" });
      return withDepthRecipe(metric, { ...request.recipe, refinement: null }, null, "inverse-metric");
    }
    const prepared = map("depth", request.recipe.inputSide);
    const model = request.recipe.modelId === PHOTO_DEPTH_LARGE_Q4F16.id ? PHOTO_DEPTH_LARGE_Q4F16 : DEPTH_ACCURATE;
    return withDepthRecipe({ ...prepared, metadata: { preparation: { ...preparedMetadata(prepared), model: { id: model.id, url: model.url } } } }, { ...request.recipe, refinement: null });
  });

  let saved = 0;
  mocks.save.mockImplementation(async (prepared: FloatMap) => {
    const reference = createFileReference(`${preparedMetadata(prepared).kind}-saved-${++saved}`, "binary", "prepared.loom.exr");
    maps.set(reference, prepared); return reference;
  });
  mocks.broker.mockReturnValue({ remember: vi.fn(async (handle: { name: string }) =>
    handle.name === "depth.loom.exr" ? depthRef : handle.name === "mask.loom.exr" ? maskRef : handle.name === "night.png" ? nightRef : photoRef), allow: vi.fn(),
    snapshot: (reference: string) => ({ kind: "ready", url: `https://assets.test/${encodeURIComponent(reference)}` }),
    revision: () => 0, subscribe: () => () => {}, acquire: () => ({ release: vi.fn() }) });
  vi.stubGlobal("showOpenFilePicker", vi.fn(async () => [{ name: "sculpture.png" }]));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const prepared = maps.get(decodeURIComponent(new URL(url).pathname.slice(1)));
    if (prepared === undefined) throw new Error(`Unexpected map fetch ${url}`);
    return { ok: true, arrayBuffer: async () => encodeDepthExr(prepared).buffer };
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: vi.fn(), putImageData: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128) }),
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
});


afterEach(() => { cleanup(); runtimes.splice(0).forEach(runtime => runtime.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function runtime() {
  const next = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "projection-test" } });
  runtimes.push(next); return next;
}
async function open(target: AppRuntime, nodeId?: string, strict = false) {
  render(strict ? <StrictMode><PhotoMappingHost runtime={target} /></StrictMode> : <PhotoMappingHost runtime={target} />);
  await act(async () => { await target.bus.execute("photoMapping.prepare", nodeId === undefined ? {} : { nodeIds: [nodeId] }, target.invocation); });
  await screen.findByRole("dialog");
}
async function choosePhoto() {
  await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Reference photo" })).getByRole("button", { name: "choose…" })); });
  await waitFor(() => expect((screen.getByRole("button", { name: /^(?:Run|Rerun) depth$/ }) as HTMLButtonElement).disabled).toBe(false));
}
async function chooseMap(kind: "depth" | "mask") {
  vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: `${kind}.loom.exr` }]);
  await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: `Existing ${kind} map` })).getByRole("button", { name: "choose…" })); });
}
async function chooseNightPhoto() {
  vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: "night.png" }]);
  await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Preview photo (optional)" })).getByRole("button", { name: "choose…" })); });
  await waitFor(() => expect(mocks.decode.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(nightRef)))).toBe(true));
}
async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); }
async function existing(target: AppRuntime, previewPhoto?: string) {
  const result = await target.bus.execute("photoMapping.create", { photo: photoRef, depth: depthRef, mask: maskRef,
    width: 4, height: 2, shader: PHOTO_MAPPING_SHADER, ...(previewPhoto === undefined ? {} : { previewPhoto }) }, target.invocation);
  expect(result.status).toBe("applied"); return result.output.createdIds;
}

describe("reusable photo preparation host", () => {
  it("registers metadata-free external depth with an explicit convention and creates reusable imported-depth input without inference", async () => {
    const values = new Float32Array([-10, -0, 2 ** -149, 0.25, 1, 3, 7, 10]);
    const original = new Uint32Array(values.buffer).slice();
    maps.set(depthRef, { width: 4, height: 2, values });
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    await chooseMap("depth");
    await screen.findByRole("button", { name: "Register imported depth" });
    expect(screen.getByText(/Depth metadata is missing/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Imported depth convention" }), { target: { value: "relative-log" } });
    await click("Register imported depth"); await click("Save depth…");
    const registered = mocks.save.mock.calls[0]![0] as FloatMap;
    expect(preparedMetadata(registered)).toMatchObject({ source: { sha256, width: 4, height: 2 }, registration: "stretch",
      model: { id: "imported-depth" }, semantics: "relative-log" });
    expect(new Uint32Array(registered.values.buffer)).toEqual(original);
    expect((screen.getByRole("button", { name: "Rerun depth" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull();
    const graph = target.bus.store.getGraph(), depth = Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(depth.parameters).toMatchObject({ depthModel: "imported-depth", inputSide: "518", emptySource: "error" });
    expect(maps.get(depth.parameters.file as string)).toBe(registered);
    const output = Object.values(graph.nodes).find(node => node.type === "output")!;
    expect(compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(),
      sinks: [{ nodeId: output.id, kind: "output" }] }).diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(new Uint32Array(values.buffer)).toEqual(original);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([false, true])("rewires an existing photo effect to Video and back while preserving image-map registration and the %s clip slot", async pickClip => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const target = runtime(), ids = await existing(target), original = target.bus.store.getGraph();
    await target.bus.execute("graph.applyPatch", { baseRevision: original.revision, operations: [{ op: "setParameters",
      nodeId: ids.$effect!, parameters: { source: PHOTO_MAPPING_SHADER + "\n// Custom look before changing effect" } }] }, target.invocation);
    await open(target, ids.$depth); await screen.findByRole("button", { name: "Save mask again…" });
    fireEvent.change(screen.getByRole("combobox", { name: "First effect" }), { target: { value: "9" } });
    expect(screen.getByText("Applying this look replaces the effect shader.")).toBeDefined();
    const clip = createFileReference("video-content", "video", "show.webm");
    if (pickClip) {
      mocks.broker.mock.results[0]!.value.remember.mockResolvedValueOnce(clip);
      vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: "show.webm" }]);
      await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Video texture" })).getByRole("button", { name: "choose…" })); });
    }
    await click("Apply saved maps");
    expect(screen.queryByRole("dialog")).toBeNull();
    const videoGraph = target.bus.store.getGraph(), video = Object.values(videoGraph.nodes).find(node => node.type === "movieFileIn" && node.id !== ids.$photo)!;
    expect(video.parameters.file).toBe(pickClip ? clip : "");
    expect(videoGraph.nodes[ids.$effect!]!.parameters).toMatchObject({ mode: 9, source: PHOTO_MAPPING_SHADER });
    const sourceFor = (graph: typeof videoGraph, nodeId: string, port: string) => Object.values(graph.edges)
      .find(edge => edge.target.nodeId === nodeId && edge.target.portId === port)?.source.nodeId;
    expect(sourceFor(videoGraph, ids.$effect!, "input")).toBe(video.id);
    expect(sourceFor(videoGraph, ids.$depth!, "picture")).toBe(ids.$photo);
    expect(sourceFor(videoGraph, ids.$mask!, "picture")).toBe(ids.$photo);
    await act(async () => { await target.bus.execute("photoMapping.prepare", { nodeIds: [ids.$depth!] }, target.invocation); });
    await screen.findByRole("button", { name: "Save mask again…" });
    fireEvent.change(screen.getByRole("combobox", { name: "First effect" }), { target: { value: "0" } });
    await click("Apply saved maps");
    const restored = target.bus.store.getGraph();
    expect(sourceFor(restored, ids.$effect!, "input")).toBe(ids.$photo);
    expect(restored.nodes[video.id]!.parameters.file).toBe(pickClip ? clip : "");
    expect(restored.nodes[ids.$depth!]!.parameters.file).toBe(depthRef);
    expect(restored.nodes[ids.$mask!]!.parameters.file).toBe(maskRef);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("enables preparation and picking for existing blank depth and mask slots, then applies real saved maps", async () => {
    const target = runtime();
    const result = await target.bus.execute("photoMapping.create", { photo: photoRef, width: 4, height: 2, shader: PHOTO_MAPPING_SHADER }, target.invocation);
    expect(result.status).toBe("applied");
    const ids = result.output.createdIds;
    await open(target, ids.$depth);
    expect(screen.getByRole("region", { name: "Depth preparation" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Surface mask preparation" })).toBeDefined();
    expect(screen.getByRole("switch", { name: "Use depth map" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Use depth map" }));
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Run depth" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "Run mask" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(screen.getByRole("group", { name: "Existing depth map" })).getByRole("button", { name: "choose…" })).toBeDefined();
    expect(within(screen.getByRole("group", { name: "Existing mask map" })).getByRole("button", { name: "choose…" })).toBeDefined();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    await click("Apply saved maps");
    const graph = target.bus.store.getGraph();
    expect(graph.nodes[ids.$depth!]!.parameters).toMatchObject({ file: depthRef, emptySource: "error" });
    expect(graph.nodes[ids.$mask!]!.parameters).toMatchObject({ file: maskRef, emptySource: "error" });
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("creates replaceable neutral depth and full-frame mask inputs without running or saving preparation", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.click(screen.getByRole("switch", { name: "Use depth map" }));
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    expect(screen.getByText("Creates a neutral depth input. Load a map in the network later.")).toBeDefined();
    expect((screen.getByRole("button", { name: "Run depth" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    for (const [interpretation, emptyValue] of [["depth", 0.5], ["mask", 1]] as const) {
      const node = Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === interpretation)!;
      expect(node.parameters).toMatchObject({ file: "", emptySource: "constant", emptyValue, photo: photoRef });
      expect(Object.values(graph.edges).some(edge => edge.target.nodeId === node.id && edge.target.portId === "picture")).toBe(true);
    }
    const calibration = Object.values(graph.nodes).find(node => node.type === "switch")!;
    expect(calibration.parameters.index).toBe(0);
    expect(Object.values(graph.edges).filter(edge => edge.target.nodeId === calibration.id)).toHaveLength(2);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("opens a reference thumbnail in a separate interactive inspection dialog and returns without replacing the photo", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    const original = photo.bitmap;
    await click("Expand reference photo");
    const enlarged = await screen.findByRole("dialog", { name: "Reference photo" });
    expect(within(enlarged).getByRole("group", { name: "Photo viewport" })).toBeDefined();
    fireEvent.click(within(enlarged).getByRole("button", { name: "Zoom in" }));
    expect(within(enlarged).getByRole("button", { name: "Fit image" })).toBeDefined();
    await click("Back to mapping");
    expect(screen.queryByRole("dialog", { name: "Reference photo" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Map from photo" })).toBeDefined();
    expect(photo.bitmap).toBe(original);
    expect(mocks.decode).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("edits an existing mask in the large viewport and preserves pixels and redo history when Edit mask is selected again", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    await click("Edit mask");
    const canvas = screen.getByRole("img", { name: "Surface mask editor" });
    await act(async () => {
      fireEvent.pointerDown(canvas, { button: 0, clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
    });
    await click("Save mask…");
    const painted = mocks.save.mock.calls[0]![0] as FloatMap;
    expect(painted.values.some(value => value === 0)).toBe(true);
    expect(maps.get(maskRef)!.values.every(value => value === 1)).toBe(true);
    await click("Undo mask stroke");
    expect((screen.getByRole("button", { name: "Redo mask stroke" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Edit mask");
    expect((screen.getByRole("button", { name: "Redo mask stroke" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Save mask…");
    expect(mocks.save.mock.calls[1]![0].values).toEqual(maps.get(maskRef)!.values);
    await click("Redo mask stroke"); await click("Save mask…");
    expect(new Uint32Array(mocks.save.mock.calls[2]![0].values.buffer)).toEqual(new Uint32Array(painted.values.buffer));
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("creates full-frame coverage from saved depth with disabled mask controls and no mask work", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    const useMask = screen.getByRole("switch", { name: "Use surface mask" });
    expect(useMask.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(useMask);
    expect(screen.getByText("Full frame · no mask file needed")).toBeDefined();
    const maskPreparation = within(screen.getByRole("region", { name: "Surface mask preparation" }));
    for (const control of [
      maskPreparation.getByRole("combobox", { name: "Mask detail" }),
      maskPreparation.getByRole("button", { name: "Run mask" }),
      maskPreparation.getByRole("button", { name: "Save mask…" }),
      maskPreparation.getByRole("button", { name: "Start manual mask" }),
    ]) expect((control as HTMLButtonElement | HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("group", { name: "Mask painting tools" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Existing mask map" })).queryByRole("button", { name: "choose…" })).toBeNull();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    const coverage = Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")!;
    expect(coverage.parameters).toMatchObject({ file: "", emptySource: "constant", emptyValue: 1 });
    expect(Object.values(graph.nodes).filter(node => node.type === "floatMapIn" && node.parameters.file !== "").map(node => node.parameters.file)).toEqual([depthRef]);
    const maskNode = Object.values(graph.nodes).find(node => node.type === "mask")!;
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === coverage.id && edge.target.nodeId === maskNode.id && edge.target.portId === "mask")).toBe(true);
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities() });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("restores the mask requirement and preserves selected ready masks when toggled back on", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    const useMask = screen.getByRole("switch", { name: "Use surface mask" });
    fireEvent.click(useMask);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(useMask);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Run mask" }) as HTMLButtonElement).disabled).toBe(false);
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    fireEvent.click(useMask);
    for (const name of ["Erase mask", "Restore mask", "Pan mask"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Undo mask stroke" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save mask again…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole("group", { name: "Surface mask viewport" }), { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerUp(screen.getByRole("group", { name: "Surface mask viewport" }), { pointerId: 1 });
    });
    fireEvent.click(useMask);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save mask again…" })).toBeDefined();
    await click("Create mapping network");
    expect(Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([0, 4])("warns about a valid mask with %s covered samples without replacing or refusing it", async covered => {
    const values = new Float32Array(32 * 32).fill(0.49);
    values.fill(0.75, 0, covered);
    const metadata = preparedMetadata(map("mask"));
    maps.set(maskRef, makePreparedMap(values, 32, 32, {
      kind: "mask", source: metadata.source, model: metadata.model, inputSide: 1024, registration: "stretch",
    }));
    const originalBytes = encodeDepthExr(maps.get(maskRef)!).slice();
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect(screen.getByText(/Mask covers less than 1% of the photo/)).toBeDefined();
    expect(screen.getByText(/Use full frame or restore the surface with the brush/)).toBeDefined();
    expect(screen.getByRole("switch", { name: "Use surface mask" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(Object.values(graph.nodes).some(node => node.type === "solid")).toBe(false);
    expect(encodeDepthExr(maps.get(maskRef)!)).toEqual(originalBytes);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains an explicit full-frame recipe across the legacy-bus reload without inference", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    const key = `loom.photoMapping.reload.${target.project.projectId}`;
    const replaceCommand = target.bus.replaceCommand;
    const legacyBus = target.bus as unknown as { replaceCommand: unknown };
    try {
      legacyBus.replaceCommand = undefined;
      await click("Create mapping network");
      expect(screen.getByRole("alert").textContent).toMatch(/Reload Loom once.*Saved mapping setup will reopen/i);
      expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ photo: photoRef, depth: depthRef, mask: "", useMask: false });
      expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
      cleanup();
    } finally { legacyBus.replaceCommand = replaceCommand; }
    render(<PhotoMappingHost runtime={target} />);
    await screen.findByRole("dialog"); await screen.findByRole("button", { name: "Save depth again…" });
    expect(screen.getByRole("switch", { name: "Use surface mask" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Full frame · no mask file needed")).toBeDefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(key)).toBeNull();
    expect(Object.values(target.bus.store.getGraph().nodes).filter(node => node.type === "floatMapIn" && node.parameters.file !== "").map(node => node.parameters.file)).toEqual([depthRef]);
    expect(Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters).toMatchObject({ file: "", emptySource: "constant", emptyValue: 1 });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("defaults to facade masks and requests independent refinement detail only on demand", async () => {
    const target = runtime(); await open(target);
    const depthDetail = screen.getByRole("combobox", { name: "Detail" });
    const maskDetail = screen.getByRole("combobox", { name: "Mask detail" });
    expect(within(depthDetail).getAllByRole("option").map(option => (option as HTMLOptionElement).value))
      .toEqual(["266", "392", "518", "644", "770", "896", "1036", "1288"]);
    expect(within(maskDetail).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["1024", "1536"]);
    expect(depthDetail.closest("details")).toBeNull(); expect(maskDetail.closest("details")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Mask method" }) as HTMLSelectElement).value).toBe("facade");
    expect(screen.getByText(`${PHOTO_FACADE.label} · ${(PHOTO_FACADE.bytes / 1024 / 1024).toFixed(1)} MB · 512 input / 64 scene mask`)).toBeDefined();
    const cutoff = screen.getByRole("slider", { name: /^Opening cutoff/ }) as HTMLInputElement;
    expect([cutoff.value, cutoff.min, cutoff.max]).toEqual(["14", "0", "50"]);
    expect(screen.getByRole("switch", { name: "Exclude blue glass" }).getAttribute("aria-checked")).toBe("true");
    await choosePhoto();
    fireEvent.change(depthDetail, { target: { value: "1288" } });
    fireEvent.change(maskDetail, { target: { value: "1536" } });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
    await click("Run depth"); await click("Run mask");
    expect(mocks.run.mock.calls).toEqual([[{ kind: "depth", photo, recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide: 1288 } }], [{ kind: "mask", photo, inputSide: 1536, facade: FACADE_MASK_DEFAULTS }]]);
    await click("Save mask…");
    const saved = mocks.save.mock.calls[0]![0] as FloatMap;
    expect(preparedMetadata(saved)).toMatchObject({ inputSide: 512, source: { sha256, width: 4, height: 2 },
      model: { id: "facade-surfaces-v1", url: PHOTO_FACADE.url } });
    expect(facadeMaskSettings(saved)).toEqual({ version: 1, detailSide: 1536, envelopeWidth: 64, envelopeHeight: 64, ...FACADE_MASK_DEFAULTS });
    expect(saved.values).toBeInstanceOf(Float32Array);
    expect(Math.max(saved.width, saved.height)).toBe(1536);
    expect(screen.getByRole("button", { name: "Erase mask" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Restore mask" })).toBeDefined();
  });

  it.each(["opening cutoff", "blue glass"] as const)("invalidates only a saved facade recipe after changing %s without automatic inference", async setting => {
    maps.set(maskRef, facadeMap());
    const originalBytes = encodeDepthExr(maps.get(maskRef)!).slice();
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const changed = setting === "opening cutoff" ? { ...FACADE_MASK_DEFAULTS, darkCutoff: srgbToLinear(0.25) }
      : { ...FACADE_MASK_DEFAULTS, excludeBlueGlass: false };
    if (setting === "opening cutoff") fireEvent.change(screen.getByRole("slider", { name: /^Opening cutoff/ }), { target: { value: "25" } });
    else fireEvent.click(screen.getByRole("switch", { name: "Exclude blue glass" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Mask settings changed|Mask belongs to another reference photo/i);
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(encodeDepthExr(maps.get(maskRef)!)).toEqual(originalBytes);
    await click("Rerun mask");
    expect(mocks.run.mock.calls).toEqual([[{ kind: "mask", photo, inputSide: 1024, facade: changed }]]);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Save mask…");
    expect(facadeMaskSettings(mocks.save.mock.calls[0]![0])).toMatchObject(changed);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores a saved facade recipe and refinement detail despite its 512 model input", async () => {
    const settings = { darkCutoff: srgbToLinear(0.23), feather: 0.025, excludeBlueGlass: false };
    maps.set(maskRef, facadeMap(1536, settings));
    const originalBytes = encodeDepthExr(maps.get(maskRef)!).slice();
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect((screen.getByRole("combobox", { name: "Mask method" }) as HTMLSelectElement).value).toBe("facade");
    expect((screen.getByRole("combobox", { name: "Mask detail" }) as HTMLSelectElement).value).toBe("1536");
    expect((screen.getByRole("slider", { name: /^Opening cutoff/ }) as HTMLInputElement).value)
      .toBe(String(Math.round(linearToSrgb(settings.darkCutoff) * 100)));
    expect(screen.getByRole("switch", { name: "Exclude blue glass" }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    expect(Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(preparedMetadata(maps.get(maskRef)!).inputSide).toBe(512);
    expect(encodeDepthExr(maps.get(maskRef)!)).toEqual(originalBytes);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("uses the explicit background method with four run arguments", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Mask method" }), { target: { value: "background" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Mask detail" }), { target: { value: "1536" } });
    expect(screen.queryByRole("slider", { name: /^Opening cutoff/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Exclude blue glass" })).toBeNull();
    expect(mocks.run).not.toHaveBeenCalled();
    await click("Run mask"); await click("Save mask…");
    expect(mocks.run.mock.calls).toEqual([[{ kind: "mask", photo, inputSide: 1536 }]]);
    expect(preparedMetadata(mocks.save.mock.calls[0]![0]).inputSide).toBe(1536);
    expect(facadeMaskSettings(mocks.save.mock.calls[0]![0])).toBeUndefined();
  });

  it("retains the imported facade feather and exclusions on an explicit rerun", async () => {
    const settings = { darkCutoff: 0.047, feather: 0.025, excludeBlueGlass: false };
    maps.set(maskRef, facadeMap(1536, settings));
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect(mocks.run).not.toHaveBeenCalled();
    await click("Rerun mask");
    expect(mocks.run.mock.calls).toEqual([[{ kind: "mask", photo, inputSide: 1536, facade: settings }]]);
    await click("Save mask…");
    expect(facadeMaskSettings(mocks.save.mock.calls[0]![0])).toMatchObject({ ...settings, detailSide: 1536 });
  });

  it("marks excluded facade samples with a red tint while preserving included photo samples and saved values", async () => {
    const prepared = facadeMap();
    for (let row = 0; row < prepared.height; row++) prepared.values.fill(0, row * prepared.width, row * prepared.width + prepared.width / 4);
    maps.set(maskRef, prepared);
    const originalBytes = encodeDepthExr(prepared).slice();
    const paint = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation((function(this: HTMLCanvasElement) { return {
      drawImage: vi.fn(), putImageData: (image: ImageData) => paint(this.getAttribute("aria-label"), image), clearRect: vi.fn(), fillRect: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128) }),
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    }; }) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const image = paint.mock.calls.filter(call => call[0] === "Surface mask editor").at(-1)![1] as ImageData;
    expect(image.data[0]).toBeGreaterThan(image.data[1]!);
    expect(image.data[0]).toBeGreaterThan(image.data[2]!);
    expect(image.data[0]).toBeGreaterThan(128);
    expect([...image.data.slice(4, 8)]).toEqual([128, 128, 128, 255]);
    expect(screen.getByRole("button", { name: "Erase mask" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Restore mask" })).toBeDefined();
    expect(encodeDepthExr(prepared)).toEqual(originalBytes);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects a recognized facade mask with a missing recipe instead of reusing it as a background mask", async () => {
    const invalid = facadeMap();
    maps.set(maskRef, { ...invalid, metadata: { preparation: invalid.metadata!.preparation! } });
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Invalid facade mask.*metadata/i));
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("invalidates only the changed mask detail and requires a fresh save after rerunning", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const maskDetail = screen.getByRole("combobox", { name: "Mask detail" });
    fireEvent.change(maskDetail, { target: { value: "1536" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Mask settings changed|Mask belongs to another reference photo/i);
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
    fireEvent.change(maskDetail, { target: { value: "1024" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(maskDetail, { target: { value: "1536" } });
    await click("Rerun mask");
    expect(mocks.run.mock.calls).toEqual([[{ kind: "mask", photo, inputSide: 1536 }]]);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Save mask…"); await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")?.parameters.file).toBe(depthRef);
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["mask"]);
    expect(preparedMetadata(mocks.save.mock.calls[0]![0]).inputSide).toBe(1536);
  });

  it("keeps a saved mask ready when depth detail changes independently", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "1288" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Depth out of date/i);
    expect((screen.getByRole("button", { name: "Save mask again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("combobox", { name: "Mask detail" }) as HTMLSelectElement).value).toBe("1024");
    expect(mocks.run).not.toHaveBeenCalled();
    await click("Rerun depth"); await click("Save depth…"); await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(mocks.run.mock.calls).toEqual([[{ kind: "depth", photo, recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide: 1288 } }]]);
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["depth"]);
  });

  it.each(["mask", PHOTO_MASK_PERSON.id, PHOTO_MASK.id])("adopts an imported legacy %s mask as background removal without inference or resaving", async modelId => {
    const prepared = map("mask", 1536);
    const metadata = preparedMetadata(prepared);
    maps.set(maskRef, { ...prepared, metadata: { preparation: { ...metadata, model: { ...metadata.model, id: modelId } } } });
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect((screen.getByRole("combobox", { name: "Mask detail" }) as HTMLSelectElement).value).toBe("1536");
    expect((screen.getByRole("combobox", { name: "Mask method" }) as HTMLSelectElement).value).toBe("background");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("fits a large-photo network while preserving the original bitmap and native map provenance", async () => {
    photo = { ...photo, bitmap: { width: 6512, height: 4341, close: vi.fn() } as unknown as ImageBitmap };
    const originalBitmap = photo.bitmap;
    for (const [reference, kind] of [[depthRef, "depth"], [maskRef, "mask"]] as const) {
      const prepared = map(kind); const metadata = preparedMetadata(prepared);
      maps.set(reference, { ...prepared, metadata: { preparation: { ...metadata,
        source: { sha256, width: 6512, height: 4341 } } } });
    }
    const originalMaps = [maps.get(depthRef)!, maps.get(maskRef)!].map(prepared => ({
      bytes: encodeDepthExr(prepared).slice(), metadata: preparedMetadata(prepared),
    }));
    const target = runtime(); await open(target); await choosePhoto();
    expect(screen.getByRole("note").textContent).toBe("Large photo: network fits within 4096 px, keeping the full frame");
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect(photo.bitmap).toBe(originalBitmap);
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull();
    const graph = target.bus.store.getGraph();
    const sources = Object.values(graph.nodes).filter(node => node.type === "movieFileIn" || node.type === "floatMapIn");
    for (const source of sources) expect(source.resolution).toEqual({ mode: "fixed", width: 4096, height: 2730 });
    expect(sources.find(node => node.type === "movieFileIn")?.parameters.file).toBe(photoRef);
    expect(sources.filter(node => node.type === "floatMapIn").map(node => node.parameters.file)).toEqual([depthRef, maskRef]);
    const corner = Object.values(graph.nodes).find(node => node.type === "cornerPin")!;
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(),
      sinks: [{ nodeId: corner.id, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(plan.outputs.find(output => output.nodeId === corner.id)?.size).toEqual([4096, 2730]);
    for (const [index, reference] of [depthRef, maskRef].entries()) {
      expect(preparedMetadata(maps.get(reference)!)).toEqual(originalMaps[index]!.metadata);
      expect(encodeDepthExr(maps.get(reference)!)).toEqual(originalMaps[index]!.bytes);
      expect(preparedMetadata(maps.get(reference)!).source).toEqual({ sha256, width: 6512, height: 4341 });
    }
    expect(originalBitmap.width).toBe(6512); expect(originalBitmap.height).toBe(4341);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("creates the default photo point cloud as independently editable depth, colour, geometry, camera and rendering stages", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    expect((screen.getByRole("combobox", { name: "First effect" }) as HTMLSelectElement).value).toBe("13");
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    const nodes = Object.values(graph.nodes);
    expect(nodes.filter(node => node.type === "pointGrid")).toHaveLength(1);
    expect(nodes.filter(node => node.type === "pointKernel")).toHaveLength(2);
    for (const type of ["geometry", "camera", "render", "lfo", "materialUnlit"]) expect(nodes.filter(node => node.type === type)).toHaveLength(1);
    const carve = nodes.find(node => node.label === "kernel_relative_depth1")!;
    const paint = nodes.find(node => node.label === "kernel_photo_colour1")!;
    const range = nodes.find(node => node.label === "wgsl_depth_range1")!;
    const geometry = nodes.find(node => node.type === "geometry")!;
    const camera = nodes.find(node => node.type === "camera")!;
    const render = nodes.find(node => node.type === "render")!;
    expect(paint.parameters).toMatchObject({ heat: 0, gain: 1 });
    expect(geometry.parameters).toMatchObject({ mode: "points", scale: { mode: "map", bindings: { map: { attribute: "tint", channel: "w" } } },
      tint: { mode: "map", bindings: { map: { attribute: "tint" } } } });
    expect(render.parameters).toMatchObject({ camera: camera.label, scenes: geometry.label });
    expect(nodes.find(node => node.label === "level_photo_grade1")?.parameters).toMatchObject({ brightness: 1.5 });
    expect(Object.values(graph.edges)).toContainEqual(expect.objectContaining({ source: { nodeId: range.id, portId: "out" }, target: { nodeId: carve.id, portId: "field" } }));
    const window = nodes.find(node => node.type === "window")!;
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(), sinks: [{ nodeId: window.id, kind: "output" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    const field = plan.outputs.find(output => output.nodeId === range.id)!;
    expect(field).toMatchObject({ format: "r32float", space: "data" });
    expect(plan.passes.find(pass => "nodeId" in pass && pass.nodeId === carve.id && "textures" in pass)).toMatchObject({
      textures: [{ binding: "fieldTexture", resourceId: field.resourceId, sampled: "unfiltered" }] });
    const depth = nodes.find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    const updated = await target.bus.execute("graph.applyPatch", { baseRevision: graph.revision, label: "Set modular depth range", operations: [
      { op: "setParameters", nodeId: range.id, parameters: { low: 0.25, high: 0.8 } },
    ] }, target.invocation);
    expect(updated.status).toBe("applied");
    await open(target, depth.id);
    await screen.findByRole("button", { name: "Apply saved maps" });
    expect(screen.queryByRole("combobox", { name: "First effect" })).toBeNull();
    fireEvent.click(screen.getByText("Depth range and cutoff", { exact: true }));
    expect((screen.getByRole("slider", { name: /^Far cutoff/ }) as HTMLInputElement).value).toBe("0.25");
    expect((screen.getByRole("slider", { name: /^Near cutoff/ }) as HTMLInputElement).value).toBe("0.8");
    fireEvent.change(screen.getByRole("slider", { name: /^Far cutoff/ }), { target: { value: "0.35" } });
    await click("Apply saved maps");
    expect(target.bus.store.getGraph().nodes[range.id]!.parameters).toMatchObject({ low: 0.35, high: 0.8 });
    expect(target.bus.store.getGraph().nodes[camera.id]).toEqual(camera);
    expect(target.bus.store.getGraph().nodes[geometry.id]).toEqual(geometry);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("runs depth and mask only on demand, saves each separately, and creates one undoable usable network", async () => {
    const target = runtime(); await open(target);
    expect(screen.getByText("Next: Choose a reference photo to begin")).toBeDefined();
    await choosePhoto();
    expect(screen.getByText(/Next: .*depth.*run depth/)).toBeDefined();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
    await click("Run depth");
    expect(screen.getByText("Next: Save depth, then prepare the surface mask")).toBeDefined();
    expect(mocks.run.mock.calls.map(call => call[0].kind)).toEqual(["depth"]);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Save depth…");
    expect(screen.getByText(/Next: .*mask.*manual mask/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Save depth again…" })).toBeDefined();
    await click("Run mask");
    expect(screen.getByText("Next: Check the edges, then save the mask")).toBeDefined();
    await click("Save mask…");
    expect(screen.getByText("Next: Create the network, then align Window Out")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save mask again…" })).toBeDefined();
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["depth", "mask"]);
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull();
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(23);
    const window = Object.values(graph.nodes).find(node => node.type === "window")!;
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(),
      sinks: [{ nodeId: window.id, kind: "output" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(Object.keys(target.bus.store.getGraph().nodes)).toHaveLength(0);
  });

  it("creates a preview network from existing depth and mask without generating or saving either map", async () => {
    maps.set(depthRef, map("depth", 392));
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    expect((screen.getByLabelText("Detail") as HTMLSelectElement).value).toBe("392");
    const light = screen.getByRole("slider", { name: /^Preview light/ }) as HTMLInputElement;
    expect([light.value, light.min, light.max]).toEqual(["35", "0", "100"]);
    fireEvent.change(light, { target: { value: "60" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(23);
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")?.parameters)
      .toMatchObject({ file: depthRef, inputSide: "392" });
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    const output = Object.values(graph.nodes).find(node => node.type === "output")!;
    const preview = Object.values(graph.nodes).find(node => node.type === "screen")!;
    expect(preview.parameters.opacity).toBe(0.6);
    const coverage = Object.values(graph.nodes).find(node => node.label === "mask_surface1")!;
    const reference = Object.values(graph.nodes).find(node => node.label === "level_reference1")!;
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === coverage.id && edge.target.nodeId === preview.id && edge.target.portId === "in1")).toBe(true);
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === reference.id && edge.target.nodeId === preview.id && edge.target.portId === "in2")).toBe(true);
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === preview.id && edge.target.nodeId === output.id)).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("can turn reference-photo preview off while retaining a wired main output", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    const previewSwitch = screen.getByRole("switch", { name: "Preview on reference photo" });
    expect(screen.getByText("Preview on reference photo", { selector: "label" })).toBeDefined();
    expect(previewSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(previewSwitch);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(21);
    expect(Object.values(graph.nodes).some(node => node.type === "screen")).toBe(false);
    const output = Object.values(graph.nodes).find(node => node.type === "output")!;
    const corner = Object.values(graph.nodes).find(node => node.type === "cornerPin")!;
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === corner.id && edge.target.nodeId === output.id)).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("offers four modular looks before ten classic effects with explanations for depth, masks and video", async () => {
    const target = runtime(); await open(target);
    const finish = within(screen.getByRole("region", { name: "Create or update mapping" }));
    const effect = screen.getByRole("combobox", { name: "First effect" });
    expect(within(effect).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Photo point cloud", "Grazing light · modular", "Contour engraving · modular", "Depth slices · modular",
      "Neon contours", "Prismatic sweep", "Chromatic relief", "Surface trace", "Depth reveal",
      "Moonlit stone", "Liquid strata", "Depth constellation", "Thermal scan", "Mapped video",
    ]);
    fireEvent.change(effect, { target: { value: "3" } });
    expect(finish.getByText(/mask.*bound|bound.*mask/i)).toBeDefined();
    fireEvent.change(effect, { target: { value: "4" } });
    expect(finish.getByText(/depth.*bands/i)).toBeDefined();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([3, 4, 5, 6, 7, 8, 9])("creates the selected diagnostic effect %s from reused maps", async mode => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    fireEvent.change(screen.getByRole("combobox", { name: "First effect" }), { target: { value: String(mode) } });
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    const effect = Object.values(graph.nodes).find(node => node.type === "customWgslMulti")!;
    expect(effect.parameters.mode).toBe(mode);
    const output = Object.values(graph.nodes).find(node => node.type === "output")!;
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(),
      sinks: [{ nodeId: output.id, kind: "output" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("uses an optional night photo only for the viewer while keeping the original map source", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    await click("Projection effect");
    expect(await screen.findByRole("img", { name: "Animated mapping preview" })).toBeDefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(24);
    const original = Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === photoRef)!;
    const previewPhoto = Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    const reference = Object.values(graph.nodes).find(node => node.label === "level_reference1")!;
    const mapNodes = Object.values(graph.nodes).filter(node => node.type === "floatMapIn");
    expect(mapNodes.map(node => node.parameters.photo)).toEqual([photoRef, photoRef]);
    for (const node of mapNodes) {
      expect(Object.values(graph.edges).some(edge => edge.source.nodeId === original.id && edge.target.nodeId === node.id && edge.target.portId === "picture")).toBe(true);
    }
    expect(Object.values(graph.edges).filter(edge => edge.source.nodeId === previewPhoto.id)).toMatchObject([
      { target: { nodeId: reference.id } },
    ]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts a higher-resolution night photo with matching aspect and resamples only its movie output", async () => {
    nightPhoto = { ...nightPhoto, bitmap: { width: 8, height: 4, close: vi.fn() } as unknown as ImageBitmap };
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const previewPhoto = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    expect(previewPhoto.resolution).toEqual({ mode: "fixed", width: 4, height: 2 });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reopens the saved night preview and replaces only its movie file and fit without preparing maps", async () => {
    const target = runtime(); const ids = await existing(target, nightRef);
    const before = target.bus.store.getGraph();
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun depth" });
    await screen.findByRole("button", { name: "Rerun mask" });
    const picker = within(screen.getByRole("group", { name: "Preview photo (optional)" }));
    expect(picker.getByText("night.png")).toBeDefined();
    await waitFor(() => expect(mocks.decode.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(nightRef)))).toBe(true));
    const replacement = createFileReference("preview-replacement", "image", "replacement-night.png");
    const replacementPhoto = { ...nightPhoto, name: "replacement-night.png", sha256: "c".repeat(64) };
    mocks.decode.mockImplementation(async (url: string) => url.includes(encodeURIComponent(replacement)) ? replacementPhoto
      : url.includes(encodeURIComponent(nightRef)) ? nightPhoto : photo);
    mocks.broker().remember.mockResolvedValueOnce(replacement);
    vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: "replacement-night.png" }]);
    await act(async () => { fireEvent.click(picker.getByRole("button", { name: "choose…" })); });
    await waitFor(() => expect(mocks.decode.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(replacement)))).toBe(true));
    fireEvent.change(screen.getByRole("combobox", { name: "Preview fit" }), { target: { value: "fill" } });
    await click("Apply saved maps");
    const after = target.bus.store.getGraph();
    expect(after.nodes[ids.$previewPhoto!]!.parameters.file).toBe(replacement);
    expect(after.nodes[ids.$previewPhoto!]!.parameters.imageFit).toBe("fill");
    for (const [id, node] of Object.entries(before.nodes)) {
      if (id !== ids.$previewPhoto) expect(after.nodes[id]).toEqual(node);
    }
    expect(after.edges).toEqual(before.edges);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes[ids.$previewPhoto!]!.parameters.file).toBe(nightRef);
    expect(target.bus.store.getGraph().nodes[ids.$previewPhoto!]!.parameters.imageFit).toBe(before.nodes[ids.$previewPhoto!]!.parameters.imageFit);
  });

  it.each(["fit", "fill", "stretch"])("warns about different preview framing and persists the chosen %s treatment", async fit => {
    nightPhoto = { ...nightPhoto, bitmap: { width: 8, height: 2, close: vi.fn() } as unknown as ImageBitmap };
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    await screen.findByRole("note", { name: "Preview framing warning" });
    expect(screen.getByRole("note", { name: "Preview framing warning" }).textContent).toMatch(/Different aspect ratio.*alignment/i);
    const fitting = screen.getByRole("combobox", { name: "Preview fit" });
    expect(within(fitting).getAllByRole("option").map(option => option.textContent)).toEqual(["Fit whole image", "Crop to frame", "Stretch to frame"]);
    expect((fitting as HTMLSelectElement).value).toBe("stretch");
    fireEvent.change(fitting, { target: { value: fit } });
    expect(screen.getByText(fit === "fill" ? /Crop removes edges/ : fit === "stretch" ? /Stretch changes proportions/ : /Fit adds borders/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)?.parameters.imageFit).toBe(fit);
    expect(Object.values(graph.nodes).filter(node => node.type === "floatMapIn").map(node => node.parameters.photo)).toEqual([photoRef, photoRef]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts pixel-rounded day and night resolutions without a framing warning", async () => {
    photo = { ...photo, bitmap: { width: 3000, height: 1688, close: vi.fn() } as unknown as ImageBitmap };
    nightPhoto = { ...nightPhoto, bitmap: { width: 1672, height: 941, close: vi.fn() } as unknown as ImageBitmap };
    for (const [reference, kind] of [[depthRef, "depth"], [maskRef, "mask"]] as const) {
      const prepared = map(kind); const metadata = preparedMetadata(prepared);
      maps.set(reference, { ...prepared, metadata: { preparation: { ...metadata,
        source: { ...metadata.source, width: 3000, height: 1688 } } } });
    }
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    expect(screen.queryByRole("note", { name: "Preview framing warning" })).toBeNull();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const preview = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    expect(preview.resolution).toEqual({ mode: "fixed", width: 3000, height: 1688 });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refreshes a stale strict creation schema before applying preview fitting and preserves prior undo history", async () => {
    const target = runtime(); await existing(target); const before = target.bus.store.getGraph();
    await open(target);
    const staleHandler = vi.fn(() => { throw new Error("The obsolete creation handler must never run"); });
    // Deliberately emulate an already-running module that predates previewFit.
    const staleSchema = z.object({ photo: z.string(), depth: z.string(), mask: z.string(), width: z.number(), height: z.number(),
      shader: z.string(), effect: z.number().optional(), inputSide: z.number().optional(), previz: z.boolean().optional(),
      previewPhoto: z.string().optional() }).strict() as unknown as CommandInputSchema<"photoMapping.create">;
    target.bus.replaceCommand({ name: "photoMapping.create", inSession: "definition", inputSchema: staleSchema, handler: staleHandler });
    await choosePhoto(); await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" }); await chooseNightPhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview fit" }), { target: { value: "fill" } });
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(staleHandler).not.toHaveBeenCalled();
    const createdNight = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    expect(createdNight.parameters.imageFit).toBe("fill");
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes).toEqual(before.nodes);
    expect(target.bus.store.getGraph().edges).toEqual(before.edges);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains saved mapping setup across the one-time legacy-bus reload without inference", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" }); await chooseNightPhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview fit" }), { target: { value: "fill" } });
    fireEvent.change(screen.getByRole("combobox", { name: "First effect" }), { target: { value: "4" } });
    const key = `loom.photoMapping.reload.${target.project.projectId}`;
    const replaceCommand = target.bus.replaceCommand;
    const legacyBus = target.bus as unknown as { replaceCommand: unknown };
    try {
      legacyBus.replaceCommand = undefined;
      await click("Create mapping network");
      expect(screen.getByRole("alert").textContent).toMatch(/Reload Loom once.*Saved mapping setup will reopen/i);
      expect(screen.getByRole("button", { name: "Reload Loom" })).toBeDefined();
      expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ photo: photoRef, depth: depthRef, mask: maskRef,
        previewPhoto: nightRef, previewFit: "fill", mode: 4, previz: true, inputSide: 518 });
      const legacyDraft = JSON.parse(sessionStorage.getItem(key)!) as Record<string, unknown>;
      delete legacyDraft.useMask;
      sessionStorage.setItem(key, JSON.stringify(legacyDraft));
      expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
      cleanup();
    } finally { legacyBus.replaceCommand = replaceCommand; }
    render(<PhotoMappingHost runtime={target} />);
    await screen.findByRole("dialog"); await screen.findByRole("button", { name: "Rerun depth" });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(screen.getByRole("switch", { name: "Use surface mask" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("combobox", { name: "First effect" }) as HTMLSelectElement).value).toBe("4");
    expect((screen.getByRole("combobox", { name: "Preview fit" }) as HTMLSelectElement).value).toBe("fill");
    expect(within(screen.getByRole("group", { name: "Reference photo" })).getByText("sculpture.png")).toBeDefined();
    expect(within(screen.getByRole("group", { name: "Preview photo (optional)" })).getByText("night.png")).toBeDefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(key)).toBeNull();
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "customWgslMulti")?.parameters.mode).toBe(4);
    expect(Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)?.parameters.imageFit).toBe("fill");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("runs depth and mask inference on the original reference after selecting a night preview", async () => {
    const target = runtime(); await open(target); await choosePhoto(); await chooseNightPhoto();
    await click("Run depth"); await click("Run mask");
    expect(mocks.run.mock.calls.map(call => call[0].kind)).toEqual(["depth", "mask"]);
    for (const call of mocks.run.mock.calls) {
      expect(call[0].photo).toBe(photo); expect(call[0].photo).not.toBe(nightPhoto);
    }
  });

  it.each(["wrong-kind", "corrupt", "stale"] as const)("rejects an existing %s map without invoking inference", async failure => {
    const target = runtime(); await open(target); await choosePhoto();
    if (failure === "wrong-kind") maps.set(depthRef, map("mask"));
    if (failure === "stale") {
      const prepared = map("depth"); const metadata = preparedMetadata(prepared);
      maps.set(depthRef, { ...prepared, metadata: { preparation: { ...metadata, source: { ...metadata.source, sha256: "b".repeat(64) } } } });
    }
    if (failure === "corrupt") vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })));
    await chooseMap("depth");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(failure === "wrong-kind" ? /prepared depth/i : failure === "stale" ? /Depth out of date/i : /float|header|truncat|short/i));
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reuses saved depth while generating and saving only a missing mask", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await click("Run mask"); await click("Save mask…"); await click("Create mapping network");
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(depth.parameters.file).toBe(depthRef);
    expect(mocks.run.mock.calls.map(call => call[0].kind)).toEqual(["mask"]);
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["mask"]);
  });

  it.each(["depth", "mask"] as const)("shows measured %s downloads and indeterminate processing and saving only on its own preview", async kind => {
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun mask" });
    const other = kind === "depth" ? "mask" : "depth";
    const label = kind === "depth" ? "Depth" : "Mask";
    const region = within(screen.getByRole("region", { name: kind === "depth" ? "Depth preparation" : "Surface mask preparation" }));
    const previewWell = screen.getByTestId(`${kind}-preview-frame`).parentElement!;
    const otherWell = screen.getByTestId(`${other}-preview-frame`).parentElement!;
    const sourceId = kind === "depth" ? ids.$depth! : ids.$mask!;
    const original = target.bus.store.getGraph().nodes[sourceId]!.parameters.file;
    let finish!: (result: FloatMap) => void;
    mocks.run.mockReturnValueOnce(new Promise<FloatMap>(resolve => { finish = resolve; }));
    const replacement = { ...map(kind), width: 6, height: 6, values: new Float32Array(36).fill(kind === "depth" ? 0.5 : 1) };
    const originalBytes = encodeDepthExr(maps.get(original as string)!).slice();
    const intervals = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await click(`Rerun ${kind}`);
    const intervalIndex = intervals.mock.calls.findIndex(([, delay]) => delay === 1000);
    expect(intervalIndex).toBeGreaterThanOrEqual(0);
    const report = mocks.create.mock.calls[0]![0] as (update: PreparationProgress) => void;
    expect(previewWell.getAttribute("aria-busy")).toBe("true");
    expect(otherWell.getAttribute("aria-busy")).toBe("false");
    expect(within(otherWell).queryByRole("progressbar")).toBeNull();
    await act(async () => { report({ phase: "downloading", message: "47 MB of 94 MB", fraction: 0.5 }); });
    const progress = region.getByRole("progressbar", { name: `${label} preparation progress` });
    expect(progress.getAttribute("max")).toBe("100");
    expect(progress.getAttribute("value")).toBe("50");
    expect(region.getByText("50%")).toBeDefined();
    for (const control of [
      screen.getByRole("button", { name: `Rerun ${kind}` }),
      screen.getByRole("button", { name: `Save ${kind} again…` }),
      screen.getByRole("combobox", { name: "Detail" }),
      screen.getByRole("combobox", { name: "Mask detail" }),
      screen.getByRole("button", { name: "Apply saved maps" }),
    ]) expect((control as HTMLButtonElement | HTMLSelectElement).disabled).toBe(true);
    await act(async () => { report({ phase: "downloading", message: "47 MB" }); });
    expect(progress.hasAttribute("value")).toBe(false);
    await act(async () => { report({ phase: "processing", message: "Running the model on your photo…" }); });
    expect(progress.hasAttribute("value")).toBe(false);
    expect(region.getByText("Process").getAttribute("data-state")).toBe("active");
    const tick = intervals.mock.calls[intervalIndex]![0] as () => void;
    await act(async () => { now = 3000; tick(); });
    expect(region.getByText("2s")).toBeDefined();
    expect(region.queryByText("6 × 6 native samples · float32")).toBeNull();
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    expect(encodeDepthExr(maps.get(original as string)!)).toEqual(originalBytes);
    await act(async () => { finish(replacement); });
    expect(region.queryByRole("progressbar")).toBeNull();
    expect(previewWell.getAttribute("aria-busy")).toBe("false");
    expect(clearInterval).toHaveBeenCalledWith(intervals.mock.results[intervalIndex]!.value);
    expect((region.getByRole("button", { name: `Save ${kind}…` }) as HTMLButtonElement).disabled).toBe(false);
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    expect(mocks.save).not.toHaveBeenCalled();
    if (kind === "depth") expect(region.getByText("6 × 6 native samples · float32")).toBeDefined();

    let saved!: (reference: string) => void;
    mocks.save.mockReturnValueOnce(new Promise<string>(resolve => { saved = resolve; }));
    await click(`Save ${kind}…`);
    expect(previewWell.getAttribute("aria-busy")).toBe("true");
    expect(otherWell.getAttribute("aria-busy")).toBe("false");
    expect(region.getByRole("progressbar").hasAttribute("value")).toBe(false);
    const writing = mocks.save.mock.calls[0]![2] as (update: PreparationProgress) => void;
    await act(async () => { writing({ phase: "saving", message: "Writing the float32 map…" }); });
    expect(region.getByText("Save").getAttribute("data-state")).toBe("active");
    expect(region.getByRole("progressbar").hasAttribute("value")).toBe(false);
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    const reference = createFileReference(`${kind}-progress-saved`, "binary", `${kind}.loom.exr`);
    maps.set(reference, replacement);
    await act(async () => { saved(reference); });
    expect(region.queryByRole("progressbar")).toBeNull();
    expect(previewWell.getAttribute("aria-busy")).toBe("false");
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    await click("Apply saved maps");
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(reference);
  });

  it.each(["inference", "saving", "cancelled picker"] as const)("clears progress after %s without replacing the saved map", async failure => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    let fail!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    if (failure === "inference") mocks.run.mockReturnValueOnce(pending);
    else mocks.save.mockReturnValueOnce(pending);
    await click(failure === "inference" ? "Rerun depth" : "Save depth again…");
    const previewWell = screen.getByTestId("depth-preview-frame").parentElement!;
    expect(previewWell.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("progressbar", { name: "Depth preparation progress" })).toBeDefined();
    await act(async () => { fail(failure === "cancelled picker" ? new DOMException("cancelled", "AbortError") : new Error(`${failure} failed`)); });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(previewWell.getAttribute("aria-busy")).toBe("false");
    expect((screen.getByRole("button", { name: "Rerun depth" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(false);
    if (failure === "cancelled picker") expect(screen.queryByRole("alert")).toBeNull();
    else expect(screen.getByRole("alert").textContent).toBe(`${failure} failed`);
    expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
    expect(maps.get(depthRef)).toBeDefined();
  });

  it("reloads the same saved depth handle when it is selected after an unsaved rerun", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    await click("Rerun depth");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull();
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(depth.parameters.file).toBe(depthRef);
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains existing map selections made before choosing their reference photo", async () => {
    const target = runtime(); await open(target);
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await choosePhoto();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const mapsInGraph = Object.values(target.bus.store.getGraph().nodes).filter(node => node.type === "floatMapIn");
    expect(mapsInGraph.map(node => node.parameters.file).sort()).toEqual([depthRef, maskRef].sort());
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports an impossible imported depth letterbox without crashing the dialog", async () => {
    photo = { ...photo, bitmap: { width: 100, height: 1, close: vi.fn() } as unknown as ImageBitmap };
    mocks.decode.mockResolvedValue(photo);
    const prepared = map("depth"); const metadata = preparedMetadata(prepared);
    maps.set(depthRef, { ...prepared, width: 2, height: 2, values: new Float32Array([0, 1, 2, 3]),
      metadata: { preparation: { ...metadata, source: { ...metadata.source, width: 100, height: 1 } } } });
    const target = runtime(); await open(target); await choosePhoto(); await chooseMap("depth");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/letterbox band contains no native samples/i));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("updates depth detail when an existing map is overwritten under the same retained reference", async () => {
    const target = runtime(); const ids = await existing(target);
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters.inputSide).toBe("518");
    maps.set(depthRef, map("depth", 392));
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun mask" });
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await click("Apply saved maps");
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters).toMatchObject({ file: depthRef, inputSide: "392" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters.inputSide).toBe("518");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reopens saved maps without inference and reruns depth without changing mask or calibration", async () => {
    const target = runtime(); const ids = await existing(target);
    await target.bus.execute("graph.applyPatch", { baseRevision: target.bus.store.getRevision(), operations: [
      { op: "setParameters", nodeId: ids.$grid!, parameters: { p00: [0.1, 0.2] } },
    ] }, target.invocation);
    const before = target.bus.store.getGraph();
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun depth" });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(mocks.create).not.toHaveBeenCalled();
    await click("Rerun depth"); await click("Save depth…"); await click("Apply saved maps");
    const after = target.bus.store.getGraph();
    expect(after.nodes[ids.$mask!]!.parameters).toEqual(before.nodes[ids.$mask!]!.parameters);
    expect(after.nodes[ids.$grid!]).toEqual(before.nodes[ids.$grid!]);
    expect(after.nodes[ids.$corner!]).toEqual(before.nodes[ids.$corner!]);
    expect(after.nodes[ids.$depth!]!.parameters.file).not.toBe(depthRef);
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters.file).toBe(depthRef);
    expect(mocks.run.mock.calls.map(call => call[0].kind)).toEqual(["depth"]);
  });

  it("rejects wrong selections and dry runs without opening a dialog", async () => {
    const target = runtime(); const ids = await existing(target);
    render(<PhotoMappingHost runtime={target} />);
    const dry = await target.bus.execute("photoMapping.prepare", { nodeIds: [ids.$depth!] }, { ...target.invocation, dryRun: true });
    expect(dry.status).toBe("validated"); expect(dry.output.opened).toBe(false);
    const wrong = await target.bus.execute("photoMapping.prepare", { nodeIds: [ids.$photo!] }, target.invocation);
    expect(wrong.status).toBe("rejected"); expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.decode).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });

  it("disposes preparation on close and ignores late inference completion", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    let complete!: (result: FloatMap) => void;
    mocks.run.mockReturnValue(new Promise<FloatMap>(resolve => { complete = resolve; }));
    const clearInterval = vi.spyOn(window, "clearInterval");
    await click("Run depth");
    expect(screen.getByRole("progressbar", { name: "Depth preparation progress" })).toBeDefined();
    await click("Close");
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    const report = mocks.create.mock.calls[0]![0] as (update: PreparationProgress) => void;
    await act(async () => { report({ phase: "processing", message: "Late progress" }); complete(map("depth")); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
    expect(Object.keys(target.bus.store.getGraph().nodes)).toHaveLength(0);
  });

  it("retains a working preparation session after StrictMode effect replay", async () => {
    const target = runtime(); await open(target, undefined, true); await choosePhoto();
    await click("Run depth");
    await screen.findByRole("button", { name: "Rerun depth" });
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("paints native high-resolution samples despite a smaller display and preserves radius edits and undo", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const prepared = makePreparedMap(new Float32Array(1536 * 1536).fill(0.75), 1536, 1536, {
      kind: "mask", source: { sha256, width: 4, height: 2 },
      model: { id: "manual", url: "loom:manual-mask" }, inputSide: 1536, registration: "stretch",
    });
    maps.set(maskRef, prepared);
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const canvas = screen.getByRole("img", { name: "Surface mask editor" }) as HTMLCanvasElement;
    expect(canvas.width * canvas.height).toBeLessThan(prepared.values.length);
    fireEvent.change(screen.getByRole("slider", { name: "Mask brush radius" }), { target: { value: "5" } });
    await click("Save mask again…");
    const loaded = mocks.save.mock.calls[0]![0] as FloatMap;
    expect(loaded.values.every(value => Object.is(value, 0.75))).toBe(true);
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 600, clientY: 384, pointerId: 1 });
      fireEvent.pointerCancel(canvas, { pointerId: 1 });
    });
    await click("Save mask…");
    const saved = mocks.save.mock.calls[1]![0] as FloatMap;
    expect([saved.width, saved.height]).toEqual([1536, 1536]);
    expect(saved.values[768 * 1536 + 768]).toBe(0);
    expect(saved.values[768 * 1536 + 900]).toBe(0);
    expect(saved.values[0]).toBe(0.75);
    expect(prepared.values[768 * 1536 + 768]).toBe(0.75);
    await click("Undo mask stroke"); await click("Save mask…");
    expect(mocks.save.mock.calls[2]![0]).toBe(loaded);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("undoes an entire manual mask stroke before saving without invoking inference", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const target = runtime(); await open(target); await choosePhoto();
    await click("Start manual mask");
    const canvas = screen.getByRole("img", { name: "Surface mask editor" });
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 600, clientY: 400, pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
    });
    await click("Save mask…");
    expect([...mocks.save.mock.calls[0]![0].values]).toEqual(new Array(8).fill(0));
    await click("Undo mask stroke"); await click("Save mask…");
    expect([...mocks.save.mock.calls[1]![0].values]).toEqual(new Array(8).fill(1));
    expect((screen.getByRole("button", { name: "Undo mask stroke" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps rerun depth and painted mask when older saved-file loads finish late", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const oldDepth = map("depth"), oldMask = map("mask");
    oldMask.values.fill(0.5);
    let finishDepth!: (bytes: ArrayBuffer) => void, finishMask!: (bytes: ArrayBuffer) => void;
    const depthLoad = new Promise<ArrayBuffer>(resolve => { finishDepth = resolve; });
    const maskLoad = new Promise<ArrayBuffer>(resolve => { finishMask = resolve; });
    const fetchFiles = vi.fn(async (url: string) => ({ ok: true,
      arrayBuffer: () => url.includes(encodeURIComponent(depthRef)) ? depthLoad : maskLoad }));
    vi.stubGlobal("fetch", fetchFiles);
    const metadata = preparedMetadata(oldDepth);
    const freshDepth = makePreparedMap(Float32Array.from({ length: 16 }, (_, i) => 100 + i * 0.5), 4, 4,
      { kind: "depth", source: metadata.source, model: metadata.model, inputSide: 518, registration: "letterbox" });
    mocks.run.mockResolvedValueOnce(freshDepth);
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth);
    await waitFor(() => expect(fetchFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "Run depth" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Run depth"); await click("Start manual mask");
    const canvas = screen.getByRole("img", { name: "Surface mask editor" });
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      finishDepth(encodeDepthExr(oldDepth).buffer as ArrayBuffer);
      finishMask(encodeDepthExr(oldMask).buffer as ArrayBuffer);
    });
    await click("Save depth…"); await click("Save mask…");
    expect([...mocks.save.mock.calls[0]![0].values]).toEqual([...freshDepth.values]);
    expect([...mocks.save.mock.calls[1]![0].values]).toEqual(new Array(8).fill(0));
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("does not reload saved depth when the independent mask handle becomes ready after a depth rerun", async () => {
    let maskReady = false, revision = 0;
    const listeners = new Set<() => void>();
    const broker = mocks.broker();
    mocks.broker.mockReturnValue({ ...broker,
      snapshot: (reference: string) => reference === maskRef && !maskReady ? { kind: "pending" }
        : { kind: "ready", url: `https://assets.test/${encodeURIComponent(reference)}` },
      revision: () => revision,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    });
    const fetchFiles = vi.fn(async (url: string) => {
      const reference = decodeURIComponent(new URL(url).pathname.slice(1));
      const prepared = maps.get(reference);
      if (prepared === undefined) throw new Error(`Unexpected map fetch ${reference}`);
      return { ok: true, arrayBuffer: async () => encodeDepthExr(prepared).buffer };
    });
    vi.stubGlobal("fetch", fetchFiles);
    const metadata = preparedMetadata(map("depth"));
    const freshDepth = makePreparedMap(Float32Array.from({ length: 16 }, (_, i) => 50 + i * 0.25), 4, 4,
      { kind: "depth", source: metadata.source, model: metadata.model, inputSide: 518, registration: "letterbox" });
    mocks.run.mockResolvedValueOnce(freshDepth);
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth); await screen.findByRole("button", { name: "Rerun depth" });
    expect(fetchFiles).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Run mask" })).toBeDefined();
    await click("Rerun depth");
    await act(async () => { maskReady = true; revision++; listeners.forEach(listener => listener()); });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(fetchFiles.mock.calls.filter(([url]) => url.includes(encodeURIComponent(depthRef)))).toHaveLength(1);
    expect(fetchFiles.mock.calls.filter(([url]) => url.includes(encodeURIComponent(maskRef)))).toHaveLength(1);
    await click("Save depth…");
    expect([...mocks.save.mock.calls[0]![0].values]).toEqual([...freshDepth.values]);
  });

  it("opens a fresh target when preparation is invoked again while a draft is open", async () => {
    const target = runtime(); const ids = await existing(target);
    await open(target); await choosePhoto(); await click("Run depth");
    expect(mocks.create).toHaveBeenCalledOnce();
    await act(async () => { await target.bus.execute("photoMapping.prepare", { nodeIds: [ids.$depth!] }, target.invocation); });
    await screen.findByRole("button", { name: "Apply saved maps" });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Create mapping network" })).toBeNull();
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Apply saved maps");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(Object.keys(target.bus.store.getGraph().nodes)).toHaveLength(11);
  });

  it("rejects loaded mask samples outside the coverage range explicitly", async () => {
    const invalid = map("mask"); invalid.values[3] = 1.125;
    maps.set(maskRef, invalid);
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$mask);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/mask.*0\.\.1|probabilities.*0\.\.1/i));
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("marks saved source dimensions stale even when the photo hash matches", async () => {
    const prepared = map("depth");
    const metadata = preparedMetadata(prepared);
    maps.set(depthRef, { ...prepared, metadata: { preparation: { ...metadata, source: { ...metadata.source, width: 8 } } } });
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Depth out of date/i));
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["photo", "detail"] as const)("rejects applying when the graph's %s changed while preparation was open", async changed => {
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth); await screen.findByRole("button", { name: "Rerun depth" });
    await click("Rerun depth"); await click("Save depth…");
    await target.bus.execute("graph.applyPatch", { baseRevision: target.bus.store.getRevision(), operations: [
      { op: "setParameters", nodeId: changed === "photo" ? ids.$photo! : ids.$depth!,
        parameters: changed === "photo" ? { file: createFileReference("replacement", "image", "replacement.png") } : { inputSide: "266" } },
    ] }, target.invocation);
    const before = target.bus.store.getGraph();
    await click("Apply saved maps");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/changed.*preparation|preparation.*changed/i);
    expect(target.bus.store.getGraph()).toEqual(before);
  });
});

describe("photo depth model and refinement workflow", () => {
  function enableWebGpu() {
    vi.stubGlobal("navigator", { gpu: {}, userAgent: navigator.userAgent, platform: navigator.platform });
    vi.stubGlobal("crypto", webcrypto);
  }

  function installRefinement() {
    mocks.refine.mockImplementation(async (_photo: PreparationPhoto, native: FloatMap, recipe: PhotoDepthRecipe) => {
      const metadata = preparedMetadata(native);
      const derived = makePreparedMap(new Float32Array([0, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 1]), 4, 2,
        { kind: "depth", source: metadata.source, model: metadata.model, inputSide: metadata.inputSide, registration: "stretch" });
      return withDepthRecipe(derived, recipe, { sha256: createHash("sha256").update(encodeDepthExr(native)).digest("hex"),
        width: native.width, height: native.height });
    });
  }

  it("defaults large-input refinement radius to one while preserving an explicit radius edit", async () => {
    enableWebGpu();
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "1288" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "source" } });
    const radius = screen.getByRole("spinbutton", { name: "Pass radius" }) as HTMLInputElement;
    expect(radius.value).toBe("1");
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "518" } });
    expect(radius.value).toBe(String(DEFAULT_DEPTH_REFINEMENT.radius));
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "1288" } });
    expect(radius.value).toBe("1");
    fireEvent.change(radius, { target: { value: "4" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "518" } });
    expect(radius.value).toBe("4");
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "1288" } });
    expect(radius.value).toBe("4");
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.refine).not.toHaveBeenCalled();
  });

  it("preserves a restored large-input refinement radius instead of applying new defaults", async () => {
    enableWebGpu();
    const target = runtime(), ids = await existing(target), native = withDepthRecipe(map("depth", 1288), { ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide: 1288 });
    const nativeRef = createFileReference("restored-native", "binary", "native.loom.exr");
    const refinedRef = createFileReference("restored-refined", "binary", "refined.loom.exr");
    const recipe = { ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide: 1288, refinement: { ...DEFAULT_DEPTH_REFINEMENT, radius: 3 } };
    const metadata = preparedMetadata(native), derived = makePreparedMap(new Float32Array(8).fill(0.5), 4, 2,
      { kind: "depth", source: metadata.source, model: metadata.model, inputSide: 1288, registration: "stretch" });
    maps.set(nativeRef, native);
    maps.set(refinedRef, withDepthRecipe(derived, recipe, { sha256: createHash("sha256").update(encodeDepthExr(native)).digest("hex"), width: 4, height: 4 }));
    await target.bus.execute("graph.applyPatch", { baseRevision: target.bus.store.getRevision(), operations: [{ op: "setParameters",
      nodeId: ids.$depth!, parameters: { file: refinedRef, nativeMap: nativeRef, ...depthRecipeParameters(recipe) } }] }, target.invocation);
    await open(target, ids.$depth);
    const radius = await screen.findByRole("spinbutton", { name: "Pass radius" }) as HTMLInputElement;
    await waitFor(() => expect(radius.value).toBe("3"));
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "518" } });
    expect(radius.value).toBe("3");
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "1288" } });
    expect(radius.value).toBe("3");
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.refine).not.toHaveBeenCalled();
  });

  it("Save all and create saves fresh native depth and a manual mask once before graph mutation", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    expect(screen.getByRole("switch", { name: "Use depth map" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Use surface mask" }).getAttribute("aria-checked")).toBe("true");
    await click("Run depth"); await click("Start manual mask");
    const before = target.bus.store.getGraph(), saveMap = mocks.save.getMockImplementation()!;
    mocks.save.mockImplementation(async (...args) => {
      expect(target.bus.store.getGraph()).toBe(before);
      return saveMap(...args);
    });
    expect((screen.getByRole("button", { name: "Save all and create" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Save all and create");
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls.map(([prepared]) => preparedMetadata(prepared).kind)).toEqual(["depth", "mask"]);
    const [depthFile, maskFile] = await Promise.all(mocks.save.mock.results.map(result => result.value as Promise<string>));
    const graph = target.bus.store.getGraph();
    const depth = Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    const mask = Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")!;
    expect(depth.parameters.file).toBe(depthFile);
    expect(mask.parameters.file).toBe(maskFile);
    expect(maps.get(depthFile!)).toBe(mocks.save.mock.calls[0]![0]);
    expect(maps.get(maskFile!)).toBe(mocks.save.mock.calls[1]![0]);
    expect(preparedMetadata(maps.get(maskFile!)!).model.id).toBe("manual");
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Save all and create saves unsaved native, refined depth and mask in order with the canonical EXR parent SHA", async () => {
    enableWebGpu(); installRefinement();
    const target = runtime(); await open(target); await choosePhoto();
    await click("Run depth");
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "source" } });
    await click("Run refinement"); await click("Start manual mask");
    expect(mocks.save).not.toHaveBeenCalled();
    const before = target.bus.store.getGraph(), saveMap = mocks.save.getMockImplementation()!;
    mocks.save.mockImplementation(async (...args) => {
      expect(target.bus.store.getGraph()).toBe(before);
      return saveMap(...args);
    });
    await click("Save all and create");
    expect(mocks.save).toHaveBeenCalledTimes(3);
    const [native, refined, mask] = mocks.save.mock.calls.map(([prepared]) => prepared as FloatMap);
    expect(preparedMetadata(native!)).toMatchObject({ kind: "depth", version: 2, stage: "native" });
    expect(preparedMetadata(refined!)).toMatchObject({ kind: "depth", version: 2, stage: "refined",
      parent: { sha256: createHash("sha256").update(encodeDepthExr(native!)).digest("hex"), width: native!.width, height: native!.height } });
    expect(preparedMetadata(mask!)).toMatchObject({ kind: "mask", model: { id: "manual" } });
    const [nativeFile, depthFile, maskFile] = await Promise.all(mocks.save.mock.results.map(result => result.value as Promise<string>));
    const graph = target.bus.store.getGraph();
    const depth = Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    const coverage = Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")!;
    expect(depth.parameters).toMatchObject({ file: depthFile, nativeMap: nativeFile, refinementTarget: "source" });
    expect(coverage.parameters.file).toBe(maskFile);
    expect(maps.get(nativeFile!)).toBe(native);
    expect(maps.get(depthFile!)).toBe(refined);
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.refine).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["cancel", "undefined"])("Save all stops on the second %s save and reuses the first saved depth on retry", async failure => {
    const target = runtime(); await open(target); await choosePhoto();
    await click("Run depth"); await click("Start manual mask");
    const before = target.bus.store.getGraph(), saveMap = mocks.save.getMockImplementation()!;
    let saves = 0;
    mocks.save.mockImplementation(async (...args) => {
      expect(target.bus.store.getGraph()).toBe(before);
      if (++saves === 2) {
        if (failure === "cancel") throw new DOMException("Cancelled save", "AbortError");
        return undefined;
      }
      return saveMap(...args);
    });
    await click("Save all and create");
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(target.bus.store.getGraph()).toBe(before);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save depth again…" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Save mask…" })).toBeDefined();
    const depthFile = await mocks.save.mock.results[0]!.value as string;
    expect(maps.get(depthFile)).toBe(mocks.save.mock.calls[0]![0]);
    await click("Save all and create");
    expect(mocks.save).toHaveBeenCalledTimes(3);
    expect(mocks.save.mock.calls.map(([prepared]) => preparedMetadata(prepared).kind)).toEqual(["depth", "mask", "mask"]);
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(depth.parameters.file).toBe(depthFile);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("Save all and create reuses independently saved depth and mask without extra writes", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await click("Run depth"); await click("Save depth…");
    await click("Start manual mask"); await click("Save mask…");
    const references = await Promise.all(mocks.save.mock.results.map(result => result.value as Promise<string>));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    await click("Save all and create");
    expect(mocks.save).toHaveBeenCalledTimes(2);
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).filter(node => node.type === "floatMapIn").map(node => node.parameters.file))
      .toEqual(references);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("skips optional refinement and creates from the exact saved native prediction", async () => {
    enableWebGpu(); installRefinement();
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    await click("Run depth"); await click("Save depth…");
    const native = mocks.save.mock.calls[0]![0] as FloatMap;
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "source" } });
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "off" } });
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const node = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(maps.get(node.parameters.file as string)).toBe(native);
    expect(node.parameters.nativeMap ?? "").toBe("");
    expect(node.parameters.refinementTarget).toBe("off");
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.refine).not.toHaveBeenCalled(); expect(mocks.save).toHaveBeenCalledOnce();
  });

  it("derives a float32 mask from depth without inference and invalidates only that mask when its cutoff changes", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await click("Run depth"); await click("Save depth…");
    const native = mocks.save.mock.calls[0]![0] as FloatMap, original = encodeDepthExr(native);
    fireEvent.change(screen.getByRole("combobox", { name: "Mask method" }), { target: { value: "depth" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Run mask" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Run mask"); await click("Save mask…");
    const mask = mocks.save.mock.calls[1]![0] as FloatMap;
    expect(depthRangeMaskSettings(mask)).toEqual({ version: 1, low: 0, high: 1, softness: 0.02,
      parentSha256: createHash("sha256").update(original).digest("hex") });
    expect(mask.values).toBeInstanceOf(Float32Array);
    expect(mask.values.every(value => value === 1)).toBe(true);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByRole("slider", { name: /^Far cutoff/ }), { target: { value: "0.25" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Mask settings changed|Mask belongs to another reference photo/);
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect(encodeDepthExr(native)).toEqual(original);
    expect(mocks.run).toHaveBeenCalledOnce();
    await click("Rerun mask"); await click("Save mask…");
    const changed = mocks.save.mock.calls[2]![0] as FloatMap;
    expect(depthRangeMaskSettings(changed)).toMatchObject({ low: 0.25, high: 1 });
    expect(changed.values.some(value => value === 0)).toBe(true);
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.refine).not.toHaveBeenCalled();
  });

  it("selects Large 4-bit explicitly while retaining the independently saved surface mask", async () => {
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Save mask again…" });
    const depthPreparation = within(screen.getByRole("region", { name: "Depth preparation" }));
    const models = depthPreparation.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    expect(within(models).getByRole("option", { name: /Large.*4-bit.*MB/ })).toBeDefined();
    fireEvent.change(models, { target: { value: PHOTO_DEPTH_LARGE_Q4F16.id } });
    expect(screen.getByRole("alert").textContent).toMatch(/Depth out of date/);
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save mask again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(true);
    expect((depthPreparation.getByRole("combobox", { name: "Inference backend" }) as HTMLSelectElement).value).toBe("wasm");
    const sizes = depthPreparation.getByRole("combobox", { name: "Detail" }) as HTMLSelectElement;
    expect(sizes.value).toBe("518");
    expect((within(sizes).getByRole("option", { name: "1036 × 1036" }) as HTMLOptionElement).disabled).toBe(true);
    await click("Rerun depth"); await click("Save depth…"); await click("Apply saved maps");
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run.mock.calls[0]![0]).toMatchObject({ kind: "depth", recipe: { modelId: PHOTO_DEPTH_LARGE_Q4F16.id, backend: "wasm", inputSide: 518 } });
    const graph = target.bus.store.getGraph();
    expect(graph.nodes[ids.$depth!]!.parameters.depthModel).toBe(PHOTO_DEPTH_LARGE_Q4F16.id);
    expect(graph.nodes[ids.$mask!]!.parameters.file).toBe(maskRef);
  });

  it("shows canonical Marigold platform requirements and prevents unavailable inference without downloading", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "marigold-v2-q4" } });
    const preparation = within(screen.getByRole("region", { name: "Depth preparation" }));
    for (const requirement of ["Desktop only", "macOS", "Apple Silicon"]) expect(preparation.getByText(requirement, { exact: true })).toBeDefined();
    expect(preparation.getByRole("note").textContent).toMatch(/desktop app/i);
    expect((screen.getByRole("button", { name: "Run depth" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Run depth" }));
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(Object.keys(target.bus.store.getGraph().nodes)).toHaveLength(0);
  });

  /**
   * T1817b: Depth Pro 2 at selection says its licence, offers its own two boxes, and takes
   * its field of view from the photo's EXIF until the person sets one — and what reaches
   * the run and the network is what the form said.
   */
  it("offers Depth Pro 2 with its licence, boxes and an EXIF field of view, and runs and saves what the form says", async () => {
    enableWebGpu();
    photo = { ...photo, focalLength35: 24 };
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    const preparation = within(screen.getByRole("region", { name: "Depth preparation" }));
    fireEvent.change(preparation.getByRole("combobox", { name: "Model" }), { target: { value: "depthpro2-s-fp32" } });
    expect(preparation.getAllByRole("note").map(note => note.textContent).join(" ")).toMatch(/research use only/);
    expect((preparation.getByRole("combobox", { name: "Inference backend" }) as HTMLSelectElement).value).toBe("webgpu");
    const sizes = preparation.getByRole("combobox", { name: "Detail" }) as HTMLSelectElement;
    expect(sizes.value).toBe("640");
    expect(within(sizes).getAllByRole("option").map(option => option.textContent)).toEqual(["640 × 480 (4:3)", "672 × 384 (16:9)"]);
    // 24 mm equivalent on a 2:1 frame: 43.27 mm × 2/√5 = 38.7 mm across, 2·atan(38.7/48) = 77.8°.
    expect((preparation.getByRole("spinbutton", { name: /Field of view/ }) as HTMLInputElement).value).toBe("77.8");
    expect(preparation.getByText(/24 mm equivalent, 77.8°/)).toBeDefined();
    // Leaving the family lands on Depth Anything's own sizes, not a Depth Pro 2 box; coming back, on its 4:3 box.
    const models = preparation.getByRole("combobox", { name: "Model" });
    fireEvent.change(models, { target: { value: DEFAULT_PHOTO_DEPTH_RECIPE.modelId } });
    expect(sizes.value).toBe("518");
    expect(preparation.queryByRole("spinbutton", { name: /Field of view/ })).toBeNull();
    fireEvent.change(models, { target: { value: "depthpro2-s-fp32" } });
    expect(sizes.value).toBe("640");
    fireEvent.change(sizes, { target: { value: "672" } });
    fireEvent.change(preparation.getByRole("spinbutton", { name: /Field of view/ }), { target: { value: "70" } });
    await click("Run depth");
    expect(mocks.run.mock.calls[0]![0]).toMatchObject({ kind: "depth",
      recipe: { version: 3, modelId: "depthpro2-s-fp32", backend: "webgpu", inputSide: 672, fieldOfView: 70, refinement: null } });
    await click("Save depth…");
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn")!;
    expect(depth.parameters).toMatchObject({ depthModel: "depthpro2-s-fp32", depthBackend: "webgpu", inputSide: "672", depthFieldOfView: 70 });
  });

  it("saves the native parent before the refined result and persists the selected recipe in the network", async () => {
    enableWebGpu(); installRefinement();
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    await click("Run depth");
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "source" } });
    await click("Run refinement");
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
    await click("Save native depth…");
    await click("Save depth…");
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    const native = mocks.save.mock.calls[0]![0] as FloatMap;
    const refined = mocks.save.mock.calls[1]![0] as FloatMap;
    expect(preparedMetadata(native)).toMatchObject({ version: 2, stage: "native", recipe: { refinement: null } });
    expect(preparedMetadata(refined)).toMatchObject({ version: 2, stage: "refined", recipe: { refinement: DEFAULT_DEPTH_REFINEMENT },
      parent: { sha256: createHash("sha256").update(encodeDepthExr(native)).digest("hex"), width: native.width, height: native.height } });
    await click("Create mapping network");
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn")!;
    expect(depth.parameters).toMatchObject({ depthModel: DEFAULT_PHOTO_DEPTH_RECIPE.modelId, depthBackend: "wasm", inputSide: "518",
      refinementTarget: "source", refineRadius: DEFAULT_DEPTH_REFINEMENT.radius, refineSpatialSigma: DEFAULT_DEPTH_REFINEMENT.spatialSigma,
      refineColorSigma: DEFAULT_DEPTH_REFINEMENT.colorSigma });
    expect(maps.get(depth.parameters.nativeMap as string)).toEqual(native);
    expect(maps.get(depth.parameters.file as string)).toEqual(refined);
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.refine).toHaveBeenCalledOnce();
  });

  it("retains a previously saved native parent and the refined inspection view through asynchronous parent verification", async () => {
    enableWebGpu(); installRefinement();
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    await click("Run depth"); await click("Save depth…");
    const native = mocks.save.mock.calls[0]![0] as FloatMap;
    const nativeBytes = encodeDepthExr(native), nativeDigest = createHash("sha256").update(nativeBytes).digest("hex");
    const nativeReference = [...maps].find(([reference, saved]) => reference !== depthRef && saved === native)![0];
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "source" } });
    await click("Run refinement");
    const views = within(screen.getByRole("group", { name: "Inspection view" }));
    expect(views.getByRole("button", { name: "Refined depth" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: "Refined depth display; numerical samples are shown below" })).toBeDefined();
    let finishNative!: (bytes: ArrayBuffer) => void;
    const pendingNative = new Promise<ArrayBuffer>(resolve => { finishNative = resolve; });
    const fetchFiles = vi.fn(async (url: string) => {
      const reference = decodeURIComponent(new URL(url).pathname.slice(1));
      const saved = maps.get(reference);
      if (saved === undefined) throw new Error(`Unexpected map fetch ${reference}`);
      return { ok: true, arrayBuffer: () => reference === nativeReference ? pendingNative : Promise.resolve(encodeDepthExr(saved).buffer) };
    });
    vi.stubGlobal("fetch", fetchFiles);
    mocks.broker.mock.results[0]!.value.remember.mockResolvedValueOnce(nativeReference);
    vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: "native.loom.exr" }]);
    await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Native depth parent" })).getByRole("button", { name: "choose…" })); });
    await waitFor(() => expect(fetchFiles).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(views.getByRole("button", { name: "Refined depth" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => { finishNative(nativeBytes.buffer as ArrayBuffer); });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(false));
    expect(views.getByRole("button", { name: "Refined depth" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: "Refined depth display; numerical samples are shown below" })).toBeDefined();
    await click("Save depth…");
    const refined = mocks.save.mock.calls[1]![0] as FloatMap;
    expect(preparedMetadata(refined)).toMatchObject({ stage: "refined",
      parent: { sha256: nativeDigest, width: native.width, height: native.height } });
    expect(encodeDepthExr(maps.get(nativeReference)!)).toEqual(nativeBytes);
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(depth.parameters.nativeMap).toBe(nativeReference);
    expect(maps.get(depth.parameters.file as string)).toBe(refined);
    expect(encodeDepthExr(maps.get(depth.parameters.nativeMap as string)!)).toEqual(nativeBytes);
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.refine).toHaveBeenCalledOnce();
  });

  it("blocks applying or saving refined depth until its exact native parent is verified", async () => {
    const target = runtime(); const ids = await existing(target);
    const native = maps.get(depthRef)!;
    const nativeRef = createFileReference("wrong-native", "binary", "wrong-native.loom.exr");
    const wrong = { ...native, values: new Float32Array(native.values).fill(8) };
    maps.set(nativeRef, wrong);
    const finalRef = createFileReference("refined", "binary", "refined.loom.exr");
    const metadata = preparedMetadata(native);
    const recipe = { ...DEFAULT_PHOTO_DEPTH_RECIPE, refinement: DEFAULT_DEPTH_REFINEMENT };
    const derived = makePreparedMap(new Float32Array(8).fill(0.5), 4, 2, { kind: "depth", source: metadata.source,
      model: metadata.model, inputSide: 518, registration: "stretch" });
    maps.set(finalRef, withDepthRecipe(derived, recipe, { sha256: createHash("sha256").update(encodeDepthExr(native)).digest("hex"), width: 4, height: 4 }));
    await target.bus.execute("graph.applyPatch", { baseRevision: target.bus.store.getGraph().revision, operations: [
      { op: "setParameters", nodeId: ids.$depth!, parameters: { file: finalRef, nativeMap: nativeRef, ...depthRecipeParameters(recipe) } },
    ] }, target.invocation);
    const before = target.bus.store.getGraph();
    await open(target, ids.$depth);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/recorded parent/));
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.refine).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(target.bus.store.getGraph()).toEqual(before);
  });

  it("refines again from the retained native prediction without rerunning inference", async () => {
    enableWebGpu(); installRefinement();
    const target = runtime(); await open(target); await choosePhoto(); await click("Run depth");
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "source" } });
    await click("Run refinement");
    const native = mocks.refine.mock.calls[0]![1] as FloatMap;
    const original = native.values.slice();
    fireEvent.change(screen.getByRole("slider", { name: /^Edge sensitivity/ }), { target: { value: "0.2" } });
    await click("Run refinement");
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.refine).toHaveBeenCalledTimes(2);
    expect(mocks.refine.mock.calls[1]![1]).toBe(native);
    expect(mocks.refine.mock.calls[1]![2]).toMatchObject({ refinement: { colorSigma: 0.2 } });
    expect(native.values).toEqual(original);
  });

  it("keeps cancellation active until work retires and discards a late successful result", async () => {
    let finish!: (map: FloatMap) => void;
    mocks.run.mockReturnValueOnce(new Promise<FloatMap>(resolve => { finish = resolve; }));
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth); await screen.findByRole("button", { name: "Save depth again…" });
    await click("Rerun depth"); await click("Cancel preparation");
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Rerun depth" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(withDepthRecipe(map("depth"), DEFAULT_PHOTO_DEPTH_RECIPE)); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel preparation" })).toBeNull());
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save depth again…" })).toBeDefined();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters.file).toBe(depthRef);
  });
  it("surfaces a retirement failure after Cancel instead of claiming successful cancellation", async () => {
    let fail!: (error: Error) => void;
    mocks.run.mockReturnValueOnce(new Promise<FloatMap>((_resolve, reject) => { fail = reject; }));
    const target = runtime(); await open(target); await choosePhoto(); await click("Run depth");
    await click("Cancel preparation");
    await act(async () => { fail(new AggregateError([new Error("Native child still alive")], "Native retirement failed: Native child still alive")); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Native child still alive"));
    expect(screen.queryByText("Preparation cancelled. Saved maps are unchanged.")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("keeps a fresh native prediction saveable when a refined output is selected", async () => {
    enableWebGpu();
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Refined output" }), { target: { value: "source" } });
    await click("Run depth");
    const depth = within(screen.getByRole("region", { name: "Depth preparation" }));
    expect(depth.getByText("Ready to refine", { exact: true })).toBeDefined();
    expect(depth.queryByText("Out of date", { exact: true })).toBeNull();
    expect((depth.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByRole("slider", { name: /^Edge sensitivity/ }), { target: { value: "0.2" } });
    expect((depth.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Save depth…");
    expect(mocks.save).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Run refinement" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("reopens the latest draft with prepared maps, brush edits and settings without rerunning", async () => {
    const target = runtime(); await open(target); await choosePhoto(); await click("Run depth");
    await click("Start manual mask");
    fireEvent.change(screen.getByRole("slider", { name: "Mask brush radius" }), { target: { value: "42" } });
    fireEvent.change(screen.getByRole("combobox", { name: "First effect" }), { target: { value: "3" } });
    const originalRunCount = mocks.run.mock.calls.length;
    await click("Close"); expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { await target.bus.execute("photoMapping.prepare", {}, target.invocation); });
    await screen.findByRole("dialog");
    expect(screen.getByRole("combobox", { name: "First effect" }).getAttribute("value") ?? (screen.getByRole("combobox", { name: "First effect" }) as HTMLSelectElement).value).toBe("3");
    await click("Surface mask");
    expect((screen.getByRole("slider", { name: "Mask brush radius" }) as HTMLInputElement).value).toBe("42");
    expect(screen.getByRole("img", { name: "Surface mask editor" })).toBeDefined();
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(originalRunCount);
  });

});
