import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { ComponentPath } from "@domain/types/components.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { Breadcrumb } from "@domain/components/navigation.ts";
import { BreadcrumbTrail } from "@editor/component/index.ts";
import { registerCreateComponentCommand } from "./component-navigation.ts";
import { Button } from "@ui/primitives/button.tsx";
import styles from "./component-bar.module.css";

/**
 * The canvas's component chrome (T423): where you are, and how to make one.
 *
 * ## Why the naming prompt is a COMMAND-opened surface
 *
 * §V307: an openable surface is opened by a command, never by a click handler, so it gets
 * three doors for the price of one — the node menu's "Save as component…", the keymap's
 * binding, and the palette. `component.saveSelection` cannot BE that command: it needs a
 * NAME, and no menu row and no key press carries one. That is B60 exactly (the rename
 * item that named the document command and dispatched a rename with no name), and T415's
 * answer applies unchanged — the reachable command OPENS the editor, and the editor runs
 * the document command with what the user typed (§V342).
 *
 * ## Why the trail is here rather than inside the canvas
 *
 * The breadcrumb is the only thing that makes nested editing survivable, and it has to be
 * visible while the canvas below it is showing an unfamiliar network. Putting it in the
 * pane rather than in `GraphCanvas` also keeps the canvas component free of any knowledge
 * that components exist — it renders whatever `GraphDocument` it is handed (§V16).
 */

export interface ComponentBarProps {
  /** The ROOT bus: a component is always saved out of the graph the user is looking at. */
  bus: LoomBus;
  context: InvocationContext;
  breadcrumbs: readonly Breadcrumb[];
  insideComponent: boolean;
  onNavigate: (path: ComponentPath) => void;
  onExit: () => void;
  /** Select the instance that replaced the selection, so the gesture ends somewhere. */
  onCreated?: (nodeIds: readonly NodeId[]) => void;
}

export function ComponentBar({
  bus,
  context,
  breadcrumbs,
  insideComponent,
  onNavigate,
  onExit,
  onCreated,
}: ComponentBarProps) {
  const [pending, setPending] = useState<readonly NodeId[] | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const holder = registerCreateComponentCommand(bus);
    holder.current = (nodeIds) => {
      setMessage(null);
      setName("");
      setPending(nodeIds);
    };
    return () => {
      holder.current = null;
    };
  }, [bus]);

  useEffect(() => {
    if (pending !== null) inputRef.current?.focus();
  }, [pending]);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (pending === null) return;
      const trimmed = name.trim();
      if (trimmed === "") {
        setMessage("A component needs a name.");
        return;
      }
      void bus
        .execute("component.saveSelection", { nodeIds: pending, name: trimmed }, context)
        .then((result) => {
          if (result.output.ok) {
            setPending(null);
            const created = result.output.instanceNodeId;
            if (created !== null) onCreated?.([created]);
            return;
          }
          setMessage(result.diagnostics[0]?.message ?? "The selection could not be saved.");
        });
    },
    [bus, context, name, onCreated, pending],
  );

  if (!insideComponent && pending === null) return null;

  return (
    <div className={styles.bar}>
      {insideComponent ? (
        <BreadcrumbTrail breadcrumbs={breadcrumbs} onNavigate={onNavigate} onExit={onExit} />
      ) : null}
      {pending === null ? null : (
        <form className={styles.prompt} onSubmit={submit}>
          <label className={styles.promptLabel} htmlFor="create-component-name">
            Save {pending.length} node{pending.length === 1 ? "" : "s"} as
          </label>
          <input
            id="create-component-name"
            ref={inputRef}
            className={styles.promptInput}
            value={name}
            placeholder="Component name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setPending(null);
              }
            }}
          />
          <Button type="submit" variant="outline">
            Create
          </Button>
          <Button onClick={() => setPending(null)}>Cancel</Button>
          {message === null ? null : (
            <span className={styles.promptMessage} role="status">
              {message}
            </span>
          )}
        </form>
      )}
    </div>
  );
}
