import { useMemo, useState } from "react";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { useOptionalKeymap } from "@editor/keymap/keymap-provider.tsx";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "@ui/primitives/dialog.tsx";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@ui/primitives/tabs.tsx";
import type { HelpSection } from "./command.ts";
import { ExpressionHelp } from "./expression-help.tsx";
import { nodeReferenceSections } from "./node-reference.ts";
import { shortcutSections } from "./shortcut-reference.ts";
import styles from "./help.module.css";

/**
 * The help panel (T200, §V105, §V90).
 *
 * Three tabs, three live sources, zero authored content:
 *
 *  - SHORTCUTS come from the resolved keymap in context — override layer included, so a
 *    rebound key moves the text here the same render (§V54, §V55);
 *  - NODES come from the registry's manifests, which already hold every title, port and
 *    parameter this page shows (§V105);
 *  - EXPRESSIONS come from the evaluator itself, probed rather than described (§V71).
 *
 * Nothing in this file states a fact about the product. Everything it renders was asked
 * of the thing that owns the fact, because help is trusted and stale help is trusted
 * too — that is what makes a hand-written copy worse than no help at all.
 *
 * §V90 keeps it on demand: a modal opened by `ui.openHelp`, never a permanent pane.
 */

export interface HelpPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: HelpSection;
  onSectionChange: (section: HelpSection) => void;
  /** The installed catalogue — `registry.list()`. */
  nodes: readonly NodeDefinition[];
  /** The scope a parameter expression sees, for the live examples (§V71). */
  scope?: ExpressionScope;
}

const SECTION_LABEL: Readonly<Record<HelpSection, string>> = {
  shortcuts: "Shortcuts",
  nodes: "Nodes",
  expressions: "Expressions",
};

export function HelpPanel({
  open,
  onOpenChange,
  section,
  onSectionChange,
  nodes,
  scope = {},
}: HelpPanelProps) {
  const keymap = useOptionalKeymap();
  const [nodeQuery, setNodeQuery] = useState("");

  // Asked of the resolved keymap on every render: an override applied a moment ago is
  // already in `resolved`, so there is nothing to invalidate (§V55).
  const shortcuts = useMemo(
    () => (keymap === null ? [] : shortcutSections(keymap.resolved)),
    [keymap],
  );

  const nodeSections = useMemo(() => {
    const needle = nodeQuery.trim().toLowerCase();
    const pool =
      needle === ""
        ? nodes
        : nodes.filter(
            (definition) =>
              definition.title.toLowerCase().includes(needle) ||
              definition.type.toLowerCase().includes(needle),
          );
    return nodeReferenceSections(pool);
  }, [nodeQuery, nodes]);

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.panel}>
        <DialogTitle className={styles.title}>Help</DialogTitle>

        <TabsRoot
          value={section}
          onValueChange={(next) => onSectionChange(next as HelpSection)}
          className={styles.tabs}
        >
          <TabsList aria-label="Help sections">
            {(Object.keys(SECTION_LABEL) as HelpSection[]).map((name) => (
              <TabsTrigger key={name} value={name}>
                {SECTION_LABEL[name]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="shortcuts" className={styles.body}>
            {shortcuts.length === 0 ? (
              <p className={styles.none}>No keymap is mounted.</p>
            ) : (
              shortcuts.map((group) => (
                <section key={group.context} aria-label={group.context}>
                  <h3 className={styles.groupHeader}>{group.context}</h3>
                  <dl className={styles.shortcutList}>
                    {group.entries.map((entry) => (
                      <div key={entry.id} className={styles.shortcutRow}>
                        <dt className={styles.shortcutLabel} title={entry.description ?? entry.command}>
                          {entry.label}
                        </dt>
                        <dd className={styles.shortcutKeys}>
                          {entry.display === null ? (
                            <span className={styles.none}>unbound</span>
                          ) : (
                            entry.display
                          )}
                          {entry.conflicted ? (
                            <span className={styles.conflict}>conflict</span>
                          ) : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))
            )}
          </TabsContent>

          <TabsContent value="nodes" className={styles.body}>
            <input
              type="search"
              className={styles.search}
              value={nodeQuery}
              placeholder="Search nodes"
              aria-label="Search node reference"
              onChange={(event) => setNodeQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
            />
            {nodeSections.length === 0 ? (
              <p className={styles.none}>No node matches.</p>
            ) : (
              nodeSections.map((group) => (
                <section key={group.category} aria-label={group.category}>
                  <h3 className={styles.groupHeader}>{group.category}</h3>
                  {group.nodes.map((node) => (
                    <article key={node.type} className={styles.node}>
                      <header className={styles.nodeHeader}>
                        <span className={styles.nodeTitle}>{node.title}</span>
                        <span className={styles.nodeType}>{node.type}</span>
                      </header>
                      <p className={styles.ports}>
                        {node.inputs.map((port) => `${port.label}: ${port.type}`).join(" · ")}
                        {node.inputs.length > 0 && node.outputs.length > 0 ? " → " : ""}
                        {node.outputs.map((port) => `${port.label}: ${port.type}`).join(" · ")}
                      </p>
                      {node.parameters.length === 0 ? null : (
                        <p className={styles.params}>
                          {node.parameters
                            .map((parameter) =>
                              parameter.unit === undefined
                                ? parameter.label
                                : `${parameter.label} (${parameter.unit})`,
                            )
                            .join(" · ")}
                        </p>
                      )}
                    </article>
                  ))}
                </section>
              ))
            )}
          </TabsContent>

          <TabsContent value="expressions" className={styles.body}>
            <ExpressionHelp source="" scope={scope} />
          </TabsContent>
        </TabsRoot>
      </DialogContent>
    </DialogRoot>
  );
}
