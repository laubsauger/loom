import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Button } from "@ui/primitives/button.tsx";
import { cx } from "@ui/cx.ts";
import type { FloatMap } from "@runtime/media/float-map.ts";
import { farIsHigh, letterboxOccupancy, preparedMetadata, rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import { remapDepthValues, type DepthRangeSettings } from "@runtime/media/depth-tools.ts";
import type { PreparationPhoto } from "./photo-preparation.ts";
import { DEPTH_PALETTES, depthPaletteLut, type DepthPalette } from "./photo-depth-palette.ts";
import styles from "./photo-depth-workspace.module.css";

type View = "photo" | "native" | "depth" | "mask" | "effect";
interface Maps { native: FloatMap | null; depth: FloatMap | null; mask: FloatMap | null }
interface Point { x: number; y: number }
export interface MaskEditing {
  readonly enabled: boolean;
  readonly mode: "erase" | "restore" | "pan";
  readonly radius: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly busy: boolean;
  readonly onMode: (mode: MaskEditing["mode"]) => void;
  readonly onRadius: (radius: number) => void;
  readonly onPaint: (point: Point, first: boolean) => void;
  readonly onFinish: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}
interface Raster { width: number; height: number; primary: Float32Array | null; secondary: Float32Array | null; capped: boolean }
const VIEWS: readonly { view: View; label: string }[] = [
  { view: "photo", label: "Photo" }, { view: "native", label: "Native depth" },
  { view: "depth", label: "Refined depth" }, { view: "mask", label: "Surface mask" },
  { view: "effect", label: "Projection effect" },
];

/** A registered display raster; the source maps and their float32 samples stay untouched. */
function displayRaster(photo: PreparationPhoto, maps: Maps, view: View, compare: boolean, depthRange?: DepthRangeSettings): Raster {
  const sourceWidth = photo.bitmap.width;
  const sourceHeight = photo.bitmap.height;
  if (view === "photo" || view === "mask" || view === "effect") {
    if (view === "mask" && maps.mask !== null) {
      const metadata = preparedMetadata(maps.mask);
      if (metadata.source.sha256 !== photo.sha256 || metadata.source.width !== sourceWidth || metadata.source.height !== sourceHeight) {
        throw new Error("This surface mask belongs to a different reference photo.");
      }
    }
    const longEdge = view === "mask" && maps.mask !== null ? Math.min(4096, Math.max(maps.mask.width, maps.mask.height)) : 4096;
    const scale = Math.min(1, longEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    return { width, height, primary: view === "mask" && maps.mask !== null ? rasterizeFloatMap(maps.mask, "mask", width, height) : null,
      secondary: null, capped: scale < 1 };
  }
  const map = view === "native" ? maps.native : maps.depth;
  if (map === null) throw new Error("Run the selected depth stage to inspect its map.");
  for (const shownMap of compare ? [maps.native!, maps.depth!] : [map]) {
    const metadata = preparedMetadata(shownMap);
    if (metadata.source.sha256 !== photo.sha256 || metadata.source.width !== sourceWidth || metadata.source.height !== sourceHeight) {
      throw new Error("This depth map belongs to a different reference photo.");
    }
  }
  // Compare both predictions in the refined map's full-frame coordinates.
  const sizing = compare && maps.depth !== null ? maps.depth : map;
  const [occX, occY] = letterboxOccupancy(sizing, preparedMetadata(sizing));
  const width = Math.max(1, Math.round(sizing.width * occX));
  const height = Math.max(1, Math.round(sizing.height * occY));
  const workingDepth = (shown: FloatMap) => depthRange === undefined ? rasterizeFloatMap(shown, "depth", width, height)
    : remapDepthValues(shown, width, height, depthRange);
  return { width, height, primary: workingDepth(compare ? maps.native! : map),
    secondary: compare ? workingDepth(maps.depth!) : null, capped: false };
}

function sampleMap(map: FloatMap, point: Point) {
  const metadata = preparedMetadata(map);
  const [occX, occY] = letterboxOccupancy(map, metadata);
  const minX = Math.max(0, Math.ceil((1 - occX) * map.width / 2 - 0.5));
  const minY = Math.max(0, Math.ceil((1 - occY) * map.height / 2 - 0.5));
  const maxX = Math.min(map.width - 1, Math.floor((1 + occX) * map.width / 2 - 0.5));
  const maxY = Math.min(map.height - 1, Math.floor((1 + occY) * map.height / 2 - 0.5));
  const x = Math.max(minX, Math.min(maxX, Math.round(((point.x - 0.5) * occX + 0.5) * map.width - 0.5)));
  const y = Math.max(minY, Math.min(maxY, Math.round(((point.y - 0.5) * occY + 0.5) * map.height - 0.5)));
  const raw = map.values[y * map.width + x]!;
  let near = metadata.range.high === metadata.range.low ? 0.5 : (raw - metadata.range.low) / (metadata.range.high - metadata.range.low);
  if (metadata.version === 2 && farIsHigh(metadata.semantics)) near = 1 - near;
  return { x, y, raw, near };
}

export interface PhotoDepthWorkspaceProps {
  readonly photo: PreparationPhoto | null;
  readonly readMaps: () => Maps;
  readonly active?: View;
  readonly onSelect?: (view: View) => void;
  readonly palette?: DepthPalette;
  readonly onPaletteChange?: (palette: DepthPalette) => void;
  readonly maskEditing?: MaskEditing;
  readonly effectPreview?: ReactNode;
  readonly depthRange?: DepthRangeSettings;
}

/** Inspect preparation assets independently of live rendering or model inference. */
export function PhotoDepthWorkspace({ photo, readMaps, active, onSelect, palette, onPaletteChange, maskEditing, effectPreview, depthRange }: PhotoDepthWorkspaceProps) {
  const maps = readMaps();
  const [localPalette, setLocalPalette] = useState<DepthPalette>("grayscale");
  const selectedPalette = palette ?? localPalette;
  const paletteTable = useMemo(() => depthPaletteLut(selectedPalette), [selectedPalette]);
  const colourGradient = useMemo(() => {
    const scheme = DEPTH_PALETTES.find(item => item.id === selectedPalette)!;
    const stops = scheme.stops.map((_, index) => {
      const fraction = index / (scheme.stops.length - 1);
      const offset = Math.round(fraction * 255) * 3;
      return `rgb(${paletteTable[offset]}, ${paletteTable[offset + 1]}, ${paletteTable[offset + 2]}) ${fraction * 100}%`;
    });
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }, [selectedPalette, paletteTable]);
  const [localView, setLocalView] = useState<View>("photo");
  const view = active ?? localView;
  const depthColours = view === "native" || view === "depth" ? paletteTable : null;
  const [compare, setCompare] = useState(false);
  const [wipe, setWipe] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [hover, setHover] = useState<Point | null>(null);
  const [pinned, setPinned] = useState<Point | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<{ id: number; start: Point; pan: Point; moved: boolean } | null>(null);
  const stroke = useRef<{ id: number; finish: () => void } | null>(null);
  const finishStroke = useCallback((id?: number) => {
    const current = stroke.current;
    if (current === null || (id !== undefined && current.id !== id)) return;
    stroke.current = null; current.finish();
  }, []);
  const hintId = useId();
  const canCompare = maps.native !== null && maps.depth !== null && (view === "native" || view === "depth");
  const comparing = compare && canCompare;
  const available = photo !== null && (view === "effect" ? effectPreview !== undefined : view === "photo" || maps[view] !== null);
  const raster = useMemo(() => {
    if (photo === null || !available) return { data: null, error: null };
    try { return { data: displayRaster(photo, { native: maps.native, depth: maps.depth, mask: maps.mask }, view, comparing, depthRange), error: null }; }
    catch (error) { return { data: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [photo, available, maps.native, maps.depth, maps.mask, view, comparing, depthRange]);

  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(1); setPan({ x: 0, y: 0 }); setHover(null); setPinned(null);
    gesture.current = null;
    return () => finishStroke();
  }, [photo, view, finishStroke]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null || photo === null || raster.data === null) { setCanvasError(null); return; }
    const { width, height, primary, secondary } = raster.data;
    element.width = width; element.height = height;
    const context = element.getContext("2d");
    if (context === null) { setCanvasError("Map inspection requires a 2D canvas, which is unavailable here."); return; }
    setCanvasError(null);
    if (view === "photo" || view === "mask") context.drawImage(photo.bitmap, 0, 0, width, height);
    if (primary === null) return;
    const pixels = view === "mask" ? context.getImageData(0, 0, width, height) : context.createImageData(width, height);
    for (let i = 0; i < primary.length; i++) {
      const offset = i * 4;
      if (view === "mask") {
        const exclusion = (1 - primary[i]!) * 0.65;
        pixels.data[offset] = pixels.data[offset]! * (1 - exclusion) + 255 * exclusion;
        pixels.data[offset + 1] = pixels.data[offset + 1]! * (1 - exclusion);
        pixels.data[offset + 2] = pixels.data[offset + 2]! * (1 - exclusion);
      } else {
        const value = secondary !== null && i % width >= width * wipe / 100 ? secondary[i]! : primary[i]!;
        const brightness = Math.round(Math.max(0, Math.min(1, value)) * 255);
        const colour = brightness * 3;
        pixels.data[offset] = depthColours![colour]!;
        pixels.data[offset + 1] = depthColours![colour + 1]!;
        pixels.data[offset + 2] = depthColours![colour + 2]!;
      }
      pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [photo, raster, view, wipe, depthColours]);

  const dimensions = raster.data;
  const fit = dimensions !== null && size.width > 0 && size.height > 0
    ? Math.min((size.width - 24) / dimensions.width, (size.height - 24) / dimensions.height) : 1;
  const scale = Math.max(0.001, fit) * zoom;
  const pointAt = (event: PointerEvent<HTMLDivElement>): Point | null => {
    const rect = canvas.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return null;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return x >= 0 && y >= 0 && x < 1 && y < 1 ? { x, y } : null;
  };
  const inspect = pinned ?? hover;
  const sampledMap = view === "photo" || view === "effect" ? null : comparing && inspect !== null
    ? inspect.x < wipe / 100 ? maps.native : maps.depth : maps[view];
  const sample = inspect !== null && sampledMap !== null && raster.data !== null ? sampleMap(sampledMap, inspect) : null;
  const workingNear = sample === null || view === "mask" || depthRange === undefined ? null
    : Math.max(0, Math.min(1, (sample.near - depthRange.low) / (depthRange.high - depthRange.low)));
  const changeZoom = (next: number) => { setZoom(Math.max(0.1, Math.min(32, next))); setPan({ x: 0, y: 0 }); };
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const selectedLabel = VIEWS.find(item => item.view === view)!.label;
  const error = raster.error ?? canvasError;
  const editing = view === "mask" && maskEditing !== undefined;
  const canEdit = editing && maskEditing.enabled && !maskEditing.busy && available && error === null;
  const brushActive = canEdit && maskEditing.mode !== "pan";
  useEffect(() => { if (!brushActive) finishStroke(); }, [brushActive, finishStroke]);
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const wheel = (event: WheelEvent) => {
      if (!available) return;
      event.preventDefault(); finishStroke();
      const next = Math.max(0.1, Math.min(32, zoom * Math.exp(-event.deltaY * 0.0015)));
      const factor = next / zoom;
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      setPan(previous => ({ x: x + (previous.x - x) * factor, y: y + (previous.y - y) * factor }));
      setZoom(next); gesture.current = null;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [available, zoom, finishStroke]);
  const icon = (path: string) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={path} /></svg>;

  return <section className={styles.workspace} aria-label="Photo and depth inspection">
    <div className={styles.toolbar}>
      <div className={styles.modes} role="group" aria-label="Inspection view">
        {VIEWS.map(item => <Button key={item.view} aria-pressed={view === item.view}
          disabled={photo === null || (item.view === "effect" ? effectPreview === undefined : item.view !== "photo" && maps[item.view] === null)}
          onClick={() => { setLocalView(item.view); onSelect?.(item.view); }}>{item.label}</Button>)}
      </div>
      <div className={styles.zoom} role="group" aria-label="Viewport zoom">
        <Button disabled={!available} aria-label="Fit image" onClick={reset}>Fit</Button>
        <Button disabled={!available} aria-label={dimensions?.capped ? "100% working preview pixels" : "100% map pixels"}
          onClick={() => changeZoom(1 / Math.max(0.001, fit))}>100%</Button>
        <Button disabled={!available || zoom <= 0.1} aria-label="Zoom out" onClick={() => changeZoom(zoom / 1.5)}>−</Button>
        <Button disabled={!available || zoom >= 32} aria-label="Zoom in" onClick={() => changeZoom(zoom * 1.5)}>+</Button>
        <output aria-label="Preview scale">{Math.round(scale * 100)}%</output>
      </div>
    </div>
    {view !== "effect" ? <div className={styles.paletteBar}>
      <label>Depth colours <select aria-label="Depth colours" value={selectedPalette} onChange={event => {
        const choice = DEPTH_PALETTES.find(item => item.id === event.target.value);
        if (choice === undefined) throw new Error(`Unknown depth palette: ${event.target.value}`);
        setLocalPalette(choice.id); onPaletteChange?.(choice.id);
      }}>{DEPTH_PALETTES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <div className={styles.colourLegend} role="img" aria-label="Relative depth colours from far to near">
        <span>Far</span><span aria-hidden="true" style={{ backgroundImage: colourGradient }} /><span>Near</span>
      </div>
    </div> : null}
    {editing ? <div className={styles.brushTools} role="group" aria-label="Mask painting tools">
      <Button variant="outline" aria-label="Erase mask" aria-pressed={maskEditing.mode === "erase"} disabled={!canEdit}
        onClick={() => { finishStroke(); maskEditing.onMode("erase"); }}>{icon("M4 15 14 5l6 6-8 8H8zm5-5 6 6M12 19h9")}Erase</Button>
      <Button variant="outline" aria-label="Restore mask" aria-pressed={maskEditing.mode === "restore"} disabled={!canEdit}
        onClick={() => { finishStroke(); maskEditing.onMode("restore"); }}>{icon("m9 14 9-10 3 3-10 9M9 14c-4-1-5 2-5 5 4 0 7-1 7-4")}Restore</Button>
      <Button variant="outline" aria-label="Pan mask" aria-pressed={maskEditing.mode === "pan"} disabled={!canEdit}
        onClick={() => { finishStroke(); maskEditing.onMode("pan"); }}>{icon("M8 13V6a2 2 0 0 1 4 0v6m0-5a2 2 0 0 1 4 0v6m0-4a2 2 0 0 1 4 0v7c0 4-3 6-6 6-2 0-4-1-5-3l-5-6a2 2 0 0 1 3-2l3 3")}Pan</Button>
      <label>Brush radius <input aria-label="Mask brush radius" type="range" min={1} max={100} step={1}
        value={maskEditing.radius} disabled={!canEdit} onChange={event => maskEditing.onRadius(Number(event.target.value))} />
        <output>{maskEditing.radius} px</output></label>
      <Button variant="outline" aria-label="Undo mask stroke" disabled={!canEdit || !maskEditing.canUndo}
        onClick={() => { finishStroke(); maskEditing.onUndo(); }}>{icon("m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12")}Undo</Button>
      <Button variant="outline" aria-label="Redo mask stroke" disabled={!canEdit || !maskEditing.canRedo}
        onClick={() => { finishStroke(); maskEditing.onRedo(); }}>{icon("m15 5 5 5-5 5M20 10H10a6 6 0 0 0 0 12")}Redo</Button>
    </div> : null}
    <div className={cx(styles.stage, brushActive && styles.painting)} data-inspection-viewport ref={stage} tabIndex={available ? 0 : -1} role="group" aria-label={`${selectedLabel} viewport`}
      aria-describedby={hintId}
      onKeyDown={event => {
        if (editing && (event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
          if (canEdit) {
            event.preventDefault(); finishStroke();
            const redo = event.key.toLowerCase() === "y" || event.shiftKey;
            if (redo ? maskEditing.canRedo : maskEditing.canUndo) (redo ? maskEditing.onRedo : maskEditing.onUndo)();
          }
          return;
        }
        const delta: Record<string, Point> = { ArrowLeft: { x: 32, y: 0 }, ArrowRight: { x: -32, y: 0 }, ArrowUp: { x: 0, y: 32 }, ArrowDown: { x: 0, y: -32 } };
        const movement = delta[event.key];
        if (movement !== undefined && available) { event.preventDefault(); setPan(previous => ({ x: previous.x + movement.x, y: previous.y + movement.y })); }
        if (event.key === "Escape") { setPinned(null); setHover(null); }
      }}
      onPointerDown={event => {
        if (!available || event.button !== 0) return;
        if (editing && !canEdit) return;
        if (stroke.current !== null) return;
        event.currentTarget.focus();
        if (brushActive) {
          const point = pointAt(event);
          if (point === null) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          setPinned(null); setHover(point);
          stroke.current = { id: event.pointerId, finish: maskEditing.onFinish };
          maskEditing.onPaint(point, true);
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, pan, moved: false };
      }}
      onPointerMove={event => {
        if (stroke.current !== null) {
          if (stroke.current.id !== event.pointerId) return;
          const point = pointAt(event); setHover(point);
          if (brushActive && point !== null) maskEditing.onPaint(point, false);
          return;
        }
        const drag = gesture.current;
        if (drag !== null && drag.id === event.pointerId) {
          const dx = event.clientX - drag.start.x;
          const dy = event.clientY - drag.start.y;
          if (Math.hypot(dx, dy) > 4) drag.moved = true;
          if (drag.moved) setPan({ x: drag.pan.x + dx, y: drag.pan.y + dy });
        } else setHover(pointAt(event));
      }}
      onPointerUp={event => {
        if (stroke.current !== null) {
          if (stroke.current.id !== event.pointerId) return;
          finishStroke(event.pointerId);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          return;
        }
        const drag = gesture.current;
        if (drag === null || drag.id !== event.pointerId) return;
        if (!drag.moved && view !== "effect") setPinned(pointAt(event));
        gesture.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={event => { gesture.current = null; finishStroke(event.pointerId); }}
      onLostPointerCapture={event => { gesture.current = null; finishStroke(event.pointerId); }}
      onPointerLeave={() => setHover(null)}>
      {view === "effect" && available && dimensions !== null ? <div className={cx(styles.imageFrame, styles.effectFrame)}
        style={{ width: dimensions.width * scale, height: dimensions.height * scale,
          transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))` }}>{effectPreview}</div>
        : available && dimensions !== null ? <div className={styles.imageFrame} style={{ width: dimensions.width * scale, height: dimensions.height * scale,
        transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))` }}>
        <canvas ref={canvas} className={styles.canvas} role="img" aria-label={view === "mask" && maskEditing?.enabled ? "Surface mask editor" : `${selectedLabel} display; numerical samples are shown below`} />
        {comparing ? <><span className={styles.compareLeft}>Native · resampled</span><span className={styles.compareRight}>Refined</span>
          <span className={styles.wipe} style={{ left: `${wipe}%` }} /></> : null}
        {pinned !== null ? <span className={styles.pin} style={{ left: `${pinned.x * 100}%`, top: `${pinned.y * 100}%` }} /> : null}
        {brushActive && hover !== null && maps.mask !== null ? <span className={styles.brushCursor} aria-hidden="true" aria-label="Mask brush footprint"
          style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%`, width: `${2 * maskEditing.radius / maps.mask.width * 100}%`,
            height: `${2 * maskEditing.radius / maps.mask.height * 100}%` }} /> : null}
      </div> : <p className={styles.empty}>{photo === null ? "Choose a reference photo to inspect its surfaces." : error ?? `Prepare ${selectedLabel.toLowerCase()} to inspect this stage.`}</p>}
      {error !== null ? <p role="alert" className={styles.error}>{error}</p> : null}
    </div>
    <div className={styles.details}>
      <span>{dimensions !== null ? `${dimensions.width} × ${dimensions.height} display` : selectedLabel}
        {dimensions?.capped ? " · preview capped at 4096 px" : ""}
        {sampledMap !== null ? ` · ${sampledMap.width} × ${sampledMap.height} source map` : ""}</span>
      {canCompare ? <label className={styles.compareToggle}><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} />Compare depth stages</label> : null}
    </div>
    {comparing ? <label className={styles.compareControl}>Native / refined split
      <input type="range" min={0} max={100} value={wipe} aria-label="Native and refined comparison split" onChange={event => setWipe(Number(event.target.value))} />
      <output>{wipe}%</output></label> : null}
    {view !== "effect" ? <div className={styles.sampleBar}>
      <output aria-label="Pixel sample">{inspect === null || photo === null ? "Hover for a sample · click to pin" : <>
        Photo ({Math.min(photo.bitmap.width - 1, Math.floor(inspect.x * photo.bitmap.width))}, {Math.min(photo.bitmap.height - 1, Math.floor(inspect.y * photo.bitmap.height))})
        {sample !== null ? <> · Map ({sample.x}, {sample.y}) · Raw {sample.raw.toPrecision(6)} · {view === "mask" ? "Keep" : "Near level"} {(sample.near * 100).toFixed(1)}%
          {workingNear === null ? null : <> · Preview near {(workingNear * 100).toFixed(1)}%</>}</> : null}
      </>}</output>
      <Button disabled={pinned === null} onClick={() => setPinned(null)}>Clear sample</Button>
    </div> : null}
    <p id={hintId} className={styles.hint}>{view === "effect" ? "Drag to pan; use the wheel, zoom buttons or arrow keys. Projection effect uses the selected prepared depth and surface coverage. Preview light changes the comparison only."
      : <>{editing ? "Erase excludes projection; Restore keeps the surface. Drag to brush, or choose Pan. Ctrl/Cmd Z undoes; Shift Z or Y redoes. " : "Drag to pan; use the wheel, zoom buttons or arrow keys. "}Depth is relative; follow the Far to Near colour legend. {depthRange === undefined ? "Colours change the preview only. " : "Depth colours show the selected working range; native samples are unchanged. "}Red marks mask exclusions.</>}</p>
  </section>;
}
