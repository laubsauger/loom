import { useMemo, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { Button } from "@ui/primitives/button.tsx";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import { cx } from "@ui/cx.ts";
import { portTypeColor } from "@ui/ports.ts";
import { writeNodeDragPayload } from "./drag-payload.ts";
import type { NodeDragPayload } from "./drag-payload.ts";
import {
  compatibleDefinitions,
  describeDrag,
  describeDragPrecisely,
  filterLibrary,
  groupByCategory,
} from "./search.ts";
import type { PortDragQuery } from "./search.ts";
import styles from "./library.module.css";

/**
 * Node library pane (T39): search, categories, drag onto the canvas, and the
 * port-drag → compatible-node search.
 *
 * The pane is a catalogue, not a mutator: dropping is the canvas's business and adding
 * is the caller's (`onAddNode`), so every mutation still goes through the command bus
 * (§V29). What the library owns is the *choice* — and when a port drag is in flight the
 * choice is narrowed by `arePortsCompatible` alone (§V13). Only nodes the graph would
 * actually accept are offered; a near miss is absent, because §V13 says the fix for a
 * near miss is a conversion node, not a looser check.
 */

export interface NodeLibraryProps {
  definitions: readonly NodeDefinition[];
  /** An in-flight port drag from the canvas. Null/undefined = browse mode. */
  portDrag?: PortDragQuery | null;
  /** Add the node — via the bus, at the caller's chosen position. */
  onAddNode?: (type: string, connectTo?: NodeDragPayload["connectTo"]) => void;
  /** Leave port-drag mode. */
  onClearPortDrag?: () => void;
}

export function NodeLibrary({
  definitions,
  portDrag,
  onAddNode,
  onClearPortDrag,
}: NodeLibraryProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const drag = portDrag ?? null;

  const categories = useMemo(
    () => [...new Set(definitions.map((definition) => definition.category))].sort(),
    [definitions],
  );

  const results = useMemo(
    () => filterLibrary(definitions, { query, category, portDrag: drag }),
    [category, definitions, drag, query],
  );

  /** Which port on the candidate node would receive the dragged edge. */
  const connectPorts = useMemo(() => {
    if (drag === null) return new Map<string, NodeDragPayload["connectTo"]>();
    return new Map(
      compatibleDefinitions(definitions, drag).map((match) => [
        match.definition.type,
        // The dragged end is an output, so the new node's end is an input, and vice versa.
        { portId: match.port.id, direction: drag.direction === "output" ? "input" : "output" } as const,
      ]),
    );
  }, [definitions, drag]);

  const groups = groupByCategory(results);

  const add = (definition: NodeDefinition): void => {
    const connectTo = connectPorts.get(definition.type);
    if (connectTo === undefined) onAddNode?.(definition.type);
    else onAddNode?.(definition.type, connectTo);
  };

  const onDragStart = (event: ReactDragEvent<HTMLButtonElement>, definition: NodeDefinition): void => {
    const connectTo = connectPorts.get(definition.type);
    writeNodeDragPayload(event.dataTransfer, {
      type: definition.type,
      ...(connectTo === undefined ? {} : { connectTo }),
    });
    event.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className={styles.library}>
      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.search}
          value={query}
          placeholder="Search nodes"
          aria-label="Search nodes"
          title="Enter adds the top hit"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // §V53: a text field swallows editing keys rather than driving the graph.
            event.stopPropagation();
            if (event.key !== "Enter") return;
            event.preventDefault();
            // Enter adds the top hit — the fastest path from typing to a node.
            const top = results[0];
            if (top !== undefined) add(top);
          }}
        />

        {drag === null ? null : (
          <div className={styles.dragBanner} role="status">
            <span
              className={styles.dragDot}
              aria-hidden
              // V26: the dot is the source port's family colour, resolved to its token.
              style={{ background: portTypeColor(drag.type) }}
            />
            <span>compatible with</span>
            <span className={styles.dragType} title={describeDragPrecisely(drag)}>
              {describeDrag(drag)}
            </span>
            {onClearPortDrag === undefined ? null : (
              <Button onClick={onClearPortDrag} aria-label="Clear port filter">
                clear
              </Button>
            )}
          </div>
        )}

        {/*
          §V90: the category set GROWS with the catalogue, so rendering it as a permanent
          chip wall means a control that will eventually not fit — it was already three
          rows deep. On demand: the trigger shows the ACTIVE filter (the answer to "what
          am I looking at"), and the full set is one click away.
        */}
        <PopoverRoot open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cx(styles.chip, styles.filterTrigger)}
              aria-expanded={filtersOpen}
              aria-label={category === null ? "Filter by category" : `Category: ${category}`}
            >
              {category ?? "all categories"}
            </button>
          </PopoverTrigger>
          <PopoverContent className={styles.filterMenu} align="start" sideOffset={4}>
            <div className={styles.categories}>
              <button
                type="button"
                className={styles.chip}
                aria-pressed={category === null}
                onClick={() => {
                  setCategory(null);
                  setFiltersOpen(false);
                }}
              >
                all
              </button>
              {categories.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={styles.chip}
                  aria-pressed={category === name}
                  onClick={() => {
                    setCategory(category === name ? null : name);
                    setFiltersOpen(false);
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          </PopoverContent>
        </PopoverRoot>
      </div>

      <div className={styles.list}>
        {groups.length === 0 ? (
          <p className={styles.empty}>
            {drag === null
              ? "No node matches that search."
              : "No compatible node — insert a conversion node instead."}
          </p>
        ) : (
          groups.map((group) => (
            <section className={styles.group} key={group.category} aria-label={group.category}>
              <h3 className={styles.groupHeader}>{group.category}</h3>
              {group.definitions.map((definition) => (
                <button
                  key={definition.type}
                  type="button"
                  className={cx(styles.item, "nodrag")}
                  draggable
                  onDragStart={(event) => onDragStart(event, definition)}
                  onClick={() => add(definition)}
                  title={definition.description ?? definition.type}
                >
                  <span className={styles.itemTitle}>{definition.title}</span>
                  <span className={styles.itemMeta}>{definition.type}</span>
                </button>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
