import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { TextureFormat } from "@domain/types/node-definition.ts";
import {
  ALL_CHANNELS,
  DEFAULT_PREVIEW_VIEW,
  PREVIEW_CHANNELS,
  PREVIEW_MODES,
  previewKey,
  resolvePreviewView,
} from "@runtime/previews/index.ts";
import type {
  ChannelMask,
  PixelProbe,
  PreviewChannel,
  PreviewModeKind,
  PreviewOutputRef,
  PreviewView,
} from "@runtime/previews/index.ts";
import { cx } from "@ui/cx.ts";
import { usePixelReadout } from "./use-pixel-readout.ts";
import type { PixelReadoutOptions } from "./use-pixel-readout.ts";
import styles from "./viewer.module.css";

/**
 * The large viewer pane (T36).
 *
 * What this component is NOT: a canvas owner. The shared preview surface belongs to the
 * runtime (§V64, §V70) and composites the viewer's tile behind `.stage`, which is a transparent
 * hole in the DOM. React never encodes a GPU command (§V2); this pane emits a preview request
 * and reads back exactly one pixel on demand, and that is the whole of its contact with the GPU.
 *
 * The viewer's request is always `pinned`: it is the user pointing at an output and saying
 * "show me this", which is precisely §V28's second clause, and it is why scrolling the graph
 * away from a node does not blank the pane.
 */

export interface ViewerOutput {
  readonly ref: PreviewOutputRef;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  /** Human label, e.g. the node's title. Falls back to `nodeId:portId`. */
  readonly label?: string;
}

/** What the composition root needs to schedule the viewer's own preview. */
export interface ViewerPreviewRequest {
  readonly ref: PreviewOutputRef;
  readonly view: PreviewView;
  readonly pinned: true;
}

export interface ViewerPaneProps {
  readonly outputs: ReadonlyArray<ViewerOutput>;
  /**
   * Pixel inspection through the export interface (§V48). Absent until T68 lands, in which
   * case the readout says so rather than showing a plausible zero.
   */
  readonly probe?: PixelProbe;
  readonly onRequestChange?: (request: ViewerPreviewRequest | null) => void;
  readonly defaultSelected?: PreviewOutputRef;
  readonly readoutOptions?: PixelReadoutOptions;
}

const MODE_LABELS: Readonly<Record<PreviewModeKind | "auto", string>> = {
  auto: "auto",
  color: "colour",
  channel: "channel",
  alpha: "alpha / checker",
  exposure: "hdr exposure",
  nan: "nan · inf",
  signed: "signed",
};

const CHANNEL_LABELS: Readonly<Record<PreviewChannel, string>> = {
  r: "R",
  g: "G",
  b: "B",
  a: "A",
};

function outputLabel(output: ViewerOutput): string {
  return output.label ?? previewKey(output.ref);
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return value.toFixed(4);
}

