/**
 * Shell layout persistence (T4, T191, V18, V95).
 *
 * V18: pane sizes AND the pane arrangement live in `localStorage` and NEVER in the
 * project document. Nothing in this module may be imported by `src/domain/project` —
 * layout is per-machine chrome state, not project data, and must not travel with a
 * `.loom.json` file or across collaborators.
 *
 * V95: a pane is not nailed to a slot. Which zone a pane sits in is data — an ordered
 * list per zone plus the active tab — so "move the shader editor out of the bottom dock"
 * is a change to this record and nothing else. `floating` holds the panes that are
 * currently in their own window (V97).
 */

/** The four dock zones (§V95). FLOAT is a state a pane is in, not a zone it sits in. */
export type DockZone = "left" | "center" | "right" | "bottom";

export const DOCK_ZONES: readonly DockZone[] = ["left", "center", "right", "bottom"];

/**
 * Every pane the shell can place. Adding one here and to `PANE_TITLES` +
 * `DEFAULT_SHELL_LAYOUT` is the whole cost of a new pane: the dock is generic over this
 * list, so nothing else has to learn about it.
 */
export type PaneId =
  | "library"
  | "components"
  | "graph"
  | "inspector"
  | "viewer"
  | "shader"
  | "problems"
  | "performance"
  | "examples"
  | "agent";

export const PANE_IDS: readonly PaneId[] = [
  "library",
  "components",
  "graph",
  "inspector",
  "viewer",
  "shader",
  "problems",
  "performance",
  "examples",
  "agent",
];

/** Tab label and accessible name. Lower case, like the rest of the shell's chrome. */
export const PANE_TITLES: Readonly<Record<PaneId, string>> = {
  library: "node library",
  components: "components",
  graph: "graph",
  inspector: "inspector",
  viewer: "viewer",
  shader: "shader editor",
  problems: "problems",
  performance: "performance",
  examples: "examples",
  agent: "agent",
};

/** Where a pane goes when the stored arrangement does not mention it (a new pane). */
/**
 * §V93: the node and component libraries may share a zone — both ADD to the open
 * document. The example library must not sit beside them: OPEN replaces the document,
 * and a destructive verb one tab away from two harmless ones is how a session gets lost.
 * So it starts in the bottom dock, on its own.
 */
export const PANE_HOME: Readonly<Record<PaneId, DockZone>> = {
  library: "left",
  components: "left",
  graph: "center",
  inspector: "right",
  viewer: "right",
  shader: "bottom",
  problems: "bottom",
  performance: "bottom",
  examples: "bottom",
  agent: "bottom",
};

export interface ShellLayout {
  /** Vertical split of the body: [main area, bottom zone]. */
  readonly rows: readonly number[];
  /** Horizontal split of the main area: [left zone, center zone, right zone]. */
  readonly columns: readonly number[];
  /** Which panes each zone holds, in tab order. */
  readonly zones: Readonly<Record<DockZone, readonly PaneId[]>>;
  /** Selected tab per zone. Null only when the zone is empty. */
  readonly active: Readonly<Record<DockZone, PaneId | null>>;
  /** Panes currently in their own window (§V97). Never in a zone at the same time. */
  readonly floating: readonly PaneId[];
}

export const DEFAULT_SHELL_LAYOUT: ShellLayout = {
  rows: [72, 28],
  columns: [17, 57, 26],
  zones: {
    left: ["library", "components"],
    center: ["graph"],
    right: ["inspector", "viewer"],
    bottom: ["shader", "problems", "performance", "examples", "agent"],
  },
  active: { left: "library", center: "graph", right: "inspector", bottom: "shader" },
  floating: [],
};

/** Bumped from v1: v1 stored `rightRows` + a single `dockTab` and knew nothing of zones. */
export const LAYOUT_STORAGE_KEY = "shaderloom.shell.layout.v2";

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What a dock zone needs to render one pane's TAB. The content is not here: it is
 *  rendered once, elsewhere, and reached through an outlet (T193, `pane-portal.tsx`). */
export interface PaneDescriptor {
  readonly id: PaneId;
  readonly title: string;
  /** Count chip on the tab (problems). */
  readonly badge?: number;
}

// ---- arrangement algebra ------------------------------------------------------------
// Pure functions over ShellLayout. The shell holds one of these in a ref and writes it
// back to storage on every change; nothing else may reach into the record's shape.

function withoutPane(
  zones: Record<DockZone, PaneId[]>,
  paneId: PaneId,
): Record<DockZone, PaneId[]> {
  for (const zone of DOCK_ZONES) {
    zones[zone] = zones[zone].filter((id) => id !== paneId);
  }
  return zones;
}

function mutableZones(layout: ShellLayout): Record<DockZone, PaneId[]> {
  return {
    left: [...layout.zones.left],
    center: [...layout.zones.center],
    right: [...layout.zones.right],
    bottom: [...layout.zones.bottom],
  };
}

