import { useEffect, useState } from "react";
import { desktopInputBridge, type NativeInputSourceInfo, type NativeInputTransport } from "@devices/native-input.ts";
import { NATIVE_VIDEO_LABELS } from "@devices/native-video.ts";
import { duplicateSourceWarning, nativeSourceLabel, resolveNativeSource } from "@devices/native-source-match.ts";
import { orderRequirements } from "@domain/types/requirements.ts";
import type { RuntimeRequirementId } from "@domain/types/requirements.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { TypeBadge } from "@ui/primitives/node-identity.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";

// eslint-disable-next-line react-refresh/only-export-components -- Inspector section owns its parameter claim.
export function nativeInputSectionParameters(): readonly string[] { return ["source", "sourceApp", "sourceName"]; }

/**
 * T1340b — the section says what this node NEEDS, in the tags the library uses and in the
 * colours the taxonomy assigns.
 *
 * Owner: *"if there's a limitation and warnings we show 'source macOS desktop required',
 * that should EQUALLY be highlighted in the same kind of color here."* It used to be three
 * hand-written sentences behind a nested ternary — *macOS desktop required*, *Desktop with
 * local NDI SDK required*, and Spout's own paragraph — none of which matched the library's
 * words for the same fact. The requirements arrive from the NODE'S OWN DECLARATION
 * (`NodeDefinition.requires`, read by the inspector and handed down), so this component
 * neither knows nor can disagree about what a Syphon node needs.
 *
 * The node itself also carries a WARNING for the same fact (`use-requirement-diagnostics.ts`),
 * which is where "why is this black" gets answered. This is the reference copy under the
 * control it disables — §V90's place for help, not a second alarm.
 */
export function NativeInputSection({ nodeId, source, identity, editor, transport, requirements }: {
  nodeId: string; source: string; editor: ParameterEditor; transport: NativeInputTransport;
  /** VN113: the stored app + server name, for a node that keeps them (Syphon In). Absent
   * for a transport whose id is already its name (NDI) — the picker then writes `source` only. */
  identity?: { readonly app: string; readonly name: string } | undefined;
  /** The node's own declaration, resolved for this instance's parameters. */
  requirements: readonly RuntimeRequirementId[];
}) {
  const [sources, setSources] = useState<readonly NativeInputSourceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bridge = desktopInputBridge(transport);
  const label = NATIVE_VIDEO_LABELS[transport];
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try { const found = await bridge.list(); if (live) { setSources(found); setError(null); } }
      catch (error) { if (live) setError(String(error)); }
      finally { busy = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [bridge]);
  /* VN113: the section shows what the node is bound to by the SAME resolution the hook
     opens with, so "Bound to" here and the session there cannot name different servers. */
  const stored = { id: source, app: identity?.app ?? "", name: identity?.name ?? "" };
  const match = resolveNativeSource(stored, sources);
  const named = stored.app !== "" || stored.name !== "";
  const selected = match.kind === "bound" ? match.source.id : source;
  const missing = match.kind === "unresolved" && source !== "" && !sources.some(entry => entry.id === source)
    ? [{ value: source, label: `${named ? nativeSourceLabel(stored) : source} (not running)` }] : [];
  const status = !bridge || match.kind === "unselected" ? null
    : match.kind === "unresolved" ? `Waiting for ${named ? nativeSourceLabel(stored) : "the selected source"}`
    : match.candidates > 1 ? duplicateSourceWarning(match.source, match.candidates)
    : `Bound to ${nativeSourceLabel(match.source)}`;
  const choose = (value: string) => {
    const entry = sources.find(candidate => candidate.id === value);
    if (identity === undefined) editor.setParameter(nodeId, "source", value, "commit");
    // One patch: the id (a tie-breaker) and the identity it is kept by.
    else editor.setStored(nodeId, { source: value, sourceApp: entry?.app ?? "", sourceName: entry?.name ?? "" }, "commit");
  };
  return <section className={styles.section} aria-label={label}>
    <div className={styles.sectionHeader}><span>{label}</span><span className={styles.sectionRule} aria-hidden /></div>
    <ControlRow label="Source">
      <EnumField label={`${label} source`} value={selected} disabled={!bridge}
        options={[{ value: "", label: "Select source" }, ...missing, ...sources.map(entry => ({ value: entry.id, label: `${entry.app} / ${entry.name}` }))]}
        onChange={choose} />
    </ControlRow>
    {status === null ? null : <span className={styles.statusHint} role="status">{status}</span>}
    {error === null ? null : <span className={styles.statusHint}>{error}</span>}
    {bridge ? null : <span className={styles.requirementTags}>
      {orderRequirements(requirements).map(requirement => (
        <TypeBadge key={requirement.id} label={requirement.label}
          category={requirement.category} title={requirement.description} />
      ))}
    </span>}
  </section>;
}
