import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { useOptionalKeymap } from "@editor/keymap/keymap-provider.tsx";
import {
  eventStrokeToKeys,
  formatKeys,
  isModifierKeyName,
  strokeFromEvent,
} from "@editor/keymap/keys.ts";
import type { KeymapStore } from "@editor/keymap/store.ts";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "@ui/primitives/dialog.tsx";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@ui/primitives/tabs.tsx";
import type { HelpSection } from "./command.ts";
import { ExpressionHelp } from "./expression-help.tsx";
import { nodeReferenceSections } from "./node-reference.ts";
import { conflictWith, shortcutSections } from "./shortcut-reference.ts";
import type { ShortcutEntry } from "./shortcut-reference.ts";
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
 *
 * ## The shortcuts tab is also the shortcut EDITOR (T360)
 *
 * The keymap has supported an override layer since T78 and nothing in the product let a
 * user write one. The editor belongs HERE, on the list that is already a projection of
 * the resolved keymap, because a separate rebinding pane would be a second surface
 * listing the same bindings — and a list and its editor kept apart are two things that
 * drift. Here they cannot: one render, one source.
 *
 * It stays a LIST, not a form (§V90, §V92). The keys cell IS the control — click it and
 * it records the next chord — and the only extra affordance is a reset, which appears on
 * a row only once that row carries an override. One status line reports what happened,
 * because a rebind that lands silently is indistinguishable from one that did not.
 *
 * A chord already taken is neither stolen in silence nor refused in silence: it is
 * applied and NAMED. Refusing strands a half-finished remap (the swap through a third key
 * becomes impossible), and stealing hides that a key the user still expects has moved.
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
  /** The binding id whose next keystroke is being recorded, if any (T360). */
  const [capturing, setCapturing] = useState<string | null>(null);
  const [status, setStatus] = useState("");

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

  const store: KeymapStore | null = keymap?.store ?? null;

  function rebind(entry: ShortcutEntry, keys: string | null): void {
    if (store === null) return;
    const result = store.setOverride(entry.id, keys);
    if (result.status !== "ok") {
      // The store's own words: "not a valid key sequence" beats a generic failure.
      setStatus(result.message);
      return;
    }
    setCapturing(null);
    if (keys === null) {
      setStatus(`${entry.label} is now unbound.`);
      return;
    }
    const display = formatKeys(keys, store.platform) ?? keys;
    // Read back from the keymap AFTER the write, so the collision reported is the one
    // that now exists rather than the one predicted before applying.
    const taken = conflictWith(store.getSnapshot(), entry.id);
    setStatus(
      taken.length === 0
        ? `${entry.label} is now ${display}.`
        : `${entry.label} is now ${display}. ${display} also runs ${taken.join(", ")}.`,
    );
  }

  function onCaptureKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, entry: ShortcutEntry): void {
    const stroke = strokeFromEvent(event.nativeEvent);
    if (stroke === null) return;
    // Nothing recorded here may also FIRE — the whole point is that the next keystroke
    // is data, not a command.
    event.preventDefault();
    event.stopPropagation();
    // Holding a modifier down is not a chord yet; wait for the key it modifies.
    if (isModifierKeyName(stroke.key)) return;
    const bare = !stroke.ctrl && !stroke.meta && !stroke.alt && !stroke.shift;
    if (stroke.key === "escape" && bare) {
      setCapturing(null);
      setStatus("Rebinding cancelled.");
      return;
    }
    // Backspace clears rather than binds: "no shortcut" is a state a user must be able
    // to reach, and it is a different fact from "there is no such command" (§V54).
    if ((stroke.key === "backspace" || stroke.key === "delete") && bare) {
      rebind(entry, null);
      return;
    }
    rebind(entry, eventStrokeToKeys(stroke, store?.platform ?? "other"));
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={styles.panel}
        onEscapeKeyDown={(event) => {
          // §V302: one Escape, one job. While a chord is being recorded, Escape cancels
          // the recording — dismissing the panel in the same press would hide the fact
          // that anything was cancelled. Radix listens in the capture phase, so this is
          // the only place the panel can decline.
          if (capturing !== null) event.preventDefault();
        }}
      >
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
              <>
                {/* One line, and empty until something happens. A rebind that lands with
                    no acknowledgement is indistinguishable from one that did not. */}
                <p className={styles.status} role="status" aria-live="polite">
                  {status}
                </p>
                {shortcuts.map((group) => (
                  <section key={group.context} aria-label={group.context}>
                    <h3 className={styles.groupHeader}>{group.context}</h3>
                    <dl className={styles.shortcutList}>
                      {group.entries.map((entry) => (
                        <div key={entry.id} className={styles.shortcutRow}>
                          <dt
                            className={styles.shortcutLabel}
                            title={entry.description ?? entry.command}
                          >
                            {entry.label}
                          </dt>
                          <dd className={styles.shortcutKeys}>
                            {/* The keys cell IS the control (T360): the thing you read is
                                the thing you click, so the list never becomes a form. */}
                            <button
                              type="button"
                              className={styles.keyButton}
                              aria-label={`Change shortcut for ${entry.label}`}
                              aria-pressed={capturing === entry.id}
                              disabled={store === null}
                              onClick={() => {
                                setStatus("");
                                setCapturing((current) =>
                                  current === entry.id ? null : entry.id,
                                );
                              }}
                              onKeyDown={(event) => {
                                if (capturing !== entry.id) return;
                                onCaptureKeyDown(event, entry);
                              }}
                            >
                              {capturing === entry.id ? (
                                <span className={styles.capturing}>press a key</span>
                              ) : entry.display === null ? (
                                <span className={styles.none}>unbound</span>
                              ) : (
                                entry.display
                              )}
                            </button>
                            {entry.conflicted ? (
                              <span
                                className={styles.conflict}
                                title={
                                  entry.conflictWith.length === 0
                                    ? undefined
                                    : `Also runs ${entry.conflictWith.join(", ")}.`
                                }
                              >
                                conflict
                              </span>
                            ) : null}
                            {/* Only where it means something: a row still on its shipped
                                key has nothing to reset (§V90). */}
                            {entry.source === "override" ? (
                              <button
                                type="button"
                                className={styles.reset}
                                aria-label={`Reset shortcut for ${entry.label}`}
                                onClick={() => {
                                  store?.resetBinding(entry.id);
                                  setCapturing(null);
                                  setStatus(`${entry.label} is back to its default.`);
                                }}
                              >
                                reset
                              </button>
                            ) : null}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </>
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
