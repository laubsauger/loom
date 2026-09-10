import { useEffect, useState } from "react";
import { desktopInputBridge, type NativeInputSourceInfo } from "@devices/native-input.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";

// eslint-disable-next-line react-refresh/only-export-components -- Inspector section owns its parameter claim.
export function syphonSectionParameters(): readonly string[] { return ["source"]; }

export function SyphonSection({ nodeId, source, editor }: { nodeId: string; source: string; editor: ParameterEditor }) {
  const [sources, setSources] = useState<readonly NativeInputSourceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bridge = desktopInputBridge();
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
  return <section className={styles.section} aria-label="Syphon">
    <div className={styles.sectionHeader}><span>Syphon</span><span className={styles.sectionRule} aria-hidden /></div>
    <ControlRow label="Source">
      <EnumField label="Syphon source" value={source} disabled={!bridge}
        options={[{ value: "", label: "Select source" }, ...sources.map(entry => ({ value: entry.id, label: `${entry.app} / ${entry.name}` }))]}
        onChange={value => editor.setParameter(nodeId, "source", value, "commit")} />
    </ControlRow>
    {!bridge || error ? <span className={styles.statusHint}>{error ?? "macOS desktop required"}</span> : null}
  </section>;
}
