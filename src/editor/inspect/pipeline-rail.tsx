import { useCallback, useSyncExternalStore } from "react";
import type { TelemetrySource } from "@runtime/telemetry/index.ts";
import { spanBasePassId } from "@runtime/backend/plan.ts";
import { formatMs } from "./format.ts";
import { buildPipelineDetail, missingSelectionNote } from "./pipeline-model.ts";
import type { PipelineRequest, PipelineSelection, PipelineView } from "./pipeline-model.ts";
import styles from "./pipeline.module.css";

/**
 * The detail rail — what one column or one lane actually is (T1188).
 *
 * ## Three states, and none of them is blank
 *
 * NOTHING SELECTED is an invitation, not an empty box: it says what the frame is and
 * what clicking does. A SELECTION shows the pass or the resource. And a selection whose
 * pass or resource has DISAPPEARED from the installed plan — an edit landed while the
 * rail was open — says so, because silently clearing would be the same dishonesty the
 * install banner exists to prevent.
 *
 * ## Milliseconds, and why they do not have to wait for §T1189
 *
 * The telemetry hub's `spans` is a `Map<passId, ms>` written only from the device's
 * `onPassTimings`, so the MEASUREMENTS are device truth keyed by pass id. What is
 * mis-sourced in §T1189 is the hub's pass LIST (`use-graph-compile.ts` feeds it
 * `result.compiled`, not the installed plan), and joining spans against the INSTALLED
 * plan's ids inherits none of that. A pass the GPU is running that the hub has no row
 * for reads "not measured" — the honest answer, and the visible symptom of §T1189 rather
 * than a repeat of it.
 *
 * Substep iterations are timed under suffixed span names; `spanBasePassId` is the
 * published inverse, so a looped pass finds its own row instead of none.
 *
 * Only this component subscribes to telemetry, so a 10 Hz metric tick re-renders the
 * rail and never the tape or the plan model (§V16).
 */

export interface PipelineRailProps {
  readonly request: PipelineRequest;
  readonly view: PipelineView;
  readonly selection: PipelineSelection | null;
  readonly telemetry?: TelemetrySource | null | undefined;
}

export function PipelineRail({ request, view, selection, telemetry }: PipelineRailProps) {
  const source = telemetry ?? null;
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => source?.subscribe(listener) ?? (() => {}), [source]),
    useCallback(() => source?.snapshot() ?? null, [source]),
    useCallback(() => source?.snapshot() ?? null, [source]),
  );

  if (selection === null) {
    return (
      <aside className={styles.rail} data-testid="pipeline-rail" data-state="empty">
        <p className={styles.railHint}>
          Click a column to read a pass, or a lane to read a resource.
        </p>
        {view.stats === null ? null : (
          <dl className={styles.railFacts}>
            <dt>frame</dt>
            <dd>
              {view.stats.passes} passes, {view.stats.encodes} encodes
            </dd>
            <dt>storage</dt>
            <dd>{view.track.lanes.length} resources on the tape</dd>
          </dl>
        )}
      </aside>
    );
  }

  const detail = buildPipelineDetail(request, selection);

  if (detail === null) {
    return (
      <aside className={styles.rail} data-testid="pipeline-rail" data-state="gone">
        <p className={styles.railGone}>
          <code>{selection.id}</code> — {missingSelectionNote(selection)}
        </p>
      </aside>
    );
  }

  const row =
    detail.kind === "pass"
      ? (snapshot?.passes.find((entry) => spanBasePassId(entry.passId) === spanBasePassId(detail.id)) ?? null)
      : null;
  // The same bucket shape the performance tab builds per row, so one formatter — and one
  // §V86 rule about absent measurements — serves both surfaces.
  const span =
    row === null
      ? null
      : formatMs({
          availability: row.availability,
          gpuMs: row.gpuMs,
          passCount: 1,
          nodeCount: row.nodeId === null ? 0 : 1,
        });

  return (
    <aside className={styles.rail} data-testid="pipeline-rail" data-state="detail" data-detail={detail.id}>
      <h4 className={styles.railTitle}>{detail.title}</h4>
      <p className={styles.railSubtitle}>{detail.subtitle}</p>

      {detail.kind !== "pass" ? null : (
        <dl className={styles.railFacts}>
          <dt>gpu time</dt>
          {span === null ? (
            <dd className={styles.absent} data-measured="false">
              not measured
            </dd>
          ) : (
            <dd className={span.absent ? styles.absent : undefined} data-measured={!span.absent}>
              {span.text}
            </dd>
          )}
        </dl>
      )}

      {detail.groups.map((group) => (
        <section key={group.title} className={styles.railGroup}>
          <h5 className={styles.railGroupTitle}>{group.title}</h5>
          <dl className={styles.railFacts}>
            {group.rows.map((row) => (
              <div key={row.label} className={styles.railRow}>
                <dt>{row.label}</dt>
                <dd className={row.absent === true ? styles.absent : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </aside>
  );
}
