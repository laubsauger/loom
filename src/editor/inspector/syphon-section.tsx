import { useEffect, useState } from "react";
import { desktopInputBridge, type NativeInputSourceInfo, type NativeInputTransport } from "@devices/native-input.ts";
import { NATIVE_VIDEO_LABELS, SPOUT_UNAVAILABLE } from "@devices/native-video.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";

// eslint-disable-next-line react-refresh/only-export-components -- Inspector section owns its parameter claim.
export function nativeInputSectionParameters(): readonly string[] { return ["source"]; }

export function NativeInputSection({ nodeId, source, editor, transport }: {
  nodeId: string; source: string; editor: ParameterEditor; transport: NativeInputTransport;
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
  return <section className={styles.section} aria-label={label}>
    <div className={styles.sectionHeader}><span>{label}</span><span className={styles.sectionRule} aria-hidden /></div>
    <ControlRow label="Source">
      <EnumField label={`${label} source`} value={source} disabled={!bridge}
        options={[{ value: "", label: "Select source" }, ...sources.map(entry => ({ value: entry.id, label: `${entry.app} / ${entry.name}` }))]}
        onChange={value => editor.setParameter(nodeId, "source", value, "commit")} />
    </ControlRow>
    {!bridge || error ? <span className={styles.statusHint}>{error ?? (transport === "spout" ? SPOUT_UNAVAILABLE : transport === "ndi"
      ? "Desktop with local NDI SDK required" : "macOS desktop required")}</span> : null}
  </section>;
}
