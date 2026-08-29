import { useMemo } from "react";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import {
  expressionFunctions,
  expressionOperators,
  expressionSuggestions,
  expressionVariables,
  previewExpression,
} from "./expression-reference.ts";
import styles from "./help.module.css";

/**
 * Expression authoring, surfaced where the expression is written (T201, §V105, §V71).
 *
 * Parameter modes landed and nothing said so. A mode you can only find by reading the
 * spec is not shipped, and "which names can I use here?" is not a manual question — it
 * is a question about THIS parameter, asked while typing into it. So this renders beside
 * the editor and answers three things at once:
 *
 *  - what the source currently EVALUATES TO, against the same scope the resolver will
 *    use, updated as it is typed. A number on screen settles an argument a paragraph
 *    cannot;
 *  - which VARIABLES exist, each showing its value right now — `time`, `delta`, `frame`
 *    from the frame input, plus whatever node context the caller passed (§V71);
 *  - which operators and functions the evaluator accepts, probed rather than listed.
 *
 * It owns no editing. The parameter mode buttons and the source field belong to the
 * inspector's control kit; this is the help beside them, and `onInsert` is how it hands
 * a name back to whoever does own the field.
 */

export interface ExpressionHelpProps {
  /** The source being edited. Empty is fine — the preview simply has nothing to show. */
  source: string;
  /** The scope the expression will really be evaluated against (§V61). */
  scope: ExpressionScope;
  /** Insert a name or a starter at the caret. Absent = the lists are read-only. */
  onInsert?: (text: string) => void;
}

/** Short enough to sit in a row, precise enough to see a value move. */
function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function ExpressionHelp({ source, scope, onInsert }: ExpressionHelpProps) {
  const preview = useMemo(() => previewExpression(source, scope), [source, scope]);
  const variables = useMemo(() => expressionVariables(scope), [scope]);
  const suggestions = useMemo(() => expressionSuggestions(scope), [scope]);
  // Probes against the evaluator; the grammar does not change between renders.
  const operators = useMemo(() => expressionOperators(), []);
  const functions = useMemo(() => expressionFunctions(), []);

  const insert = (text: string): void => onInsert?.(text);

  return (
    <div className={styles.expression}>
      <div className={styles.preview} role="status" aria-label="Result">
        {preview.state === "empty" ? (
          <span className={styles.previewDim}>no expression</span>
        ) : preview.state === "value" ? (
          <span className={styles.previewValue}>= {formatValue(preview.value)}</span>
        ) : (
          <span className={styles.previewError}>{preview.reason}</span>
        )}
      </div>

      <section className={styles.section} aria-label="Variables">
        <h4 className={styles.sectionHeader}>Variables</h4>
        <div className={styles.chips}>
          {variables.map((variable) => (
            <button
              key={variable.name}
              type="button"
              className={styles.chip}
              disabled={onInsert === undefined}
              onClick={() => insert(variable.name)}
            >
              <span className={styles.chipName}>{variable.name}</span>
              <span className={styles.chipValue}>{formatValue(variable.value)}</span>
            </button>
          ))}
        </div>
      </section>

      {suggestions.length === 0 ? null : (
        <section className={styles.section} aria-label="Starters">
          <h4 className={styles.sectionHeader}>Starters</h4>
          <div className={styles.chips}>
            {suggestions.map((sample) => (
              <button
                key={sample.source}
                type="button"
                className={styles.chip}
                disabled={onInsert === undefined}
                onClick={() => insert(sample.source)}
              >
                <span className={styles.chipName}>{sample.source}</span>
                <span className={styles.chipValue}>{formatValue(sample.value)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className={styles.section} aria-label="Operators">
        <h4 className={styles.sectionHeader}>Operators</h4>
        <div className={styles.chips}>
          {operators.map((sample) => (
            <span key={sample.source} className={styles.chipStatic}>
              <span className={styles.chipName}>{sample.source}</span>
              <span className={styles.chipValue}>{formatValue(sample.value)}</span>
            </span>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-label="Functions">
        <h4 className={styles.sectionHeader}>Functions</h4>
        {functions.length === 0 ? (
          <p className={styles.none}>none</p>
        ) : (
          <div className={styles.chips}>
            {functions.map((name) => (
              <button
                key={name}
                type="button"
                className={styles.chip}
                disabled={onInsert === undefined}
                onClick={() => insert(`${name}(`)}
              >
                <span className={styles.chipName}>{name}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
