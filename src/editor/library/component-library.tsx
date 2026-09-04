import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { ComponentSummary, InstanceUpgradeSummary } from "@domain/components/commands.ts";
import type { ComponentRegistryView } from "@domain/components/registry.ts";
import { instanceDisplayNames } from "@domain/components/instance.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ComponentId, NodeId } from "@domain/types/ids.ts";
import { Button } from "@ui/primitives/button.tsx";
import { LibraryPanel, LibrarySearch } from "./library-panel.tsx";
import styles from "./library.module.css";

/**
 * The component library (T188, §V93, §V79, §V84, §V94).
 *
 * Second library, second verb: INSTANTIATE. Everything underneath already existed —
 * `component.list`, `component.instantiate`, `component.upgrades` and
 * `component.saveSelection` have been bus commands since track U landed — and none of it
 * had a surface. This pane is a view over that surface and holds no component logic of
 * its own (§V29): it lists what the query returns and executes what the user picks.
 *
 * Three things it must get right:
 *
 *  - LINKED vs DETACHED is a choice, not a setting. Both are offered on every row, so
 *    the decision is made where the placement happens rather than in a mode somewhere
 *    else that the next placement silently inherits (§V79).
 *  - VERSION is shown, always. An instance pins one (§V84), so a library that showed
 *    only a name would be hiding the field the pin is about.
 *  - UPGRADES are listed per INSTANCE and never applied in bulk. `component.upgrades` is
 *    informational; migrating is an explicit act on one instance (§V84, §V10).
 *
 * Saving a selection lives here too, on the theory that the place you look for a
 * component is the place you look after building one worth keeping.
 */

export interface ComponentLibraryProps {
  bus: LoomBus;
  /** Actor/project/capabilities for every command this pane sends (§V30). Memoise it. */
  context: InvocationContext;
  /**
   * The catalogue, for change notification. Re-authoring a component is not a document
   * edit, so the graph store never fires for it and the list would go stale.
   */
  components: ComponentRegistryView;
  /** Current canvas selection — what save-selection would capture. */
  selection?: readonly NodeId[];
  /** Where a placement lands, in graph coordinates. */
  position?: { x: number; y: number };
  /** Select the instance the user just placed or upgraded. */
  onPlaced?: (nodeIds: readonly NodeId[]) => void;
}

interface Placement {
  componentId: ComponentId;
  mode: "linked" | "detached";
}

