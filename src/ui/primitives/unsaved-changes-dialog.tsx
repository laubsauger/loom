import { Button } from "./button.tsx";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
} from "./dialog.tsx";
import styles from "./dialog.module.css";

/**
 * The one dialog that stands between a destructive verb and unsaved work (§V165, §V166).
 *
 * ## Three outcomes, and why the third is not optional
 *
 * §V166: the confirm must offer SAVE as its primary action, not only Discard and Cancel.
 * A two-button "are you sure?" makes the careful user do the most work — cancel, find
 * Save, save, then repeat the action they already asked for — while discarding their work
 * stays one click. The dialog exists specifically to protect unsaved work, so the safe
 * path has to be the shortest one in it.
 *
 * Order and emphasis are part of the contract, not styling: Save first and primary,
 * Discard second and marked destructive, Cancel last. Escape and the overlay both cancel,
 * because the safe default for a dialog nobody meant to open is to do nothing.
 *
 * ## One dialog, not one per caller
 *
 * Every destructive verb needs exactly these three outcomes — New (§V165), Open, and the
 * example library's open-when-dirty — so they share this component rather than each
 * growing a confirm that behaves slightly differently. It lives in `src/ui/primitives`
 * for that reason: `src/app` and `src/editor` can both reach it, and neither owns it.
 *
 * It is presentational. It does not know what "save" means, does not read the document,
 * and never decides whether there is unsaved work; the caller answers all three.
 */

export interface UnsavedChangesDialogProps {
  readonly open: boolean;
  /** What is about to happen, in the user's words: "Start a new project", "Open E1". */
  readonly action: string;
  /** Saves, then continues. The PRIMARY action (§V166). */
  readonly onSave: () => void;
  /** Continues without saving. */
  readonly onDiscard: () => void;
  /** Does nothing. Also what Escape and the overlay do. */
  readonly onCancel: () => void;
  /** True while the save is in flight, so the dialog cannot be double-submitted. */
  readonly busy?: boolean;
}

export function UnsavedChangesDialog({
  open,
  action,
  onSave,
  onDiscard,
  onCancel,
  busy = false,
}: UnsavedChangesDialogProps) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent aria-label="Unsaved changes" data-testid="unsaved-changes-dialog">
        <DialogTitle>Unsaved changes</DialogTitle>
        <DialogDescription>{action}</DialogDescription>
        <p className={styles.description}>This project has changes that are not saved.</p>
        <DialogFooter>
          <Button variant="outline" size="md" onClick={onSave} disabled={busy} autoFocus>
            Save and continue
          </Button>
          <Button variant="danger" size="md" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
          <Button size="md" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
