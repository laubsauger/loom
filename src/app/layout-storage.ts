/**
 * Shell layout persistence (T4, T191, T426, T436, V18, V95, V311).
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
 *
 * T436: the store holds a NAMED SET of layouts plus the live one, not a single record.
 */

/**
 * The dock zones (§V95). FLOAT is a state a pane is in, not a zone it sits in.
 *
 * T426: the right sidebar runs the FULL height of the window and is split in two, so it
 * is two zones — `right` on top, `rightBottom` under it. The bottom dock spans the left
 * and centre columns only, which is what "not limited by the bottom bar" means.
 */
export type DockZone = "left" | "center" | "right" | "rightBottom" | "bottom";

export const DOCK_ZONES: readonly DockZone[] = ["left", "center", "right", "rightBottom", "bottom"];

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
  inspector: "rightBottom",
  viewer: "right",
  shader: "bottom",
  problems: "bottom",
  performance: "bottom",
  examples: "bottom",
  agent: "bottom",
};

export interface ShellLayout {
  /**
   * Horizontal split of the WINDOW: [work area, right sidebar]. The sidebar is a
   * top-level column, which is what makes it full height (T426).
   */
  readonly columns: readonly number[];
  /** Horizontal split of the work area: [left zone, centre zone]. */
  readonly mainColumns: readonly number[];
  /** Vertical split of the work area: [centre, bottom zone]. */
  readonly rows: readonly number[];
  /** Vertical split of the right sidebar: [top zone, bottom zone]. */
  readonly rightRows: readonly number[];
  /** Which panes each zone holds, in tab order. */
  readonly zones: Readonly<Record<DockZone, readonly PaneId[]>>;
  /** Selected tab per zone. Null only when the zone is empty. */
  readonly active: Readonly<Record<DockZone, PaneId | null>>;
  /** Panes currently in their own window (§V97). Never in a zone at the same time. */
  readonly floating: readonly PaneId[];
}

/**
 * T426 — the default arrangement.
 *
 * The right sidebar is a full-height column split horizontally: the viewer on top, the
 * inspector under it. Before this, both were TABS in a right dock that stopped where the
 * bottom dock began, so the parameters got a third of a column and you could not see the
 * output and the parameters that drive it at the same time.
 */
export const DEFAULT_SHELL_LAYOUT: ShellLayout = {
  columns: [74, 26],
  mainColumns: [23, 77],
  rows: [72, 28],
  rightRows: [50, 50],
  zones: {
    left: ["library", "components"],
    center: ["graph"],
    right: ["viewer"],
    rightBottom: ["inspector"],
    bottom: ["shader", "problems", "performance", "examples", "agent"],
  },
  active: {
    left: "library",
    center: "graph",
    right: "viewer",
    rightBottom: "inspector",
    bottom: "shader",
  },
  floating: [],
};

/**
 * The arrangement the app shipped with before T426: inspector and viewer as TABS in one
 * right dock. Kept as a preset rather than deleted, because it is what everyone who used
 * the app before today is looking at, and "put it back" has to be one click.
 */
export const CLASSIC_SHELL_LAYOUT: ShellLayout = {
  columns: [74, 26],
  mainColumns: [23, 77],
  rows: [72, 28],
  rightRows: [100, 0],
  zones: {
    left: ["library", "components"],
    center: ["graph"],
    right: ["inspector", "viewer"],
    rightBottom: [],
    bottom: ["shader", "problems", "performance", "examples", "agent"],
  },
  active: {
    left: "library",
    center: "graph",
    right: "inspector",
    rightBottom: null,
    bottom: "shader",
  },
  floating: [],
};

// ---- named layouts (T436) -----------------------------------------------------------

export interface NamedLayout {
  readonly id: string;
  readonly name: string;
  readonly layout: ShellLayout;
}

export const DEFAULT_LAYOUT_ID = "preset:default";
export const CLASSIC_LAYOUT_ID = "preset:classic";

/**
 * Built-in layouts, shipped in CODE and not in the store.
 *
 * A preset therefore cannot be deleted — there is no row to remove — which is the answer
 * to "deleting a built-in must be impossible or restorable". Making it deletable would
 * mean persisting a tombstone list purely so the delete could be undone, i.e. more state
 * in the store for a capability nobody asked for, and a user who deletes "Default" loses
 * the one arrangement the app can always get back to.
 */
