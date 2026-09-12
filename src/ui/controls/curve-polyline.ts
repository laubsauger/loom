/**
 * The curve parameter's plot geometry (T37), split out of `curve-field.tsx` by T1315b
 * so that file exports only components and Fast Refresh can swap them.
 */

export interface CurvePoint {
  x: number;
  y: number;
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
