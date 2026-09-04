import { useState } from "react";
import type { NodeFormatOverride, NodeResolutionOverride } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId, PortId } from "@domain/types/ids.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import type { ControlVariant } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { NumberField } from "@ui/controls/number-field.tsx";
import type { NumericSpec } from "@ui/controls/types.ts";
import { cx } from "@ui/cx.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import {
  FORMAT_MODE_AUTO,
  RESOLUTION_MODE_CUSTOM,
  RESOLUTION_MODE_FIT,
  RESOLUTION_MODE_LIMIT,
  RESOLUTION_MODE_INPUT,
  RESOLUTION_MODE_OPTIONS,
  formatDiagnosticsFor,
  formatModeKey,
  formatModeOptions,
  overrideForFormatMode,
  overrideForResolutionMode,
  resolutionModeKey,
} from "./resolution.ts";
import type { FormatContext, ResolutionContext, ResolvedCommon } from "./resolution.ts";
import styles from "./inspector.module.css";

/**
 * The node "Common" section (T73, §V50, §V51) — TouchDesigner's Common page.
 *
 * Two selects and a readout. The readout is the point: a user who picks "1/2" wants to
 * see the pixels they will get, not the word "1/2" — and since T1064 those pixels are
 * READ OFF THE COMPILED PLAN rather than recomputed here. Same for format, which can be
 * refused by the device: the compiler's diagnostic and the fallback it chose are surfaced
 * verbatim, and the panel makes no claim of its own about support. Duplicating either
 * decision in the UI is how the two drift apart, and for two releases they had.
 *
 * "Auto" is expressed by CLEARING the override (`null`), not by writing `{mode:"auto"}`:
 * an absent override means "whatever the definition's policy says", which is what the
 * user asked for and what keeps following the definition if it later changes.
 */

/** Resolution edits recreate render targets, so width/height are whole pixels. */
const DIMENSION_SPEC: NumericSpec = { min: 1, step: 1, precision: 0 };

/** T601: one choice row for a component instance's preview source. */
export interface ComponentPreviewChoice {
  /** Inner node id, or "" for the default entry. */
  readonly value: string;
  readonly label: string;
}

export interface CommonSectionProps {
  nodeId: NodeId;
  /**
   * T601: present only on component instances — which INNER node the instance's
   * preview shows. The default is STATED in the list (§V499: never silently first):
   * the entry with value "" names the Out node it falls back to.
   */
  componentPreview?: {
    readonly current: string;
    readonly choices: readonly ComponentPreviewChoice[];
  };
  resolution: NodeResolutionOverride | undefined;
  format: NodeFormatOverride | undefined;
  resolutionContext: ResolutionContext;
  formatContext: FormatContext;
  /**
   * What the compiler resolved for this node, or `null` when the plan has no row for it
   * (pruned, inside a component, or nothing compiled yet). Resolved once by the pane and
   * passed down: it is a READ of shared state now, not a pure function two callers may
   * each evaluate.
   */
  resolved: ResolvedCommon | null;
  diagnostics?: readonly RuntimeDiagnostic[];
  editor: ParameterEditor;
  variant?: ControlVariant;
}

