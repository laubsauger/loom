import { useMemo, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { Button } from "@ui/primitives/button.tsx";
import { cx } from "@ui/cx.ts";
import { portTypeColor } from "@ui/ports.ts";
import { LibraryGroups, LibraryPanel, LibrarySearch } from "./library-panel.tsx";
import { writeNodeDragPayload } from "./drag-payload.ts";
import type { NodeDragPayload } from "./drag-payload.ts";
import {
  categoriesOf,
  compatibleDefinitions,
  describeDrag,
  describeDragPrecisely,
  filterLibrary,
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

  // T732: shared with the node browser's tab strip, so the two category affordances
  // cannot come to disagree about what the categories ARE (§V487).
  const categories = useMemo(() => categoriesOf(definitions), [definitions]);

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
    <LibraryPanel
      toolbar={
        <>
          {/*
            §T877: the same search row the example pane uses. It was a hand-built copy
            here, which is why §T855's one-row filter landed there and not here — the
            owner's words: "node library didnt adjust its category filter".
          */}
          <LibrarySearch
            label="Search nodes"
            value={query}
            onChange={setQuery}
            title="Enter adds the top hit"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              // Enter adds the top hit — the fastest path from typing to a node.
              const top = results[0];
              if (top !== undefined) add(top);
            }}
            categories={categories}
            category={category}
            onCategoryChange={setCategory}
            filtersOpen={filtersOpen}
            onFiltersOpenChange={setFiltersOpen}
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
        </>
      }
    >
      <LibraryGroups
        items={results}
        keyOf={(definition) => definition.type}
        empty={
          drag === null
            ? "No node matches that search."
            : "No compatible node — insert a conversion node instead."
        }
        renderItem={(definition) => (
          <button
            type="button"
            className={cx(styles.item, "nodrag")}
            draggable
            onDragStart={(event) => onDragStart(event, definition)}
            /*
             * T635: SINGLE click adds — that is the stated gesture. A double-click (the
             * file-browser habit) is two click events, and treating both as adds stacked
             * two identical nodes on one spot; the owner's ~20-blur pile-up reads as this
             * gesture repeated. `detail > 1` is the burst's second-and-later clicks, so a
             * double-click adds exactly once, while deliberate repeat-adds (clicks outside
             * the double-click window) still add one each.
             */
            onClick={(event) => {
              if (event.detail > 1) return;
              add(definition);
            }}
            title={definition.description ?? definition.type}
          >
            <span className={styles.itemTitle}>{definition.title}</span>
            <span className={styles.itemMeta}>{definition.type}</span>
          </button>
        )}
      />
    </LibraryPanel>
  );
}
