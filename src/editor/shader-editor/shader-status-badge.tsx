import { cx } from "@ui/cx.ts";
import type { ShaderStatusBadgeProps } from "./shader-status.ts";
import styles from "./shader-editor.module.css";

/**
 * Compile status as it appears on the graph node (§V27 — "surfaces on node badge and
 * problems tab"). Presentation only; the graph canvas (track F) places it.
 *
 * Renders nothing when there is nothing to say. A badge that is always present is a
 * badge nobody looks at, and a clean node should read as clean at a glance.
 */
export function ShaderStatusBadge({
  errorCount,
  warningCount,
  stale = false,
  compiling = false,
  className,
}: ShaderStatusBadgeProps) {
  if (errorCount === 0 && warningCount === 0 && !stale && !compiling) return null;

  const summary = [
    errorCount > 0 ? `${errorCount} errors` : null,
    warningCount > 0 ? `${warningCount} warnings` : null,
    stale ? "output stale" : null,
    compiling ? "compiling" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <span className={cx(styles.badge, className)} role="status" aria-label={`Shader: ${summary}`}>
      {compiling ? <span className={cx(styles.badgeItem, styles.badgeCompiling)}>…</span> : null}
      {errorCount > 0 ? (
        <span className={cx(styles.badgeItem, styles.badgeError)} aria-hidden="true">
          ✕ {errorCount}
        </span>
      ) : null}
      {warningCount > 0 ? (
        <span className={cx(styles.badgeItem, styles.badgeWarning)} aria-hidden="true">
          ! {warningCount}
        </span>
      ) : null}
      {stale ? (
        <span className={cx(styles.badgeItem, styles.badgeStale)} aria-hidden="true">
          stale
        </span>
      ) : null}
    </span>
  );
}