export function ComponentLibrary({
  bus,
  context,
  components,
  selection = [],
  position,
  onPlaced,
}: ComponentLibraryProps) {
  const graph = useSyncExternalStore<GraphDocument>(
    bus.store.subscribe,
    bus.store.getGraph,
    bus.store.getGraph,
  );

  const [catalogueRevision, bumpCatalogue] = useState(0);
  useEffect(
    () => components.subscribe(() => bumpCatalogue((count) => count + 1)),
    [components],
  );

  const [summaries, setSummaries] = useState<readonly ComponentSummary[]>([]);
  const [upgrades, setUpgrades] = useState<readonly InstanceUpgradeSummary[]>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<Placement | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    // A bus without the component module registered is a real configuration, not an
    // error: the pane shows nothing rather than throwing out of an effect.
    if (!bus.hasQuery("component.list")) return;
    const [list, stale] = await Promise.all([
      bus.query("component.list", {}, context),
      bus.query("component.upgrades", {}, context),
    ]);
    setSummaries(list);
    setUpgrades(stale);
  }, [bus, context]);

  // Both sources move independently: the graph when an instance is placed or upgraded,
  // the catalogue when a definition is registered.
  useEffect(() => {
    void refresh();
  }, [refresh, graph, catalogueRevision]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return summaries;
    return summaries.filter(
      (summary) =>
        summary.name.toLowerCase().includes(needle) ||
        summary.componentId.toLowerCase().includes(needle),
    );
  }, [query, summaries]);

  const instanceNames = useMemo(() => {
    // The registry is not a reactive value; `catalogueRevision` is how a re-authored
    // name reaches this memo, so it is read here rather than only listed as a dep.
    void catalogueRevision;
    return instanceDisplayNames(
      graph,
      (componentId, version) => components.get(componentId, version)?.name ?? componentId,
    );
  }, [components, graph, catalogueRevision]);

  const report = (diagnostics: readonly { message: string }[]): void => {
    const first = diagnostics[0];
    setMessage(first === undefined ? null : first.message);
  };

  const instantiate = async (
    summary: ComponentSummary,
    mode: "linked" | "detached",
  ): Promise<void> => {
    setBusy({ componentId: summary.componentId, mode });
    try {
      const outcome = await bus.execute(
        "component.instantiate",
        {
          componentId: summary.componentId,
          mode,
          ...(position === undefined ? {} : { position }),
        },
        context,
      );
      report(outcome.diagnostics);
      if (outcome.output.ok) onPlaced?.(outcome.output.nodeIds);
    } finally {
      setBusy(null);
    }
  };

  const upgrade = async (nodeId: NodeId): Promise<void> => {
    const outcome = await bus.execute("component.upgradeInstance", { nodeId }, context);
    report(outcome.diagnostics);
    await refresh();
  };

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "" || selection.length === 0) return;
    const outcome = await bus.execute(
      "component.saveSelection",
      { nodeIds: selection, name: trimmed },
      context,
    );
    report(outcome.diagnostics);
    if (outcome.output.ok) setName("");
    await refresh();
  };

  return (
    /*
     * §T877: the SKELETON only, and that is the honest extent of the share. This pane has
     * no categories to filter and a flat list of rows, so it takes `LibraryPanel` — which
     * is where the toolbar-outside-the-scroller rule lives, so §T876's sticky fix is
     * inherited here too — and stops there. Handing it a category control to look like
     * its siblings would be inventing an affordance with nothing behind it.
     */
    <LibraryPanel
      notice={message}
      toolbar={
        <>
          <LibrarySearch collection="components" value={query} onChange={setQuery} />

          <div className={styles.saveRow}>
            <input
              type="text"
              className={styles.search}
              value={name}
              placeholder="Component name"
              aria-label="Component name"
              disabled={selection.length === 0}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key !== "Enter") return;
                event.preventDefault();
                void save();
              }}
            />
            <Button
              variant="outline"
              disabled={selection.length === 0 || name.trim() === ""}
              onClick={() => void save()}
            >
              Save selection
            </Button>
          </div>
          <p className={styles.hint}>{selection.length} selected</p>
        </>
      }
    >
      <>
        {matches.length === 0 ? (
          <p className={styles.empty}>
            {summaries.length === 0 ? "No component installed." : "No component matches."}
          </p>
        ) : (
          matches.map((summary) => (
            <div key={summary.componentId} className={styles.row}>
              <button
                type="button"
                className={styles.item}
                disabled={busy !== null}
                title={summary.description ?? summary.componentId}
                onClick={() => void instantiate(summary, "linked")}
              >
                <span className={styles.itemTitle}>{summary.name}</span>
                <span className={styles.version}>v{summary.version}</span>
                <span className={styles.itemMeta}>
                  {summary.inputs.length} in · {summary.outputs.length} out ·{" "}
                  {summary.parameters.length} params
                </span>
              </button>
              <Button
                disabled={busy !== null}
                aria-label={`Copy ${summary.name}`}
                title={`Copy ${summary.name}`}
                onClick={() => void instantiate(summary, "detached")}
              >
                copy
              </Button>
            </div>
          ))
        )}

        {upgrades.length === 0 ? null : (
          <section className={styles.group} aria-label="Upgrades">
            <h3 className={styles.groupHeader}>Upgrades</h3>
            {upgrades.map((entry) => (
              <div key={entry.nodeId} className={styles.row}>
                <span className={styles.itemTitle}>
                  {instanceNames[entry.nodeId] ?? entry.nodeId}
                </span>
                <span className={styles.version}>
                  v{entry.pinnedVersion} → v{entry.latestVersion}
                </span>
                <Button
                  variant="outline"
                  aria-label={`Upgrade ${instanceNames[entry.nodeId] ?? entry.nodeId}`}
                  onClick={() => void upgrade(entry.nodeId)}
                >
                  Upgrade
                </Button>
              </div>
            ))}
          </section>
        )}
      </>
    </LibraryPanel>
  );
}
