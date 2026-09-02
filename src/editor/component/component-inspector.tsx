import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { readComponentInstance } from "@domain/components/instance.ts";
import { availableUpgrade } from "@domain/components/upgrade.ts";
import type { ComponentRegistryView } from "@domain/components/registry.ts";
import { resolveParameters } from "@editor/inspector/parameter-resolver.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import type { ParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { ParameterControl } from "@ui/controls/parameter-control.tsx";
import type { ControlVariant } from "@ui/controls/control-row.tsx";
import { Button } from "@ui/primitives/button.tsx";
import styles from "./component.module.css";

/**
 * The inspector for a component INSTANCE (T137, §V79, §V84, §V17).
 *
 * Three things this pane must show that an ordinary node's inspector does not:
 *
 *  - the PARAMETER PAGE, which is the component's own re-authored controls, not the
 *    internal parameters they drive (§V80);
 *  - the EXPOSED PORTS, so the boundary is inspectable without entering the component;
 *  - the PINNED VERSION and, when a newer one exists, an explicit upgrade. Never an
 *    automatic one: a newer definition must not change a saved project (§V84).
 *
 * Published values are ordinary node parameters, so they are read through
 * `resolveParameters` (§V61) and written through the same `ParameterEditor` every other
 * control uses (§V29). There is no component-specific edit path.
 */

export interface ComponentInspectorProps {
  bus: LoomBus;
  /** Actor/project/capabilities for every command this pane sends (§V30). Memoise it. */
  context: InvocationContext;
  nodeId: NodeId;
  components: ComponentRegistryView;
  /** Enter the component to edit its internals (T130). */
  onEnter?: ((nodeId: NodeId) => void) | undefined;
  /** Injectable for tests; otherwise the pane owns its editor. */
  editor?: ParameterEditor;
  variant?: ControlVariant;
}

export function ComponentInspector({
  bus,
  context,
  nodeId,
  components,
  onEnter,
  editor: providedEditor,
  variant = "inspector",
}: ComponentInspectorProps) {
  const graph = useSyncExternalStore<GraphDocument>(
    bus.store.subscribe,
    bus.store.getGraph,
    bus.store.getGraph,
  );
  // The catalogue changes outside the graph store — re-authoring a component is not a
  // document edit — so the pane subscribes to it too, or a renamed port never appears.
  const [, bumpCatalogue] = useState(0);
  useEffect(
    () => components.subscribe(() => bumpCatalogue((count) => count + 1)),
    [components],
  );

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const ownedEditor = useMemo(
    () => (providedEditor === undefined ? createParameterEditor({ bus, context }) : null),
    [bus, context, providedEditor],
  );
  useEffect(() => () => ownedEditor?.dispose(), [ownedEditor]);
  const editor = providedEditor ?? ownedEditor;

  const node = graph.nodes[nodeId];
  const state = node === undefined ? null : readComponentInstance(node);

  if (node === undefined || state === null || editor === null) {
    return <div className={styles.empty}>Select a component instance.</div>;
  }

  const definition = components.get(state.componentId, state.version);
  const manifest = bus.registry.get(node.type);
  const upgrade = availableUpgrade(node, components);
  const versions = components.versions(state.componentId);

  if (definition === undefined || manifest === undefined) {
    return (
      <div className={styles.inspector}>
        <header className={styles.header}>
          <span className={styles.title}>{state.componentId}</span>
          <span className={styles.version}>v{state.version}</span>
        </header>
        <p className={styles.empty}>
          This component is not installed. Its values are preserved and will work again once
          the package that defines it is available.
        </p>
      </div>
    );
  }

  const resolved = resolveParameters(node, manifest);

  const run = async (
    command: "component.upgradeInstance" | "component.detach",
    input: { nodeId: NodeId },
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await bus.execute(command, input, context);
      const first = result.diagnostics[0];
      setMessage(first === undefined ? null : first.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.inspector}>
      <header className={styles.header}>
        <span className={styles.title}>{definition.name}</span>
        <span className={styles.version}>
          v{state.version}
          {versions.length > 1 ? ` of ${versions.length}` : ""}
        </span>
        <span className={styles.pinned}>pinned</span>
      </header>

      {upgrade !== null ? (
        <div className={styles.upgrade} role="status">
          <span>
            Version {upgrade.latestVersion} is available. This instance stays on v
            {upgrade.pinnedVersion} until you upgrade it.
          </span>
          <div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run("component.upgradeInstance", { nodeId })}
            >
              Upgrade to v{upgrade.latestVersion}
            </Button>
          </div>
        </div>
      ) : null}

      <section className={styles.section} aria-label="Parameters">
        <div className={styles.sectionHeader}>
          <span>Parameters</span>
        </div>
        {resolved.entries.length === 0 ? (
          <p className={styles.empty}>This component publishes no parameters.</p>
        ) : (
          resolved.entries.map((entry) => (
            <ParameterControl
              key={entry.key}
              parameterKey={entry.key}
              definition={entry.definition}
              value={entry.value}
              variant={variant}
              driven={entry.driven}
              onChange={(value, phase) => editor.setParameter(nodeId, entry.key, value, phase)}
            />
          ))
        )}
      </section>

      <section className={styles.section} aria-label="Exposed ports">
        <div className={styles.sectionHeader}>
          <span>Exposed ports</span>
        </div>
        {definition.inputs.length + definition.outputs.length === 0 ? (
          <p className={styles.empty}>This component exposes no ports.</p>
        ) : (
          <ul className={styles.ports}>
            {[
              ...definition.inputs.map((port) => ({ port, direction: "in" as const })),
              ...definition.outputs.map((port) => ({ port, direction: "out" as const })),
            ].map(({ port, direction }) => (
              <li className={styles.port} key={`${direction}-${port.externalId}`}>
                <span>{port.label}</span>
                <span className={styles.portTarget}>
                  {direction} · {port.nodeId}.{port.portId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className={styles.actions}>
        {onEnter === undefined ? null : (
          <Button variant="outline" onClick={() => onEnter(nodeId)}>
            Edit contents
          </Button>
        )}
        <Button disabled={busy} onClick={() => void run("component.detach", { nodeId })}>
          Detach copy
        </Button>
      </div>

      {message === null ? null : (
        <p className={styles.empty} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
