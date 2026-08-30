/**
 * The analytic-topology vocabulary (T302, consumed by T301).
 *
 * Topology travels on the pointset EDGE as a string (T296) because it is a CLAIM the
 * producer makes about index structure, not data: `points` (no connectivity), or
 * `grid:{cols}x{rows}` with optional wrap flags — `:wrapU` closes the column seam
 * (tube), `:wrapUV` closes both (torus). ONE parser and ONE formatter so the grammar
 * cannot fork: producers format, consumers parse, and a string neither understands is
 * an explicit `null` rather than a guessed shape.
 */

export interface GridTopology {
  readonly kind: "grid";
  readonly cols: number;
  readonly rows: number;
  /** Column seam closed: cell (cols-1, y) connects back to column 0 — a tube. */
  readonly wrapU: boolean;
  /** Row seam closed too: with wrapU, a torus. */
  readonly wrapV: boolean;
}

export interface PointsTopology {
  readonly kind: "points";
}

export type PointTopology = GridTopology | PointsTopology;

const GRID = /^grid:(\d+)x(\d+)(?::(wrapU|wrapV|wrapUV))?$/;

export function parseTopology(value: string | undefined): PointTopology | null {
  if (value === undefined || value === "points") return { kind: "points" };
  const match = GRID.exec(value);
  if (match === null) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  const wrap = match[3];
  return {
    kind: "grid",
    cols,
    rows,
    wrapU: wrap === "wrapU" || wrap === "wrapUV",
    wrapV: wrap === "wrapV" || wrap === "wrapUV",
  };
}

export function formatTopology(topology: PointTopology): string {
  if (topology.kind === "points") return "points";
  const wrap = topology.wrapU && topology.wrapV ? ":wrapUV" : topology.wrapU ? ":wrapU" : topology.wrapV ? ":wrapV" : "";
  return `grid:${topology.cols}x${topology.rows}${wrap}`;
}

/** Points a grid topology addresses — what a consumer checks against edge capacity. */
export function gridPointCount(topology: GridTopology): number {
  return topology.cols * topology.rows;
}

/** Cells along each axis: a wrapped axis has as many cells as points (the seam cell). */
export function gridCellCounts(topology: GridTopology): { cellsU: number; cellsV: number } {
  return {
    cellsU: topology.wrapU ? topology.cols : topology.cols - 1,
    cellsV: topology.wrapV ? topology.rows : topology.rows - 1,
  };
}
