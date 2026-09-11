import { createVgpuBackend, browserGpuHost, BackendDiagnosticCode } from '../../src/runtime/backend/index.ts';
import type { LogicalExecutionPlan } from '../../src/domain/types/backend.ts';

declare const window: Window & {
  proof: {
    receive(callback: (frame: VideoFrame, metadata: { sequence: number; format: number }, release: () => void) => Promise<unknown>): void;
    ready(): void;
    fail(message: string): void;
  };
};

function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const mantissa = bits & 1023;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24);
}

async function run() {
  const backend = createVgpuBackend({ host: browserGpuHost() });
  backend.onDiagnostic(diagnostic => {
    if (diagnostic.severity === 'error' || diagnostic.code === BackendDiagnosticCode.frameError) {
      window.proof.fail(`${diagnostic.code}: ${diagnostic.message}`);
    }
  });
  const plan: LogicalExecutionPlan = {
    resources: [
      { kind: 'externalTexture', id: 'native', sourceId: 'native-source', size: [64, 64], format: 'rgba16float' },
      { kind: 'target', id: 'out', size: [64, 64], format: 'rgba16float' },
    ],
    passes: [{ kind: 'effect', id: 'copy', target: 'out',
      shader: `@group(0) @binding(0) var source: texture_2d<f32>;
        @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
          return textureLoad(source, vec2i(p.xy), 0);
        }`,
      textures: [{ binding: 'source', resourceId: 'native' }], samplers: [],
    }], diagnostics: [],
  };
  await backend.initialize({});
  const compiled = await backend.compile(plan);
  const at = (index: number) => ({
    frame: { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: 'offline' as const, randomSeed: 7 },
    pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] as const,
  });
  let previousUnregister: (() => void) | undefined;
  window.proof.receive(async (frame, { sequence, format }, release) => {
    if (frame.timestamp !== sequence) throw new Error('Wrong native frame timestamp');
    // A new producer may restart its frame counter. A stale owner's unregister
    // must not remove the replacement registered under the same source ID.
    const unregister = backend.registerMediaSource('native-source', {
      currentFrame: () => ({ frameId: 0, image: frame }),
    });
    previousUnregister?.();
    previousUnregister = unregister;
    backend.render(compiled, at(sequence * 3));
    release();
    // Reusing the already uploaded ID must not touch the now-closed VideoFrame.
    backend.render(compiled, at(sequence * 3 + 1));
    const image = await backend.readOutput('out');
    if (image.format !== 'rgba16float' || image.rowStride !== 512) throw new Error('Unexpected backend readback format');
    const pixels = new Uint16Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength / 2);
    let maxError = 0;
    const samples: number[] = [];
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const red = format === 0 ? ((Math.floor(x / 8) + sequence) % 4) / 3
        : x < 16 ? -0.25 : x < 32 ? 0.125 : x < 48 ? 0.5 : 2;
      const expected = [red, ((Math.floor(y / 8) + sequence) % 4) / 3, sequence % 2, 1];
      for (let channel = 0; channel < 4; channel++) {
        const actual = half(pixels[(y * 64 + x) * 4 + channel]!);
        if (!Number.isFinite(actual)) throw new Error('Non-finite backend pixel');
        maxError = Math.max(maxError, Math.abs(actual - expected[channel]!));
        if (y === 4 && x % 16 === 4 && channel === 0) samples.push(actual);
      }
    }
    if (sequence === 23) {
      unregister();
      backend.render(compiled, at(sequence * 3 + 2));
      const held = await backend.readOutput('out');
      if (held.bytes.some((byte, index) => byte !== image.bytes[index])) throw new Error('Unregister changed retained output');
      backend.dispose();
    }
    return { sequence, format, maxError, samples, earlyReleased: true,
      adapter: { path: 'actual browserGpuHost/createVgpuBackend' } };
  });
  window.proof.ready();
}
run().catch(error => window.proof.fail(String(error.stack ?? error)));
