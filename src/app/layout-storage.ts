/**
 * Shell layout persistence (T4, V18).
 *
 * V18: pane sizes live in `localStorage` and NEVER in the project document.
 * Nothing in this module may be imported by `src/domain/project` — layout is
 * per-machine chrome state, not project data, and must not travel with a
 * `.loom.json` file or across collaborators.
 */

export type DockTab = "shader" | "problems" | "performance";

export const DOCK_TABS: readonly DockTab[] = ["shader", "problems", "performance"];

export interface ShellLayout {
  /** Vertical split of the body: [main area, bottom dock]. */
  readonly rows: readonly number[];
  /** Horizontal split of the main area: [node library, graph canvas, right column]. */
  readonly columns: readonly number[];
  /** Vertical split of the right column: [inspector, viewer]. */
  readonly rightRows: readonly number[];
  /** Selected bottom-dock tab. */
  readonly dockTab: DockTab;
}

export const DEFAULT_SHELL_LAYOUT: ShellLayout = {
  rows: [72, 28],
  columns: [17, 57, 26],
  rightRows: [46, 54],
  dockTab: "shader",
};

export const LAYOUT_STORAGE_KEY = "shaderloom.shell.layout.v1";

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Percentages must be positive, finite and add up to a full group. */
function isValidGroup(value: unknown, length: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  let total = 0;
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) return false;
    total += entry;
  }
  return Math.abs(total - 100) < 0.5;
}

function isDockTab(value: unknown): value is DockTab {
  return typeof value === "string" && (DOCK_TABS as readonly string[]).includes(value);
}

/** Reads the ambient store, tolerating environments where it is missing or blocked. */
export function defaultLayoutStorage(): LayoutStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Safari private mode and hardened embedders throw on access.
    return null;
  }
}

/**
 * Never throws and never returns a partially-valid layout: any group that fails
 * validation falls back to its default, so a corrupted entry degrades to the
 * stock layout instead of an unusable shell.
 */
export function readLayout(storage: LayoutStorage | null = defaultLayoutStorage()): ShellLayout {
  if (!storage) return DEFAULT_SHELL_LAYOUT;

  let raw: string | null;
  try {
    raw = storage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    return DEFAULT_SHELL_LAYOUT;
  }
  if (raw === null) return DEFAULT_SHELL_LAYOUT;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SHELL_LAYOUT;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_SHELL_LAYOUT;

  const candidate = parsed as Partial<Record<keyof ShellLayout, unknown>>;
  return {
    rows: isValidGroup(candidate.rows, 2) ? candidate.rows : DEFAULT_SHELL_LAYOUT.rows,
    columns: isValidGroup(candidate.columns, 3) ? candidate.columns : DEFAULT_SHELL_LAYOUT.columns,
    rightRows: isValidGroup(candidate.rightRows, 2)
      ? candidate.rightRows
      : DEFAULT_SHELL_LAYOUT.rightRows,
    dockTab: isDockTab(candidate.dockTab) ? candidate.dockTab : DEFAULT_SHELL_LAYOUT.dockTab,
  };
}

export function writeLayout(
  layout: ShellLayout,
  storage: LayoutStorage | null = defaultLayoutStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Quota or a blocked store: layout persistence is a convenience, never a
    // reason to break the session.
  }
}

export function clearLayout(storage: LayoutStorage | null = defaultLayoutStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    /* see writeLayout */
  }
}