export const LAYOUT_PRESETS: readonly NamedLayout[] = [
  { id: DEFAULT_LAYOUT_ID, name: "Default", layout: DEFAULT_SHELL_LAYOUT },
  { id: CLASSIC_LAYOUT_ID, name: "Classic", layout: CLASSIC_SHELL_LAYOUT },
];

export function isPresetLayoutId(id: string): boolean {
  return id.startsWith("preset:");
}

/**
 * What the store holds: the LIVE arrangement, the named set, and which named layout the
 * live one came from.
 *
 * `current` is written on every drag of a divider and every pane move. A named layout is
 * written only when the user asks — that separation is the whole reason UPDATE can differ
 * from SAVE-AS, and why restoring a preset and then nudging a divider does not silently
 * rewrite the preset.
 */
export interface LayoutStore {
  readonly current: ShellLayout;
  /** Which named layout `current` was restored from. Null once it is not from one. */
  readonly currentId: string | null;
  /** USER layouts only. Presets are code (`LAYOUT_PRESETS`), never rows here. */
  readonly layouts: readonly NamedLayout[];
}

export const DEFAULT_LAYOUT_STORE: LayoutStore = {
  current: DEFAULT_SHELL_LAYOUT,
  currentId: DEFAULT_LAYOUT_ID,
  layouts: [],
};

/** Bumped from v2: v2 stored ONE layout, and its right dock was a single zone. */
export const LAYOUT_STORAGE_KEY = "shaderloom.shell.layouts.v3";

/** v2's key. Read once, migrated, and removed — see `migrateLegacyLayout`. */
export const LEGACY_LAYOUT_STORAGE_KEY = "shaderloom.shell.layout.v2";

export const LAYOUT_STORE_VERSION = 3;

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

function emptyZones(): Record<DockZone, PaneId[]> {
  return { left: [], center: [], right: [], rightBottom: [], bottom: [] };
}

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
  const zones = emptyZones();
  for (const zone of DOCK_ZONES) zones[zone] = [...layout.zones[zone]];
  return zones;
}

