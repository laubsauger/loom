import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { GraphComponentDefinition, PublishedParameter } from "@domain/types/components.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterDefinition, ParameterValue } from "@domain/types/parameters.ts";
import { defaultValueOf } from "@domain/components/parameter-defaults.ts";
import { readParentBindings } from "@domain/components/instance.ts";
import { internalParameterOf } from "@domain/components/definition.ts";
import type { ComponentRegistryView } from "@domain/components/registry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { ParameterControl } from "@ui/controls/parameter-control.tsx";
import { Button } from "@ui/primitives/button.tsx";
import styles from "./component.module.css";

/**
 * THE PARAMETER PAGE EDITOR — a component's public interface, authored (T423, §V80).
 *
 * Everything under here was reachable from a bus command since T131/T132 and from no
 * control at all: `composition-seams.test.ts` listed `component.exposePort`,
 * `component.unexposePort`, `component.publishParameter`, `component.unpublishParameter`,
 * `component.setPublishedParameter` and `component.setParentBinding` in
 * `COMMANDS_WITH_NO_INVOKER` with the reason "T423 — the component EDITOR does not
 * exist". This is that editor; those lines come out with it.
 *
 * ## Four things a parameter page is
 *
 *  - a LIST OF CONTROLS, which is what an instance's inspector shows;
 *  - a set of RE-AUTHORED definitions — label, range, unit chosen for the person USING
 *    the component, never copied from whichever internal parameter they happen to drive
 *    (§V80). Publishing a Blur that reads 0..64px over three internal radii is the point;
 *  - an ORDER. It cannot be derived — alphabetical ignores what the component does and
 *    insertion order records only who published what first — so it is authored, with the
 *    same up/down pair `StopsField` uses for a gradient's stops, for the same reason;
 *  - a LEXICAL SCOPE. A published key is readable by every descendant as `parent.<key>`
 *    (§V81) whether or not it drives a target directly, which is why the page also has to
 *    show the parent bindings that read it.
 *
 * ## One live control per row, not a preview of one
 *
 * The value control on each row runs `component.setPublishedParameter`, which fans the
 * value out to every target in ONE patch — one undo step for a knob driving three radii
 * (§V80, §V32, §V34). Authoring a control you cannot turn is how a range gets published
 * that nothing inside can accept.
 */

export interface ComponentPageProps {
  /** The SESSION bus — the one whose `host` is this component. */
  bus: ShaderloomBus;
  context: InvocationContext;
  definition: GraphComponentDefinition;
  components: ComponentRegistryView;
  nodes: NodeRegistryView;
  /** The internal node selected on the canvas, whose parameters can be published. */
  selectedNodeId: NodeId | null;
  /** Published keys of the component ONE level out, for a `parent.<key>` binding (§V81). */
  parentKeys?: readonly string[];
}

const NUMBER_FIELDS = [
  { field: "min", label: "Min" },
  { field: "max", label: "Max" },
  { field: "step", label: "Step" },
] as const;

