import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { TextureFormat } from "@domain/types/node-definition.ts";
import { ParameterControl } from "@ui/controls/parameter-control.tsx";
import type { ControlVariant } from "@ui/controls/control-row.tsx";
import { CommonSection } from "./common-section.tsx";
import { groupParameters } from "./parameter-groups.ts";
import { createParameterEditor } from "./parameter-editor.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import { resolveParameters } from "./parameter-resolver.ts";
import type { InputResolution } from "./resolution.ts";
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

  const ownedEditor = useMemo(
    () => (providedEditor === undefined ? createParameterEditor({ bus, context }) : null),
    [bus, context, providedEditor],
  );
  useEffect(() => () => ownedEditor?.dispose(), [ownedEditor]);
  const editor = providedEditor ?? ownedEditor;

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

  return (
    <div className={styles.inspector}>
      <header className={styles.header}>
        <span className={styles.title}>{definition?.title ?? node.type}</span>
        <span className={styles.type}>{node.type}</span>
        <span className={styles.identity}>{node.id}</span>
      </header>

      {definition === undefined ? (
        <p className={styles.placeholder}>
          Unknown node type “{node.type}”. Its parameters are preserved but cannot be edited
          until the package that defines it is installed (§V10).
        </p>
      ) : null}

      <CommonSection
        nodeId={node.id}
        definition={definition}
        resolution={node.resolution}
        format={node.format}
        resolutionContext={{
          project: settings.outputResolution,
          inputs,
          ...(settings.limits?.maxResolution === undefined
            ? {}
            : { maxResolution: settings.limits.maxResolution }),
        }}
        formatContext={{
          projectFormat: settings.workingFormat,
          inputs,
          ...(capabilities === undefined ? {} : { supported: capabilities.formats }),
        }}
        {...(diagnostics === undefined ? {} : { diagnostics })}
        editor={editor}
        variant={variant}
      />

      {groups.map((group) => (
        <section className={styles.section} key={group.name} aria-label={group.name}>
          <div className={styles.sectionHeader}>
            <span>{group.name}</span>
            <span className={styles.sectionRule} aria-hidden />
          </div>
          {group.entries.map((entry) => (
            <ParameterControl
              key={entry.key}
              parameterKey={entry.key}
              definition={entry.definition}
              value={entry.value}
              variant={variant}
              driven={entry.driven}
              onChange={(value, phase) => editor.setParameter(node.id, entry.key, value, phase)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