export function CommonSection({
  nodeId,
  componentPreview,
  resolution,
  format,
  resolutionContext,
  formatContext,
  resolved,
  diagnostics,
  editor,
  variant = "inspector",
}: CommonSectionProps) {
  /**
   * Local draft for the custom width/height fields. A resolution change recreates
   * targets and resets feedback history (§V50, §V22), so a drag must not write one per
   * frame: intermediate values move the field, only the committed value moves the graph.
   */
  const [draft, setDraft] = useState<{ width: number; height: number } | null>(null);

  /*
   * The SEED for the Custom / Fit / Limit boxes. The plan's own numbers when there are
   * any; the project size when the node has no row, so switching modes on a pruned node
   * still writes a sane box instead of a zero.
   */
  const seed =
    resolved === null
      ? resolutionContext.project
      : { width: resolved.size.width, height: resolved.size.height };
  const shown = draft ?? seed;

  const inputs = resolutionContext.inputs ?? [];
  const selectedInput: PortId | undefined =
    (resolution !== undefined && (resolution.mode === "input" || resolution.mode === "scale")
      ? resolution.input
      : undefined) ?? inputs[0]?.portId;

  const modeKey = resolutionModeKey(resolution);
  // fit and limit carry a box the user edits, exactly as custom does.
  const hasDimensions =
    modeKey === RESOLUTION_MODE_CUSTOM ||
    modeKey === RESOLUTION_MODE_FIT ||
    modeKey === RESOLUTION_MODE_LIMIT;
  const usesInput =
    modeKey === RESOLUTION_MODE_INPUT ||
    modeKey === RESOLUTION_MODE_FIT ||
    modeKey === RESOLUTION_MODE_LIMIT ||
    modeKey.startsWith("scale:");

  const applyResolution = (override: NodeResolutionOverride | null): void => {
    setDraft(null);
    void editor.setResolution(nodeId, override);
  };

  const onModeChange = (key: string): void => {
    applyResolution(overrideForResolutionMode(key, shown, selectedInput));
  };

  const onInputChange = (portId: string): void => {
    if (modeKey === RESOLUTION_MODE_INPUT) {
      applyResolution({ mode: "input", input: portId });
      return;
    }
    applyResolution(overrideForResolutionMode(modeKey, shown, portId));
  };

  const onDimension = (axis: "width" | "height", value: number, commit: boolean): void => {
    const next = { ...shown, [axis]: Math.max(1, Math.round(value)) };
    if (!commit) {
      setDraft(next);
      return;
    }
    setDraft(null);
    // Editing the box under fit/limit must not silently switch the node to fixed.
    const mode =
      modeKey === RESOLUTION_MODE_FIT ? "fit" : modeKey === RESOLUTION_MODE_LIMIT ? "limit" : "fixed";
    void editor.setResolution(
      nodeId,
      mode === "fixed"
        ? { mode, width: next.width, height: next.height }
        : selectedInput === undefined
          ? { mode, width: next.width, height: next.height }
          : { mode, width: next.width, height: next.height, input: selectedInput },
    );
  };

  const formatDiagnostics = formatDiagnosticsFor(nodeId, diagnostics);

  return (
    <section className={styles.section} aria-label="Common">
      {/*
        No section header: since T269 the TAB carries the name, and a heading repeating
        the tab you just clicked is a line of chrome that tells you nothing. The block
        readout is gone from here too — it lives in the inspector header now, where it
        stays visible from the Parameters tab as well (§V174).
      */}
      {componentPreview === undefined ? null : (
        <ControlRow label="Preview" variant={variant}>
          <EnumField
            label="Component preview source"
            value={componentPreview.current}
            options={[...componentPreview.choices]}
            onChange={(next) => {
              void editor.setComponentPreview(nodeId, next === "" ? null : next);
            }}
          />
        </ControlRow>
      )}
      <ControlRow label="Resolution" variant={variant}>
        <EnumField
          label="Resolution mode"
          value={modeKey}
          options={RESOLUTION_MODE_OPTIONS}
          onChange={(next) => onModeChange(next)}
        />
      </ControlRow>

      {usesInput && inputs.length > 1 ? (
        <ControlRow label="Source input" variant={variant}>
          <EnumField
            label="Resolution source input"
            value={selectedInput ?? ""}
            options={inputs.map((input) => ({ value: input.portId, label: input.label }))}
            onChange={(next) => onInputChange(next)}
          />
        </ControlRow>
      ) : null}

      {hasDimensions ? (
        <ControlRow label="Size" variant={variant} hint="px">
          <div className={styles.sizeFields}>
            <NumberField
              label="Width"
              value={shown.width}
              spec={dimensionSpec(resolutionContext.maxResolution)}
              unit="px"
              onChange={(value, phase) => onDimension("width", value, phase === "commit")}
            />
            <NumberField
              label="Height"
              value={shown.height}
              spec={dimensionSpec(resolutionContext.maxResolution)}
              unit="px"
              onChange={(value, phase) => onDimension("height", value, phase === "commit")}
            />
          </div>
        </ControlRow>
      ) : null}

      <ControlRow label="Format" variant={variant}>
        <EnumField
          label="Pixel format"
          value={formatModeKey(format)}
          options={formatModeOptions(formatContext.supported)}
          onChange={(next) =>
            void editor.setFormat(
              nodeId,
              overrideForFormatMode(next === "" ? FORMAT_MODE_AUTO : next, selectedInput),
            )
          }
        />
      </ControlRow>

      {formatDiagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.code}-${index}`}
          role="alert"
          className={cx(
            styles.diagnostic,
            diagnostic.severity === "error" && styles.diagnosticError,
          )}
        >
          <span>{diagnostic.message}</span>
          {diagnostic.suggestion === undefined ? null : (
            <span className={styles.diagnosticHint}>{diagnostic.suggestion}</span>
          )}
        </div>
      ))}

      {/*
        T1064: no second "unsupported" alert. The panel used to raise one from its own
        copy of the format ladder, over the format the user ASKED for — while the plan
        was already rendering the substitute. The compiler's own `format-unsupported`
        diagnostic is directly above and names that substitute.
      */}
    </section>
  );
}

function dimensionSpec(maxResolution: number | undefined): NumericSpec {
  // §V24: the project cap is a real bound, so the control shows and enforces it.
  return maxResolution === undefined ? DIMENSION_SPEC : { ...DIMENSION_SPEC, max: maxResolution };
}

export interface CommonReadoutProps {
  /** `null` when the compiled plan has no row for this node — see `resolvedCommonFor`. */
  resolved: ResolvedCommon | null;
  /**
   * One dense line instead of a bordered block (T269). The inspector header uses it:
   * the resolved size and format are the facts you glance at constantly — and they move
   * as a CONSEQUENCE of edits elsewhere, when an input changes what a node inherits — so
   * they stay visible while the Common controls that set them go behind their tab.
   */
  compact?: boolean;
}

/**
 * The resolved size and format, in one line. Exported on its own so the node body can
 * show exactly the same readout as the inspector without re-deriving it (T73).
 *
 * §V90 in the compact form: the SOURCE words ("node default", "project") explain where
 * the number came from and are carried on hover rather than printed — they are the
 * second question, asked once. The warning flags stay inline, because "clamped" and
 * "unsupported" are STATE, not help, and state is one of the four things a dense row is
 * allowed to say.
 */
export function CommonReadout({ resolved, compact = false }: CommonReadoutProps) {
  /*
   * T1064 — THE STATE THE MIRROR COULD NOT REACH, and therefore never showed. A node that
   * is pruned, or inside a component the pane dived into, or simply not compiled yet, has
   * NO SIZE: nothing on the GPU is that many pixels wide. The old arithmetic always had an
   * answer, so it printed a confident number for a texture that does not exist. Saying
   * "no size" is the honest reading, and it is a legible one — the node is not in the plan.
   */
  if (resolved === null) {
    const title = "not in the compiled plan";
    return (
      <div
        className={compact ? styles.readoutLine : styles.readout}
        aria-label="Resolved output"
        title={title}
      >
        <span className={styles.readoutValue}>—</span>
        <span className={styles.readoutSource}>{title}</span>
      </div>
    );
  }
  const { size, format } = resolved;
  if (compact) {
    return (
      <div
        className={styles.readoutLine}
        aria-label="Resolved output"
        title={`${size.width} × ${size.height} ${size.source} · ${format.format} ${format.source}`}
      >
        <span className={styles.readoutValue}>
          {size.width} × {size.height}
        </span>
        <span className={styles.readoutDot} aria-hidden>
          ·
        </span>
        <span className={styles.readoutValue}>{format.format}</span>
        {size.clamped ? <span className={styles.readoutFlag}>clamped</span> : null}
      </div>
    );
  }
  return (
    <div className={styles.readout} aria-label="Resolved output">
      <span className={styles.readoutValue}>
        {size.width} × {size.height}
      </span>
      <span className={styles.readoutSource}>{size.source}</span>
      {/*
        T1064: "the limit in force", the compiler's own words, because it is not always
        the PROJECT's. `compiler/resolution.ts` clamps to `min(project, device)`, and the
        half that bit on the machine this bug was reported from was the device's.
      */}
      {size.clamped ? <span className={styles.readoutFlag}>clamped to the limit in force</span> : null}
      <span className={styles.readoutValue}>{format.format}</span>
      <span className={styles.readoutSource}>{format.source}</span>
    </div>
  );
}
