import { Button } from "@ui/index.ts";
import styles from "./notices.module.css";

/**
 * The strip under the top bar: things the user must be told and can act on.
 *
 * Three of them exist today and all three are states the app used to enter silently:
 * autosave is off because there is no storage; a halted GPU with no way back; an
 * autosave newer than what just loaded. A diagnostic in the problems tab is the right
 * place for the record, and the wrong place for a decision — this is where the decision
 * gets a button.
 *
 * §V19: every action is a real `<button>` with an accessible name and the shared focus
 * ring, reachable in tab order without a pointer. The strip is a live region so a notice
 * that appears while the user is elsewhere is announced rather than just drawn.
 */

export type NoticeTone = "info" | "warn" | "error";

export interface NoticeAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly variant?: "ghost" | "outline" | "danger" | undefined;
}

export interface Notice {
  readonly id: string;
  readonly tone: NoticeTone;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly actions?: readonly NoticeAction[] | undefined;
}

export interface NoticeStripProps {
  readonly notices: readonly Notice[];
}

export function NoticeStrip({ notices }: NoticeStripProps) {
  if (notices.length === 0) return null;

  return (
    <div className={styles.strip} role="status" aria-live="polite" data-testid="notice-strip">
      {notices.map((notice) => (
        <div key={notice.id} className={styles.notice} data-tone={notice.tone} data-notice={notice.id}>
          <span className={styles.message}>
            {notice.message}
            {notice.detail === undefined ? null : <span className={styles.detail}>{notice.detail}</span>}
          </span>
          {notice.actions === undefined || notice.actions.length === 0 ? null : (
            <span className={styles.actions}>
              {notice.actions.map((action) => (
                <Button
                  key={action.label}
                  variant={action.variant ?? "outline"}
                  onClick={action.onSelect}
                >
                  {action.label}
                </Button>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
