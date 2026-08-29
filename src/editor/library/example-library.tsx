import { useMemo, useState } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { Button } from "@ui/primitives/button.tsx";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
} from "@ui/primitives/dialog.tsx";
import { listExampleProjects } from "./example-catalogue.ts";
import type { ExampleProject } from "./example-catalogue.ts";
import styles from "./library.module.css";

/**
 * The example library (T189, §V93, §V88).
 *
 * Third library, third verb: OPEN. It is its own pane and not a tab beside the node and
 * component catalogues, because those two ADD to the graph and this one REPLACES the
 * document — §V93 refuses to put a destructive verb one click from an additive one.
 *
 * That asymmetry is the whole design here:
 *  - opening asks first when there is unsaved work, and only then (§V93). A confirmation
 *    on a clean document trains people to dismiss the one that matters;
 *  - adding and instantiating never ask, because undo is right there.
 *
 * Opening goes through `project.open` with the file's own bytes (§V29, §V88) — the same
 * command the file picker and the restore path use, so an example takes the identical
 * route a user's own file takes and cannot be "loaded" by a path nothing else exercises.
 */

/**
 * The command an example row runs. A literal rather than an import: the registration
 * lives in `src/app`, and `src/editor` importing upward from the composition root would
 * invert the layering. `CommandMap` still types the call, so a rename breaks this line.
 */
const OPEN_COMMAND = "project.open";

export interface ExampleLibraryProps {
  bus: ShaderloomBus;
  /** Actor/project/capabilities for the open command (§V30). Memoise it. */
  context: InvocationContext;
  /** Unsaved work in the open document — the one thing that makes opening ask first. */
  dirty: boolean;
  /** Injectable for tests; otherwise the shipped `examples/` directory. */
  examples?: readonly ExampleProject[];
  /** Fires after a successful open, e.g. to focus the canvas. */
  onOpened?: (example: ExampleProject) => void;
}

export function ExampleLibrary({
  bus,
  context,
  dirty,
  examples,
  onOpened,
}: ExampleLibraryProps) {
  const catalogue = useMemo(() => examples ?? listExampleProjects(), [examples]);
  const [pending, setPending] = useState<ExampleProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // `project.open` is registered by the mounted composition root, so it can genuinely be
  // absent — in a test harness, or before the root's effect has run. A row that would
  // throw is disabled instead, the way an unregistered menu item is (§V52).
  const canOpen = bus.hasCommand(OPEN_COMMAND);

  const open = async (example: ExampleProject): Promise<void> => {
    setPending(null);
    setBusy(true);
    try {
      const outcome = await bus.execute(
        OPEN_COMMAND,
        { text: example.text, fileName: example.fileName },
        context,
      );
      const first = outcome.diagnostics[0];
      setMessage(first === undefined ? null : first.message);
      if (outcome.output.opened) onOpened?.(example);
    } finally {
      setBusy(false);
    }
  };

  const choose = (example: ExampleProject): void => {
    // §V93: confirm only when there is work to lose.
    if (dirty) setPending(example);
    else void open(example);
  };

  return (
    <div className={styles.library}>
      <div className={styles.list}>
        {catalogue.length === 0 ? (
          <p className={styles.empty}>No example ships with this build.</p>
        ) : (
          catalogue.map((example) => (
            <button
              key={example.fileName}
              type="button"
              className={styles.item}
              disabled={busy || !canOpen}
              onClick={() => choose(example)}
            >
              <span className={styles.itemTitle}>{example.name}</span>
              <span className={styles.itemMeta}>{example.nodeCount} nodes</span>
            </button>
          ))
        )}
      </div>

      {message === null ? null : (
        <p className={styles.notice} role="status">
          {message}
        </p>
      )}

      <DialogRoot
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
      >
        {/* Named by its title, so the dialog announces the example it is about. */}
        <DialogContent>
          <DialogTitle>Open {pending?.name ?? ""}</DialogTitle>
          <DialogDescription>Unsaved changes are replaced.</DialogDescription>
          <DialogFooter>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pending !== null) void open(pending);
              }}
            >
              Open
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
