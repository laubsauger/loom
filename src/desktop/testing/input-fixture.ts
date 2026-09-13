import { createVgpuBackend, browserGpuHost } from '../../runtime/backend/index.ts';
import type { LogicalExecutionPlan } from '../../domain/types/backend.ts';
import { desktopInputBridge, type NativeInputTransport } from '../../devices/native-input.ts';

// Test-only readback oracle. Transport uses native GPU surfaces, never these bytes.
export async function verifyNativeInput(name: string, transport: NativeInputTransport = 'syphon') {
  const bridge = desktopInputBridge(transport);
  if (!bridge) throw new Error(`Missing ${transport} input capability`);
  // NDI exact-name open delegates discovery to the SDK, including first startup.
  // Syphon's persisted source identity is a discovery UUID rather than its name.
  const sources = transport === 'ndi' ? [{ id: name }] : (await bridge.list()).filter(source => source.name === name);
  if (sources.length !== 1) throw new Error('Expected one exact round-trip native source');
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
  let previousSequence = 0;
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
        if (transport === 'ndi') {
          const near = (x: number, y: number, rgb: readonly number[]) => {
            const offset = y * image.rowStride + x * 4;
            if (rgb.some((value, channel) => Math.abs(image.bytes[offset + channel]! - value) > 24) || image.bytes[offset + 3] !== 255)
              throw new Error('NDI graph pixels lost orientation, channel order or opaque alpha');
          };
          let sequence = 0;
          for (let bit = 0; bit < 32; bit++) {
            const x = Math.floor((2 * bit + 1) * 1920 / 64);
            const value = image.bytes[135 * image.rowStride + x * 4]! >= 128 ? 255 : 0;
            near(x, 135, [value, value, value]); near(x, 405, [255 - value, 255 - value, 255 - value]);
            if (value) sequence = (sequence | (1 << bit)) >>> 0;
          }
          near(480, 810, [255, 0, 0]); near(1440, 810, [0, 255, 0]);
          if (sequence <= previousSequence) throw new Error('NDI graph input repeated or reversed its decoded frame');
          previousSequence = sequence;
        } else {
          const expected = [0, 0, 255, 255, 0, 0, 255, 255, 0, 128, 0, 255, 0, 128, 0, 255];
          if (colors.some((value, index) => value !== expected[index])) throw new Error(`Native input pixels differ: ${colors}`);
        }
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
