import { useState } from "react";
import type { NodeFormatOverride, NodeResolutionOverride } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId, PortId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
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
  resolveNodeFormat,
  resolveNodeSize,
} from "./resolution.ts";
import type { FormatContext, ResolutionContext, ResolvedFormat, ResolvedSize } from "./resolution.ts";
import styles from "./inspector.module.css";

/**
 * The node "Common" section (T73, §V50, §V51) — TouchDesigner's Common page.
 *
 * Two selects and a readout. The readout is the point: a user who picks "1/2" wants to
 * see the pixels they will get, not the word "1/2". Same for format, which can be
 * refused by the device — when the compiler says a format is unsupported, its
 * diagnostic (and the fallback it chose) is surfaced here verbatim. The fallback
 * decision stays in the compiler; duplicating it in the UI is how the two drift apart.
 *
 * "Auto" is expressed by CLEARING the override (`null`), not by writing `{mode:"auto"}`:
 * an absent override means "whatever the definition's policy says", which is what the
 * user asked for and what keeps following the definition if it later changes.
 */

/** Resolution edits recreate render targets, so width/height are whole pixels. */
const DIMENSION_SPEC: NumericSpec = { min: 1, step: 1, precision: 0 };

export interface CommonSectionProps {
  nodeId: NodeId;
  definition: NodeDefinition | undefined;
  resolution: NodeResolutionOverride | undefined;
  format: NodeFormatOverride | undefined;
  resolutionContext: ResolutionContext;
  formatContext: FormatContext;
  diagnostics?: readonly RuntimeDiagnostic[];
  editor: ParameterEditor;
  variant?: ControlVariant;
}

export function CommonSection({
  nodeId,
  definition,
  resolution,
  format,
  resolutionContext,
  formatContext,
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

  const size = resolveNodeSize(resolution, definition?.resolutionPolicy, resolutionContext);
  const resolvedFormat = resolveNodeFormat(format, definition?.formatPolicy, formatContext);
  const shown = draft ?? { width: size.width, height: size.height };

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
    applyResolution(
      overrideForResolutionMode(key, { width: size.width, height: size.height }, selectedInput),
    );
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
      <div className={styles.sectionHeader}>
        <span>Common</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

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
              defaultValue={resolutionContext.project.width}
              spec={dimensionSpec(resolutionContext.maxResolution)}
              unit="px"
              onChange={(value, phase) => onDimension("width", value, phase === "commit")}
            />
            <NumberField
              label="Height"
              value={shown.height}
              defaultValue={resolutionContext.project.height}
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

      <CommonReadout size={size} format={resolvedFormat} />

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

      {formatDiagnostics.length === 0 && !resolvedFormat.supported ? (
        <div role="alert" className={styles.diagnostic}>
          <span>
            {resolvedFormat.format} is not in this device&apos;s capability report; the compiler
            will fall back.
          </span>
          <span className={styles.diagnosticHint}>
            Pick a supported format, or accept the documented fallback (§V51).
          </span>
        </div>
      ) : null}
    </section>
  );
}

function dimensionSpec(maxResolution: number | undefined): NumericSpec {
  // §V24: the project cap is a real bound, so the control shows and enforces it.
  return maxResolution === undefined ? DIMENSION_SPEC : { ...DIMENSION_SPEC, max: maxResolution };
}

export interface CommonReadoutProps {
  size: ResolvedSize;
  format: ResolvedFormat;
}

/**
 * The resolved size and format, in one line. Exported on its own so the node body can
 * show exactly the same readout as the inspector without re-deriving it (T73).
 */
export function CommonReadout({ size, format }: CommonReadoutProps) {
  return (
    <div className={styles.readout} aria-label="Resolved output">
      <span className={styles.readoutValue}>
        {size.width} × {size.height}
      </span>
      <span className={styles.readoutSource}>{size.source}</span>
      {size.clamped ? <span className={styles.readoutFlag}>clamped to project limit</span> : null}
      <span className={styles.readoutValue}>{format.format}</span>
      <span className={styles.readoutSource}>{format.source}</span>
      {format.supported ? null : <span className={styles.readoutFlag}>unsupported</span>}
    </div>
  );
}
