import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { useOptionalKeymap } from "@editor/keymap/keymap-hooks.ts";
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
import { McpSetup } from "./mcp-setup.tsx";
import { nodeReferenceSections } from "./node-reference.ts";
import type { NodeReference } from "./node-reference.ts";
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
  agents: "Agents",
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

  // §T1178: the references are built ONCE per registry and the search filters the built
  // sections — a keystroke used to rebuild every matching definition's reference (ports,
  // parameters, descriptions for up to 92 types). No debounce: with the build hoisted the
  // filter is a string test per node, and a search that lags its keystroke reads as broken.
  const allSections = useMemo(() => nodeReferenceSections(nodes), [nodes]);
  const nodeSections = useMemo(() => {
    const needle = nodeQuery.trim().toLowerCase();
    if (needle === "") return allSections;
    return allSections
      .map((section) => ({
        category: section.category,
        nodes: section.nodes.filter(
          (reference) =>
            reference.title.toLowerCase().includes(needle) ||
            reference.type.toLowerCase().includes(needle),
        ),
      }))
      .filter((section) => section.nodes.length > 0);
  }, [nodeQuery, allSections]);

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
                      {/* T1337b — the author's own first sentence, always. This is the
                          line that used to exist only inside a `title=` tooltip. */}
                      {node.summary === undefined ? null : (
                        <p className={styles.summary}>{node.summary}</p>
                      )}
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
                      <NodeDetails node={node} />
                    </article>
                  ))}
                </section>
              ))
            )}
          </TabsContent>

          <TabsContent value="expressions" className={styles.body}>
            <ExpressionHelp source="" scope={scope} />
          </TabsContent>

          {/* T399: how to attach an EXTERNAL agent. The in-app transports and what they
              have published are the agent pane's job (T397); this is the setup only. */}
          <TabsContent value="agents" className={styles.body}>
            <McpSetup />
          </TabsContent>
        </TabsRoot>
      </DialogContent>
    </DialogRoot>
  );
}

/** One documented thing: what it is called, what it IS, and what it MEANS. */
interface GlossaryEntry {
  readonly key: string;
  readonly name: string;
  /** The machine fact — a port's type, a parameter's type and unit. */
  readonly meta: string;
  readonly text: string;
}

/**
 * The rest of a node's reference, on demand (T1337b, T1338b).
 *
 * A `<details>` rather than a hover: the whole finding behind these rows is that the only
 * surface this prose had was a native `title=`, which **cannot be scrolled or selected and
 * dismisses on pointer move** (§V998). What opens here stays open, sits inside the panel's
 * own scroller, and is selectable text — and it is the author's bytes, uncut.
 *
 * Absent entirely when there is nothing behind the summary, so the 216 single-sentence
 * manifests of the 485 shipped strings do not grow an affordance that opens onto nothing.
 */
function NodeDetails({ node }: { node: NodeReference }) {
  const ports = (entries: NodeReference["inputs"]): readonly GlossaryEntry[] =>
    entries
      .filter((port) => port.description !== undefined && port.description !== "")
      .map((port) => ({
        key: port.id,
        name: port.label,
        // T1338b: the authored sentence SUPPLEMENTS the type, it never replaces it — a
        // connection is refused on the type, so the type is the fact that must survive,
        // and the meaning is the elaboration that follows it.
        meta: port.optional ? `${port.type} · optional` : port.type,
        text: port.description ?? "",
      }));

  const inputs = ports(node.inputs);
  const outputs = ports(node.outputs);
  const parameters = node.parameters
    .filter((parameter) => parameter.description !== undefined && parameter.description !== "")
    .map((parameter) => ({
      key: parameter.key,
      name: parameter.label,
      meta: parameter.unit === undefined ? parameter.type : `${parameter.type} · ${parameter.unit}`,
      text: parameter.description ?? "",
    }));

  if (
    node.detail === "" &&
    inputs.length === 0 &&
    outputs.length === 0 &&
    parameters.length === 0
  ) {
    return null;
  }

  return (
    <details className={styles.more}>
      <summary className={styles.moreToggle}>Full reference</summary>
      {node.detail === "" ? null : <p className={styles.detail}>{node.detail}</p>}
      <Glossary title="Inputs" entries={inputs} />
      <Glossary title="Outputs" entries={outputs} />
      <Glossary title="Parameters" entries={parameters} />
    </details>
  );
}

/**
 * Name, type, meaning — stacked, never a grid.
 *
 * §V1016: this panel is read at every width from a 92vw phone to an 880px desktop dialog,
 * and a three-column row would put the authored sentence in a track narrow enough to
 * ellipsise exactly where it is most needed. Each row is two blocks that wrap.
 */
function Glossary({ title, entries }: { title: string; entries: readonly GlossaryEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <>
      <h4 className={styles.glossaryHeader}>{title}</h4>
      <dl className={styles.glossary}>
        {entries.map((entry) => (
          <div key={entry.key} className={styles.glossaryRow}>
            <dt className={styles.glossaryTerm}>
              <span className={styles.glossaryName}>{entry.name}</span>
              <span className={styles.glossaryMeta}>{entry.meta}</span>
            </dt>
            <dd className={styles.glossaryText}>{entry.text}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
