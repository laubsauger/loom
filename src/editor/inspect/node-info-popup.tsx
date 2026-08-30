import type { ReactNode } from "react";
import { DEFAULT_PREVIEW_LENS, PREVIEW_LENSES, isDefaultLens } from "@runtime/previews/index.ts";
import type { PreviewLens, PreviewLensKind } from "@runtime/previews/index.ts";
import type { TimingBucket } from "@runtime/telemetry/index.ts";
import { MAX_EXPOSURE_STOPS } from "@editor/viewer/index.ts";
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
  /**
   * The preview LENS for this node, and the way to change it (T336).
   *
   * Handed in rather than read: §V85 keeps this file a pure function of its props, so the
   * lens controls dispatch through a callback the host turns into a bus command, exactly as
   * every fact above arrives already-computed. Omit `onLens` and the section does not render
   * at all — a popup with no way to apply a lens must not show one (§V90).
   */
  readonly lens?: PreviewLens | undefined;
  readonly onLens?: ((patch: Partial<PreviewLens>) => void) | undefined;
  readonly onLensReset?: (() => void) | undefined;
}

const LENS_LABEL: Readonly<Record<PreviewLensKind, string>> = {
  rgb: "RGB",
  r: "R",
  g: "G",
  b: "B",
  a: "A",
  luminance: "LUM",
};

const LENS_TITLE: Readonly<Record<PreviewLensKind, string>> = {
  rgb: "Colour — the picture as this node renders it",
  r: "Isolate red, as grayscale",
  g: "Isolate green, as grayscale",
  b: "Isolate blue, as grayscale",
  a: "Alpha coverage over a checkerboard",
  luminance: "Luminance (Rec.709), as grayscale",
};

function formatStops(stops: number): string {
  return `${stops > 0 ? "+" : ""}${stops} EV`;
}

/**
 * The preview lens controls (T336, §V255).
 *
 * ## Why they live in this popup
 *
 * Because it is the surface that is already transient, already scoped to one node, and
 * already opened by one command from three routes — middle click, the `?` binding, the node
 * menu's Info item. The alternative the owner has pushed back on repeatedly (§V90/§V91/§V92)
 * is a row of channel buttons living permanently on every node body; this puts the same
 * controls behind a gesture and costs zero pixels of chrome when nobody is inspecting.
 *
 * It also happens to be the only placement where you can WATCH the thing you are changing:
 * the popup anchors under the node, so the node's own preview stays visible above it, and a
 * context menu — the other candidate — closes on every click, so changing three things would
 * mean opening it three times.
 *
 * ## What it deliberately does not offer
 *
 * The `nan` and `signed` diagnostic modes, the checkerboard size and the signed scale. They
 * are real capabilities of `PreviewView`, and putting all seven fields here would rebuild the
 * cluttered panel this placement exists to avoid. The lens vocabulary is the small set with a
 * question behind each entry.
 */
function PreviewLensControls({
  lens,
  onLens,
  onLensReset,
}: {
  lens: PreviewLens;
  onLens: (patch: Partial<PreviewLens>) => void;
  onLensReset: (() => void) | undefined;
}) {
  const dirty = !isDefaultLens(lens);
  const step = (delta: number): void => {
    const next = Math.max(-MAX_EXPOSURE_STOPS, Math.min(MAX_EXPOSURE_STOPS, lens.exposureStops + delta));
    onLens({ exposureStops: next });
  };

  return (
    <section className={styles.section} aria-label="Preview lens">
      <h4
        className={styles.sectionTitle}
        // §V90 — the explanation hangs off the label, it does not sit under it as a sentence.
        title="Preview only — the node still renders what it renders."
      >
        preview lens
      </h4>

      <div className={styles.lensRow} role="group" aria-label="Channel">
        {PREVIEW_LENSES.map((kind) => (
          <button
            key={kind}
            type="button"
            className={styles.lensButton}
            aria-pressed={lens.lens === kind}
            data-active={lens.lens === kind}
            title={LENS_TITLE[kind]}
            onClick={() => onLens({ lens: kind })}
          >
            {LENS_LABEL[kind]}
          </button>
        ))}
      </div>

      <div className={styles.lensRow}>
        <span className={styles.lensLabel}>exposure</span>
        <button
          type="button"
          className={styles.lensButton}
          aria-label="Exposure down one stop"
          disabled={lens.exposureStops <= -MAX_EXPOSURE_STOPS}
          onClick={() => step(-1)}
        >
          −
        </button>
        <span className={styles.lensValue} data-testid="lens-exposure">
          {formatStops(lens.exposureStops)}
        </span>
        <button
          type="button"
          className={styles.lensButton}
          aria-label="Exposure up one stop"
          disabled={lens.exposureStops >= MAX_EXPOSURE_STOPS}
          onClick={() => step(1)}
        >
          +
        </button>
        <button
          type="button"
          className={styles.lensButton}
          aria-pressed={lens.tonemap}
          data-active={lens.tonemap}
          title="Filmic tonemap after exposure; off shows clipping"
          onClick={() => onLens({ tonemap: !lens.tonemap })}
        >
          tonemap
        </button>
        {/* Only offered when there is something to undo — §V90's "nothing that does nothing". */}
        {dirty && onLensReset !== undefined ? (
          <button
            type="button"
            className={styles.lensButton}
            title="Back to the plain picture"
            onClick={onLensReset}
          >
            reset
          </button>
        ) : null}
      </div>
    </section>
  );
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

export function NodeInfoPopup({ info, lens, onLens, onLensReset }: NodeInfoPopupProps) {
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

      {/* No materialized texture means no preview to look through, so no controls (§V90). */}
      {output === null || onLens === undefined ? null : (
        <PreviewLensControls
          lens={lens ?? DEFAULT_PREVIEW_LENS}
          onLens={onLens}
          onLensReset={onLensReset}
        />
      )}

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
