import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { commandHolder } from "@domain/commands/command-holder.ts";
import { registerPhotoMappingCommands } from "@domain/commands/photo-mapping-commands.ts";
import { nodeIdsInput } from "@domain/commands/input-schema.ts";
import { uniqueNodeName } from "@domain/graph/names.ts";
import { SHADER_DEPTH_RANGE, SHADER_DEPTH_LIGHT, SHADER_DEPTH_CONTOURS, SHADER_DEPTH_SLICE } from "@domain/media/photo-mapping-modules.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { selectCreatedNodes } from "@editor/selection/select-created.ts";
import { parseFileReference } from "@domain/media/file-reference.ts";
import { PHOTO_DEPTH_INPUT_SIDES, PHOTO_MASK_INPUT_SIDES, supportsPhotoMaskSize } from "@domain/media/preparation-sizes.ts";
import { PHOTO_DEPTH_MODELS, PHOTO_MASK, PHOTO_FACADE } from "@runtime/models/model-catalogue.ts";
import { FACADE_MASK_DEFAULTS, facadeMaskSettings, type FacadeMaskSettings } from "@runtime/media/facade-mask.ts";
import { linearToSrgb, srgbToLinear } from "@runtime/export/pixel-format.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { AssetField } from "@ui/controls/curve-field.tsx";
import { Button } from "@ui/primitives/button.tsx";
import { BooleanField } from "@ui/controls/boolean-field.tsx";
import { navigationHolderFor } from "./component-navigation.ts";
import { DialogRoot, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@ui/primitives/dialog.tsx";
import { retainedFiles } from "@ui/files/retained-files.ts";
import type { FloatMap } from "@runtime/media/float-map.ts";
import { encodePreparedMap } from "@runtime/media/prepared-map-file.ts";
import { decodeNumericalMap, DEPTH_IMAGE_FORMATS, type DepthImageFormat } from "@runtime/media/depth-image.ts";
import { exportDepthImage } from "./photo-preparation.ts";
import { makePreparedMap, withDepthRecipe, beginMaskStroke, preparedMetadata, rasterizeFloatMap, depthRecipeOf } from "@runtime/media/prepared-map.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { createPhotoPreparer, decodePreparationPhoto, savePreparedMap, type PreparationPhoto, type PreparationProgress } from "./photo-preparation.ts";
import { floatMapPhotoUrlFor } from "./use-float-map-sources.ts";
import { PHOTO_MAPPING_SHADER, PHOTO_MAPPING_EFFECTS, PHOTO_ALIGNMENT_SHADER } from "./photo-mapping-effects.ts";
import { PhotoMappingPreview } from "./photo-mapping-preview.tsx";
import { hasMatchingPhotoAspect, previewPhotoPlacement, type PreviewImageFit } from "./photo-preview-framing.ts";
import { DEFAULT_DEPTH_PALETTE, depthPaletteLut, type DepthPalette } from "./photo-depth-palette.ts";
import { DEFAULT_IMAGE_FRAMING, imageFramingSchema, imageFramingFromParameters, imageFramingParameters, type ImageFraming } from "@domain/media/image-framing.ts";
import { PhotoPreviewCrop } from "./photo-preview-crop.tsx";
import { PhotoDepthWorkspace } from "./photo-depth-workspace.tsx";
import { DEFAULT_PHOTO_DEPTH_RECIPE, DEFAULT_MARIGOLD_RECIPE, MARIGOLD_INPUT_SIDES, DEFAULT_DEPTH_REFINEMENT, photoDepthRecipeSchema,
  depthRecipeKey, depthInferenceKey, depthRecipeParameters, depthRecipeFromParameters, depthRefinementSize,
  DEFAULT_DEPTH_PRO2_FIELD_OF_VIEW, DEFAULT_DEPTH_PRO2_RECIPE, DEPTH_PRO2_PHOTO_SIDES, depthPro2BoxLabel, isDepthPro2PhotoModel,
  type PhotoDepthRecipe } from "@domain/media/photo-depth-recipe.ts";
import { PHOTO_DEPTH_PRO2_MODELS, photoDepthSidesFor, photoDepthUnavailableReason } from "@runtime/models/photo-depth-models.ts";
import { horizontalFieldOfView } from "@runtime/media/exif-focal.ts";
import { probeNativePreparation, type NativePreparationCapability } from "@devices/native-preparation.ts";
import { orderRequirements } from "@domain/types/requirements.ts";
import { TypeBadge } from "@ui/primitives/node-identity.tsx";
import { MEDIA_IMAGE_FIT_PARAMETERS } from "@nodes/definitions/media.ts";
import { DEFAULT_DEPTH_RANGE, depthRangeSchema, type DepthRangeSettings } from "@domain/media/depth-range.ts";
import { createDepthRangeMask, depthRangeMaskSettings } from "@runtime/media/depth-tools.ts";
import styles from "./photo-mapping-host.module.css";

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "photoMapping.prepare": { input: { nodeIds?: readonly string[] }; output: { opened: boolean } };
  }
}

interface Recipe {
  readonly photo: string;
  readonly depth: string;
  readonly nativeDepth?: string;
  readonly depthRecipe?: PhotoDepthRecipe;
  readonly mask: string;
  readonly previewPhoto: string;
  readonly previewFit: PreviewImageFit;
  readonly previewFraming?: ImageFraming;
  readonly previewPhotoId?: string;
  readonly depthId?: string;
  readonly maskId?: string;
  readonly photoId?: string;
  readonly inputSide: number;
  readonly mode?: number;
  readonly previz?: boolean;
  readonly useMask?: boolean;
  readonly useDepth?: boolean;
  readonly depthRange?: DepthRangeSettings;
  readonly testPattern?: boolean;
  readonly video?: string;
  readonly videoId?: string;
  readonly effectId?: string;
  readonly rangeId?: string;
  readonly effectInputId?: string;
  readonly effectShader?: string;
  readonly patternSwitchId?: string;
  readonly previewOpacity?: number;
}

const reloadRecipeSchema = z.object({ version: z.literal(1), photo: z.string().min(1), depth: z.string(), mask: z.string(),
  nativeDepth: z.string().optional(), depthRecipe: photoDepthRecipeSchema.optional(),
  previewPhoto: z.string(), previewFit: z.enum(["fit", "fill", "stretch"]), previewFraming: imageFramingSchema.default(DEFAULT_IMAGE_FRAMING), inputSide: z.number().int().positive(),
  mode: z.number().int().min(0).max(13), previz: z.boolean(), useMask: z.boolean().default(true),
  useDepth: z.boolean().default(true), depthRange: depthRangeSchema.default(DEFAULT_DEPTH_RANGE),
  testPattern: z.boolean().default(false), video: z.string().default(""),
  previewOpacity: z.number().min(0).max(1).default(0.35) }).strict()
  .refine(recipe => recipe.useMask === false || recipe.mask.length > 0, "A selected surface mask requires a saved map.");
const reloadRecipeKey = (runtime: AppRuntime) => `loom.photoMapping.reload.${runtime.project.projectId}`;

function value(graph: GraphDocument, nodeId: string | undefined, key: string): string {
  const read = nodeId === undefined ? undefined : storedStaticValue(graph.nodes[nodeId]?.parameters[key]);
  return typeof read === "string" ? read : "";
}

function recipeFor(graph: GraphDocument, nodeId?: string): Recipe {
  if (nodeId === undefined) return { photo: "", depth: "", mask: "", previewPhoto: "", previewFit: "stretch", inputSide: 518 };
  const node = graph.nodes[nodeId];
  if (node?.type !== "floatMapIn") throw new Error("Select a prepared Float Map In to rerun its preparation.");
  const group = Object.values(graph.groups).find(candidate => candidate.members.includes(nodeId));
  const members = group?.members ?? [nodeId];
  const depthId = members.find(id => graph.nodes[id]?.type === "floatMapIn" && value(graph, id, "interpretation") === "depth");
  const maskId = members.find(id => graph.nodes[id]?.type === "floatMapIn" && value(graph, id, "interpretation") === "mask");
  const edge = Object.values(graph.edges).find(candidate => candidate.target.nodeId === nodeId && candidate.target.portId === "picture");
  const previewId = members.find(id => graph.nodes[id]?.type === "screen");
  const referenceId = Object.values(graph.edges).find(candidate => candidate.target.nodeId === previewId
    && (candidate.target.portId === "in1" || candidate.target.portId === "in2")
    && graph.nodes[candidate.source.nodeId]?.type === "level")?.source.nodeId;
  const previewSource = Object.values(graph.edges).find(candidate => candidate.target.nodeId === referenceId && candidate.target.portId === "input")?.source.nodeId;
  const previewPhotoId = previewSource !== edge?.source.nodeId && graph.nodes[previewSource ?? ""]?.type === "movieFileIn" ? previewSource : undefined;
  const effectId = members.find(id => graph.nodes[id]?.type === "customWgslMulti" && Object.hasOwn(graph.nodes[id]!.parameters, "mode"));
  const rangeId = members.find(id => value(graph, id, "source") === SHADER_DEPTH_RANGE);
  const modularMode = members.some(id => graph.nodes[id]?.type === "render") ? 13
    : members.some(id => value(graph, id, "source") === SHADER_DEPTH_LIGHT) ? 10
    : members.some(id => value(graph, id, "source") === SHADER_DEPTH_CONTOURS) ? 11
    : members.some(id => value(graph, id, "source") === SHADER_DEPTH_SLICE) ? 12 : undefined;
  const patternSwitchId = members.find(id => graph.nodes[id]?.type === "switch");
  const effectInput = Object.values(graph.edges).find(candidate => candidate.target.nodeId === effectId && candidate.target.portId === "input")?.source.nodeId;
  const videoSources = members.filter(id => graph.nodes[id]?.type === "movieFileIn" && id !== edge?.source.nodeId && id !== previewPhotoId);
  if (videoSources.length > 1) throw new Error("Mapping contains multiple video sources. Edit their routing in the network.");
  const videoId = videoSources[0];
  const numeric = (id: string | undefined, key: string, defaultValue: number) => {
    const stored = id === undefined ? undefined : storedStaticValue(graph.nodes[id]?.parameters[key]);
    if (stored === undefined) return defaultValue;
    if (typeof stored !== "number" || !Number.isFinite(stored)) throw new Error(`Mapping ${key} requires a static numeric value.`);
    return stored;
  };
  const previewFit = value(graph, previewPhotoId, "imageFit") || MEDIA_IMAGE_FIT_PARAMETERS.imageFit.default;
  if (previewFit !== "fit" && previewFit !== "fill" && previewFit !== "stretch") throw new Error("Preview photo has an invalid image fit.");
  return { nativeDepth: value(graph, depthId, "nativeMap"),
    ...(depthId === undefined ? {} : { depthRecipe: depthRecipeFromParameters(graph.nodes[depthId]!.parameters) }),
    photo: floatMapPhotoUrlFor(graph, nodeId), depth: value(graph, depthId, "file"), mask: value(graph, maskId, "file"),
    previewPhoto: value(graph, previewPhotoId, "file"), ...(previewPhotoId === undefined ? {} : { previewPhotoId }),
    previewFit, previewFraming: previewPhotoId === undefined ? DEFAULT_IMAGE_FRAMING : imageFramingFromParameters(graph.nodes[previewPhotoId]!.parameters),
    ...(depthId === undefined ? {} : { depthId }), ...(maskId === undefined ? {} : { maskId }),
    ...(edge === undefined ? {} : { photoId: edge.source.nodeId }),
    ...(effectId === undefined ? {} : { effectId }), ...(patternSwitchId === undefined ? {} : { patternSwitchId }),
    ...(rangeId === undefined ? {} : { rangeId }),
    ...(effectInput === undefined ? {} : { effectInputId: effectInput }), effectShader: value(graph, effectId, "source"),
    ...(videoId === undefined ? {} : { videoId }), video: value(graph, videoId, "file"),
    ...(modularMode !== undefined ? { mode: modularMode } : effectId !== undefined ? { mode: numeric(effectId, "mode", 0) } : {}), testPattern: numeric(patternSwitchId, "index", 0) === 1,
    useDepth: depthId !== undefined && value(graph, depthId, "file") !== "",
    useMask: maskId !== undefined && value(graph, maskId, "file") !== "",
    depthRange: depthRangeSchema.parse({ low: numeric(rangeId ?? effectId, rangeId === undefined ? "depthLow" : "low", 0),
      high: numeric(rangeId ?? effectId, rangeId === undefined ? "depthHigh" : "high", 1), softness: 0.02 }),
    inputSide: Number(value(graph, depthId, "inputSide") || "518") };
}

