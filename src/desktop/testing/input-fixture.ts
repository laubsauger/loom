import { createVgpuBackend, browserGpuHost } from '../../runtime/backend/index.ts';
import type { LogicalExecutionPlan } from '../../domain/types/backend.ts';

type Metadata = { sequence: number; width: number; height: number };
declare const window: Window & { loomDesktop: { input: {
  list(): Promise<Array<{ id: string; name: string }>>;
  open(uuid: string, consume: (frame: VideoFrame, metadata: Metadata) => Promise<void>): Promise<string>;
  poll(id: string): Promise<unknown>;
  close(id: string): Promise<unknown>;
} } };

// Test-only readback oracle. Transport uses native GPU surfaces, never these bytes.
export async function verifyNativeInput(name: string) {
  const bridge = window.loomDesktop.input;
  const sources = (await bridge.list()).filter(source => source.name === name);
  if (sources.length !== 1) throw new Error('Expected one exact round-trip Syphon source');
  const backend = createVgpuBackend({ host: browserGpuHost() });
  const plan: LogicalExecutionPlan = {
    resources: [
      { kind: 'externalTexture', id: 'native', sourceId: 'native-source', size: [1920, 1080], format: 'rgba8unorm-srgb' },
      { kind: 'target', id: 'out', size: [1920, 1080], format: 'rgba8unorm-srgb' },
    ],
    passes: [{ kind: 'effect', id: 'copy', target: 'out',
      shader: `@group(0) @binding(0) var source: texture_2d<f32>;
        @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
          return textureLoad(source, vec2i(p.xy), 0);
        }`, textures: [{ binding: 'source', resourceId: 'native' }], samplers: [],
    }], diagnostics: [],
  };
  let session: string | undefined;
  const samples: number[][] = [];
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    session = await bridge.open(sources[0]!.id, async (frame, metadata) => {
      if (metadata.width !== 1920 || metadata.height !== 1080) throw new Error('Native input lost full resolution');
      const unregister = backend.registerMediaSource('native-source', {
        currentFrame: () => ({ frameId: metadata.sequence, image: frame }),
      });
      try {
        backend.render(compiled, {
          frame: { timeSeconds: metadata.sequence / 60, deltaSeconds: 1 / 60, frameIndex: metadata.sequence, mode: 'offline', randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 }, resolution: [1920, 1080],
        });
        const image = await backend.readOutput('out');
        const colors = [[100, 100], [1800, 100], [100, 900], [1800, 900]].flatMap(([x, y]) =>
          Array.from(image.bytes.slice(y! * image.rowStride + x! * 4, y! * image.rowStride + x! * 4 + 4)));
        const expected = [0, 0, 255, 255, 0, 0, 255, 255, 0, 128, 0, 255, 0, 128, 0, 255];
        if (colors.some((value, index) => value !== expected[index])) throw new Error(`Native input pixels differ: ${colors}`);
        samples.push(colors);
      } finally { unregister(); }
    });
    const deadline = performance.now() + 10000;
    while (samples.length < 3) {
      if (performance.now() > deadline) throw new Error('Native input round trip timed out');
      await bridge.poll(session);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { frames: samples.length, size: [1920, 1080], samples };
  } finally {
    try { if (session) await bridge.close(session); } finally { backend.dispose(); }
  }
}
