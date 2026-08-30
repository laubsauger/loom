import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cx } from "@ui/cx.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { TextureFormat } from "@domain/types/node-definition.ts";
import { ParameterControl } from "@ui/controls/parameter-control.tsx";
import type { ControlVariant } from "@ui/controls/control-row.tsx";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@ui/primitives/tabs.tsx";
import { CommonReadout, CommonSection } from "./common-section.tsx";
import { groupParameters } from "./parameter-groups.ts";
import { createParameterEditor } from "./parameter-editor.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import { resolveParameters } from "./parameter-resolver.ts";
import { resolveNodeFormat, resolveNodeSize } from "./resolution.ts";
import type { FormatContext, InputResolution, ResolutionContext } from "./resolution.ts";
import styles from "./inspector.module.css";

/**
 * Inspector pane (T38).
 *
 * Manifest-driven end to end: the pane renders whatever the node definition declares,
 * grouped as the definition groups it, using the shared control kit. There is no
 * per-node inspector code anywhere in the editor, which is what makes a node package
 * that lands later — or one an agent authors — fully editable the moment it registers.
 *
 * Reads come through `resolveParameters` (the single parameter read path); writes go
 * through the command bus via `ParameterEditor` (§V29). The pane never touches the
 * store, and never mutates a node object.
 *
 * ## Pages, not one long scroll (T269, §V174)
 *
 * TD's model: a node has PAGES and the inspector shows one at a time. Parameters is the
 * first tab and the default; Common is its own. Stacking both on one page put a
 * resolution and a format — set once per node, revisited almost never — across the top
 * third of the panel, ahead of the controls the panel was opened for. Common is chrome;
 * parameters are the work; the top of the panel goes to the work.
 *
 * What does NOT go behind the tab is the resolved readout. "1280 × 720 · rgba16float" is
 * the fact you check constantly, and it moves as a consequence of edits made elsewhere —
 * rewire an input and an inheriting node's size changes under you. So it rides in the
 * header as one compact line, visible from either tab, instead of two rows and a box.
 */

export interface InspectorProjectSettings {
  outputResolution: { width: number; height: number };
  workingFormat: TextureFormat;
  limits?: { maxResolution?: number };
}

export interface InspectorProps {
  bus: ShaderloomBus;
  /** Actor/project/capabilities for every command the pane sends (§V30). Memoise it. */
  context: InvocationContext;
  nodeId: NodeId | null;
  settings: InspectorProjectSettings;
  /** Compiler diagnostics; the Common section surfaces the format ones (§V51). */
  diagnostics?: readonly RuntimeDiagnostic[];
  /** Device capability report (§V12), used to flag unsupported formats. */
  capabilities?: { formats: readonly TextureFormat[] } | undefined;
  /**
   * Resolved size/format per input port, when the compiler has reported them. Without
   * it the Common section falls back to the project size and says so.
   */
  inputResolutions?: readonly InputResolution[];
  /** Injectable for tests; otherwise the pane owns its editor. */
  editor?: ParameterEditor;
  variant?: ControlVariant;
}

