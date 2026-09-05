import { useCallback, useMemo, useState } from "react";
import type { TelemetrySource } from "@runtime/telemetry/index.ts";
import { DialogContent, DialogRoot, DialogTitle } from "@ui/primitives/dialog.tsx";
import { formatBytes } from "./format.ts";
import { buildPipelineView } from "./pipeline-model.ts";
import type {
  PipelineFinding,
  PipelineLimit,
  PipelinePassRow,
  PipelineRequest,
  PipelineSelection,
  PipelineView,
} from "./pipeline-model.ts";
import { PipelineRail } from "./pipeline-rail.tsx";
import { PipelineTrackView } from "./pipeline-track.tsx";
import styles from "./pipeline.module.css";

/**
 * The pipeline inspector (T1188) — "the magic under the hood", on demand.
 *
 * A modal opened by `ui.showPipeline`, never a permanent pane (§V90): it answers a
 * question somebody asks at a moment, and the answer is long.
 *
 * ## The reading order is the argument
 *
 * 1. WHICH PLAN THIS IS. §B179 and §T1163 are the reason this screen exists in this
 *    shape, so the banner is in the masthead and does not scroll away: "the graph does
 *    not compile and you are looking at an older pipeline" outweighs every other row on
 *    the page, and it is the state somebody is in when they open this.
 * 2. THE FRAME, AS A PICTURE, with a detail rail beside it. See `pipeline-track.tsx` for
 *    why this is a Gantt chart and deliberately not a second drawing of the node graph.
 * 3. WILL THE DEVICE TAKE IT. A limit breach is a compiler decision that failed, not a
 *    cost — §T1153's ring overflowing `maxTextureArrayLayers` dies at `createTexture` on
 *    the uncaptured-error path with no diagnostic anywhere, and one row ends that.
 * 4. THE DECISIONS, in words. Every finding renders even when it found nothing, because
 *    "every pass writes at the format it reads" is an answer and a missing section is
 *    not.
 * 5. THE FLOW. The pass table is a table of contents and it is last — and it is also the
 *    KEYBOARD route to selecting a pass, so the tape can stay a pointer surface without
 *    the detail rail becoming mouse-only.
 */

export interface PipelinePanelProps extends PipelineRequest {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Per-pass GPU spans for the rail. Absent, every pass reads "not measured". */
  telemetry?: TelemetrySource | null | undefined;
}

const PASS_TONE: Readonly<Record<PipelinePassRow["kind"], string>> = {
  effect: "filter",
  draw: "render",
  dispatch: "points",
  counter: "utility",
  swap: "temporal",
  loop: "utility",
};

function Meter({ label, value, tone }: { label: string; value: string; tone?: "signal" }) {
  return (
    <div className={styles.meter}>
      <span className={styles.meterLabel}>{label}</span>
      <span className={styles.meterValue} {...(tone === undefined ? {} : { "data-tone": tone })}>
        {value}
      </span>
    </div>
  );
}