/** Active tab per zone after a move: keep the current one if it is still there. */
function activeFor(
  zones: Record<DockZone, PaneId[]>,
  previous: ShellLayout["active"],
  overrides: Partial<Record<DockZone, PaneId | null>> = {},
): Record<DockZone, PaneId | null> {
  const next: Record<DockZone, PaneId | null> = {
    left: null,
    center: null,
    right: null,
    rightBottom: null,
    bottom: null,
  };
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

// ---- named-layout algebra (T436) ----------------------------------------------------

/** Presets first, then the user's own, in the order they were saved. */
export function allNamedLayouts(store: LayoutStore): readonly NamedLayout[] {
  return [...LAYOUT_PRESETS, ...store.layouts];
}

export function findNamedLayout(store: LayoutStore, id: string): NamedLayout | undefined {
  return allNamedLayouts(store).find((entry) => entry.id === id);
}

/** RESTORE: the named layout becomes the live one, and the selection follows it. */
export function applyNamedLayout(store: LayoutStore, id: string): LayoutStore {
  const found = findNamedLayout(store, id);
  if (found === undefined) return store;
  return { ...store, current: found.layout, currentId: found.id };
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Deterministic — no clock, no randomness, so a test can name the entry it just made. */
function mintLayoutId(store: LayoutStore, name: string): string {
  const base = `user:${slug(name) || "layout"}`;
  const taken = new Set(store.layouts.map((entry) => entry.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * SAVE AS: a NEW entry holding the live arrangement, which becomes the selection.
 *
 * Distinct from `updateNamedLayout` on purpose. An "update" that appends is how a layout
 * list becomes forty near-duplicates nobody dares delete, so the two verbs are separate
 * functions with separate controls and only this one ever grows the list.
 */
export function saveLayoutAs(store: LayoutStore, name: string): LayoutStore {
  const trimmed = name.trim();
  if (trimmed === "") return store;
  const id = mintLayoutId(store, trimmed);
  return {
    current: store.current,
    currentId: id,
    layouts: [...store.layouts, { id, name: trimmed, layout: store.current }],
  };
}

/**
 * UPDATE: overwrite an EXISTING user layout with the live arrangement. Never appends.
 * A preset is code, so updating one is refused rather than silently forked into a copy.
 */
export function updateNamedLayout(store: LayoutStore, id: string): LayoutStore {
  if (isPresetLayoutId(id)) return store;
  if (!store.layouts.some((entry) => entry.id === id)) return store;
  return {
    ...store,
    currentId: id,
    layouts: store.layouts.map((entry) =>
      entry.id === id ? { ...entry, layout: store.current } : entry,
    ),
  };
}

export function renameNamedLayout(store: LayoutStore, id: string, name: string): LayoutStore {
  const trimmed = name.trim();
  if (trimmed === "" || isPresetLayoutId(id)) return store;
  if (!store.layouts.some((entry) => entry.id === id)) return store;
  return {
    ...store,
    layouts: store.layouts.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)),
  };
}

/**
 * DELETE a user layout. What is on screen does not change — deleting the bookmark is not
 * the same as rearranging the room — only the selection is dropped.
 */
export function deleteNamedLayout(store: LayoutStore, id: string): LayoutStore {
  if (isPresetLayoutId(id)) return store;
  if (!store.layouts.some((entry) => entry.id === id)) return store;
  return {
    current: store.current,
    currentId: store.currentId === id ? null : store.currentId,
    layouts: store.layouts.filter((entry) => entry.id !== id),
  };
}

/** Has the live arrangement drifted from the layout it was restored from? */
export function isLayoutModified(store: LayoutStore): boolean {
  if (store.currentId === null) return true;
  const selected = findNamedLayout(store, store.currentId);
  if (selected === undefined) return true;
  return !sameLayout(selected.layout, store.current);
}

function sameLayout(a: ShellLayout, b: ShellLayout): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Key order is not part of a layout's identity; a stable projection is. */
function normalize(layout: ShellLayout): unknown {
  return [
    layout.columns,
    layout.mainColumns,
    layout.rows,
    layout.rightRows,
    DOCK_ZONES.map((zone) => layout.zones[zone]),
    DOCK_ZONES.map((zone) => layout.active[zone]),
    layout.floating,
  ];
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
  const zones = emptyZones();
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

/** One stored layout → a usable one. Any group that fails validation falls back. */
function repairLayout(candidate: unknown, fallback: ShellLayout = DEFAULT_SHELL_LAYOUT): ShellLayout {
  const source = (typeof candidate === "object" && candidate !== null ? candidate : {}) as Partial<
    Record<keyof ShellLayout, unknown>
  >;
  return {
    columns: isValidGroup(source.columns, 2) ? source.columns : fallback.columns,
    mainColumns: isValidGroup(source.mainColumns, 2) ? source.mainColumns : fallback.mainColumns,
    rows: isValidGroup(source.rows, 2) ? source.rows : fallback.rows,
    rightRows: isValidGroup(source.rightRows, 2) ? source.rightRows : fallback.rightRows,
    ...repairArrangement(candidate),
  };
}

// ---- migration (§V311) --------------------------------------------------------------

/**
 * The stock v2 layout, byte for byte. Needed to tell "this user arranged their shell"
 * from "this user has simply opened the app once".
 *
 * The shell writes its layout to storage on EVERY mount, so an entry existing proves
 * nothing at all. §V311's lesson is that the innocuous-looking direction is the
 * dangerous one: the `true` case (a customised layout) is the one you think about, and
 * the `false` case — an entry that only exists because the app booted — is the one that
 * would have given every single user a pointless "Saved layout" row and pinned them to
 * the OLD arrangement, so nobody would ever have seen T426 at all.
 */
const LEGACY_DEFAULT_V2 = {
  rows: [72, 28],
  columns: [17, 57, 26],
  zones: {
    left: ["library", "components"],
    center: ["graph"],
    right: ["inspector", "viewer"],
    bottom: ["shader", "problems", "performance", "examples", "agent"],
  },
  active: { left: "library", center: "graph", right: "inspector", bottom: "shader" },
  floating: [] as string[],
};

function isStockV2(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const source = raw as Record<string, unknown>;
  const projected = {
    rows: source["rows"],
    columns: source["columns"],
    zones: source["zones"],
    active: source["active"],
    floating: source["floating"],
  };
  return JSON.stringify(projected) === JSON.stringify(LEGACY_DEFAULT_V2);
}

/**
 * v2 → v3, in both directions (§V311).
 *
 *  - v2's `columns` was `[left, centre, right]` across a body the bottom dock cut short.
 *    v3 splits the WINDOW into `[work, right]` and the work area into `[left, centre]`,
 *    so the width the user chose for each of the three is preserved exactly: the ratio
 *    is rescaled, not dropped and not reset.
 *  - v2 had one right dock. It becomes v3's `right` (top) with `rightBottom` empty and
 *    `rightRows` at `[100, 0]` — the sidebar looks identical to what they had, rather
 *    than half of it being replaced by an empty second section on first launch.
 *  - a CUSTOMISED v2 layout is kept as a named user layout and selected, so nobody loses
 *    the arrangement they are sitting in. A STOCK v2 entry is not: there is nothing of
 *    theirs in it, so they get T426's default and no phantom row.
 */
export function migrateLegacyLayout(raw: unknown): LayoutStore | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (isStockV2(raw)) return DEFAULT_LAYOUT_STORE;

  const source = raw as Record<string, unknown>;
  const wide = isValidGroup(source["columns"], 3)
    ? (source["columns"] as number[])
    : [...LEGACY_DEFAULT_V2.columns];
  const [left = 0, centre = 0, right = 0] = wide;
  const work = left + centre;
  const columns = work <= 0 ? [...DEFAULT_SHELL_LAYOUT.columns] : [work, right];
  const mainColumns =
    work <= 0 ? [...DEFAULT_SHELL_LAYOUT.mainColumns] : [(left / work) * 100, (centre / work) * 100];

  const layout = repairLayout({
    ...source,
    columns,
    mainColumns,
    // v2's right dock was one zone; keep it whole and leave the new section closed.
    rightRows: [100, 0],
    zones: { ...(source["zones"] as object | undefined), rightBottom: [] },
  });

  const id = "user:saved-layout";
  return {
    /*
     * Their arrangement is KEPT as a row but NOT selected — the owner reported twice that
     * they never saw T426's default. Selecting the migrated layout preserved everyone's
     * shell (the caution V311 asks for) and had the side effect that the new arrangement
     * was unreachable without knowing to look for it: a default nobody is shown is not a
     * default. Nothing is lost — "Saved layout" is one click away in the layout menu.
     */
    current: DEFAULT_SHELL_LAYOUT,
    currentId: DEFAULT_LAYOUT_ID,
    layouts: [{ id, name: "Saved layout", layout }],
  };
}

// ---- reading and writing ------------------------------------------------------------

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

export function readJson(storage: LayoutStorage, key: string): unknown {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function repairNamedLayouts(candidate: unknown): NamedLayout[] {
  if (!Array.isArray(candidate)) return [];
  const seen = new Set<string>();
  const layouts: NamedLayout[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const name = record["name"];
    if (typeof id !== "string" || id === "" || isPresetLayoutId(id)) continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    layouts.push({ id, name: name.trim(), layout: repairLayout(record["layout"]) });
  }
  return layouts;
}

/**
 * Never throws and never returns a partially-valid store: a corrupt entry degrades to
 * the stock layouts instead of an unusable shell, and a v2 entry is migrated rather than
 * discarded (§V311).
 */
export function readLayoutStore(
  storage: LayoutStorage | null = defaultLayoutStorage(),
): LayoutStore {
  if (!storage) return DEFAULT_LAYOUT_STORE;

  const parsed = readJson(storage, LAYOUT_STORAGE_KEY);
  if (typeof parsed !== "object" || parsed === null) {
    return migrateLegacyLayout(readJson(storage, LEGACY_LAYOUT_STORAGE_KEY)) ?? DEFAULT_LAYOUT_STORE;
  }

  const source = parsed as Record<string, unknown>;
  const layouts = repairNamedLayouts(source["layouts"]);
  const currentId = source["currentId"];
  const known =
    typeof currentId === "string" &&
    (LAYOUT_PRESETS.some((preset) => preset.id === currentId) ||
      layouts.some((entry) => entry.id === currentId));

  return {
    current: repairLayout(source["current"]),
    currentId: known ? (currentId as string) : null,
    layouts,
  };
}

export function writeLayoutStore(
  store: LayoutStore,
  storage: LayoutStorage | null = defaultLayoutStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORE_VERSION,
        current: store.current,
        currentId: store.currentId,
        layouts: store.layouts,
      }),
    );
  } catch {
    // Quota or a blocked store: layout persistence is a convenience, never a
    // reason to break the session.
  }
}

/** Drops v2's entry once v3 has been written, so exactly one key holds the layout. */
export function clearLegacyLayout(storage: LayoutStorage | null = defaultLayoutStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_LAYOUT_STORAGE_KEY);
  } catch {
    /* see writeLayoutStore */
  }
}

/** The live arrangement alone — what the shell mounts with. */
export function readLayout(storage: LayoutStorage | null = defaultLayoutStorage()): ShellLayout {
  return readLayoutStore(storage).current;
}

export function clearLayout(storage: LayoutStorage | null = defaultLayoutStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    /* see writeLayoutStore */
  }
}

