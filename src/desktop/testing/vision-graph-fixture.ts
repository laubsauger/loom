import { createGraphStore } from '../../domain/graph/store.ts';
import { createDomainBus } from '../../domain/commands/index.ts';
import { createNodeRegistry } from '../../nodes/registry/registry.ts';
import { allNodeDefinitions } from '../../nodes/definitions/index.ts';
import { mediaSourceIdFor } from '../../nodes/definitions/media.ts';
import { personMaskNode } from '../../nodes/definitions/person-mask.ts';
import { effectiveParameterSchema } from '../../domain/parameters/resolve.ts';
import { compileGraph } from '../../compiler/index.ts';
import { createVgpuBackend, browserGpuHost } from '../../runtime/backend/index.ts';
import { createNativeVisionSources } from '../../app/native-vision-sources.ts';
import { displacementStackDocument } from '../../examples/documents/displacement-stack.ts';
import { buildProjectFile } from '../../domain/project/project-file.ts';

async function createVisionGraph() {
  const store = createGraphStore(), registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const result = await bus.execute('graph.applyPatch', {
    baseRevision: store.view.getGraph().revision, label: 'Native Vision graph proof', operations: [
      { op: 'addNode', ref: '$source', type: 'webcam', label: 'Fixture image', position: { x: 0, y: 0 } },
      { op: 'setNodeResolution', nodeId: '$source', resolution: { mode: 'fixed', width: 1920, height: 1080 } },
      { op: 'addNode', ref: '$mask', type: 'personMask', label: 'mask1', position: { x: 300, y: 0 }, parameters: { transport: 'native', rateLimit: 0 } },
      { op: 'addNode', ref: '$output', type: 'output', position: { x: 600, y: 0 } },
      { op: 'connect', source: { nodeId: '$source', portId: 'out' }, target: { nodeId: '$mask', portId: 'input' } },
      { op: 'connect', source: { nodeId: '$mask', portId: 'out' }, target: { nodeId: '$output', portId: 'input' } },
    ],
  }, { actor: { kind: 'system', id: 'vision-graph-smoke' }, projectId: 'vision-graph-smoke', capabilities: [] });
  if (result.status !== 'applied') throw new Error(JSON.stringify(result));
  const sourceId = result.output.createdIds['$source']!, maskId = result.output.createdIds['$mask']!;
  return { store, registry, sourceId, maskId, bus };
}

export async function nativeVisionFixture() {
  const { store, maskId } = await createVisionGraph();
  const document = { ...displacementStackDocument, id: 'native-vision-smoke', name: 'Native Vision smoke',
    graph: store.view.getGraph(), settings: { ...displacementStackDocument.settings, workingFormat: 'rgba8unorm' as const } };
  return { text: buildProjectFile({ document, components: [], now: () => document.updatedAt }).text, maskId };
}