export function ComponentPage({
  bus,
  context,
  definition,
  components,
  nodes,
  selectedNodeId,
  parentKeys = [],
}: ComponentPageProps) {
  const graph = useSyncExternalStore<GraphDocument>(
    bus.store.subscribe,
    bus.store.getGraph,
    bus.store.getGraph,
  );
  // Re-authoring is a CATALOGUE edit, not a document edit, so nothing in the graph store
  // fires for it and this pane would keep showing the page it first rendered.
  const [, bumpCatalogue] = useState(0);
  useEffect(
    () => components.subscribe(() => bumpCatalogue((count) => count + 1)),
    [components],
  );

  const [message, setMessage] = useState<string | null>(null);
  const live = components.get(definition.componentId, definition.version) ?? definition;

  const run = (promise: Promise<{ diagnostics: readonly { message: string }[] }>): void => {
    void promise.then((result) => setMessage(result.diagnostics[0]?.message ?? null));
  };

  const republish = (published: PublishedParameter, next: ParameterDefinition): void => {
    run(
      bus.execute(
        "component.publishParameter",
        { key: published.key, definition: next, targets: published.targets },
        context,
      ),
    );
  };

  const selected = selectedNodeId === null ? undefined : graph.nodes[selectedNodeId];
  const selectedManifest = selected === undefined ? undefined : nodes.get(selected.type);

  return (
    <div className={styles.inspector} data-testid="component-page">
      <header className={styles.header}>
        <span className={styles.title}>{live.name}</span>
        <span className={styles.version}>v{live.version}</span>
        <span className={styles.pinned}>editing</span>
      </header>

      <section className={styles.section} aria-label="Parameter page">
        <div className={styles.sectionHeader}>
          <span>Parameter page</span>
        </div>
        {live.parameters.length === 0 ? (
          // §V90: an empty state names the state, it does not explain the feature. The
          // "how" is the `+` on every parameter row of the selected node, below.
          <p className={styles.empty}>Nothing published yet.</p>
        ) : (
          <ol className={styles.rows}>
            {live.parameters.map((published, index) => (
              <li className={styles.row} key={published.key}>
                <div className={styles.rowHead}>
                  <span className={styles.rowKey}>{published.key}</span>
                  <div className={styles.rowActions}>
                    <Button
                      aria-label={`Move ${published.definition.label} earlier`}
                      title="Move earlier"
                      disabled={index === 0}
                      onClick={() =>
                        run(
                          bus.execute(
                            "component.reorderParameter",
                            { key: published.key, toIndex: index - 1 },
                            context,
                          ),
                        )
                      }
                    >
                      ↑
                    </Button>
                    <Button
                      aria-label={`Move ${published.definition.label} later`}
                      title="Move later"
                      disabled={index === live.parameters.length - 1}
                      onClick={() =>
                        run(
                          bus.execute(
                            "component.reorderParameter",
                            { key: published.key, toIndex: index + 1 },
                            context,
                          ),
                        )
                      }
                    >
                      ↓
                    </Button>
                    <Button
                      variant="danger"
                      aria-label={`Unpublish ${published.definition.label}`}
                      title="Unpublish"
                      onClick={() =>
                        run(
                          bus.execute(
                            "component.unpublishParameter",
                            { key: published.key },
                            context,
                          ),
                        )
                      }
                    >
                      −
                    </Button>
                  </div>
                </div>

                <label className={styles.field}>
                  <span>Label</span>
                  <input
                    className={styles.input}
                    value={published.definition.label}
                    onChange={(event) =>
                      republish(published, {
                        ...published.definition,
                        label: event.target.value,
                      } as ParameterDefinition)
                    }
                  />
                </label>

                {published.definition.type === "number" || published.definition.type === "vector"
                  ? NUMBER_FIELDS.map(({ field, label }) => (
                      <label className={styles.field} key={field}>
                        <span>{label}</span>
                        <input
                          className={styles.input}
                          type="number"
                          value={
                            (published.definition as unknown as Record<string, unknown>)[field] as
                              | number
                              | undefined ?? ""
                          }
                          onChange={(event) => {
                            const raw = event.target.value;
                            const next = { ...published.definition } as unknown as Record<
                              string,
                              unknown
                            >;
                            // An empty box means "no bound", which is a DIFFERENT statement
                            // from a bound of zero — writing 0 for a cleared field would
                            // silently pin a slider to the origin.
                            if (raw === "") delete next[field];
                            else next[field] = Number(raw);
                            republish(published, next as unknown as ParameterDefinition);
                          }}
                        />
                      </label>
                    ))
                  : null}

                <ParameterControl
                  parameterKey={published.key}
                  definition={published.definition}
                  value={defaultValueOf(published.definition)}
                  variant="inspector"
                  onChange={(value: ParameterValue) =>
                    run(
                      bus.execute(
                        "component.setPublishedParameter",
                        { key: published.key, value },
                        context,
                      ) as unknown as Promise<{ diagnostics: readonly { message: string }[] }>,
                    )
                  }
                />

                <p className={styles.targets}>
                  {published.targets.length === 0
                    ? "drives nothing directly — readable as parent." + published.key + " (§V81)"
                    : published.targets
                        .map((target) => `${target.nodeId}.${target.key}`)
                        .join(", ")}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.section} aria-label="Exposed ports">
        <div className={styles.sectionHeader}>
          <span>Exposed ports</span>
        </div>
        {live.inputs.length + live.outputs.length === 0 ? (
          <p className={styles.empty}>This component exposes no ports.</p>
        ) : (
          <ul className={styles.ports}>
            {[
              ...live.inputs.map((port) => ({ port, direction: "input" as const })),
              ...live.outputs.map((port) => ({ port, direction: "output" as const })),
            ].map(({ port, direction }) => (
              <li className={styles.port} key={`${direction}-${port.externalId}`}>
                <span>{port.label}</span>
                <span className={styles.portTarget}>
                  {direction === "input" ? "in" : "out"} · {port.nodeId}.{port.portId}
                </span>
                <Button
                  variant="danger"
                  aria-label={`Unexpose ${port.label}`}
                  title="Unexpose"
                  onClick={() =>
                    run(
                      bus.execute(
                        "component.unexposePort",
                        { direction, externalId: port.externalId },
                        context,
                      ),
                    )
                  }
                >
                  −
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected === undefined || selectedManifest === undefined ? null : (
        <section className={styles.section} aria-label="Selected node">
          <div className={styles.sectionHeader}>
            <span>{selected.label ?? selectedManifest.title}</span>
          </div>

          <ul className={styles.ports}>
            {[
              ...selectedManifest.inputs.map((port) => ({ port, direction: "input" as const })),
              ...selectedManifest.outputs.map((port) => ({ port, direction: "output" as const })),
            ].map(({ port, direction }) => (
              <li className={styles.port} key={`${direction}-${port.id}`}>
                <span>{port.label}</span>
                <span className={styles.portTarget}>
                  {direction === "input" ? "in" : "out"} · {port.type.kind}
                </span>
                <Button
                  aria-label={`Expose ${port.label} on the component boundary`}
                  title="Expose on the boundary"
                  onClick={() =>
                    run(
                      bus.execute(
                        "component.exposePort",
                        { direction, nodeId: selected.id, portId: port.id },
                        context,
                      ),
                    )
                  }
                >
                  +
                </Button>
              </li>
            ))}
          </ul>

          <PublishRows
            bus={bus}
            context={context}
            definition={live}
            nodeId={selected.id}
            parameters={selectedManifest.parameters}
            bindings={readParentBindings(selected)}
            parentKeys={parentKeys}
            onMessage={setMessage}
            nodes={nodes}
          />
        </section>
      )}

      {message === null ? null : (
        <p className={styles.empty} role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * One row per parameter of the selected internal node: publish it, or bind it to the
 * owning component's page as `parent.<key>` (§V80, §V81).
 *
 * The two are DIFFERENT mechanisms and the row says so rather than merging them.
 * Publishing makes the component's own control write this parameter; a parent binding
 * makes this parameter READ a value from one level out, which is what a node three levels
 * deep needs when no chain of publishes reaches it. A control offering only the first
 * would leave the second reachable from nothing, which is the state it was in.
 */
function PublishRows({
  bus,
  context,
  definition,
  nodeId,
  parameters,
  bindings,
  parentKeys,
  onMessage,
  nodes,
}: {
  bus: ShaderloomBus;
  context: InvocationContext;
  definition: GraphComponentDefinition;
  nodeId: NodeId;
  parameters: Readonly<Record<string, ParameterDefinition>>;
  bindings: Readonly<Record<string, string>>;
  parentKeys: readonly string[];
  onMessage: (message: string | null) => void;
  nodes: NodeRegistryView;
}) {
  const keys = useMemo(() => Object.keys(parameters).sort(), [parameters]);
  const publishedFor = useMemo(() => {
    const byTarget = new Map<string, string>();
    for (const published of definition.parameters) {
      for (const target of published.targets) {
        if (target.nodeId === nodeId) byTarget.set(target.key, published.key);
      }
    }
    return byTarget;
  }, [definition.parameters, nodeId]);

  const run = (promise: Promise<{ diagnostics: readonly { message: string }[] }>): void => {
    void promise.then((result) => onMessage(result.diagnostics[0]?.message ?? null));
  };

  /** A page key that does not collide, derived from the internal key the user picked. */
  const freeKey = (wanted: string): string => {
    const taken = new Set(definition.parameters.map((published) => published.key));
    if (!taken.has(wanted)) return wanted;
    let suffix = 2;
    while (taken.has(`${wanted}${suffix}`)) suffix += 1;
    return `${wanted}${suffix}`;
  };

  return (
    <ul className={styles.ports}>
      {keys.map((key) => {
        const parameter = parameters[key] as ParameterDefinition;
        const alreadyPublished = publishedFor.get(key);
        const bound = bindings[key] ?? "";
        return (
          <li className={styles.port} key={key}>
            <span>{parameter.label}</span>
            <span className={styles.portTarget}>
              {alreadyPublished === undefined ? parameter.type : `→ ${alreadyPublished}`}
            </span>
            <select
              className={styles.input}
              aria-label={`Bind ${parameter.label} to a parent parameter`}
              value={bound}
              onChange={(event) =>
                run(
                  bus.execute(
                    "component.setParentBinding",
                    {
                      nodeId,
                      key,
                      reference: event.target.value === "" ? null : event.target.value,
                    },
                    context,
                  ),
                )
              }
            >
              <option value="">not bound</option>
              {definition.parameters.map((published) => (
                <option key={published.key} value={`parent.${published.key}`}>
                  parent.{published.key}
                </option>
              ))}
              {parentKeys.map((outer) => (
                <option key={`outer-${outer}`} value={`parent.parent.${outer}`}>
                  parent.parent.{outer}
                </option>
              ))}
            </select>
            <Button
              aria-label={`Publish ${parameter.label} to the parameter page`}
              title="Publish to the parameter page"
              disabled={alreadyPublished !== undefined}
              onClick={() => {
                // The published definition starts as a COPY and is meant to be edited —
                // the rows above are where the range and label get re-authored. Starting
                // from the internal definition is what makes the type match every target,
                // which `validateComponentDefinition` requires (§V80).
                const internal = internalParameterOf(definition.graph, { nodeId, key }, nodes);
                run(
                  bus.execute(
                    "component.publishParameter",
                    {
                      key: freeKey(key),
                      definition: internal ?? parameter,
                      targets: [{ nodeId, key }],
                    },
                    context,
                  ),
                );
              }}
            >
              +
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
