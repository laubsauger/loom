import type { ReactNode } from "react";
import type { TimingBucket } from "@runtime/telemetry/index.ts";
import { formatAspect, formatBytes, formatMs } from "./format.ts";
import type { NodeInfo } from "./node-info-model.ts";
import { formatLabel, spaceLabel } from "./node-info-model.ts";
import styles from "./inspect.module.css";

/**
 * The node info popup's body (T145, §I.info, §V85, §V86).
 *
 * Pure presentation over a `NodeInfo`. It fetches nothing, subscribes to nothing and
 * cannot: everything it shows arrived as a prop, which is what makes the whole surface
 * renderable from a fixture with no GPU and no running frame loop.
 *
 * The formatters below are the §V86 boundary in practice. `gpuMs` is `number | null`, and
 * a null is rendered as a word — "unavailable" or "measuring" — never as `0.00 ms`. There
 * is no code path in this file that turns an absent measurement into a digit.
 */

export interface NodeInfoPopupProps {
  readonly info: NodeInfo;
}

function Value({ children, absent }: { children: ReactNode; absent?: boolean }) {
  return <dd className={absent === true ? styles.absent : undefined}>{children}</dd>;
}

function Timing({ label, bucket }: { label: string; bucket: TimingBucket }) {
  const ms = formatMs(bucket);
  return (
    <>
      <dt>{label}</dt>
      <Value absent={ms.absent}>{ms.text}</Value>
    </>
  );
}

function Badge({ tone, children }: { tone?: "warn" | "error" | "signal"; children: ReactNode }) {
  return (
    <span className={styles.badge} {...(tone === undefined ? {} : { "data-tone": tone })}>
      {children}
    </span>
  );
}

export function NodeInfoPopup({ info }: NodeInfoPopupProps) {
  const { timing, output } = info;
  const severity = info.errorCount > 0 ? "error" : info.warningCount > 0 ? "warning" : "info";

  return (
    <div className={styles.popup} data-testid="node-info">
      <div className={styles.identity}>
        <span className={styles.name}>{info.label}</span>
        <span className={styles.subtitle}>
          {info.typeTitle} · {info.nodeId}
        </span>
        {info.sourcePath === null ? null : (
          // §V82: a flattened node names a place the user can navigate to, never the
          // namespaced internal id the compiler invented for it.
          <span className={styles.subtitle}>{info.sourcePath}</span>
        )}
      </div>

      <div className={styles.badges}>
        {info.isComponent ? (
          <Badge tone="signal">
            component{info.componentVersion === null ? "" : ` v${info.componentVersion}`}
          </Badge>
        ) : null}
        {info.bypassed ? <Badge tone="warn">bypassed</Badge> : null}
        {info.muted ? <Badge tone="warn">muted</Badge> : null}
        {info.pruned ? <Badge tone="warn">pruned</Badge> : null}
        {info.stale ? <Badge tone="warn">stale</Badge> : null}
        {info.errorCount > 0 ? <Badge tone="error">{info.errorCount} error</Badge> : null}
        {info.warningCount > 0 ? <Badge tone="warn">{info.warningCount} warning</Badge> : null}
        <Badge>{info.status}</Badge>
      </div>

      <section className={styles.section} aria-label="Cook">
        <h4 className={styles.sectionTitle}>cook</h4>
        <dl className={styles.facts}>
          {info.isComponent ? (
            <>
              {/* §V87: a component's own pass is not the answer to "what does this cost
                  me" — the work is in what it contains, so all three are shown. */}
              <Timing label="own" bucket={timing.own} />
              <Timing label="children" bucket={timing.children} />
              <Timing label="total" bucket={timing.total} />
              <dt>nodes</dt>
              <Value>
                {timing.own.nodeCount} own · {timing.children.nodeCount} nested ·{" "}
                {timing.total.nodeCount} total
              </Value>
            </>
          ) : (
            <Timing label="gpu time" bucket={timing.own} />
          )}
          <dt>passes</dt>
          <Value>{timing.total.passCount}</Value>
          <dt>frames</dt>
          <Value>{info.framesRendered}</Value>
          <dt>this frame</dt>
          <Value>{info.renderedThisFrame ? "yes" : "no"}</Value>
          <dt>last frame</dt>
          <Value absent={info.lastRenderedFrame === null}>
            {info.lastRenderedFrame === null ? "never rendered" : info.lastRenderedFrame}
          </Value>
        </dl>
        {info.timingAvailable ? null : (
          <p className={styles.note}>
            This device reports no <code>timestamp-query</code> feature, so per-pass GPU
            spans cannot be measured. No timing is estimated in its place.
          </p>
        )}
      </section>

      <section className={styles.section} aria-label="Output">
        <h4 className={styles.sectionTitle}>output</h4>
        {output === null ? (
          <p className={styles.note}>
            This node materializes no texture in the current plan, so it has no resolution,
            format or memory of its own.
          </p>
        ) : (
          <dl className={styles.facts}>
            <dt>resolution</dt>
            <Value>
              {output.resolution[0]} × {output.resolution[1]}
            </Value>
            <dt>aspect</dt>
            <Value>{formatAspect(output.aspect)}</Value>
            <dt>format</dt>
            <Value>
              {output.format} · {formatLabel(output.format)}
            </Value>
            <dt>space</dt>
            <Value>{spaceLabel(output.space)}</Value>
            <dt>gpu memory</dt>
            <Value>{formatBytes(info.estimatedBytes)}</Value>
            {output.temporal ? (
              <>
                <dt>temporal</dt>
                <Value>ping-pong pair (previous frame available)</Value>
              </>
            ) : null}
            {info.outputs.length > 1 ? (
              <>
                <dt>outputs</dt>
                <Value>{info.outputs.map((entry) => entry.portId).join(", ")}</Value>
              </>
            ) : null}
          </dl>
        )}
      </section>

      <section className={styles.section} aria-label="Decided by">
        <h4 className={styles.sectionTitle}>decided by</h4>
        <dl className={styles.facts}>
          <dt>resolution</dt>
          <Value>{info.resolutionDecision.detail}</Value>
          <dt>format</dt>
          <Value>{info.formatDecision.detail}</Value>
        </dl>
      </section>

      {info.message === null && info.agent === null ? null : (
        <section className={styles.section} aria-label="State">
          <h4 className={styles.sectionTitle}>state</h4>
          {info.message === null ? null : (
            <p className={styles.message} data-severity={severity}>
              {info.message}
            </p>
          )}
          {info.agent === null ? null : (
            // §V42 — agent work is never invisible, including here.
            <p className={styles.note}>
              {info.agent.actorLabel} is {info.agent.kind}
              {info.agent.detail === undefined ? "" : ` — ${info.agent.detail}`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