export function ViewerPane({
  outputs,
  probe,
  onRequestChange,
  defaultSelected,
  readoutOptions,
}: ViewerPaneProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(
    defaultSelected === undefined ? null : previewKey(defaultSelected),
  );
  const [mask, setMask] = useState<ChannelMask>(ALL_CHANNELS);
  const [modeSelection, setModeSelection] = useState<PreviewModeKind | "auto">("auto");
  const [exposureStops, setExposureStops] = useState(0);
  const [tonemap, setTonemap] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const stage = useRef<HTMLDivElement | null>(null);

  // Selection follows the available outputs: a pinned output that the graph no longer produces
  // must not leave the pane pointing at a resource that has been freed.
  const selected = useMemo(() => {
    if (selectedKey !== null) {
      const match = outputs.find((output) => previewKey(output.ref) === selectedKey);
      if (match !== undefined) return match;
    }
    return outputs[0];
  }, [outputs, selectedKey]);

  const view = useMemo(
    () =>
      resolvePreviewView(modeSelection, mask, {
        ...DEFAULT_PREVIEW_VIEW,
        exposureStops,
        tonemap,
      }),
    [exposureStops, mask, modeSelection, tonemap],
  );

  const selectedRef = selected?.ref ?? null;

  useEffect(() => {
    if (onRequestChange === undefined) return;
    if (selectedRef === null) onRequestChange(null);
    else onRequestChange({ ref: selectedRef, view, pinned: true });
  }, [onRequestChange, selectedRef, view]);

  const readout = usePixelReadout(probe, selectedRef, readoutOptions ?? {});
  const { probeAt, clear } = readout;

  const probePixel = useCallback(
    (x: number, y: number) => {
      setCursor({ x, y });
      probeAt(x, y);
    },
    [probeAt],
  );

  const pixelFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
      const element = stage.current;
      if (element === null || selected === undefined) return null;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return null;
      const [width, height] = selected.size;
      const nx = (event.clientX - box.left) / box.width;
      const ny = (event.clientY - box.top) / box.height;
      if (nx < 0 || ny < 0 || nx >= 1 || ny >= 1) return null;
      return {
        x: Math.min(width - 1, Math.max(0, Math.floor(nx * width))),
        y: Math.min(height - 1, Math.max(0, Math.floor(ny * height))),
      };
    },
    [selected],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const pixel = pixelFromPointer(event);
      if (pixel === null) return;
      probePixel(pixel.x, pixel.y);
    },
    [pixelFromPointer, probePixel],
  );

  const onPointerLeave = useCallback(() => {
    setCursor(null);
    clear();
  }, [clear]);

  /**
   * §V19 — the readout must be reachable without a pointer. Arrow keys walk a probe cursor
   * over the image (shift = 10 px), which is the same affordance a pointer gets and is the only
   * way a keyboard user can inspect a value at all.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (selected === undefined) return;
      const step = event.shiftKey ? 10 : 1;
      const [width, height] = selected.size;
      const from = cursor ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = -step;
      else if (event.key === "ArrowDown") dy = step;
      else return;
      event.preventDefault();
      probePixel(
        Math.min(width - 1, Math.max(0, from.x + dx)),
        Math.min(height - 1, Math.max(0, from.y + dy)),
      );
    },
    [cursor, probePixel, selected],
  );

  const toggleChannel = useCallback((channel: PreviewChannel) => {
    setMask((previous) => ({ ...previous, [channel]: !previous[channel] }));
  }, []);

  const sample = readout.sample;

  return (
    <div className={styles.viewer} data-testid="viewer-pane">
      <div className={styles.bar}>
        <label className={styles.label} htmlFor="viewer-output">
          output
        </label>
        <select
          id="viewer-output"
          className={cx(styles.select, styles.grow)}
          value={selected === undefined ? "" : previewKey(selected.ref)}
          onChange={(event) => setSelectedKey(event.target.value)}
          disabled={outputs.length === 0}
        >
          {outputs.length === 0 ? <option value="">no outputs</option> : null}
          {outputs.map((output) => (
            <option key={previewKey(output.ref)} value={previewKey(output.ref)}>
              {outputLabel(output)}
            </option>
          ))}
        </select>

        <label className={styles.label} htmlFor="viewer-mode">
          view
        </label>
        <select
          id="viewer-mode"
          className={styles.select}
          value={modeSelection}
          onChange={(event) => setModeSelection(event.target.value as PreviewModeKind | "auto")}
        >
          <option value="auto">{MODE_LABELS.auto}</option>
          {PREVIEW_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.bar}>
        <span className={styles.label} id="viewer-channels-label">
          channels
        </span>
        <div className={styles.toggleGroup} role="group" aria-labelledby="viewer-channels-label">
          {PREVIEW_CHANNELS.map((channel) => (
            <button
              key={channel}
              type="button"
              className={styles.toggle}
              aria-pressed={mask[channel]}
              aria-label={`Channel ${CHANNEL_LABELS[channel]}`}
              onClick={() => toggleChannel(channel)}
            >
              {CHANNEL_LABELS[channel]}
            </button>
          ))}
        </div>

        <label className={styles.label} htmlFor="viewer-exposure">
          exposure
        </label>
        <input
          id="viewer-exposure"
          className={styles.slider}
          type="range"
          min={-8}
          max={8}
          step={0.25}
          value={exposureStops}
          onChange={(event) => setExposureStops(Number(event.target.value))}
        />
        <span className={styles.label}>{exposureStops.toFixed(2)} EV</span>

        <button
          type="button"
          className={styles.toggle}
          aria-pressed={tonemap}
          onClick={() => setTonemap((previous) => !previous)}
        >
          tonemap
        </button>
      </div>

      <div
        ref={stage}
        className={styles.stage}
        data-testid="viewer-stage"
        role="img"
        tabIndex={0}
        aria-label={
          selected === undefined
            ? "No output to preview"
            : `Preview of ${outputLabel(selected)}, ${selected.size[0]} by ${selected.size[1]}`
        }
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        {selected === undefined ? <p className={styles.stageEmpty}>No output</p> : null}
      </div>

      <dl className={styles.readout} data-testid="viewer-readout">
        <dt className={styles.readoutKey}>size</dt>
        <dd className={styles.readoutValue}>
          {selected === undefined
            ? "—"
            : `${selected.size[0]} × ${selected.size[1]} · ${selected.format}`}
        </dd>
        <dt className={styles.readoutKey}>pixel</dt>
        <dd className={styles.readoutValue}>
          {cursor === null ? "—" : `${cursor.x}, ${cursor.y}`}
        </dd>
        <dt className={styles.readoutKey} title="Linear working space">
          value
        </dt>
        <dd className={styles.readoutValue} data-testid="viewer-value">
          {probe === undefined
            ? "pixel inspection unavailable"
            : readout.error !== null
              ? readout.error
              : sample === null
                ? "—"
                : sample.rgba.map(formatValue).join("  ")}
        </dd>
      </dl>
    </div>
  );
}
