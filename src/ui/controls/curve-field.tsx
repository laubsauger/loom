import { useRef } from "react";
import { cx } from "../cx.ts";
import styles from "./controls.module.css";

/**
 * Curve and asset parameters (T37).
 *
 * Both are read-only in v1, deliberately and visibly:
 *  - curve editing belongs with keyframes and expressions, which §C defers (doc §8.2);
 *  - the asset registry and loader nodes are Phase 2 (§C scope, doc §33).
 *
 * They still render, because the inspector is manifest-driven: a definition may declare
 * either type today, and a control set that silently skipped an unknown parameter would
 * hide part of the node from the user.
 */

export interface CurvePoint {
  x: number;
  y: number;
}

export interface CurveFieldProps {
  label: string;
  value: readonly CurvePoint[];
}

/** Normalises the point list into a 0..1 polyline, whatever domain the points use. */
export function curvePolyline(points: readonly CurvePoint[]): string {
  if (points.length === 0) return "";
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return points
    .map((point) => `${(point.x - minX) / spanX},${1 - (point.y - minY) / spanY}`)
    .join(" ");
}

export function CurveField({ label, value }: CurveFieldProps) {
  const points = curvePolyline(value);
  return (
    <div className={styles.curve}>
      <svg
        className={styles.curvePlot}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} curve, ${value.length} point${value.length === 1 ? "" : "s"}`}
      >
        {points === "" ? null : <polyline className={styles.curveLine} points={points} />}
      </svg>
      <span className={styles.meta}>
        {value.length} point{value.length === 1 ? "" : "s"} · read-only in v1
      </span>
    </div>
  );
}

export interface AssetFieldProps {
  label: string;
  value: string | null;
  kind: string;
  /** Absent = read-only display (the pre-T434 stub behaviour). */
  onPick?: (url: string, fileName: string) => void;
}

const ASSET_ACCEPT: Readonly<Record<string, string>> = {
  audio: "audio/*",
  video: "video/*",
  image: "image/*",
};

/** A bound object URL's display name: the picked file's name survives in the fragment. */
function assetDisplayName(value: string): string {
  const hash = value.indexOf("#");
  if (hash >= 0 && hash < value.length - 1) return decodeURIComponent(value.slice(hash + 1));
  return value.length > 42 ? `…${value.slice(-40)}` : value;
}

/**
 * T434: a REAL file picker — `movieFileIn` and `audioFileIn` share it.
 *
 * The picked file becomes an object URL, session-scoped: it plays now and dies with the
 * page, and the meta line SAYS so instead of letting a reloaded project fail mysteriously
 * (§V288). Durable assets are still their own phase; the picker existing does not
 * pretend otherwise. The file's name rides the URL fragment so the field can display
 * something a human recognises.
 */
export function AssetField({ label, value, kind, onPick }: AssetFieldProps) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <div
      className={cx(styles.asset, "nodrag")}
      aria-label={label}
      role="group"
      /*
        The full name AND the session-only caveat live here, because the row cannot show
        both at any width a sidebar actually is. Nothing is lost when the caption is the
        first thing to give way.
      */
      title={
        value === null || value === ""
          ? `No ${kind} bound. A picked file lasts for this session only.`
          : `${assetDisplayName(value)} — this session only`
      }
    >
      <span className={styles.assetName}>
        {value === null || value === "" ? `no ${kind} bound` : assetDisplayName(value)}
      </span>
      {onPick === undefined ? (
        <span className={styles.meta}>· read-only</span>
      ) : (
        <>
          <button
            type="button"
            className={styles.meta}
            onClick={() => input.current?.click()}
          >
            choose…
          </button>
          <span className={cx(styles.meta, styles.assetCaveat)}>· this session only</span>
          <input
            ref={input}
            type="file"
            accept={ASSET_ACCEPT[kind] ?? undefined}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file === undefined) return;
              const url = `${URL.createObjectURL(file)}#${encodeURIComponent(file.name)}`;
              onPick(url, file.name);
              event.currentTarget.value = "";
            }}
          />
        </>
      )}
    </div>
  );
}