/** Active tab per zone after a move: keep the current one if it is still there. */
function activeFor(
  zones: Record<DockZone, PaneId[]>,
  previous: ShellLayout["active"],
  overrides: Partial<Record<DockZone, PaneId | null>> = {},
): Record<DockZone, PaneId | null> {
  const next: Record<DockZone, PaneId | null> = { left: null, center: null, right: null, bottom: null };
  for (const zone of DOCK_ZONES) {
    const list = zones[zone];
    const override = overrides[zone];
    if (override !== undefined && override !== null && list.includes(override)) {
      next[zone] = override;
      continue;
    }
    const current = previous[zone];
    next[zone] = current !== null && list.includes(current) ? current : (list[0] ?? null);
  }
  return next;
}

/**
 * Moves `paneId` into `zone` (at `index`, default last), taking it out of wherever it
 * was — including out of a floating window. The moved pane becomes the zone's active tab
 * because a pane you just dragged somewhere is a pane you want to look at.
 */
export function movePane(
  layout: ShellLayout,
  paneId: PaneId,
  zone: DockZone,
  index?: number,
): ShellLayout {
  const zones = withoutPane(mutableZones(layout), paneId);
  const target = zones[zone];
  const at = index === undefined ? target.length : Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, paneId);
  return {
    ...layout,
    zones,
    active: activeFor(zones, layout.active, { [zone]: paneId }),
    floating: layout.floating.filter((id) => id !== paneId),
  };
}

/** Pops a pane out into its own window (§V97). It leaves every zone. */
export function floatPane(layout: ShellLayout, paneId: PaneId): ShellLayout {
  if (layout.floating.includes(paneId)) return layout;
  const zones = withoutPane(mutableZones(layout), paneId);
  return {
    ...layout,
    zones,
    active: activeFor(zones, layout.active),
    floating: [...layout.floating, paneId],
  };
}

/** Puts a floating pane back where it came from, or its home zone. */
export function dockPane(layout: ShellLayout, paneId: PaneId): ShellLayout {
  if (!layout.floating.includes(paneId)) return layout;
  return movePane(layout, paneId, PANE_HOME[paneId]);
}

export function selectPane(layout: ShellLayout, zone: DockZone, paneId: PaneId): ShellLayout {
  if (!layout.zones[zone].includes(paneId)) return layout;
  return { ...layout, active: { ...layout.active, [zone]: paneId } };
}

export function zoneOf(layout: ShellLayout, paneId: PaneId): DockZone | "float" | null {
  for (const zone of DOCK_ZONES) {
    if (layout.zones[zone].includes(paneId)) return zone;
  }
  return layout.floating.includes(paneId) ? "float" : null;
}

// ---- validation ---------------------------------------------------------------------

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

function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && (PANE_IDS as readonly string[]).includes(value);
}

/**
 * Repairs an arrangement rather than rejecting it.
 *
 * A stored arrangement is a user's furniture: dropping the whole thing because this
 * build added a pane the file has never heard of would rearrange the room on every
 * upgrade. So unknown ids are dropped, duplicates keep their first placement, and a pane
 * the record does not mention is appended to its home zone — which is exactly what a
 * NEW pane needs, with no migration step.
 */
function repairArrangement(candidate: unknown): Pick<ShellLayout, "zones" | "active" | "floating"> {
  const source = (typeof candidate === "object" && candidate !== null ? candidate : {}) as {
    zones?: unknown;
    active?: unknown;
    floating?: unknown;
  };
  const storedZones = (
    typeof source.zones === "object" && source.zones !== null ? source.zones : {}
  ) as Partial<Record<DockZone, unknown>>;

  const seen = new Set<PaneId>();
  const zones: Record<DockZone, PaneId[]> = { left: [], center: [], right: [], bottom: [] };
  for (const zone of DOCK_ZONES) {
    const list = storedZones[zone];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isPaneId(entry) || seen.has(entry)) continue;
      seen.add(entry);
      zones[zone].push(entry);
    }
  }

  const floating: PaneId[] = [];
  if (Array.isArray(source.floating)) {
    for (const entry of source.floating) {
      if (!isPaneId(entry) || seen.has(entry)) continue;
      seen.add(entry);
      floating.push(entry);
    }
  }

  for (const paneId of PANE_IDS) {
    if (seen.has(paneId)) continue;
    zones[PANE_HOME[paneId]].push(paneId);
  }

  const storedActive = (
    typeof source.active === "object" && source.active !== null ? source.active : {}
  ) as Partial<Record<DockZone, unknown>>;
  const overrides: Partial<Record<DockZone, PaneId | null>> = {};
  for (const zone of DOCK_ZONES) {
    const entry = storedActive[zone];
    if (isPaneId(entry)) overrides[zone] = entry;
  }

  return {
    zones,
    active: activeFor(zones, DEFAULT_SHELL_LAYOUT.active, overrides),
    floating,
  };
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
    ...repairArrangement(parsed),
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