function Finding({ finding }: { finding: PipelineFinding }) {
  const empty = finding.rows.length === 0;
  return (
    <details className={styles.finding} data-empty={empty} data-finding={finding.kind}>
      <summary className={styles.findingSummary}>
        <span className={styles.findingName}>{finding.title}</span>
        <span className={styles.findingText}>{finding.summary}</span>
      </summary>
      {empty ? (
        <p className={styles.empty}>Nothing to list.</p>
      ) : (
        <ul className={styles.rows}>
          {finding.rows.map((row) => (
            <li
              key={row.id}
              className={styles.row}
              {...(row.tone === undefined ? {} : { "data-tone": row.tone })}
            >
              {row.text}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** One "the plan asks N, the device grants M" row. A breach is the only loud thing here. */
function LimitRow({ limit }: { limit: PipelineLimit }) {
  return (
    <tr data-limit={limit.id} data-ok={limit.ok}>
      <td className={styles.nodeCell}>{limit.label}</td>
      <td className={styles.step}>{limit.asks}</td>
      <td className={styles.step}>
        {limit.grants === null ? <span className={styles.absent}>not reported</span> : limit.grants}
      </td>
      <td>{limit.ok ? limit.note : `${limit.note} — OVER THE DEVICE LIMIT`}</td>
    </tr>
  );
}

export function PipelineReport({
  view,
  request,
  telemetry,
}: {
  view: PipelineView;
  request: PipelineRequest;
  telemetry?: TelemetrySource | null | undefined;
}) {
  const [selection, setSelection] = useState<PipelineSelection | null>(null);
  const select = useCallback((next: PipelineSelection | null) => {
    setSelection((current) =>
      current !== null && next !== null && current.kind === next.kind && current.id === next.id
        ? null
        : next,
    );
  }, []);

  return (
    <div
      className={styles.body}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selection !== null) {
          event.stopPropagation();
          setSelection(null);
        }
      }}
    >
      {view.track.lanes.length === 0 ? null : (
        <>
          <h3 className={styles.sectionTitle}>
            One frame
            <span className={styles.sectionNote}>
              passes left to right in encode order, one lane per resource
            </span>
          </h3>
          <div className={styles.tapeWrap}>
            <PipelineTrackView
              track={view.track}
              passes={view.passes}
              selection={selection}
              onSelect={select}
            />
            <PipelineRail
              request={request}
              view={view}
              selection={selection}
              {...(telemetry === undefined ? {} : { telemetry })}
            />
          </div>
        </>
      )}

      {view.stats === null ? null : (
        <>
          <h3 className={styles.sectionTitle}>
            Will the device take it
            <span className={styles.sectionNote}>{view.limitsSummary}</span>
          </h3>
          {view.limitsNote !== null ? (
            <p className={styles.note} data-testid="pipeline-limits-absent">
              {view.limitsNote}
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table} data-testid="pipeline-limits">
                <thead>
                  <tr>
                    <th scope="col">limit</th>
                    <th scope="col">asks</th>
                    <th scope="col">grants</th>
                    <th scope="col">what asks for it</th>
                  </tr>
                </thead>
                <tbody>
                  {view.limits.map((limit) => (
                    <LimitRow key={limit.id} limit={limit} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {view.findings.length === 0 ? null : (
        <>
          <h3 className={styles.sectionTitle}>What the compiler decided</h3>
          {view.findings.map((finding) => (
            <Finding key={finding.kind} finding={finding} />
          ))}
        </>
      )}

      {view.passes.length === 0 ? null : (
        <>
          <h3 className={styles.sectionTitle}>
            The flow
            <span className={styles.sectionNote}>{view.passes.length} passes, in encode order</span>
          </h3>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">kind</th>
                  <th scope="col">node</th>
                  <th scope="col">pass</th>
                  <th scope="col">detail</th>
                </tr>
              </thead>
              <tbody>
                {view.passes.map((pass) => (
                  <tr
                    key={pass.id}
                    className={styles.passRow}
                    tabIndex={0}
                    aria-selected={selection?.kind === "pass" && selection.id === pass.id}
                    data-selected={selection?.kind === "pass" && selection.id === pass.id}
                    onClick={() => select({ kind: "pass", id: pass.id })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      select({ kind: "pass", id: pass.id });
                    }}
                  >
                    <td className={styles.step}>{pass.step}</td>
                    <td className={styles.kindCell} data-tone={PASS_TONE[pass.kind]}>
                      {pass.kind}
                    </td>
                    <td
                      className={`${styles.nodeCell} ${pass.depth > 0 ? styles.nested : ""}`.trim()}
                    >
                      {pass.label}
                    </td>
                    <td>{pass.id}</td>
                    <td>{pass.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function PipelinePanel({ open, onOpenChange, telemetry, ...request }: PipelinePanelProps) {
  const { installed, compiled, graph, registry, capabilities } = request;
  const view = useMemo(
    () => buildPipelineView({ installed, compiled, graph, registry, capabilities }),
    [installed, compiled, graph, registry, capabilities],
  );

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.panel} aria-describedby={undefined} data-testid="pipeline">
        <header className={styles.masthead}>
          <DialogTitle className={styles.title}>Pipeline</DialogTitle>
          <div
            className={styles.banner}
            data-kind={view.install.kind}
            data-testid="pipeline-install"
            {...(view.stats === null ? {} : { title: `plan ${view.stats.signature}` })}
          >
            <span className={styles.bannerHeadline}>{view.install.headline}</span>
            <span className={styles.bannerDetail}>{view.install.detail}</span>
          </div>
          {view.stats === null ? null : (
            <div className={styles.meters}>
              <Meter label="passes" value={`${view.stats.passes}`} />
              <Meter
                label="encodes / frame"
                value={`${view.stats.encodes}`}
                {...(view.stats.encodes > view.stats.passes ? { tone: "signal" as const } : {})}
              />
              <Meter label="resources" value={`${view.stats.resources}`} />
              <Meter
                label="nodes running"
                value={`${view.stats.nodes} of ${view.stats.documentNodes}`}
              />
              <Meter label="texture memory" value={formatBytes(view.stats.estimatedBytes)} />
            </div>
          )}
        </header>
        <PipelineReport view={view} request={request} {...(telemetry === undefined ? {} : { telemetry })} />
      </DialogContent>
    </DialogRoot>
  );
}
