import { createGraphStore } from '../../domain/graph/store.ts';
import { createDomainBus } from '../../domain/commands/index.ts';
import { createNodeRegistry } from '../../nodes/registry/registry.ts';
import { allNodeDefinitions } from '../../nodes/definitions/index.ts';
import { buildProjectFile } from '../../domain/project/project-file.ts';
import { displacementStackDocument } from '../../examples/documents/displacement-stack.ts';
import { createComponentSystem, registerComponentCommands } from '../../domain/components/index.ts';
import { flattenComponents } from '../../compiler/flatten.ts';

/** Authored through commands, then loaded through the real project-open UI. */
export async function nativeOutputFixture(nativeSource?: string, nested = false, publishers?: string | readonly string[]) {
  const store = createGraphStore();
  const { nodes: registry, components } = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const { bus } = createDomainBus({ store, registry });
  registerComponentCommands(bus, { components });
  const result = await bus.execute('graph.applyPatch', {
    baseRevision: store.view.getGraph().revision,
    label: 'Native output pixel and resize fixture',
    operations: [
      { op: 'addNode', ref: '$a', type: 'checker', label: 'Native A', position: { x: 0, y: 0 },
        parameters: { size: [1, 2], color1: [1, 0, 0, 1], color2: [0, 128 / 255, 0, 1] } },
      { op: 'addNode', ref: '$b', type: 'checker', label: 'Native B', position: { x: 0, y: 200 },
        parameters: { size: [1, 2], color1: [0, 0, 1, 1], color2: [0, 128 / 255, 0, 1] } },
      { op: 'setNodeResolution', nodeId: '$b', resolution: { mode: 'fixed', width: 1920, height: 1080 } },
      { op: 'addNode', ref: '$out', type: 'output', label: 'Output', position: { x: 300, y: 0 } },
      { op: 'connect', source: { nodeId: '$a', portId: 'out' }, target: { nodeId: '$out', portId: 'input' } },
    ],
  }, { actor: { kind: 'system', id: 'native-output-smoke' }, projectId: 'native-output-smoke', capabilities: [] });
  if (result.status !== 'applied') throw new Error(JSON.stringify(result));
  for (const publisherName of typeof publishers === 'string' ? [publishers] : publishers ?? []) {
    const added = await bus.execute('graph.applyPatch', {
      baseRevision: store.view.getGraph().revision, label: 'Syphon output graph fixture', operations: [
        { op: 'addNode', ref: '$syphon', type: 'syphonOut', position: { x: 400, y: 200 }, parameters: { name: publisherName } },
        { op: 'connect', source: { nodeId: result.output.createdIds['$b']!, portId: 'out' }, target: { nodeId: '$syphon', portId: 'input' } },
      ],
    }, { actor: { kind: 'system', id: 'native-output-smoke' }, projectId: 'native-output-smoke', capabilities: [] });
    if (added.status !== 'applied') throw new Error(JSON.stringify(added));
  }
  if (nativeSource !== undefined) {
    const native = await bus.execute('graph.applyPatch', {
      baseRevision: store.view.getGraph().revision, label: 'Native input graph fixture',
      operations: [{ op: 'addNode', ref: '$native', type: 'syphonIn', label: 'Native Input', position: { x: 0, y: 400 },
        parameters: { source: nativeSource } },
        { op: 'setParameters', nodeId: Object.values(store.view.getGraph().nodes).find(node => node.label === 'Native A')!.id,
          parameters: { color1: [73 / 255, 31 / 255, 17 / 255, 1], color2: [73 / 255, 31 / 255, 17 / 255, 1] } }],
    }, { actor: { kind: 'system', id: 'native-output-smoke' }, projectId: 'native-output-smoke', capabilities: [] });
    if (native.status !== 'applied') throw new Error(JSON.stringify(native));
    if (nested) {
      const context = { actor: { kind: 'system' as const, id: 'native-output-smoke' }, projectId: 'native-output-smoke', capabilities: [] };
      const inputId = native.output.createdIds['$native']!;
      const outputId = Object.values(store.view.getGraph().nodes).find(node => node.type === 'output')!.id;
      const wire = await bus.execute('graph.applyPatch', { baseRevision: store.view.getGraph().revision, label: 'Expose native input', operations: [
        { op: 'disconnect', edgeIds: Object.keys(store.view.getGraph().edges) },
        { op: 'connect', source: { nodeId: inputId, portId: 'out' }, target: { nodeId: outputId, portId: 'input' } },
      ] }, context);
      if (wire.status !== 'applied') throw new Error(JSON.stringify(wire));
      let selected = inputId;
      for (const name of ['Receiver', 'Nested Receiver']) {
        const wrapped = await bus.execute('component.saveSelection', { nodeIds: [selected], name }, context);
        if (wrapped.status !== 'applied' || !wrapped.output.instanceNodeId) throw new Error(JSON.stringify(wrapped));
        selected = wrapped.output.instanceNodeId;
      }
    }
  }
  const graph = store.view.getGraph();
  const document = { ...displacementStackDocument, id: 'native-output-smoke', name: 'Native output smoke', graph };
  const file = buildProjectFile({ document, components: components.view().list(), now: () => document.updatedAt });
  const flat = flattenComponents({ graph, registry, components: components.view() }).graph;
  return { text: file.text, a: `${Object.values(graph.nodes).find(node => node.label === 'Native A')!.id}:out`,
    b: `${Object.values(graph.nodes).find(node => node.label === 'Native B')!.id}:out`,
    native: `${Object.values(flat.nodes).find(node => node.type === 'syphonIn')?.id}:out` };
}
