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
}

export function AssetField({ label, value, kind }: AssetFieldProps) {
  return (
    <div className={cx(styles.asset, "nodrag")} aria-label={label} role="group">
      <span>{value ?? `no ${kind} bound`}</span>
      <span className={styles.meta}>· assets land in Phase 2</span>
    </div>
  );
}