/** Two workers, opposite images, then swapped images: catches cross-session routing. */
export async function verifyConcurrentVisionGraph(photo: string, inspect: () => Promise<{ producerPid: number; error: string | null }[]>) {
  const { store, registry, sourceId, maskId, bus } = await createVisionGraph();
  const added = await bus.execute('graph.applyPatch', {
    baseRevision: store.view.getGraph().revision, label: 'Second native model', operations: [
      { op: 'addNode', ref: '$source2', type: 'webcam', position: { x: 0, y: 300 } },
      { op: 'setNodeResolution', nodeId: '$source2', resolution: { mode: 'fixed', width: 1920, height: 1080 } },
      { op: 'addNode', ref: '$mask2', type: 'personMask', position: { x: 300, y: 300 }, parameters: { transport: 'native', rateLimit: 0 } },
      { op: 'addNode', ref: '$output2', type: 'output', position: { x: 600, y: 300 } },
      { op: 'connect', source: { nodeId: '$source2', portId: 'out' }, target: { nodeId: '$mask2', portId: 'input' } },
      { op: 'connect', source: { nodeId: '$mask2', portId: 'out' }, target: { nodeId: '$output2', portId: 'input' } },
    ],
  }, { actor: { kind: 'system', id: 'vision-graph-smoke' }, projectId: 'vision-graph-smoke', capabilities: [] });
  if (added.status !== 'applied') throw new Error(JSON.stringify(added));
  const sourceIds = [sourceId, added.output.createdIds['$source2']!];
  const maskIds = [maskId, added.output.createdIds['$mask2']!];
  const backend = createVgpuBackend({ host: browserGpuHost() }), native = createNativeVisionSources();
  const image = new Image(); image.src = photo; await image.decode();
  const blank = new OffscreenCanvas(1920, 1080), context = blank.getContext('2d')!;
  context.fillStyle = 'black'; context.fillRect(0, 0, 1920, 1080);
  const bitmaps = await Promise.all([image, blank].map(source => createImageBitmap(source, { resizeWidth: 1920, resizeHeight: 1080 })));
  const errors: string[] = [], frames = [];
  backend.onDiagnostic(d => { if (d.severity === 'error') errors.push(d.message); });
  try {
    const capabilities = await backend.initialize({});
    const graph = compileGraph({ graph: store.view.getGraph(), registry, capabilities,
      settings: { ...displacementStackDocument.settings, workingFormat: 'rgba8unorm' } });
    if (graph.diagnostics.some(d => d.severity === 'error')) throw new Error(JSON.stringify(graph.diagnostics));
    const plan = await backend.compile(graph);
    native.track(maskIds.map(nodeId => ({ nodeId, size: [1920, 1080], minIntervalSeconds: 0 })), backend);
    for (let index = 0; index < 3; index++) {
      const unregister = sourceIds.map((id, branch) => backend.registerMediaSource(mediaSourceIdFor(id), {
        currentFrame: () => ({ image: bitmaps[(index + branch) % 2], frameId: index + 1 }),
      }));
      try {
        const frame = { frameIndex: index, timeSeconds: index / 60, deltaSeconds: 1 / 60, mode: 'offline' as const, randomSeed: 7 };
        const render = () => backend.render(plan, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [1920, 1080] });
        const readbacks = backend.status.readbacks;
        render(); native.observe(frame); await native.settle(index);
        if (backend.status.readbacks !== readbacks) throw new Error('Concurrent native inference read back image pixels');
        const sessions = await inspect();
        if (sessions.length !== 2 || new Set(sessions.map(s => s.producerPid)).size !== 2 || sessions.some(s => s.error))
          throw new Error(`Expected two independent healthy workers: ${JSON.stringify(sessions)}`);
        render();
        const coverage = [];
        for (const [branch, nodeId] of maskIds.entries()) {
          const output = await backend.readOutput(graph.outputs.find(entry => entry.nodeId === nodeId)!.resourceId);
          let foreground = 0;
          for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++)
            if (output.bytes[y * output.rowStride + x * 4]! > 128) foreground++;
          const value = foreground / (1920 * 1080), empty = (index + branch) % 2 === 1;
          if (output.width !== 1920 || output.height !== 1080 || (empty ? value !== 0 : value < 0.01))
            throw new Error(`Concurrent frame ${index}, branch ${branch}: unexpected coverage ${value}`);
          coverage.push(value);
        }
        frames.push({ index, coverage, workers: sessions.map(s => s.producerPid) });
      } finally { unregister.forEach(remove => remove()); }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { frames };
  } finally { bitmaps.forEach(bitmap => bitmap.close()); await native.drain(); backend.dispose(); }
}

