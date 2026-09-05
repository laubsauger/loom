import { useMemo } from "react";
import { DialogContent, DialogRoot, DialogTitle } from "@ui/primitives/dialog.tsx";
import { formatBytes } from "./format.ts";
import { buildPipelineView } from "./pipeline-model.ts";
import type {
  PipelineFinding,
  PipelinePassRow,
  PipelineRequest,
  PipelineView,
} from "./pipeline-model.ts";
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
 * 2. THE FRAME, AS A PICTURE. Encode order, storage reuse and the loop that closes
 *    across the frame boundary — see `pipeline-track.tsx` for why this is a Gantt chart
 *    and deliberately not a second drawing of the node graph.
 * 3. THE DECISIONS, in words. Every finding renders even when it found nothing, because
 *    "every pass writes at the format it reads" is an answer and a missing section is
 *    not.
 * 4. THE FLOW. The pass table is a table of contents and it is last.
 *
 * The masthead's meter strip is the app's own top bar idiom — dim uppercase label, mono
 * tabular value, hairline divider — rather than a row of cards, because this panel is
 * part of an instrument and should read like the rest of it.
 */

export interface PipelinePanelProps extends PipelineRequest {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function PipelineReport({ view }: { view: PipelineView }) {
  return (
    <div className={styles.body}>
      {view.track.lanes.length === 0 ? null : (
        <>
          <h3 className={styles.sectionTitle}>
            One frame
            <span className={styles.sectionNote}>
              passes left to right in encode order, one lane per resource
            </span>
          </h3>
          <PipelineTrackView track={view.track} passes={view.passes} />
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
                  <tr key={pass.id}>
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

export function PipelinePanel({ open, onOpenChange, ...request }: PipelinePanelProps) {
  const { installed, compiled, graph, registry } = request;
  const view = useMemo(
    () => buildPipelineView({ installed, compiled, graph, registry }),
    [installed, compiled, graph, registry],
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
        <PipelineReport view={view} />
      </DialogContent>
    </DialogRoot>
  );
}