function useFileUrls(references: readonly string[]): readonly string[] {
  const files = useMemo(() => retainedFiles(), []);
  useSyncExternalStore(files.subscribe, files.revision, files.revision);
  const signature = JSON.stringify(references);
  useEffect(() => {
    const picked = JSON.parse(signature) as string[];
    const leases = [...new Set(picked.filter(reference => parseFileReference(reference) !== null))].map(reference => files.acquire(reference));
    return () => leases.forEach(lease => lease.release());
  }, [files, signature]);
  return references.map(reference => reference === "" ? "" : parseFileReference(reference) === null ? reference
    : files.snapshot(reference).kind === "ready" ? (files.snapshot(reference) as { url: string }).url : "");
}

function drawMaskEditor(target: HTMLCanvasElement, photo: PreparationPhoto, mask: FloatMap | null): void {
  const width = mask?.width ?? photo.bitmap.width;
  const height = mask?.height ?? photo.bitmap.height;
  const scale = Math.min(1, 768 / width, 768 / height);
  target.width = Math.max(1, Math.round(width * scale));
  target.height = Math.max(1, Math.round(height * scale));
  const context = target.getContext("2d", { willReadFrequently: true });
  if (context === null) return;
  context.drawImage(photo.bitmap, 0, 0, target.width, target.height);
  if (mask !== null) {
    const image = context.getImageData(0, 0, target.width, target.height);
    // Display sampling only. Painting and saving keep the full native float32 map.
    for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
      const i = y * target.width + x;
      const mx = Math.min(mask.width - 1, Math.floor((x + 0.5) / target.width * mask.width));
      const my = Math.min(mask.height - 1, Math.floor((y + 0.5) / target.height * mask.height));
      const excluded = (1 - mask.values[my * mask.width + mx]!) * 0.6;
      image.data[4 * i] = image.data[4 * i]! * (1 - excluded) + 230 * excluded;
      image.data[4 * i + 1] = image.data[4 * i + 1]! * (1 - excluded) + 65 * excluded;
      image.data[4 * i + 2] = image.data[4 * i + 2]! * (1 - excluded) + 70 * excluded;
    }
    context.putImageData(image, 0, 0);
  }
}

interface MapJob {
  readonly kind: "depth" | "mask" | "refinement" | "native";
  readonly progress: PreparationProgress;
}

function MapProgress({ job }: { job: MapJob }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { phase, fraction, message } = job.progress;
  const step = phase === "saving" ? 2 : phase === "processing" || phase === "finishing" ? 1 : 0;
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
  const title = `${phase === "saving" ? "Saving" : phase === "downloading" ? "Downloading model for" : "Processing"} ${job.kind}`;
  return <div className={styles.processingOverlay}>
    <div className={styles.processingPanel}>
      <div className={styles.processingHeading}><span className={styles.spinner} aria-hidden="true" />
        <strong>{title}</strong><span className={styles.processingValue}>{percent === undefined ? `${elapsed}s` : `${percent}%`}</span>
      </div>
      <progress className={styles.progressTrack} aria-label={`${job.kind === "refinement" ? "Depth refinement" : job.kind === "native" ? "Native depth" : job.kind === "depth" ? "Depth" : "Mask"} preparation progress`}
        max={100} {...(percent === undefined ? {} : { value: percent })} />
      <div className={styles.processingSteps} aria-hidden="true">{["Prepare", "Process", "Save"].map((label, index) =>
        <span key={label} data-state={index < step ? "complete" : index === step ? "active" : "pending"}>{index < step ? "✓ " : ""}{label}</span>)}</div>
      <p className={styles.processingMessage}>{message}</p>
    </div>
  </div>;
}