/** Real graph/compiler/backend/model scheduler, with test-only source and pixel readback. */
export async function verifyVisionGraph(photo: string, verifyCapture?: (rgbaBase64: string) => Promise<void>) {
  const { store, registry, sourceId, maskId } = await createVisionGraph();
  const backend = createVgpuBackend({ host: browserGpuHost() });
  const native = createNativeVisionSources();
  const errors: string[] = [];
  backend.onDiagnostic(d => { if (d.severity === 'error') errors.push(d.message); });
  const image = new Image(); image.src = photo; await image.decode();
  const blank = new OffscreenCanvas(image.width, image.height);
  const context = blank.getContext('2d')!; context.fillStyle = 'black'; context.fillRect(0, 0, blank.width, blank.height);
  let input: ImageBitmap | undefined;
  try {
    const capabilities = await backend.initialize({});
    const graph = compileGraph({ graph: store.view.getGraph(), registry, capabilities,
      settings: { ...displacementStackDocument.settings, workingFormat: 'rgba8unorm' } });
    const failures = graph.diagnostics.filter(d => d.severity === 'error');
    if (failures.length) throw new Error(JSON.stringify(failures));
    const plan = await backend.compile(graph);
    const output = graph.outputs.find(entry => entry.nodeId === maskId)!;
    const frames = [];
    for (const [index, empty] of [false, true, false, false, true, false].entries()) {
      // Reset model history between independent positive/negative controls. The
      // production export preflight uses this same drain boundary.
      if (index <= 3) {
        await native.drain();
        native.track([{ nodeId: maskId, size: [1920, 1080], minIntervalSeconds: 0, channel: 'mask1' }], backend);
      }
      input = await createImageBitmap(empty ? blank : image, { resizeWidth: 1920, resizeHeight: 1080 });
      const unregister = backend.registerMediaSource(mediaSourceIdFor(sourceId), { currentFrame: () => ({ image: input, frameId: index + 1 }) });
      const frame = { frameIndex: index, timeSeconds: index / 60, deltaSeconds: 1 / 60, mode: 'offline' as const, randomSeed: 7 };
      const render = () => backend.render(plan, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [1920, 1080] });
      try {
        const readbacks = backend.status.readbacks;
        render();
        if (errors.length) throw new Error(errors.join('\n'));
        native.observe(frame); await native.settle(index);
        if (backend.status.readbacks !== readbacks) throw new Error('Native inference performed an image readback');
        if (verifyCapture) {
          // Oracle only: compare every model-input byte with the capture renderer,
          // including alpha-as-data and packed-image row/padding boundaries.
          const floats = new Float32Array(await backend.readBuffer(`scratch:${maskId}:modelInput`));
          const bytes = Uint8Array.from(floats, value => Math.max(0, Math.min(255, Math.round(value * 255))));
          let text = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          await verifyCapture(btoa(text));
        }
        render();
        if (errors.length) throw new Error(errors.join('\n'));
        const readback = await backend.readOutput(output.resourceId);
        if (readback.width !== 1920 || readback.height !== 1080) throw new Error('Native graph lost full resolution');
        let foreground = 0;
        for (let y = 0; y < readback.height; y++) for (let x = 0; x < readback.width; x++)
          if (readback.bytes[y * readback.rowStride + x * 4]! > 128) foreground++;
        const coverage = foreground / (1920 * 1080);
        if (empty ? coverage !== 0 : coverage < 0.01) {
          const node = store.view.getGraph().nodes[maskId]!;
          const modelCoverage = native.resolver('mask1:coverage', { frame, node, key: 'transport', definition: effectiveParameterSchema(personMaskNode, node.parameters)['transport']! });
          const inputPixels = new Float32Array(await backend.readBuffer(`scratch:${maskId}:modelInput`));
          let sum = 0, max = 0;
          for (let i = 0; i < inputPixels.length; i += 4) { sum += inputPixels[i]!; max = Math.max(max, inputPixels[i]!); }
          throw new Error(`Native graph unexpected ${empty ? 'blank' : 'person'} coverage ${coverage}; model=${modelCoverage}; input=${sum / (512*512)},max=${max}; ${JSON.stringify(native.diagnostics())}`);
        }
        frames.push({ index, empty, coverage, format: readback.format, continuingSession: index > 3 });
      } finally { unregister(); input.close(); input = undefined; }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { frames, width: 1920, height: 1080 };
  } finally { input?.close(); await native.drain(); backend.dispose(); }
}
