import type { ReactNode } from "react";
import { TabBadge, TabsContent, TabsList, TabsRoot, TabsTrigger } from "@ui/primitives/tabs.tsx";
import { PaneEmpty } from "./pane.tsx";
import type { DockTab } from "./layout-storage.ts";
import { DOCK_TABS } from "./layout-storage.ts";
import styles from "./app-shell.module.css";

export interface BottomDockProps {
  value: DockTab;
  onValueChange: (value: DockTab) => void;
  shaderEditor?: ReactNode;
  problems?: ReactNode;
  performance?: ReactNode;
  /** Error count shown on the problems tab (V27 surfaces WGSL errors here). */
  problemCount?: number;
}

function asDockTab(value: string): DockTab | null {
  return DOCK_TABS.find((tab) => tab === value) ?? null;
}

/**
 * Bottom dock (§I.ui): shader editor | problems | performance.
 * The tab strip is the dock's only header — no second row of chrome.
 */
export function BottomDock({
  value,
  onValueChange,
  shaderEditor,
  problems,
  performance,
  problemCount = 0,
}: BottomDockProps) {
  return (
    <TabsRoot
      className={styles.dock}
      value={value}
      onValueChange={(next) => {
        const tab = asDockTab(next);
        if (tab) onValueChange(tab);
      }}
    >
      <TabsList aria-label="Bottom dock">
        <TabsTrigger value="shader">shader editor</TabsTrigger>
        <TabsTrigger value="problems">
          problems
          {problemCount > 0 ? <TabBadge tone="error">{problemCount}</TabBadge> : null}
        </TabsTrigger>
        <TabsTrigger value="performance">performance</TabsTrigger>
      </TabsList>

      <TabsContent value="shader">
        {shaderEditor ?? (
          <PaneEmpty label="Shader editor" hint="CodeMirror 6 WGSL editor mounts here" />
        )}
      </TabsContent>
      <TabsContent value="problems">
        {problems ?? <PaneEmpty label="Problems" hint="compile and runtime diagnostics" />}
      </TabsContent>
      <TabsContent value="performance">
        {performance ?? (
          <PaneEmpty label="Performance" hint="per-pass GPU ms, resource count, memory estimate" />
        )}
      </TabsContent>
    </TabsRoot>
  );
}