function PhotoMappingEditor({ runtime, initial, open, close }: { runtime: AppRuntime; initial: Recipe; open: boolean; close: () => void }) {
  const [photoRef, setPhotoRef] = useState(initial.photo);
  const [photoName, setPhotoName] = useState(parseFileReference(initial.photo)?.name ?? "Photo");
  const [depthRef, setDepthRef] = useState(initial.depth);
  const [maskRef, setMaskRef] = useState(initial.mask);
  const [nativeDepthRef, setNativeDepthRef] = useState(initial.nativeDepth ?? "");
  const [nativePick, setNativePick] = useState(0);
  const [savedNativeDepth, setSavedNativeDepth] = useState(initial.nativeDepth ?? "");
  const [verifiedNative, setVerifiedNative] = useState<{ reference: string; sha256: string } | null>(null);
  const [nativeDepth, setNativeDepth] = useState<FloatMap | null>(null);
  const [modelId, setModelId] = useState(initial.depthRecipe?.modelId ?? DEFAULT_PHOTO_DEPTH_RECIPE.modelId);
  const [backend, setBackend] = useState<PhotoDepthRecipe["backend"]>(initial.depthRecipe?.backend ?? DEFAULT_PHOTO_DEPTH_RECIPE.backend);
  const [seed, setSeed] = useState(initial.depthRecipe?.version === 2 ? initial.depthRecipe.seed : DEFAULT_MARIGOLD_RECIPE.seed);
  /* T1817b: Depth Pro 2's field of view. A recipe that carries one keeps it; otherwise the
     photo's EXIF suggests one, until the person types their own. */
  const [fieldOfView, setFieldOfView] = useState(initial.depthRecipe?.version === 3 ? initial.depthRecipe.fieldOfView : DEFAULT_DEPTH_PRO2_FIELD_OF_VIEW);
  const fieldOfViewChosen = useRef(initial.depthRecipe?.version === 3);
  const [nativeCapability, setNativeCapability] = useState<NativePreparationCapability>({ available: false, reason: "Checking desktop preparation…" });
  const [refinement, setRefinement] = useState<PhotoDepthRecipe["refinement"]>(initial.depthRecipe?.refinement ?? null);
  const refinementRadiusEdited = useRef(initial.depthRecipe?.refinement !== undefined && initial.depthRecipe.refinement !== null);
  const [depthPalette, setDepthPalette] = useState<DepthPalette>(DEFAULT_DEPTH_PALETTE);
  const [inspectionView, setInspectionView] = useState<"photo" | "native" | "depth" | "mask" | "effect">("photo");
  const [previewPhotoRef, setPreviewPhotoRef] = useState(initial.previewPhoto);
  const [previewPhoto, setPreviewPhoto] = useState<PreparationPhoto | null>(null);
  const [previewFit, setPreviewFit] = useState<PreviewImageFit>(initial.previewFit);
  const [previewFraming, setPreviewFraming] = useState<ImageFraming>(initial.previewFraming ?? DEFAULT_IMAGE_FRAMING);
  const [previewOpacity, setPreviewOpacity] = useState(initial.previewOpacity ?? 0.35);
  const [comparison, setComparison] = useState(0);
  const [savedDepth, setSavedDepth] = useState(initial.depth);
  const [savedMask, setSavedMask] = useState(initial.mask);
  const [depthPick, setDepthPick] = useState(0);
  const [maskPick, setMaskPick] = useState(0);
  const [photo, setPhoto] = useState<PreparationPhoto | null>(null);
  const [depth, setDepth] = useState<FloatMap | null>(null);
  const [mask, setMask] = useState<FloatMap | null>(null);
  const [unregisteredDepth, setUnregisteredDepth] = useState<FloatMap | null>(null);
  const [unregisteredMask, setUnregisteredMask] = useState<FloatMap | null>(null);
  const [importedConvention, setImportedConvention] = useState<"inverse-relative" | "relative-linear" | "relative-log">("inverse-relative");
  const [side, setSide] = useState(initial.inputSide);
  const [maskSide, setMaskSide] = useState(1024);
  const [maskMethod, setMaskMethod] = useState<"facade" | "background" | "depth">("facade");
  const [facadeSettings, setFacadeSettings] = useState<FacadeMaskSettings>(FACADE_MASK_DEFAULTS);
  const [useMask, setUseMask] = useState(initial.useMask ?? true);
  const [useDepth, setUseDepth] = useState(initial.useDepth ?? true);
  const [depthRange, setDepthRange] = useState(initial.depthRange ?? DEFAULT_DEPTH_RANGE);
  const [depthIdentity, setDepthIdentity] = useState<string | null>(null);
  const [inspectionExpanded, setInspectionExpanded] = useState(false);
  const [expandedPhoto, setExpandedPhoto] = useState<"reference" | "preview" | null>(null);
  const [mode, setMode] = useState(initial.mode ?? (initial.depthId !== undefined || initial.maskId !== undefined ? 0 : 13));
  const [testPattern, setTestPattern] = useState(initial.testPattern ?? false);
  const [videoRef, setVideoRef] = useState(initial.video ?? "");
  const [previz, setPreviz] = useState(initial.previz ?? true);
  const [requiresReload, setRequiresReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<MapJob | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [radius, setRadius] = useState(18);
  const [history, setHistory] = useState<readonly FloatMap[]>([]);
  const [redoHistory, setRedoHistory] = useState<readonly FloatMap[]>([]);
  const [maskTool, setMaskTool] = useState<"erase" | "restore" | "pan">("erase");
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState<HTMLCanvasElement | null>(null);
  const stroke = useRef<{ point: { x: number; y: number }; editor: ReturnType<typeof beginMaskStroke> } | null>(null);
  const maskRefLive = useRef(mask);
  maskRefLive.current = mask;
  const preparer = useRef<ReturnType<typeof createPhotoPreparer> | null>(null);
  const loadVersions = useRef({ depth: 0, mask: 0, native: 0 });
  const jobVersion = useRef(0);
  const cancelledJob = useRef<number | null>(null);
  const live = useRef(true);
  const existing = initial.depthId !== undefined || initial.maskId !== undefined;
  const [photoUrl, depthUrl, maskUrl, previewPhotoUrl, nativeUrl, videoUrl] = useFileUrls([photoRef, depthRef, maskRef, previewPhotoRef, nativeDepthRef, videoRef]);
  const marigold = modelId === DEFAULT_MARIGOLD_RECIPE.modelId;
  const metric = isDepthPro2PhotoModel(modelId);
  const depthRecipe = useMemo<PhotoDepthRecipe>(() => marigold
    ? { ...DEFAULT_MARIGOLD_RECIPE, seed, inputSide: side as typeof MARIGOLD_INPUT_SIDES[number], refinement }
    : metric ? { version: 3, modelId, backend: backend as "wasm" | "webgpu", inputSide: side as typeof DEPTH_PRO2_PHOTO_SIDES[number], fieldOfView, refinement }
    : { version: 1, modelId, backend: backend as "wasm" | "webgpu", inputSide: side, refinement }, [marigold, metric, seed, modelId, backend, side, fieldOfView, refinement]);
  const photoFieldOfView = photo?.focalLength35 === undefined ? undefined
    : Math.round(horizontalFieldOfView(photo.focalLength35, photo.bitmap.width, photo.bitmap.height) * 10) / 10;
  useEffect(() => {
    if (photoFieldOfView !== undefined && !fieldOfViewChosen.current) setFieldOfView(photoFieldOfView);
  }, [photoFieldOfView]);
  useEffect(() => {
    let owned = true;
    void probeNativePreparation().then(value => { if (owned) setNativeCapability(value); }).catch(cause => {
      if (owned) setNativeCapability({ available: false, reason: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { owned = false; };
  }, [busy]);
  const webgpuAvailable = globalThis.navigator?.gpu !== undefined;
  const depthUnavailable = photoDepthUnavailableReason(depthRecipe, webgpuAvailable, nativeCapability);
  const selectedModel = [...PHOTO_DEPTH_MODELS, ...PHOTO_DEPTH_PRO2_MODELS].find(model => model.id === modelId);
  const depthSides = photoDepthSidesFor(modelId, backend);
  const readInspectionMaps = useCallback(() => {
    const metadata = depth === null ? null : preparedMetadata(depth);
    const belongs = (map: FloatMap | null) => {
      if (map === null || photo === null) return false;
      const source = preparedMetadata(map).source;
      return source.sha256 === photo.sha256 && source.width === photo.bitmap.width && source.height === photo.bitmap.height;
    };
    return { native: belongs(nativeDepth) ? nativeDepth : null,
      depth: metadata?.version === 2 && metadata.stage === "refined" && belongs(depth) ? depth : null,
      mask: belongs(mask) ? mask : null };
  }, [nativeDepth, depth, mask, photo]);
  const restoreDepthRecipe = useCallback((map: FloatMap) => {
    const recipe = depthRecipeOf(map);
    refinementRadiusEdited.current = recipe.refinement !== null;
    setModelId(recipe.modelId); setBackend(recipe.backend); setSide(recipe.inputSide); setRefinement(recipe.refinement);
    if (recipe.version === 2) setSeed(recipe.seed);
    if (recipe.version === 3) { fieldOfViewChosen.current = true; setFieldOfView(recipe.fieldOfView); }
  }, []);
  useEffect(() => {
    let owned = true;
    setDepthIdentity(null);
    if (depth !== null) void crypto.subtle.digest("SHA-256", encodePreparedMap(depth).buffer as ArrayBuffer).then(digest => {
      if (owned) setDepthIdentity([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""));
    }).catch(cause => { if (owned) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { owned = false; };
  }, [depth]);
  useEffect(() => { live.current = true; return () => { live.current = false; preparer.current?.dispose(); preparer.current = null; }; }, []);

  useEffect(() => {
    setPhoto(null);
    if (!photoUrl) return;
    const abort = new AbortController();
    let owned: PreparationPhoto | null = null;
    void decodePreparationPhoto(photoUrl, photoName, abort.signal).then(next => {
      if (abort.signal.aborted) { next.bitmap.close(); return; }
      owned = next;
      setPhoto(next);
    }).catch(cause => { if (!abort.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => { abort.abort(); owned?.bitmap.close(); };
  }, [photoUrl, photoRef, photoName]);

  useEffect(() => {
    setPreviewPhoto(null);
    if (!previewPhotoUrl) return;
    const abort = new AbortController();
    let owned: PreparationPhoto | null = null;
    void decodePreparationPhoto(previewPhotoUrl, parseFileReference(previewPhotoRef)?.name ?? "Preview photo", abort.signal).then(next => {
      if (abort.signal.aborted) { next.bitmap.close(); return; }
      owned = next; setPreviewPhoto(next);
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { abort.abort(); owned?.bitmap.close(); };
  }, [previewPhotoUrl, previewPhotoRef]);

  const loadMap = useCallback((url: string | undefined, kind: "depth" | "mask", reference: string) => {
    const abort = new AbortController();
    if (url) {
      const version = ++loadVersions.current[kind];
      void fetch(url, { signal: abort.signal }).then(async response => {
        if (!response.ok) throw new Error(`Saved ${kind} could not be opened (${response.status}).`);
        const bytes = await response.arrayBuffer();
        const map = await decodeNumericalMap(bytes);
        if (!Object.hasOwn(map.metadata ?? {}, "preparation")) {
          if (!abort.signal.aborted && loadVersions.current[kind] === version) {
            if (kind === "depth") { setUnregisteredDepth(map); setSavedDepth(""); }
            else { setUnregisteredMask(map); setSavedMask(""); }
            setStatus(`This ${kind} image has no Loom preparation metadata. Confirm its convention and full-frame registration, then save a .loom.exr artifact.`);
          }
          return;
        }
        if (preparedMetadata(map).kind !== kind) throw new Error(`Choose a prepared ${kind} map.`);
        const facade = kind === "mask" ? facadeMaskSettings(map) : undefined;
        const depthMask = kind === "mask" ? depthRangeMaskSettings(map) : undefined;
        rasterizeFloatMap(map, kind, 1, 1);
        const metadata = preparedMetadata(map);
        const nativeDigest = kind === "depth" && (metadata.version === 1 || metadata.stage === "native")
          ? await crypto.subtle.digest("SHA-256", bytes) : null;
        if (!abort.signal.aborted && loadVersions.current[kind] === version) {
          if (kind === "depth") {
            setUnregisteredDepth(null);
            setDepth(map); restoreDepthRecipe(map);
            const metadata = preparedMetadata(map);
            if (metadata.version === 1 || metadata.stage === "native") {
              setNativeDepth(map); setSavedNativeDepth(reference); setNativeDepthRef(reference); setInspectionView("native");
              setVerifiedNative({ reference, sha256: [...new Uint8Array(nativeDigest!)].map(value => value.toString(16).padStart(2, "0")).join("") });
            } else { setNativeDepth(null); setVerifiedNative(null); setInspectionView("depth"); }
          }
          else {
            setUnregisteredMask(null);
            setMask(map); setInspectionView("mask");
            const loadedSide = facade?.detailSide ?? preparedMetadata(map).inputSide;
            if (supportsPhotoMaskSize(loadedSide)) setMaskSide(loadedSide);
            setMaskMethod(depthMask !== undefined ? "depth" : facade === undefined ? "background" : "facade");
            if (depthMask !== undefined) setDepthRange({ low: depthMask.low, high: depthMask.high, softness: depthMask.softness });
            if (facade !== undefined) setFacadeSettings({ darkCutoff: facade.darkCutoff, feather: facade.feather, excludeBlueGlass: facade.excludeBlueGlass });
          }
          setStatus(`Existing ${kind} opened · ${map.width} × ${map.height} · float32. Ready to reuse with its reference photo.`);
        }
      }).catch(cause => { if (!abort.signal.aborted && loadVersions.current[kind] === version) setError(cause instanceof Error ? cause.message : String(cause)); });
    }
    return () => abort.abort();
  }, [restoreDepthRecipe]);
  useEffect(() => loadMap(depthUrl, "depth", depthRef), [depthUrl, depthPick, depthRef, loadMap]);
  useEffect(() => loadMap(maskUrl, "mask", maskRef), [maskUrl, maskPick, maskRef, loadMap]);
  useEffect(() => {
    if (!nativeUrl || depth === null) return;
    const finalMetadata = preparedMetadata(depth);
    if (finalMetadata.version !== 2 || finalMetadata.stage !== "refined") return;
    if (verifiedNative?.reference === nativeDepthRef && verifiedNative.sha256 === finalMetadata.parent!.sha256
      && nativeDepth?.width === finalMetadata.parent!.width && nativeDepth.height === finalMetadata.parent!.height) return;
    const abort = new AbortController();
    const version = ++loadVersions.current.native;
    setVerifiedNative(null);
    void fetch(nativeUrl, { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(`Native depth could not be opened (${response.status}).`);
      const bytes = await response.arrayBuffer();
      const map = await decodeNumericalMap(bytes);
      const metadata = preparedMetadata(map);
      if (metadata.kind !== "depth" || (metadata.version === 2 && metadata.stage !== "native")) throw new Error("Choose the original native depth prediction.");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (hash !== finalMetadata.parent!.sha256 || map.width !== finalMetadata.parent!.width || map.height !== finalMetadata.parent!.height) throw new Error("Native depth does not match this refined map's recorded parent. Relink the matching native map.");
      if (!abort.signal.aborted && loadVersions.current.native === version) {
        setNativeDepth(map); setSavedNativeDepth(nativeDepthRef); setVerifiedNative({ reference: nativeDepthRef, sha256: hash });
      }
    }).catch(cause => { if (!abort.signal.aborted && loadVersions.current.native === version) {
      setVerifiedNative(null); setError(cause instanceof Error ? cause.message : String(cause));
    } });
    return () => abort.abort();
  }, [nativeUrl, nativeDepthRef, nativePick, depth, nativeDepth, verifiedNative]);

  useEffect(() => {
    if (canvas !== null && photo !== null) drawMaskEditor(canvas, photo, mask);
  }, [canvas, photo, mask]);

  useEffect(() => {
    const target = preview;
    if (target === null || photo === null || depth === null) return;
    const scale = Math.min(360 / photo.bitmap.width, 256 / photo.bitmap.height);
    target.width = Math.max(1, Math.round(photo.bitmap.width * scale));
    target.height = Math.max(1, Math.round(photo.bitmap.height * scale));
    const context = target.getContext("2d");
    if (context === null) return;
    const values = rasterizeFloatMap(depth, "depth", target.width, target.height);
    const colors = depthPaletteLut(depthPalette);
    const image = context.createImageData(target.width, target.height);
    for (let i = 0; i < values.length; i++) {
      const color = Math.round(Math.max(0, Math.min(1, values[i]!)) * 255) * 3;
      image.data[4 * i] = colors[color]!; image.data[4 * i + 1] = colors[color + 1]!; image.data[4 * i + 2] = colors[color + 2]!;
      image.data[4 * i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [preview, depth, photo, depthPalette]);

  const run = async (kind: "depth" | "mask" | "refinement") => {
    if (photo === null || busy || (kind === "mask" && !useMask)) return;
    loadVersions.current[kind === "mask" ? "mask" : "depth"]++;
    if (kind === "depth") loadVersions.current.native++;
    const version = ++jobVersion.current;
    setBusy(true); setError(null);
    setJob({ kind, progress: { phase: "preparing", message: "Preparing your photo…" } });
    try {
      if (kind !== "mask" || maskMethod !== "depth") preparer.current ??= createPhotoPreparer(progress => {
        if (live.current && cancelledJob.current !== jobVersion.current) { setStatus(progress.message); setJob(current => current === null ? null : { ...current, progress }); }
      });
      const map = kind === "depth" ? await preparer.current!.run({ kind, photo, recipe: depthRecipe })
        : kind === "refinement" ? await preparer.current!.refine(photo, nativeDepth!, depthRecipe, runtime.settings.limits.maxResolution,
          verifiedNative?.reference === savedNativeDepth ? verifiedNative.sha256 : undefined)
        : maskMethod === "depth" ? (() => {
          if (depth === null || !matches(depth) || depthIdentity === null) throw new Error("Prepare matching depth before deriving a depth range mask.");
          const scale = maskSide / Math.max(photo.bitmap.width, photo.bitmap.height);
          return createDepthRangeMask(depth, Math.max(1, Math.round(photo.bitmap.width * scale)),
            Math.max(1, Math.round(photo.bitmap.height * scale)), depthRange, depthIdentity);
        })() : await preparer.current!.run({ kind, photo, inputSide: maskSide, ...(maskMethod === "facade" ? { facade: facadeSettings } : {}) });
      if (!live.current || jobVersion.current !== version) return;
      if (cancelledJob.current === version) { setStatus("Preparation cancelled. Saved maps are unchanged."); return; }
      if (kind === "depth") {
        setNativeDepth(map); setDepth(map); setSavedDepth(""); setSavedNativeDepth(""); setNativeDepthRef(""); setVerifiedNative(null); setInspectionView("native");
      } else if (kind === "refinement") { setDepth(map); setSavedDepth(""); setInspectionView("depth"); }
      else { setMask(map); setSavedMask(""); setHistory([]); setRedoHistory([]); setInspectionView("mask"); }
      setStatus(`${kind === "refinement" ? "Refined depth" : kind === "depth" ? "Depth" : "Mask"} ready · ${map.width} × ${map.height} · float32. Save it to reuse.`);
    } catch (cause) {
      if (live.current && jobVersion.current === version) {
        if (!(cause instanceof AggregateError) && (cancelledJob.current === version || (cause instanceof DOMException && cause.name === "AbortError"))) setStatus("Preparation cancelled. Saved maps are unchanged.");
        else setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally { if (live.current && jobVersion.current === version) { setBusy(false); setJob(null); } }
  };

  const cancelJob = () => {
    cancelledJob.current = jobVersion.current;
    preparer.current?.cancel();
    // Keep the job active until submitted work retires; no cancelled result can publish.
    setStatus("Cancelling preparation…");
  };

  const save = async (kind: "depth" | "mask" | "native", parent?: { reference: string; sha256: string }): Promise<string | undefined> => {
    const map = kind === "native" ? nativeDepth : kind === "depth" ? depth : mask;
    if (map === null || photo === null) return;
    setBusy(true); setError(null); setStatus(`Choose where to save the ${kind} map`);
    setJob({ kind, progress: { phase: "saving", message: "Choose a file location…" } });
    try {
      const metadata = preparedMetadata(map);
      if (metadata.version === 2 && metadata.stage === "refined" && !nativeParentReady &&
        !(nativeMatches && parent?.reference !== "" && parent?.sha256 === metadata.parent?.sha256 && nativeDepth?.width === metadata.parent?.width
          && nativeDepth?.height === metadata.parent?.height)) throw new Error("Save or relink the matching native depth prediction before saving its refined result.");
      const nativeDigest = metadata.kind === "depth" && (metadata.version === 1 || metadata.stage === "native")
        ? await crypto.subtle.digest("SHA-256", encodePreparedMap(map).buffer as ArrayBuffer) : null;
      const reference = await savePreparedMap(map, photo.name, progress => {
        if (live.current) { setStatus(progress.message); setJob(current => current === null ? null : { ...current, progress }); }
      });
      if (!live.current) return;
      if (typeof reference !== "string" || reference.trim() === "") throw new Error("Saved artifact did not return a file reference.");
      if (nativeDigest !== null) setVerifiedNative({ reference,
        sha256: [...new Uint8Array(nativeDigest)].map(value => value.toString(16).padStart(2, "0")).join("") });
      if (kind === "native") { setSavedNativeDepth(reference); setNativeDepthRef(reference); }
      else if (kind === "depth") {
        setSavedDepth(reference);
        if (metadata.version === 1 || metadata.stage === "native") { setSavedNativeDepth(reference); setNativeDepthRef(reference); }
      } else setSavedMask(reference);
      setStatus(`${kind === "native" ? "Native depth" : kind === "depth" ? "Depth" : "Mask"} saved. Apply it to the network when ready.`);
      return reference;
    } catch (cause) { if (live.current && !(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) { setBusy(false); setJob(null); } }
  };

  const exportImage = async (format: DepthImageFormat) => {
    if (depth === null || photo === null || busy) return;
    setBusy(true); setError(null);
    try {
      await exportDepthImage(depth, photo.name, format);
      if (live.current) setStatus(`${DEPTH_IMAGE_FORMATS.find(item => item.id === format)!.label} exported. Original float32 map retained.`);
    } catch (cause) { if (live.current && !(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setBusy(false); }
  };

  const matches = (map: FloatMap | null) => {
    if (photo === null || map === null) return false;
    const metadata = preparedMetadata(map);
    if (metadata.source.sha256 !== photo.sha256 || metadata.source.width !== photo.bitmap.width || metadata.source.height !== photo.bitmap.height) return false;
    if (metadata.kind === "depth") {
      const native = metadata.version === 1 || metadata.stage === "native";
      return native ? depthInferenceKey(depthRecipeOf(map)) === depthInferenceKey(depthRecipe)
        : depthRecipeKey(depthRecipeOf(map)) === depthRecipeKey(depthRecipe);
    }
    const facade = facadeMaskSettings(map);
    const depthMask = depthRangeMaskSettings(map);
    if (depthMask !== undefined) return maskMethod === "depth" && depthIdentity !== null && depthMask.parentSha256 === depthIdentity
      && metadata.inputSide === maskSide && depthMask.low === depthRange.low && depthMask.high === depthRange.high && depthMask.softness === depthRange.softness;
    if (facade !== undefined) return maskMethod === "facade" && facade.detailSide === maskSide
      && facade.darkCutoff === facadeSettings.darkCutoff && facade.feather === facadeSettings.feather && facade.excludeBlueGlass === facadeSettings.excludeBlueGlass;
    return (maskMethod === "background" || metadata.model.id === "manual") && metadata.inputSide === maskSide;
  };
  const depthMetadata = depth === null ? null : preparedMetadata(depth);
  const pendingRefinement = refinement !== null && depthMetadata !== null &&
    (depthMetadata.version === 1 || depthMetadata.stage === "native") && matches(depth);
  const depthReady = savedDepth !== "" && matches(depth) && !pendingRefinement;
  const maskReady = savedMask !== "" && matches(mask);
  const nativeMatches = photo !== null && nativeDepth !== null && preparedMetadata(nativeDepth).source.sha256 === photo.sha256
    && preparedMetadata(nativeDepth).source.width === photo.bitmap.width && preparedMetadata(nativeDepth).source.height === photo.bitmap.height
    && depthInferenceKey(depthRecipeOf(nativeDepth)) === depthInferenceKey(depthRecipe);
  const finalMetadata = depth === null ? null : preparedMetadata(depth);
  const nativeParentReady = finalMetadata?.version !== 2 || finalMetadata.stage !== "refined" || (nativeMatches && verifiedNative?.reference === savedNativeDepth
    && finalMetadata?.version === 2 && finalMetadata.stage === "refined" && verifiedNative.sha256 === finalMetadata.parent!.sha256
    && nativeDepth?.width === finalMetadata.parent!.width && nativeDepth.height === finalMetadata.parent!.height);
  let refinementSize: { width: number; height: number } | null = null;
  let refinementUnavailable: string | null = !webgpuAvailable ? "Guided refinement requires WebGPU in this host." : null;
  if (refinement !== null && photo !== null) {
    try { refinementSize = depthRefinementSize(depthRecipe, photo.bitmap.width, photo.bitmap.height, runtime.settings.limits.maxResolution); }
    catch (cause) { refinementUnavailable = cause instanceof Error ? cause.message : String(cause); }
  }
  const needsDepth = existing ? initial.depthId !== undefined && useDepth : useDepth;
  const needsMask = existing ? initial.maskId !== undefined && useMask : useMask;
  const maskCoverage = useMemo(() => {
    if (mask === null) return null;
    let covered = 0;
    for (let i = 0; i < mask.values.length; i++) if (mask.values[i]! >= 0.5) covered++;
    return covered / mask.values.length;
  }, [mask]);
  const previewFramingMatches = photo !== null && previewPhoto !== null && hasMatchingPhotoAspect(photo.bitmap, previewPhoto.bitmap);
  const previewReady = previewPhotoRef === "" || previewPhoto !== null;
  const canApply = photo !== null && (!needsDepth || depthReady) && (!needsMask || maskReady) && (!previz || previewReady) && (!needsDepth || nativeParentReady);
  const canSaveAll = photo !== null && (!needsDepth || (matches(depth) && !pendingRefinement)) && (!needsMask || matches(mask))
    && (!needsDepth || finalMetadata?.version !== 2 || finalMetadata.stage !== "refined" || (nativeMatches && nativeDepth?.width === finalMetadata.parent?.width
      && nativeDepth?.height === finalMetadata.parent?.height)) && (!previz || previewReady);
  const readPreviewMaps = useCallback(() => ({ depth: needsDepth ? depth : null, mask }), [depth, mask, needsDepth]);
  const nextAction = photo === null ? "Choose a reference photo to begin"
    : needsDepth && depth === null ? "Choose saved depth, or run depth"
    : needsDepth && !matches(depth) ? refinement !== null && nativeMatches ? "Run refinement from the native prediction" : "Choose matching depth, or rerun for this photo and detail"
    : needsDepth && pendingRefinement ? savedNativeDepth === "" ? "Save the native prediction, then run refinement" : "Run refinement from the saved native prediction"
    : needsDepth && !nativeParentReady ? "Save the original native prediction, then the refined depth"
    : needsDepth && !depthReady ? needsMask ? "Save depth, then prepare the surface mask" : "Save depth to create the full-frame mapping"
    : needsMask && mask === null ? "Choose a saved mask, run mask, or start a manual mask"
    : needsMask && !matches(mask) ? "Choose a matching mask, or rerun for this photo"
    : needsMask && !maskReady ? "Check the edges, then save the mask"
    : previz && !previewReady ? "Open a preview photo, or use the reference photo"
    : existing ? "Apply the saved maps to your network" : "Create the network, then align Window Out";
  const previewAspect = photo === null ? "16 / 9" : `${photo.bitmap.width} / ${photo.bitmap.height}`;
  const photoFrameStyle = { aspectRatio: previewAspect,
    maxWidth: `calc(var(--photo-thumbnail-height, 160px) * ${photo === null ? 16 / 9 : photo.bitmap.width / photo.bitmap.height})` };
  const framing = photo === null || previewPhoto === null ? null : previewPhotoPlacement(previewPhoto.bitmap, photo.bitmap, previewFit, previewFraming);
  const previewImageStyle = framing === null || photo === null || previewPhoto === null ? { objectFit: "fill" as const } : {
    objectFit: "fill" as const,
    left: `${(framing.destination.x - framing.source.x * framing.destination.width / framing.source.width) / photo.bitmap.width * 100}%`,
    top: `${(framing.destination.y - framing.source.y * framing.destination.height / framing.source.height) / photo.bitmap.height * 100}%`,
    width: `${previewPhoto.bitmap.width / framing.source.width * framing.destination.width / photo.bitmap.width * 100}%`,
    height: `${previewPhoto.bitmap.height / framing.source.height * framing.destination.height / photo.bitmap.height * 100}%`,
  };
  const previewStyle = { aspectRatio: previewAspect,
    maxWidth: `calc(var(--photo-map-preview-height, 256px) * ${photo === null ? 16 / 9 : photo.bitmap.width / photo.bitmap.height})` };
  const inspect = (view: typeof inspectionView, image: typeof expandedPhoto = null) => {
    setInspectionView(view); setExpandedPhoto(image); setInspectionExpanded(true);
  };
  const mapState = (map: FloatMap | null, saved: boolean) => map === null ? "Not generated"
    : !matches(map) ? "Out of date" : map === depth && pendingRefinement ? "Ready to refine" : saved ? "Saved" : "Ready to save";
  const apply = async (files?: { depth: string; mask: string; native: string; nativeSha256?: string }) => {
    const depthFile = files?.depth ?? savedDepth, maskFile = files?.mask ?? savedMask, nativeFile = files?.native ?? savedNativeDepth;
    const parentReady = files === undefined ? nativeParentReady : finalMetadata?.version !== 2 || finalMetadata.stage !== "refined" || (nativeMatches
      && finalMetadata.parent?.sha256 === files.nativeSha256 && nativeDepth?.width === finalMetadata.parent?.width && nativeDepth?.height === finalMetadata.parent?.height);
    if (photo === null || busy) return;
    setBusy(true); setError(null);
    try {
      if ((needsDepth && (depthFile === "" || !matches(depth) || pendingRefinement)) || (needsMask && (maskFile === "" || !matches(mask)))) {
        throw new Error("Save prepared maps that match the photo and detail settings before applying them.");
      }
      if (previz && !previewReady) throw new Error("Open the preview photo before creating the network.");
      if (needsDepth && !parentReady) throw new Error("Verify the matching native depth parent before applying the refined result.");
      let result;
      if (!existing) {
        if (typeof runtime.bus.replaceCommand !== "function") {
          // One-time bootstrap for a bus constructed before command refresh existed.
          // All required maps are already saved; retain their identities rather than rerun.
          sessionStorage.setItem(reloadRecipeKey(runtime), JSON.stringify({ version: 1, photo: photoRef, depth: depthFile, mask: maskFile,
            previewPhoto: previewPhotoRef, previewFit, previewFraming, previewOpacity, inputSide: side, mode, previz, useMask, useDepth, depthRange, testPattern, video: videoRef, depthRecipe, nativeDepth: nativeFile }));
          setRequiresReload(true);
          throw new Error("Reload Loom once to update the live command schema. Saved mapping setup will reopen.");
        }
        registerPhotoMappingCommands(runtime.bus, { refresh: true });
        result = await runtime.bus.execute("photoMapping.create", { photo: photoRef, ...(needsDepth ? { depth: depthFile } : {}), ...(needsMask ? { mask: maskFile } : {}),
          width: photo.bitmap.width, height: photo.bitmap.height, shader: PHOTO_MAPPING_SHADER, effect: mode, inputSide: side, previz,
          ...(needsDepth ? { depthRecipe, ...(refinement === null ? {} : { nativeDepth: nativeFile }) } : {}), depthRange,
          patternShader: PHOTO_ALIGNMENT_SHADER, testPattern, ...(videoRef === "" ? {} : { video: videoRef }),
          ...(previz ? { previewOpacity } : {}),
          ...(previz && previewPhotoRef !== "" ? { previewPhoto: previewPhotoRef, previewFit, previewFraming } : {}) }, runtime.invocation);
      } else {
        const graph = runtime.bus.store.getGraph();
        if (initial.depthId !== undefined && value(graph, initial.depthId, "inputSide") !== String(initial.inputSide)) {
          throw new Error("Depth settings changed while preparation was open. Reopen preparation.");
        }
        if (initial.depthId !== undefined && initial.depthRecipe !== undefined &&
          depthRecipeKey(depthRecipeFromParameters(graph.nodes[initial.depthId]!.parameters)) !== depthRecipeKey(initial.depthRecipe)) {
          throw new Error("Depth model, backend or refinement settings changed while preparation was open. Reopen preparation.");
        }
        if (initial.depthId !== undefined && value(graph, initial.depthId, "nativeMap") !== (initial.nativeDepth ?? "")) throw new Error("The native depth parent changed while preparation was open. Reopen preparation.");
        const operations = [];
        for (const [nodeId, reference, map] of [[initial.depthId, depthFile, depth], [initial.maskId, maskFile, mask]] as const) {
          if (nodeId !== undefined && !(nodeId === initial.depthId ? needsDepth : needsMask)) {
            const initialReference = nodeId === initial.depthId ? initial.depth : initial.mask;
            if (value(graph, nodeId, "file") !== initialReference) throw new Error("A prepared map changed while preparation was open. Reopen preparation.");
            if (initialReference !== "") operations.push({ op: "setParameters" as const, nodeId,
              parameters: { file: "", emptySource: "constant", emptyValue: nodeId === initial.depthId ? 0.5 : 1 } });
            continue;
          }
          if (nodeId === undefined || map === null || reference === "") continue;
          if (floatMapPhotoUrlFor(graph, nodeId) !== initial.photo) throw new Error("The reference photo changed while preparation was open. Reopen preparation.");
          if (value(graph, nodeId, "file") !== (nodeId === initial.depthId ? initial.depth : initial.mask)) {
            throw new Error("A prepared map changed while preparation was open. Reopen preparation.");
          }
          const isDepth = preparedMetadata(map).kind === "depth";
          const inputSide = String(preparedMetadata(map).inputSide);
          if (reference === value(graph, nodeId, "file") && (!isDepth || (value(graph, nodeId, "inputSide") === inputSide
            && depthRecipeKey(depthRecipeFromParameters(graph.nodes[nodeId]!.parameters)) === depthRecipeKey(depthRecipe)
            && value(graph, nodeId, "nativeMap") === (refinement === null ? "" : nativeFile)))) continue;
          operations.push({ op: "setParameters" as const, nodeId,
            parameters: { file: reference, emptySource: "error", ...(isDepth ? { ...depthRecipeParameters(depthRecipe), nativeMap: refinement === null ? "" : nativeFile } : {}) } });
        }
        if (initial.effectId !== undefined && (mode !== initial.mode || depthRange.low !== initial.depthRange?.low || depthRange.high !== initial.depthRange?.high)) {
          const current = graph.nodes[initial.effectId]!.parameters;
          if ((storedStaticValue(current.mode) ?? 0) !== (initial.mode ?? 0) ||
            (storedStaticValue(current.depthLow) ?? 0) !== (initial.depthRange?.low ?? 0) ||
            (storedStaticValue(current.depthHigh) ?? 1) !== (initial.depthRange?.high ?? 1)) throw new Error("Effect settings changed while preparation was open. Reopen preparation.");
          if (mode !== initial.mode && value(graph, initial.effectId, "source") !== initial.effectShader) throw new Error("Effect shader changed while preparation was open. Reopen preparation.");
          operations.push({ op: "setParameters" as const, nodeId: initial.effectId, parameters: { mode, depthLow: depthRange.low, depthHigh: depthRange.high,
            ...(mode === initial.mode ? {} : { source: PHOTO_MAPPING_SHADER }) } });
        }
        if (initial.rangeId !== undefined && (depthRange.low !== initial.depthRange?.low || depthRange.high !== initial.depthRange?.high)) {
          if (storedStaticValue(graph.nodes[initial.rangeId]!.parameters.low) !== initial.depthRange?.low ||
            storedStaticValue(graph.nodes[initial.rangeId]!.parameters.high) !== initial.depthRange?.high) throw new Error("Depth range changed while preparation was open. Reopen preparation.");
          operations.push({ op: "setParameters" as const, nodeId: initial.rangeId, parameters: { low: depthRange.low, high: depthRange.high } });
        }
        if (initial.patternSwitchId !== undefined && testPattern !== initial.testPattern) {
          if ((storedStaticValue(graph.nodes[initial.patternSwitchId]!.parameters.index) ?? 0) !== Number(initial.testPattern ?? false)) throw new Error("Test pattern changed while preparation was open.");
          operations.push({ op: "setParameters" as const, nodeId: initial.patternSwitchId, parameters: { index: Number(testPattern) } });
        }
        if (initial.videoId !== undefined && videoRef !== initial.video) {
          if (value(graph, initial.videoId, "file") !== initial.video) throw new Error("Video changed while preparation was open.");
          operations.push({ op: "setParameters" as const, nodeId: initial.videoId, parameters: { file: videoRef } });
        }
        if (initial.effectId !== undefined && mode !== initial.mode && (mode === 9 || initial.mode === 9)) {
          const input = Object.values(graph.edges).find(candidate => candidate.target.nodeId === initial.effectId && candidate.target.portId === "input");
          if (input === undefined || input.source.nodeId !== initial.effectInputId || initial.photoId === undefined) throw new Error("Effect input routing changed while preparation was open. Reopen preparation.");
          let source = mode === 9 ? initial.videoId : initial.photoId;
          if (source === undefined) {
            source = "$mappingVideo";
            const photoNode = graph.nodes[initial.photoId]!;
            const group = Object.values(graph.groups).find(candidate => candidate.members.includes(initial.effectId!));
            const bottom = Math.max(photoNode.position.y, ...Object.values(graph.nodes).filter(node => node.position.x === photoNode.position.x).map(node => node.position.y)) + 300;
            operations.push({ op: "addNode" as const, ref: "$mappingVideo", type: "movieFileIn", label: uniqueNodeName(graph, "movie_content"),
              position: { x: photoNode.position.x, y: bottom }, parameters: { file: videoRef } },
            { op: "setNodeResolution" as const, nodeId: "$mappingVideo", resolution: { mode: "fixed" as const,
              width: Math.max(1, Math.round(photo.bitmap.width * Math.min(1, runtime.settings.limits.maxResolution / Math.max(photo.bitmap.width, photo.bitmap.height)))),
              height: Math.max(1, Math.round(photo.bitmap.height * Math.min(1, runtime.settings.limits.maxResolution / Math.max(photo.bitmap.width, photo.bitmap.height)))) } });
            if (group !== undefined) operations.push({ op: "setGroup" as const, groupId: group.id, members: [...group.members, "$mappingVideo"],
              bounds: { ...group.bounds, height: Math.max(group.bounds.height, bottom + 260 - group.bounds.y) } });
          }
          operations.push({ op: "disconnect" as const, edgeIds: [input.id] }, { op: "connect" as const,
            source: { nodeId: source, portId: "out" }, target: { nodeId: initial.effectId, portId: "input" } });
        }
        if (initial.previewPhotoId !== undefined && (previewPhotoRef !== initial.previewPhoto || previewFit !== initial.previewFit || JSON.stringify(previewFraming) !== JSON.stringify(initial.previewFraming ?? DEFAULT_IMAGE_FRAMING))) {
          if (value(graph, initial.previewPhotoId, "file") !== initial.previewPhoto ||
            (value(graph, initial.previewPhotoId, "imageFit") || MEDIA_IMAGE_FIT_PARAMETERS.imageFit.default) !== initial.previewFit ||
            JSON.stringify(imageFramingFromParameters(graph.nodes[initial.previewPhotoId]!.parameters)) !== JSON.stringify(initial.previewFraming ?? DEFAULT_IMAGE_FRAMING)) {
            throw new Error("Preview photo or fit changed while preparation was open.");
          }
          operations.push({ op: "setParameters" as const, nodeId: initial.previewPhotoId, parameters: { file: previewPhotoRef, imageFit: previewFit, ...imageFramingParameters(previewFraming) } });
        }
        if (operations.length === 0) { close(); return; }
        result = await runtime.bus.execute("graph.applyPatch", { baseRevision: graph.revision, label: "Apply prepared photo maps", operations }, runtime.invocation);
      }
      if (result.status !== "applied") throw new Error(result.diagnostics.map(diagnostic => diagnostic.message).join(" "));
      if (!existing) {
        const navigation = navigationHolderFor(runtime.bus).current;
        while (navigation !== null && navigation.getPath().length > 0) {
          const depthBefore = navigation.getPath().length;
          const jumped = await runtime.bus.execute("graph.jumpUp", {}, runtime.invocation);
          if (jumped.status !== "applied" || navigation.getPath().length >= depthBefore) {
            throw new Error("The mapping was created at project root, but the editor could not leave its component.");
          }
        }
        await selectCreatedNodes(runtime.bus, runtime.invocation, result);
        if (runtime.bus.hasCommand("view.frameSelected")) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (live.current) {
            const nodeIds = Object.entries(result.output.createdIds).filter(([ref]) => ref !== "$group").map(([, id]) => id);
            await runtime.bus.execute("view.frameSelected", { nodeIds }, runtime.invocation);
            if (runtime.bus.hasCommand("node.openViewer")) {
              await runtime.bus.execute("node.openViewer", { nodeIds: [result.output.createdIds[previz ? "$previz" : "$corner"]!] }, runtime.invocation);
            }
          }
        }
      }
      close();
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setBusy(false); }
  };

  const saveAllAndApply = async () => {
    if (busy || !canSaveAll) return;
    let depthFile = savedDepth, maskFile = savedMask, nativeFile = savedNativeDepth;
    let nativeSha256 = verifiedNative?.reference === nativeFile ? verifiedNative.sha256 : undefined;
    if (needsDepth && finalMetadata?.version === 2 && finalMetadata.stage === "refined" && nativeFile === "") {
      const reference = await save("native");
      if (reference === undefined) return;
      nativeFile = reference;
      nativeSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encodePreparedMap(nativeDepth!).buffer as ArrayBuffer))].map(value => value.toString(16).padStart(2, "0")).join("");
    }
    if (needsDepth && !depthReady) {
      const reference = await save("depth", nativeSha256 === undefined ? undefined : { reference: nativeFile, sha256: nativeSha256 });
      if (reference === undefined) return;
      depthFile = reference;
      if (finalMetadata?.version !== 2 || finalMetadata.stage === "native") nativeFile = reference;
    }
    if (needsMask && !maskReady) {
      const reference = await save("mask");
      if (reference === undefined) return;
      maskFile = reference;
    }
    await apply({ depth: depthFile, mask: maskFile, native: nativeFile, ...(nativeSha256 === undefined ? {} : { nativeSha256 }) });
  };

  const registerImportedMap = (kind: "depth" | "mask") => {
    const map = kind === "depth" ? unregisteredDepth : unregisteredMask;
    if (photo === null || map === null || busy) return;
    try {
      const prepared = makePreparedMap(map.values, map.width, map.height, { kind,
        source: { sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height },
        model: { id: kind === "depth" ? "imported-depth" : "manual", url: kind === "depth" ? depthRef : maskRef },
        inputSide: kind === "depth" ? DEFAULT_PHOTO_DEPTH_RECIPE.inputSide : maskSide, registration: "stretch" });
      if (kind === "depth") {
        const recipe = { ...DEFAULT_PHOTO_DEPTH_RECIPE, modelId: "imported-depth" };
        const native = withDepthRecipe(prepared, recipe, null, importedConvention);
        setDepth(native); setNativeDepth(native); restoreDepthRecipe(native); setInspectionView("native");
        setSavedDepth(""); setSavedNativeDepth(""); setNativeDepthRef(""); setVerifiedNative(null); setUnregisteredDepth(null);
      } else {
        setMask(prepared); setSavedMask(""); setHistory([]); setRedoHistory([]); setInspectionView("mask"); setUnregisteredMask(null);
      }
      setError(null); setStatus(`Imported ${kind} registered to this photo. Save the float32 EXR to keep its new metadata.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const paintAt = (point: { x: number; y: number }, first: boolean) => {
    const current = maskRefLive.current;
    if (busy || !needsMask || current === null || (!first && stroke.current === null)) return;
    const next = { x: point.x * current.width, y: point.y * current.height };
    if (first) {
      if (stroke.current !== null) return;
      loadVersions.current.mask++;
      setHistory(previous => [...previous.slice(-19), current]); setRedoHistory([]);
      stroke.current = { point: next, editor: beginMaskStroke(current) }; setSavedMask("");
    }
    const active = stroke.current!;
    const painted = { ...active.editor.paint(active.point, next, radius, maskTool === "restore" ? 1 : 0) };
    active.point = next; maskRefLive.current = painted; setMask(painted);
  };
  const undoMask = () => {
    if (busy || mask === null || history.length === 0) return;
    setRedoHistory(previous => [...previous.slice(-19), mask]);
    const previous = history[history.length - 1]!; setMask(previous); maskRefLive.current = previous;
    setHistory(previous => previous.slice(0, -1)); setSavedMask("");
  };
  const redoMask = () => {
    if (busy || mask === null || redoHistory.length === 0) return;
    setHistory(previous => [...previous.slice(-19), mask]);
    const next = redoHistory[redoHistory.length - 1]!; setMask(next); maskRefLive.current = next;
    setRedoHistory(previous => previous.slice(0, -1)); setSavedMask("");
  };

  const finishStroke = () => {
    if (stroke.current === null) return;
    const painted = { ...stroke.current.editor.finish() };
    stroke.current = null;
    maskRefLive.current = painted;
    setMask(painted);
  };

  const closeDialog = () => {
    if (busy && job?.progress.phase !== "saving") cancelJob();
    preparer.current?.dispose(); preparer.current = null;
    close();
  };
  const inspectionWorkspace = <PhotoDepthWorkspace photo={photo} readMaps={readInspectionMaps} active={inspectionView} onSelect={setInspectionView} depthRange={depthRange}
    palette={depthPalette} onPaletteChange={setDepthPalette}
    effectPreview={<PhotoMappingPreview photo={photo} previewPhoto={previewPhoto} mode={mode} depthRange={depthRange} testPattern={testPattern} {...(videoUrl === undefined || videoUrl === "" ? {} : { videoUrl })}
      previewFit={previewFit} previewFraming={previewFraming} previewOpacity={previewOpacity} readMaps={readPreviewMaps}
      fullFrame={!needsMask} matching={(!needsDepth || depth === null || matches(depth)) && (!needsMask || (mask !== null && matches(mask))) && previewReady} />}
    maskEditing={{ enabled: needsMask && mask !== null, mode: maskTool, radius, canUndo: history.length > 0, canRedo: redoHistory.length > 0, busy,
      onMode: setMaskTool, onRadius: setRadius, onPaint: paintAt, onFinish: finishStroke, onUndo: undoMask, onRedo: redoMask }} />;
  if (!open) return null;
  return <DialogRoot open onOpenChange={opened => { if (!opened) closeDialog(); }}>
    <DialogContent className={styles.dialog}>
      <DialogTitle>{existing ? "Prepare photo mapping" : "Map from photo"}</DialogTitle>
      <DialogDescription className={styles.description}>Choose a photo, load or prepare maps, then create</DialogDescription>
      <div className={styles.body} data-testid="photo-mapping-body">
      <section className={styles.photoStep} aria-label="Choose reference photo">
        <div className={styles.stepHeading}><span className={styles.stepNumber}>1</span><h2>Choose a photo</h2>
          {photo === null ? null : <span className={styles.complete}>Selected</span>}</div>
        <p className={styles.hint}>Keep the object still; photograph beside the projector lens</p>
        <div className={styles.photoColumns}>
        <section className={styles.photoCard} aria-label="Reference photograph">
        <div className={styles.cardHeading}><h3>Reference</h3><span className={styles.badge}>Depth + mask source</span></div>
        <div className={`${styles.photoPicker} ${photo === null ? styles.photoEmpty : ""}`}>
        <AssetField label="Reference photo" kind="image" value={photoRef || null}
        {...(existing || busy ? {} : { onPick: (reference: string, fileName: string) => {
          setPhotoRef(reference); setPhotoName(fileName); setError(null);
        } })} />
        </div>
        <button type="button" className={styles.photoFrame} data-testid="reference-photo-frame" aria-label="Expand reference photo" disabled={photo === null} onClick={() => inspect("photo", "reference")}>
          {photo === null ? <span className={styles.placeholder}>Choose your reference photo</span> : <div className={styles.photoImageFrame} style={photoFrameStyle}><img src={photoUrl} alt="Reference photo" /></div>}
        </button>
        <p className={styles.hint}>Used to prepare depth and mask</p>
        {photo !== null && Math.max(photo.bitmap.width, photo.bitmap.height) > runtime.bus.store.getSettings().limits.maxResolution
          ? <p className={styles.hint} role="note">Large photo: network fits within {runtime.bus.store.getSettings().limits.maxResolution} px, keeping the full frame</p> : null}
        </section>
        <section className={styles.photoCard} aria-label="Preview photograph">
        <div className={styles.cardHeading}><h3>Preview</h3><span className={styles.badge}>Optional night photo</span></div>
        {(!existing || initial.previewPhotoId !== undefined) ? <div className={styles.photoPicker}>
          <AssetField label="Preview photo (optional)" kind="image" value={previewPhotoRef || null}
            {...(busy ? {} : { onPick: (reference: string) => { setPreviewPhotoRef(reference); setPreviewPhoto(null); setError(null); } })} />
        </div> : <p className={styles.hint}>Using the reference photo</p>}
        <button type="button" className={styles.photoFrame} data-testid="preview-photo-frame" aria-label="Expand preview photo" disabled={photo === null} onClick={() => inspect("photo", "preview")}>
          {photo === null ? <span className={styles.placeholder}>Choose an optional preview photo</span>
            : <div className={styles.photoImageFrame} style={photoFrameStyle}><img src={previewPhotoUrl || photoUrl} alt="Preview photo" style={previewImageStyle} />
              {comparison > 0 && previewPhoto !== null ? <img src={photoUrl} alt="Reference alignment overlay" className={styles.referenceOverlay} style={{ opacity: comparison / 100 }} /> : null}
            </div>}
        </button>
        {previewPhotoRef === "" ? <p className={styles.hint}>Using the reference until you choose a preview photo</p> : <>
          <label className={styles.previewFit}>Preview fit <select value={previewFit} disabled={busy} onChange={event => setPreviewFit(event.target.value as PreviewImageFit)}>
            <option value="fit">Fit whole image</option><option value="fill">Crop to frame</option><option value="stretch">Stretch to frame</option>
          </select></label>
          {photo !== null && previewPhoto !== null && !previewFramingMatches ? <p role="note" aria-label="Preview framing warning" className={styles.warning}>Different aspect ratio: check the fitted alignment</p> : null}
          <p className={styles.hint}>{previewFit === "fill" ? "Crop removes edges; check the fitted alignment" : previewFit === "stretch" ? "Stretch changes proportions; check the fitted alignment" : "Fit adds borders; check the fitted alignment"}</p>
          {framing !== null && previewPhoto !== null && photo !== null ? <details className={styles.framingDetails} open={!previewFramingMatches}>
            <summary>Check framing and alignment</summary>
            <PhotoPreviewCrop source={previewPhoto.bitmap} target={photo.bitmap} url={previewPhotoUrl!} fit={previewFit} value={previewFraming} onChange={setPreviewFraming} disabled={busy} />
            <p className={styles.hint}>{previewFit === "fill" ? `Crop removes ${Math.round((1 - framing.source.width * framing.source.height / (previewPhoto.bitmap.width * previewPhoto.bitmap.height)) * 100)}% of the photo; outlined area stays`
              : previewFit === "fit" ? `Borders occupy ${Math.round((1 - framing.destination.width * framing.destination.height / (photo.bitmap.width * photo.bitmap.height)) * 100)}% of the frame; all edges stay`
              : `All edges stay; horizontal proportions ×${(photo.bitmap.width / photo.bitmap.height / (previewPhoto.bitmap.width / previewPhoto.bitmap.height)).toFixed(2)}`}</p>
            <label>Reference overlay <input type="range" min={0} max={100} value={comparison} disabled={busy} onChange={event => setComparison(Number(event.target.value))} /><output>{comparison}%</output></label>
            <p className={styles.hint}>Compare rooflines and windows; the crop is saved with the preview</p>
          </details> : null}
          {!existing ? <Button variant="outline" disabled={busy} onClick={() => { setPreviewPhotoRef(""); setPreviewPhoto(null); setError(null); }}>Use reference photo</Button> : null}
        </>}
        <p className={styles.hint}>Same viewpoint and framing; used only for preview</p>
        {!existing ? <label className={styles.previewLight}>Preview light <input type="range" min={0} max={100} value={Math.round(previewOpacity * 100)} disabled={busy} onChange={event => setPreviewOpacity(Number(event.target.value) / 100)} /><output>{Math.round(previewOpacity * 100)}%</output></label> : null}
        {!existing ? <p className={styles.hint}>Lower to see more building; projector stays full strength</p> : null}
        </section>
        </div>
      </section>
      <div className={styles.workspaceGrid}>
      <section className={styles.preparationStep} aria-label="Prepare and save maps">
        <div className={styles.stepHeading}><span className={styles.stepNumber}>2</span><h2>Prepare and save</h2></div>
        <p className={styles.hint}>Reuse saved maps, or generate and save new ones</p>
      <div className={styles.columns}>
        {(!existing || initial.depthId !== undefined) ? <section className={styles.section} aria-label="Depth preparation">
          <div className={styles.cardHeading}><h3>Depth</h3><BooleanField label="Use depth map" value={useDepth} onChange={setUseDepth} disabled={busy} /><span className={depthReady && job?.kind !== "depth" && job?.kind !== "refinement" && job?.kind !== "native" ? styles.complete : styles.badge}>{!needsDepth ? "Load later" : job?.kind === "depth" || job?.kind === "refinement" || job?.kind === "native" ? "Working…" : mapState(depth, depthReady)}</span></div>
          {!needsDepth ? <p className={styles.hint}>Creates a neutral depth input. Load a map in the network later.</p> : null}
          <label>Model <select value={modelId} disabled={busy} onChange={event => { const nextModel = event.target.value;
            setModelId(nextModel);
            if (nextModel === DEFAULT_MARIGOLD_RECIPE.modelId) { setBackend("mlx"); setSide(DEFAULT_MARIGOLD_RECIPE.inputSide); }
            else if (isDepthPro2PhotoModel(nextModel)) {
              // Each family's sizes are its own, so a switch lands on the new family's default.
              // Entering the family takes its WebGPU default; B has no CPU path at all.
              if (!metric) setSide(DEFAULT_DEPTH_PRO2_RECIPE.inputSide);
              if (!metric || nextModel !== DEFAULT_DEPTH_PRO2_RECIPE.modelId) setBackend(webgpuAvailable ? "webgpu" : "wasm");
            }
            else if (backend === "mlx" || metric) { if (backend === "mlx") setBackend("wasm"); setSide(DEFAULT_PHOTO_DEPTH_RECIPE.inputSide); } }}>
            {PHOTO_DEPTH_MODELS.map(model => <option key={model.id} value={model.id}>{model.label} ({(model.bytes / 1024 / 1024).toFixed(1)} MB)</option>)}
            {PHOTO_DEPTH_PRO2_MODELS.map(model => <option key={model.id} value={model.id}>{model.label} ({(model.bytes / 1024 / 1024).toFixed(1)} MB)</option>)}
            <option value="marigold-v2-q4">Marigold V2 · mixed Q4/Q8 · Desktop</option>
            {selectedModel === undefined && modelId !== "marigold-v2-q4" ? <option value={modelId}>Saved model: {modelId}</option> : null}
          </select></label>
          {modelId === "marigold-v2-q4" ? <div className={styles.requirements}>
            {orderRequirements(["desktop", "macos", "apple-silicon"]).map(requirement => <TypeBadge key={requirement.id} label={requirement.label} category={requirement.category} title={requirement.description} />)}
          </div> : null}
          <label>Inference backend <select value={backend} disabled={busy} onChange={event => { setBackend(event.target.value as PhotoDepthRecipe["backend"]); }}>
            {marigold ? <option value="mlx">Apple GPU (MLX)</option> : <><option value="wasm">CPU (WASM)</option><option value="webgpu" disabled={!webgpuAvailable}>GPU (WebGPU)</option></>}
          </select></label>
          {depthUnavailable !== null ? <p role="note" className={styles.warning}>{depthUnavailable}</p> : null}
          {selectedModel?.license === "CC-BY-NC-4.0" ? <p role="note" className={styles.warning}>Large weights carry CC-BY-NC-4.0 · non-commercial use</p> : null}
          {metric ? <p role="note" className={styles.warning}>Apple ML Research licence · research use only, not commercial or client work</p> : null}
          <label>Detail <select value={side} disabled={busy} onChange={event => { const nextSide = Number(event.target.value); setSide(nextSide);
            if (!refinementRadiusEdited.current) setRefinement(current => current === null ? null : { ...current, radius: nextSide >= 1280 ? 1 : DEFAULT_DEPTH_REFINEMENT.radius }); }}>
            {(marigold ? MARIGOLD_INPUT_SIDES : metric ? DEPTH_PRO2_PHOTO_SIDES : PHOTO_DEPTH_INPUT_SIDES).map(size => <option key={size} value={size} disabled={!depthSides.includes(size) || (marigold && nativeCapability.available && nativeCapability.inputSides !== undefined && !nativeCapability.inputSides.includes(size as typeof MARIGOLD_INPUT_SIDES[number]))}>{marigold ? `${size} px long edge` : metric ? depthPro2BoxLabel(size as typeof DEPTH_PRO2_PHOTO_SIDES[number]) : `${size} × ${size}`}</option>)}
          </select></label>
          {metric ? <>
            <label>Field of view <input type="number" min={1} max={170} step={0.1} value={fieldOfView} disabled={busy} onChange={event => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next) || next < 1 || next > 170) { setError("Field of view must be between 1° and 170°."); return; }
              setError(null); fieldOfViewChosen.current = true; setFieldOfView(next);
            }} /> °</label>
            <p className={styles.hint}>{photo?.focalLength35 === undefined
              ? "Horizontal, in degrees. The photo records no 35 mm focal length, so set it: a wider view reads nearer."
              : `Horizontal, in degrees. The photo says ${photo.focalLength35} mm equivalent, ${photoFieldOfView}°.`}</p>
            <p className={styles.hint}>Metric: saves inverse metres, sky at 0</p>
          </> : null}
          {marigold ? <>
            <label>Depth seed <input type="number" min={0} max={4294967295} step={1} value={seed} disabled={busy} onChange={event => {
              const next = Number(event.target.value);
              if (!Number.isInteger(next) || next < 0 || next > 4294967295) { setError("Depth seed must be an unsigned 32-bit integer."); return; }
              setError(null); setSeed(next);
            }} /></label>
            <p className={styles.hint}>Local static depth · 15.3 GB cached download · tested through 1536 px on M3 Max / 36 GB</p>
            <p className={styles.hint}>{nativeCapability.available ? nativeCapability.cached ? "Model verified on disk · ready offline" : "First run downloads and verifies the model" : "Native worker setup: pnpm native:marigold:build"}</p>
          </> : null}
          <p className={styles.hint}>Native float32; larger sizes take more time and memory</p>
          <div className={styles.actions}>
            <Button size="md" variant="outline" className={depth === null ? styles.runButton : undefined}
              disabled={photo === null || busy || !needsDepth || depthUnavailable !== null} onClick={() => void run("depth")}>{depth === null ? "Run depth" : "Rerun depth"}</Button>
            <Button size="md" variant="outline" className={styles.saveButton}
              disabled={depth === null || busy || !matches(depth) || !nativeParentReady} onClick={() => void save("depth")}>{depthReady ? "Save depth again…" : "Save depth…"}</Button>
          </div>
          <div className={styles.existingMap}>
            <span>Use an existing depth map</span>
            <AssetField label="Existing depth map" kind="binary" value={depthRef || null}
              {...(busy ? {} : { onPick: (reference: string) => {
                loadVersions.current.depth++; setDepth(null); setUnregisteredDepth(null); setDepthRef(reference); setSavedDepth(reference);
                setDepthPick(previous => previous + 1);
                setError(null); setStatus("Opening the existing depth map…");
              } })} />
          </div>
          {unregisteredDepth !== null ? <div role="note" className={styles.warning}>
            <p>Depth metadata is missing. Confirm that the map spans the whole reference photo.</p>
            <label>Imported depth convention <select value={importedConvention} disabled={busy} onChange={event => setImportedConvention(event.target.value as typeof importedConvention)}>
              <option value="inverse-relative">Brighter is nearer</option><option value="relative-linear">Brighter is farther · linear</option><option value="relative-log">Brighter is farther · log-depth</option>
            </select></label>
            <Button variant="outline" disabled={photo === null || busy} onClick={() => registerImportedMap("depth")}>Register imported depth</Button>
          </div> : null}
          <figure className={styles.figure}>
            <div className={styles.previewWell} aria-busy={job?.kind === "depth" || job?.kind === "refinement" || job?.kind === "native"}><button type="button" aria-label="Expand depth map" disabled={depth === null || busy} onClick={() => inspect(depthMetadata?.version === 2 && depthMetadata.stage === "refined" ? "depth" : "native")} className={styles.previewFrame} data-testid="depth-preview-frame" style={previewStyle}>
              <canvas ref={setPreview} role="img" aria-label="Depth preview" className={`${styles.preview} ${depth === null ? styles.emptyCanvas : ""}`} />
              {depth === null ? <span className={styles.placeholder}>Load or run depth to see the surface relief</span> : null}
            </button>{job?.kind === "depth" || job?.kind === "refinement" || job?.kind === "native" ? <MapProgress job={job} /> : null}</div>
            <figcaption className={styles.previewCaption}>{depth === null ? "Surface relief" : `${depth.width} × ${depth.height} ${depthMetadata?.version === 2 && depthMetadata.stage === "refined" ? "derived" : "native"} samples · float32`}</figcaption>
          </figure>
          <details className={styles.refinement}><summary>Depth range and cutoff</summary>
            <p className={styles.hint}>Far = 0, near = 1. Re-range effect depth without changing saved samples. Use Depth range as the mask method to exclude depths outside this band.</p>
            <label>Far cutoff <input type="range" min={0} max={Math.max(0, depthRange.high - 0.01)} step={0.01} value={depthRange.low} disabled={busy} onChange={event => { setDepthRange(previous => ({ ...previous, low: Number(event.target.value) })); if (depth !== null) setInspectionView(depthMetadata?.version === 2 && depthMetadata.stage === "refined" ? "depth" : "native"); }} /><output>{depthRange.low.toFixed(2)}</output></label>
            <label>Near cutoff <input type="range" min={Math.min(1, depthRange.low + 0.01)} max={1} step={0.01} value={depthRange.high} disabled={busy} onChange={event => { setDepthRange(previous => ({ ...previous, high: Number(event.target.value) })); if (depth !== null) setInspectionView(depthMetadata?.version === 2 && depthMetadata.stage === "refined" ? "depth" : "native"); }} /><output>{depthRange.high.toFixed(2)}</output></label>
            <label>Cutoff softness <input type="range" min={0} max={0.25} step={0.005} value={depthRange.softness} disabled={busy} onChange={event => setDepthRange(previous => ({ ...previous, softness: Number(event.target.value) }))} /><output>{depthRange.softness.toFixed(3)}</output></label>
            <Button variant="outline" disabled={busy} onClick={() => setDepthRange(DEFAULT_DEPTH_RANGE)}>Reset depth range</Button>
          </details>
          <details className={styles.refinement}>
            <summary>Export depth image…</summary>
            <p className={styles.hint}>PNG/TIFF store 65,536 normalized depth levels; EXR preserves raw float32 values. Palettes are excluded. Native maps retain their model grid; refined maps use the full photo frame.</p>
            <div className={styles.actions}>{DEPTH_IMAGE_FORMATS.map(format => <Button variant="outline" key={format.id} disabled={busy || depth === null || !matches(depth)} onClick={() => void exportImage(format.id)}>{format.label}</Button>)}</div>
          </details>
          <details className={styles.refinement} open={refinement !== null}>
            <summary>Guided depth refinement</summary>
            <p className={styles.hint}>Optional: recommended for cleaner edges and larger maps. Uses the photo to guide smoothing and upscaling, without rerunning the model. Save a separate result or use native depth.</p>
            <label>Refined output <select value={refinement?.target ?? "off"} disabled={busy} onChange={event => {
              setRefinement(event.target.value === "off" ? null : { ...DEFAULT_DEPTH_REFINEMENT,
                radius: side >= 1280 ? 1 : DEFAULT_DEPTH_REFINEMENT.radius, ...refinement, target: event.target.value as "source" | "2048" | "4096" });
              if (event.target.value === "off" && nativeDepth !== null && nativeMatches) { setDepth(nativeDepth); setSavedDepth(savedNativeDepth); setInspectionView("native"); }
            }}><option value="off">Native prediction</option><option value="source">Source photo size</option><option value="2048">2K long edge</option><option value="4096">4K long edge</option></select></label>
            {refinement !== null ? <>
              <Button variant="outline" disabled={busy || !nativeMatches} onClick={() => {
                setRefinement(null); setDepth(nativeDepth); setSavedDepth(savedNativeDepth); setInspectionView("native");
                setError(null); setStatus("Using native depth. Refinement skipped.");
              }}>Use native depth · skip refinement</Button>
              <p className={styles.hint}>{refinementSize === null ? "Choose a supported output size" : `${refinementSize.width} × ${refinementSize.height} derived samples · progressive RGB-guided passes`}</p>
              <label>Smoothing <input type="range" min={0.25} max={8} step={0.25} value={refinement.spatialSigma} disabled={busy} onChange={event => { setRefinement({ ...refinement, spatialSigma: Number(event.target.value) }); }} /><output>{refinement.spatialSigma}</output></label>
              <label>Edge sensitivity <input type="range" min={0.005} max={1} step={0.005} value={refinement.colorSigma} disabled={busy} onChange={event => { setRefinement({ ...refinement, colorSigma: Number(event.target.value) }); }} /><output>{refinement.colorSigma.toFixed(3)}</output></label>
              <label>Pass radius <input type="number" min={1} max={4} step={1} value={refinement.radius} disabled={busy} onChange={event => {
                const radius = Number(event.target.value);
                if (!Number.isInteger(radius) || radius < 1 || radius > 4) { setError("Pass radius must be an integer from 1 to 4."); return; }
                refinementRadiusEdited.current = true;
                setError(null); setRefinement({ ...refinement, radius });
              }} /></label>
              <p className={styles.hint}>Use photo edges as guidance; paint and shadows are not measured geometry. Native depth stays unchanged.</p>
              {refinementUnavailable !== null ? <p role="note" className={styles.warning}>{refinementUnavailable}</p> : null}
              <div className={styles.actions}>
                <Button size="md" variant="outline" className={depthMetadata?.version === 2 && depthMetadata.stage === "refined" ? undefined : styles.runButton} disabled={busy || !nativeMatches || refinementUnavailable !== null} onClick={() => void run("refinement")}>Run refinement</Button>
                {depthMetadata?.version === 2 && depthMetadata.stage === "refined" && savedNativeDepth === "" ? <Button size="md" variant="outline" className={styles.saveButton} disabled={busy || !nativeMatches} onClick={() => void save("native")}>Save native depth…</Button> : null}
              </div>
              <p className={styles.hint}>{savedNativeDepth === "" ? "Native is the original prediction: save it once. Refined depth is a separate file." : "Original native prediction saved. Save the refined result separately if you use it."}</p>
              <AssetField label="Native depth parent" kind="binary" value={nativeDepthRef || null} {...(busy ? {} : { onPick: (reference: string) => { loadVersions.current.native++; setNativePick(value => value + 1); setNativeDepthRef(reference); setNativeDepth(null); setSavedNativeDepth(""); setVerifiedNative(null); } })} />
            </> : null}
          </details>
          {depth !== null && photo !== null && !matches(depth) ? <p role="alert">Depth out of date: choose a matching map or rerun</p> : null}
        </section> : null}
        {(!existing || initial.maskId !== undefined) ? <section className={styles.section} aria-label="Surface mask preparation">
          <div className={styles.cardHeading}><h3>Surface mask</h3>
            <label htmlFor="photo-mapping-use-mask">Use mask<BooleanField id="photo-mapping-use-mask" label="Use surface mask" value={useMask} onChange={setUseMask} disabled={busy} /></label>
            <span className={maskReady && needsMask && job?.kind !== "mask" ? styles.complete : styles.badge}>{job?.kind === "mask" ? "Working…" : needsMask ? mapState(mask, maskReady) : "Full frame"}</span>
          </div>
          <label>Mask detail <select value={maskSide} disabled={busy || !needsMask} onChange={event => { setMaskSide(Number(event.target.value)); setSavedMask(""); }}>
            {PHOTO_MASK_INPUT_SIDES.map(size => <option key={size} value={size}>{size} × {size}</option>)}
          </select></label>
          <p className={styles.hint}>{needsMask ? maskMethod === "depth" ? "Keep a depth band; exclude near or far surfaces" : maskMethod === "facade" ? "Keep walls; exclude sky, openings and reflective glass" : "Select the object and remove its background" : "Full frame · no mask file needed"}</p>
          <div className={styles.actions}>
            <Button size="md" variant="outline" className={mask === null ? styles.runButton : undefined}
              disabled={photo === null || busy || !needsMask || (maskMethod === "depth" && (depth === null || !matches(depth) || depthIdentity === null))} onClick={() => void run("mask")}>{mask === null ? "Run mask" : "Rerun mask"}</Button>
            <Button size="md" variant="outline" className={styles.saveButton}
              disabled={mask === null || busy || !needsMask || !matches(mask)} onClick={() => void save("mask")}>{maskReady ? "Save mask again…" : "Save mask…"}</Button>
          </div>
          <div className={styles.existingMap}>
            <span>Use an existing mask</span>
            <AssetField label="Existing mask map" kind="binary" value={maskRef || null}
              {...(busy || !needsMask ? {} : { onPick: (reference: string) => {
                loadVersions.current.mask++; setMask(null); setUnregisteredMask(null); setMaskRef(reference); setSavedMask(reference);
                setMaskPick(previous => previous + 1);
                setHistory([]); setError(null); setStatus("Opening the existing mask…");
              } })} />
          </div>
          {unregisteredMask !== null ? <div role="note" className={styles.warning}>
            <p>Mask metadata is missing. Confirm full-frame registration; 0 excludes and 1 keeps the surface.</p>
            <Button variant="outline" disabled={photo === null || busy} onClick={() => registerImportedMap("mask")}>Register imported mask</Button>
          </div> : null}
          <figure className={styles.figure}>
            <div className={styles.previewWell} aria-busy={job?.kind === "mask"}><button type="button" aria-label="Expand surface mask" disabled={mask === null || busy} onClick={() => inspect("mask")} className={styles.previewFrame} data-testid="mask-preview-frame" style={previewStyle}>
              <canvas ref={setCanvas} role="img" aria-label={mask === null ? "Reference photo preview" : "Surface mask overview"}
                className={`${styles.preview} ${photo === null ? styles.emptyCanvas : ""}`}
                 />
              {photo === null ? <span className={styles.placeholder}>Choose a photo to see its surface</span> : null}
            </button>{job?.kind === "mask" ? <MapProgress job={job} /> : null}</div>
            <figcaption className={styles.previewCaption}>{mask === null ? "Reference photo before masking" : "Red is excluded · edit in the large Surface Mask view"}</figcaption>
          </figure>
          <label>Mask method <select value={maskMethod} disabled={busy || !needsMask} onChange={event => { setMaskMethod(event.target.value as "facade" | "background" | "depth"); setSavedMask(""); }}>
            <option value="facade">Facade walls and openings</option><option value="background">Object background removal</option><option value="depth">Depth range</option>
          </select></label>
          {maskMethod === "facade" ? <div className={styles.brushTools}>
            <label>Opening cutoff <input type="range" min={0} max={50} step={1} value={Math.round(linearToSrgb(facadeSettings.darkCutoff) * 100)}
              disabled={busy || !needsMask} onChange={event => { setFacadeSettings(previous => ({ ...previous, darkCutoff: srgbToLinear(Number(event.target.value) / 100) })); setSavedMask(""); }} /><output>{Math.round(linearToSrgb(facadeSettings.darkCutoff) * 100)}%</output></label>
            <label>Exclude blue glass <BooleanField label="Exclude blue glass" value={facadeSettings.excludeBlueGlass} disabled={busy || !needsMask}
              onChange={excludeBlueGlass => { setFacadeSettings(previous => ({ ...previous, excludeBlueGlass })); setSavedMask(""); }} /></label>
            <p className={styles.hint}>Check shaded walls and painted glass; restore with the brush</p>
            <p className={styles.hint}>Change exclusions, then rerun mask; depth stays saved</p>
          </div> : null}
          {maskMethod === "depth" ? <p className={styles.hint}>Set cutoffs under Depth range and cutoff, then run mask. No model download. Brush corrections remain available.</p> : null}
          <div className={styles.alternative}><Button variant="outline" disabled={photo === null || busy || !needsMask} onClick={() => {
            if (photo === null) return;
            setInspectionView("mask"); setMaskTool("erase");
            if (mask !== null) return;
            loadVersions.current.mask++;
            const scale = Math.min(1, maskSide / photo.bitmap.width, maskSide / photo.bitmap.height);
            const width = Math.max(1, Math.round(photo.bitmap.width * scale)), height = Math.max(1, Math.round(photo.bitmap.height * scale));
            setMask(makePreparedMap(new Float32Array(width * height).fill(1), width, height, { kind: "mask", source: {
              sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height }, model: { id: "manual", url: "loom:manual-mask" },
              inputSide: maskSide, registration: "stretch" })); setSavedMask(""); setHistory([]);
          }}>{mask === null ? "Start manual mask" : "Edit mask"}</Button><span>Paint in the large view</span></div>
          <details className={styles.refinement}><summary>Mask help and model details</summary>
            <p className={styles.model}>{maskMethod === "depth" ? "Local depth thresholding · no inference" : maskMethod === "facade" ? `${PHOTO_FACADE.label} · ${(PHOTO_FACADE.bytes / 1024 / 1024).toFixed(1)} MB · 512 input / 64 scene mask` : `${PHOTO_MASK.label} · ${(PHOTO_MASK.bytes / 1024 / 1024).toFixed(1)} MB · cached after first run`}</p>
            <p className={styles.hint}>Erase and restore in the large Surface mask view. Rerun replaces brush edits. Photo refinement adds detail at the selected resolution.</p>
          </details>
          {needsMask && maskCoverage !== null && maskCoverage < 0.01 ? <div role="alert" className={styles.warning}>
            <p>Mask covers less than 1% of the photo</p>
            <p>Use full frame or restore the surface with the brush</p>
          </div> : null}
          {needsMask && mask !== null && photo !== null && !matches(mask) ? <div role="alert">
            <p>{preparedMetadata(mask).source.sha256 !== photo.sha256 ? "Mask belongs to another reference photo. Run mask for this photo, or use full frame." : "Mask settings changed. Rerun mask, or use full frame; depth remains available."}</p>
            <Button variant="outline" disabled={busy} onClick={() => setUseMask(false)}>Use full frame</Button>
          </div> : null}
        </section> : null}
      </div>
      </section>
      <section className={styles.creationStep} aria-label="Create or update mapping">
        <div className={styles.stepHeading}><span className={styles.stepNumber}>3</span><h2>{existing ? "Update your network" : "Create in this project"}</h2></div>
        <p className={styles.hint}>Inspect the surface, choose your effect, then create</p>
        <div className={styles.inspection}>{!inspectionExpanded ? inspectionWorkspace : null}</div>
        <div className={styles.finishStep}>
        <Button variant="outline" disabled={photo === null} onClick={() => inspect(inspectionView)}>Expand inspection</Button>
        {(!existing || initial.effectId !== undefined) ? <label>First effect <select value={mode} disabled={busy} onChange={event => { setMode(Number(event.target.value)); setInspectionView("effect"); }}>
        {PHOTO_MAPPING_EFFECTS.filter(effect => !existing || effect.id < 10).map(effect => <option key={effect.id} value={effect.id}>{effect.name}</option>)}
        </select></label> : null}
        <p className={styles.hint}>{PHOTO_MAPPING_EFFECTS.find(effect => effect.id === mode)?.description}</p>
        {existing && mode !== initial.mode ? <p className={styles.hint}>Applying this look replaces the effect shader.</p> : null}
        <label>Alignment test pattern <BooleanField label="Alignment test pattern" value={testPattern} disabled={busy || (existing && initial.patternSwitchId === undefined)} onChange={value => { setTestPattern(value); setInspectionView("effect"); }} /></label>
        {mode === 9 ? <AssetField label="Video texture" kind="video" value={videoRef || null} {...(busy ? {} : { onPick: setVideoRef })} /> : null}
        {!existing ? <label>Preview on reference photo <BooleanField label="Preview on reference photo" value={previz} onChange={setPreviz} disabled={busy} /></label> : null}
        {!existing && previz ? <p className={styles.hint}>Preview dims the reference so projected light stays clear</p> : null}
        <p className={styles.hint}>{canApply ? previz && !existing ? "View the effect on your photo; align Window Out to project" : "Next: align Grid Warp and Corner Pin in Window Out" : "Load saved maps or save new results to enable this step"}</p>
      </div>
      </section>
      </div>
      </div>
      <div className={styles.feedback}>
        <p className={styles.nextAction}>{busy ? job?.progress.message ?? "Working…" : `Next: ${nextAction}`}</p>
        {status === "" ? null : <p role="status" className={styles.status}>{status}</p>}
        {error === null ? null : <p role="alert" className={styles.error}>{error}</p>}
        {requiresReload ? <Button onClick={() => window.location.reload()}>Reload Loom</Button> : null}
      </div>
      <DialogFooter className={styles.footer}>{job !== null && job.progress.phase !== "saving" ? <Button size="md" variant="outline" onClick={cancelJob}>Cancel preparation</Button> : null}<Button size="md" variant="outline" onClick={closeDialog}>Close</Button>
        <Button size="md" variant="outline" className={styles.saveButton} disabled={busy || !canSaveAll} onClick={() => void saveAllAndApply()}>{existing ? "Save all and apply" : "Save all and create"}</Button>
        <Button size="md" variant="outline" className={styles.primary} disabled={busy || !canApply}
          onClick={() => void apply()}>{existing ? "Apply saved maps" : "Create mapping network"}</Button></DialogFooter>
      <DialogRoot open={inspectionExpanded} onOpenChange={setInspectionExpanded}>
        <DialogContent className={styles.expandedDialog}>
          <DialogTitle>{expandedPhoto === "preview" ? "Preview photo" : expandedPhoto === "reference" ? "Reference photo" : "Inspect photo mapping"}</DialogTitle>
          <DialogDescription>Zoom, pan and inspect. Changes to masks and depth colours also appear in the mapping dialog.</DialogDescription>
          <div className={styles.expandedInspection}>{expandedPhoto === null ? inspectionWorkspace
            : <PhotoDepthWorkspace photo={expandedPhoto === "preview" ? previewPhoto ?? photo : photo}
              readMaps={() => ({ native: null, depth: null, mask: null })} active="photo" />}</div>
          <DialogFooter><Button variant="outline" onClick={() => setInspectionExpanded(false)}>Back to mapping</Button></DialogFooter>
        </DialogContent>
      </DialogRoot>
    </DialogContent>
  </DialogRoot>;
}

/** Mounted even while closed, so the pulse and top-bar action always have a command surface. */
export function PhotoMappingHost({ runtime }: { runtime: AppRuntime }) {
  const [session, setSession] = useState<{ id: string; recipe: Recipe; open: boolean } | null>(null);
  useEffect(() => { setSession(null); }, [runtime.documentIdentity]);
  useEffect(() => {
    if (typeof runtime.bus.replaceCommand !== "function") return;
    registerPhotoMappingCommands(runtime.bus, { refresh: true });
    const stored = sessionStorage.getItem(reloadRecipeKey(runtime));
    if (stored !== null) {
      const { version: _version, nativeDepth, depthRecipe, ...recipe } = reloadRecipeSchema.parse(JSON.parse(stored));
      setSession({ id: crypto.randomUUID(), open: true, recipe: { ...recipe,
        ...(nativeDepth === undefined ? {} : { nativeDepth }), ...(depthRecipe === undefined ? {} : { depthRecipe }) } });
    }
  }, [runtime]);
  const holder = useMemo(() => {
    const found = commandHolder<{ open: (recipe: Recipe) => void }>(runtime.bus, "photoMapping.prepare");
    if (!runtime.bus.hasCommand("photoMapping.prepare")) runtime.bus.registerCommand({
      name: "photoMapping.prepare", inSession: "app", inputSchema: z.object({ nodeIds: nodeIdsInput.optional() }).strict(),
      description: "Open reusable photo preparation, or rerun a prepared map.",
      handler: (input, context) => {
        try {
          if ((input.nodeIds?.length ?? 0) > 1) throw new Error("Open preparation for one Float Map In at a time.");
          const next = recipeFor(context.graph, input.nodeIds?.[0]);
          if (found.current === null) throw new Error("Photo preparation is not mounted.");
          if (!context.dryRun) found.current.open(next);
          return { status: context.dryRun ? "validated" : "applied", output: { opened: !context.dryRun }, diagnostics: [] };
        } catch (cause) { return { status: "rejected", output: { opened: false }, diagnostics: [{ severity: "error", code: "photoMapping.prepare.unavailable",
          message: cause instanceof Error ? cause.message : String(cause) }] }; }
      }, rejectionOutput: () => ({ opened: false }),
    });
    return found;
  }, [runtime.bus]);
  useEffect(() => { const surface = { open: (recipe: Recipe) => setSession(previous => previous !== null && JSON.stringify(previous.recipe) === JSON.stringify(recipe)
      ? { ...previous, open: true } : { id: crypto.randomUUID(), recipe, open: true }) }; holder.current = surface;
    return () => { if (holder.current === surface) holder.current = null; }; }, [holder]);
  return session === null ? null : <PhotoMappingEditor key={session.id} runtime={runtime} initial={session.recipe} open={session.open} close={() => {
    sessionStorage.removeItem(reloadRecipeKey(runtime)); setSession(previous => previous === null ? null : { ...previous, open: false });
  }} />;
}
