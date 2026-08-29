import type { Breadcrumb } from "@domain/components/navigation.ts";
import type { ComponentPath } from "@domain/types/components.ts";
import { cx } from "@ui/cx.ts";
import styles from "./component.module.css";

/**
 * Where you are inside the component tree (T130, §V82).
 *
 * The trail is the only affordance that makes nested editing survivable: without it,
 * entering three components deep leaves the user looking at an unfamiliar network with
 * no way back and nothing saying what they are inside. Each crumb is a real `<button>`,
 * so it is tab-reachable, Enter/Space activated and announced (§V19), and the current
 * one is marked rather than merely styled differently.
 *
 * The labels are the same ones a diagnostic path uses, so `Main / DreamyFeedback_2 /
 * Blur_1` in an error message names exactly what the trail shows.
 */

export interface BreadcrumbTrailProps {
  breadcrumbs: readonly Breadcrumb[];
  /** Called with the path of the crumb clicked. The root crumb's path is empty. */
  onNavigate: (path: ComponentPath) => void;
  /** Optional "leave this component" action, one level out. */
  onExit?: (() => void) | undefined;
  label?: string;
}

export function BreadcrumbTrail({
  breadcrumbs,
  onNavigate,
  onExit,
  label = "Component path",
}: BreadcrumbTrailProps) {
  const lastIndex = breadcrumbs.length - 1;

  return (
    <nav className={styles.trail} aria-label={label}>
      {breadcrumbs.map((crumb, index) => {
        const current = index === lastIndex;
        return (
          <span key={`${crumb.label}-${crumb.path.join("/")}`}>
            {index > 0 ? (
              <span className={styles.separator} aria-hidden>
                /
              </span>
            ) : null}
            <button
              type="button"
              className={cx(styles.crumb, current && styles.current)}
              {...(current ? { "aria-current": "page" as const } : {})}
              disabled={current}
              onClick={() => onNavigate(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
      {onExit !== undefined && breadcrumbs.length > 1 ? (
        <button type="button" className={cx(styles.crumb, styles.exit)} onClick={onExit}>
          Exit component
        </button>
      ) : null}
    </nav>
  );
}
