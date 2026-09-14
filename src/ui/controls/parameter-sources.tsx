import type { CSSProperties } from "react";
import { cx } from "../cx.ts";
import { NodeIdentity } from "../primitives/node-identity.tsx";
import styles from "./controls.module.css";

/**
 * WHICH NODE an expression on this row reads — T1336b.
 *
 * ## The defect this exists for
 *
 * §T987 gave a name-reference parameter (a Render's camera, a Feedback's source) a picker
 * that names what it points at, in the hue of the dashed line it causes. The owner's
 * complaint outlived it, because the document they were describing does not contain one:
 * E10 Instanced Torus has NO camera reference at all. Its only reference is
 * `renderInstances.rotate.y`, an expression slot holding `op('lfo1').chan.value`.
 *
 * At rest that row said `expr` on the label and drew a one-letter `E` on the Y axis. Both
 * are true and neither says WHO. The name `lfo1` was written down exactly once, inside the
 * expression text, behind the mode-panel disclosure — so the canvas drew a dashed line to
 * a node the panel would not name until you clicked. That is the same shape §T987 repaired
 * wearing the other binding mode: a relationship stated on one surface and unreadable on
 * the other.
 *
 * ## What it is, and what it is NOT
 *
 * A READOUT of the dependencies the document already has — `dependenciesFrom` in
 * `@domain/graph`, the same walk `parameterDependencies` hands the canvas, so the names
 * here and the lines there cannot disagree about who reads whom (§V154). It is not an
 * editor: the expression text is still edited in the mode panel, and DRAGGING a node into
 * one is §T986, a separate row. This says what is already true.
 *
 * ## Reuse, not re-derivation
 *
 *  - `NodeIdentity` — the app's one name+type pairing (§T954/§T877), the same one §T987's
 *    reference chips wear. A second spelling of "a node, and what it is" is exactly what
 *    the owner objected to when the example library grew its own badge.
 *  - `.referenceChip` / `.referenceDash` / `.referenceName` — §T987's chip, unchanged. The
 *    dash IS the canvas line at row scale, and it is painted from `--reference-hue`, which
 *    the caller fills from `REFERENCE_KIND_COLOR`. One table, two surfaces, no drift.
 *  - `.axisLabel` — the vector field's own channel letter, so the `y` naming the driven
 *    channel is spelled the way the field above it spells it.
 */

export interface ParameterSourceView {
  /**
   * `REFERENCE_KIND_COLOR[kind]` — the very entry the canvas strokes this relationship's
   * dashed line with. Handed in because the table lives with the lines in `src/editor`,
   * and this kit is the layer underneath.
   */
  readonly color: string;
  /** The node being read, by LABEL — what `op()` addresses it by (§B170). */
  readonly name: string;
  /** Its machine type, for the badge: `lfo`, `audio`, `mouse`. */
  readonly type: string;
  /** The component this binding sits on (`y`), or null when the whole parameter carries it. */
  readonly channel: string | null;
  /** As written in the document: `lfo1`, or a channel address like `mouse1:x`. */
  readonly address: string;
}

export interface ParameterSourcesProps {
  /** The parameter's label, for the hover sentence and as the group's DOM handle. */
  label: string;
  sources: readonly ParameterSourceView[];
}

export function ParameterSources({ label, sources }: ParameterSourcesProps) {
  if (sources.length === 0) return null;
  return (
    <ul
      className={cx(styles.referenceChips, styles.parameterSources)}
      data-parameter-sources={label}
    >
      {sources.map((source) => (
        <li
          className={styles.referenceChip}
          key={`${source.channel ?? ""}|${source.name}`}
          data-parameter-source={source.name}
          {...(source.channel === null ? {} : { "data-parameter-channel": source.channel })}
          /*
           * §V17: the value is the `var(--port-…)` token reference handed down from
           * `REFERENCE_KIND_COLOR`, never a literal colour. The stylesheet reads it for
           * the dash, so the mark and the line are the same paint by construction.
           */
          style={{ "--reference-hue": source.color } as CSSProperties}
          /* §V90 — the whole sentence hangs off the mark, on demand, not beside it. */
          title={`${label}${source.channel === null ? "" : `.${source.channel}`} reads ${source.address} — the dashed line on the canvas`}
        >
          <span className={styles.referenceDash} aria-hidden />
          {source.channel === null ? null : (
            <span className={styles.axisLabel}>{source.channel}</span>
          )}
          <NodeIdentity
            name={source.name}
            type={source.type}
            nameClassName={styles.referenceName}
          />
        </li>
      ))}
    </ul>
  );
}
