import { useMemo } from "react";
import { DialogContent, DialogRoot, DialogTitle } from "@ui/primitives/dialog.tsx";
import { formatBytes } from "./format.ts";
import { buildPipelineView } from "./pipeline-model.ts";
import type { PipelineFinding, PipelineRequest, PipelineView } from "./pipeline-model.ts";
import styles from "./pipeline.module.css";

/**
 * The pipeline inspector (T1188) — "the magic under the hood", on demand.
 *
 * A modal opened by `ui.showPipeline`, never a permanent pane (§V90): it answers a
 * question somebody asks at a moment, and the answer is long.
 *
 * ## The banner is the feature
 *
 * §B179 and §T1163 are the reason this screen exists at all in this shape. The banner
 * states which plan is being described and whether the GPU is holding it, BEFORE any
 * pass name — because "the graph does not compile and you are looking at an older
 * pipeline" is more valuable than every other row on the page put together, and it is
 * exactly the state somebody is in when they open this.
 *
 * ## Findings before the flow
 *
 * The pass list is a table of contents and it is last. What comes first is what the
 * compiler DECIDED: what it could not reach, where format and resolution move, where a
 * loop closed through an edge the canvas does not draw (§V285), where a component
 * flattened, where substeps expand, where resources alias. Every finding renders even
 * when it found nothing, because "every pass writes at the format it reads" is an answer
 * and a missing section is not.
 */

export interface PipelinePanelProps extends PipelineRequest {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
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
      <div className={styles.banner} data-kind={view.install.kind} data-testid="pipeline-install">
        <span className={styles.bannerHeadline}>{view.install.headline}</span>
        <span className={styles.bannerDetail}>{view.install.detail}</span>
      </div>

      {view.stats === null ? null : (
        <div className={styles.statRow}>
          <Stat label="passes" value={`${view.stats.passes}`} />
          <Stat label="resources" value={`${view.stats.resources}`} />
          <Stat label="nodes running" value={`${view.stats.nodes} of ${view.stats.documentNodes}`} />
          <Stat label="texture memory" value={formatBytes(view.stats.estimatedBytes)} />
          <Stat label="plan signature" value={view.stats.signature.slice(0, 12)} />
        </div>
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
          <h3 className={styles.sectionTitle}>The flow — {view.passes.length} passes, in encode order</h3>
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
                    <td className={styles.kind}>{pass.kind}</td>
                    <td className={pass.depth > 0 ? styles.nested : undefined}>{pass.label}</td>
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
        <DialogTitle className={styles.title}>Pipeline</DialogTitle>
        <PipelineReport view={view} />
      </DialogContent>
    </DialogRoot>
  );
}
