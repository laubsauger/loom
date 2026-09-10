import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { NodeResizer } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useStore } from "zustand";
import { cx } from "@ui/cx.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { MIN_NODE_SIZE } from "@domain/types/graph.ts";
import { annotationColorOf } from "@nodes/definitions/annotate.ts";
import { useGraphCanvas } from "@editor/graph-canvas/canvas-context.ts";
import type { LoomNode } from "@editor/graph-canvas/derive.ts";
import styles from "./annotation-node.module.css";

/**
 * The annotation box (T1262) — TD's Network Comment, as an xyflow node type of its own.
 *
 * It is a VIEW of an `annotate` node and nothing more: the title, body and colour are the
 * node's parameters, its box is `GraphNode.size` (§V116), and every edit leaves through
 * the canvas's `dispatch`, i.e. `graph.applyPatch` on the bus (§V29). The projection puts
 * it BEHIND every graph node (`ANNOTATION_Z` in `derive.ts`), and this component draws
 * no port, no status and no preview — a box with words in it.
 *
 * The resizer emits NO patch of its own: React Flow reports the gesture as `dimensions`
 * changes and the canvas commits the finished one as a single `setNodeSize`, exactly as
 * it does for a graph node's grips (§V15). The floor is the document's `MIN_NODE_SIZE`,
 * so the drag cannot reach a size `applyGraphPatch` would clamp.
 *
 * The title edits in place (double-click, Enter commits, Escape cancels) because a note
 * you cannot retitle where it sits is a form, not a note. The body is prose and edits in
 * the inspector's multiline field — the same control `text.text` uses.
 */
export const AnnotationNode = memo(function AnnotationNode({ id, selected }: NodeProps<LoomNode>) {
  const { store, dispatch } = useGraphCanvas();
  // Own slice only (§V16): another node's edit does not re-render this one.
  const node = useStore(store, (state) => state.graph.nodes[id]);
  const [editing, setEditing] = useState(false);

  const commitTitle = useCallback(
    (title: string) => {
      dispatch(
        [{ op: "setParameters", nodeId: id as NodeId, parameters: { title } }],
        "Edit annotation title",
      );
    },
    [dispatch, id],
  );

  if (node === undefined) return null;

  const title = stringOf(storedStaticValue(node.parameters["title"]), "");
  const body = stringOf(storedStaticValue(node.parameters["body"]), "");
  const color = annotationColorOf(storedStaticValue(node.parameters["color"]));

  return (
    <>
      <NodeResizer
        isVisible={selected === true}
        minWidth={MIN_NODE_SIZE.width}
        minHeight={MIN_NODE_SIZE.height}
      />
      <div
        className={cx(styles.box, selected && styles.selected)}
        data-testid={`annotation-${id}`}
        // The colour NAME, never a value: the stylesheet maps it to `var(--category-*)`,
        // so no hue is spelled here (§V17) and a name the stylesheet does not know paints
        // nothing rather than something arbitrary.
        data-color={color}
        data-sized={node.size !== undefined}
      >
        {editing ? (
          <TitleEditor
            nodeId={id as NodeId}
            initial={title}
            onCommit={commitTitle}
            onClose={() => setEditing(false)}
          />
        ) : (
          <div
            className={styles.title}
            data-testid={`annotation-title-${id}`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditing(true);
            }}
          >
            {title}
          </div>
        )}
        {body === "" ? null : (
          <div className={styles.body} data-testid={`annotation-body-${id}`}>
            {body}
          </div>
        )}
      </div>
    </>
  );
});

function stringOf(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

interface TitleEditorProps {
  nodeId: NodeId;
  initial: string;
  onCommit: (title: string) => void;
  onClose: () => void;
}

function TitleEditor({ nodeId, initial, onCommit, onClose }: TitleEditorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(initial);
  // Enter commits and then blurs, which would commit again. One settle per session.
  const settling = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  const commit = useCallback(() => {
    if (settling.current) return;
    settling.current = true;
    const next = draft.trim();
    // An unchanged title is no edit: no revision and no undo entry for nothing (§V33).
    if (next !== initial) onCommit(next);
    onClose();
  }, [draft, initial, onClose, onCommit]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settling.current = true;
        onClose();
      } else {
        // §V53: a text field is a text context; editing keys stop here.
        event.stopPropagation();
      }
    },
    [commit, onClose],
  );

  return (
    <input
      ref={inputRef}
      className={cx(styles.titleInput, "nodrag", "nopan")}
      data-testid={`annotation-title-input-${nodeId}`}
      type="text"
      aria-label="Annotation title"
      value={draft}
      maxLength={200}
      // §V20 — the press belongs to the field: without this, selecting the text drags
      // the box across the canvas.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  );
}