export function Inspector({
  bus,
  context,
  nodeId,
  settings,
  diagnostics,
  capabilities,
  inputResolutions,
  editor: providedEditor,
  variant = "inspector",
}: InspectorProps) {
  const graph = useSyncExternalStore<GraphDocument>(
    bus.store.subscribe,
    bus.store.getGraph,
    bus.store.getGraph,
  );

  /**
   * The editor's lifetime is the MOUNT's, not a memo cell's (B10, T218).
   *
   * This used to be `useMemo(create, [bus, context])` paired with an effect cleanup
   * that called `dispose()`. React is free to run an effect's cleanup and then mount
   * the same component again WITHOUT re-rendering it — StrictMode's development
   * mount→unmount→mount check does precisely that, and so does a pane being re-docked.
   * The memo cell survived (its deps never changed), so the pane went on using an
   * editor whose coalescer was permanently disposed. A disposed coalescer drops every
   * `schedule` on the floor, which is exactly and only the `"live"` path: `"commit"`
   * sends immediately. Result in the shipped app: an 80px drag showed one value and
   * jumped on release, and §V5's uniform-only fast path was unreachable from the UI.
   *
   * Owning it through a ref that the effect REBUILDS when it finds it empty ties the
   * editor to the mount. `revive` exists because the remount does not re-render on its
   * own: the handlers already on screen still close over the disposed editor.
   */
  const ownedRef = useRef<ParameterEditor | null>(null);
  const [, revive] = useState(0);

  if (providedEditor === undefined && ownedRef.current === null) {
    ownedRef.current = createParameterEditor({ bus, context });
  }

  useEffect(() => {
    if (providedEditor !== undefined) return;
    if (ownedRef.current === null) {
      ownedRef.current = createParameterEditor({ bus, context });
      revive((generation) => generation + 1);
    }
    return () => {
      ownedRef.current?.dispose();
      ownedRef.current = null;
    };
  }, [bus, context, providedEditor]);

  const editor = providedEditor ?? ownedRef.current;

  const node = nodeId === null ? undefined : graph.nodes[nodeId];
  const definition = node === undefined ? undefined : bus.registry.get(node.type);

  if (node === undefined || editor === null) {
    return (
      <div className={styles.empty}>
        <span>No node selected</span>
        <span className={styles.type}>Select a node to edit its parameters</span>
      </div>
    );
  }

  const resolved = resolveParameters(node, definition);
  const groups = groupParameters(resolved.entries);

  const inputs: readonly InputResolution[] =
    inputResolutions ??
    (definition?.inputs ?? []).map((port) => ({
      portId: port.id,
      label: port.label,
      connected: Object.values(graph.edges).some(
        (edge) => edge.target.nodeId === node.id && edge.target.portId === port.id,
      ),
    }));

  const resolutionContext: ResolutionContext = {
    project: settings.outputResolution,
    inputs,
    ...(settings.limits?.maxResolution === undefined
      ? {}
      : { maxResolution: settings.limits.maxResolution }),
  };
  const formatContext: FormatContext = {
    projectFormat: settings.workingFormat,
    inputs,
    ...(capabilities === undefined ? {} : { supported: capabilities.formats }),
  };
  // Resolved here as well as inside CommonSection: both are pure functions of the same
  // inputs, and passing the answer down would couple the header to the section's shape
  // for no gain. The section resolves what its own controls need; this is the readout.
  const resolvedSize = resolveNodeSize(node.resolution, definition?.resolutionPolicy, resolutionContext);
  const resolvedFormat = resolveNodeFormat(node.format, definition?.formatPolicy, formatContext);

  const commonSection = (
    <CommonSection
      nodeId={node.id}
      definition={definition}
      resolution={node.resolution}
      format={node.format}
      resolutionContext={resolutionContext}
      formatContext={formatContext}
      {...(diagnostics === undefined ? {} : { diagnostics })}
      editor={editor}
      variant={variant}
    />
  );

  const parameterSections =
    groups.length === 0 ? (
      // §V91: name the STATE, not the pane's purpose. A node with no parameters is a
      // normal thing (Output, Null) and the panel should say so rather than sit blank.
      <p className={styles.emptyPage}>No parameters</p>
    ) : (
      groups.map((group) => (
        <section className={styles.section} key={group.name} aria-label={group.name}>
          <div className={styles.sectionHeader}>
            <span>{group.name}</span>
            <span className={styles.sectionRule} aria-hidden />
          </div>
          {group.entries.map((entry) => (
            // data-parameter-key lets the context menu resolve which parameter was
            // right-clicked (§V78). The control kit itself stays menu-agnostic.
            <div key={entry.key} data-parameter-key={entry.key}>
              <ParameterControl
                parameterKey={entry.key}
                definition={entry.definition}
                value={entry.value}
                variant={variant}
                driven={entry.driven}
                // §V146 (B14): the node itself says when one of its parameters cannot
                // affect the output — Noise's Time Speed on a 2D type is the case that
                // named the bug. The predicate reads the node's EFFECTIVE values, so a
                // type driven by an expression dims the same parameters a typed one does.
                inactive={entry.definition.inactiveWhen?.(resolved.values) ?? null}
                slot={entry.slot}
                {...(entry.components === undefined ? {} : { components: entry.components })}
                diagnostic={entry.diagnostic}
                // §V114: whatever the control hands over — a mode envelope, or all four
                // channels of a colour — goes out as ONE patch, so a colour pick stays one
                // undo entry.
                // §V124: a pulse writes nothing to the document, so it travels its own
                // path — one command, audited, never undoable, never saved.
                onPulse={(key) => editor.pulse(node.id, key)}
                onStoredChange={(entries, phase) => editor.setStored(node.id, entries, phase)}
                onChange={(value, phase) => editor.setParameter(node.id, entry.key, value, phase)}
              />
            </div>
          ))}
        </section>
      ))
    );

  const unknownNotice =
    definition === undefined ? (
      <p className={styles.placeholder}>
        Unknown node type “{node.type}”. Its parameters are preserved but cannot be edited
        until the package that defines it is installed (§V10).
      </p>
    ) : null;

  const header = (
    <>
      <header className={styles.header}>
        <span className={styles.title}>{definition?.title ?? node.type}</span>
        <span className={styles.type}>{node.type}</span>
        <span className={styles.identity}>{node.id}</span>
      </header>
      <CommonReadout size={resolvedSize} format={resolvedFormat} compact />
    </>
  );

  // A node-embedded inspector is a dense strip, not a paged panel: it keeps the flat
  // layout it always had, and only the pane grows tabs.
  if (variant === "node") {
    return (
      <div className={styles.inspector} data-node-id={node.id} data-keymap-context="inspector">
        {header}
        {unknownNotice}
        {parameterSections}
        {commonSection}
      </div>
    );
  }

  return (
    <div className={styles.inspector} data-node-id={node.id} data-keymap-context="inspector">
      {header}
      {unknownNotice}
      <TabsRoot className={cx(styles.pages, styles.pages)} defaultValue="parameters">
        <TabsList className={cx(styles.pageList, styles.pageList)} aria-label="Node pages">
          <TabsTrigger value="parameters">Parameters</TabsTrigger>
          <TabsTrigger value="common">Common</TabsTrigger>
        </TabsList>
        <TabsContent className={cx(styles.page, styles.page)} value="parameters">
          {parameterSections}
        </TabsContent>
        <TabsContent className={cx(styles.page, styles.page)} value="common">
          {commonSection}
        </TabsContent>
      </TabsRoot>
    </div>
  );
}

