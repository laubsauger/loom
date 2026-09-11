import { createVgpuBackend, browserGpuHost, BackendDiagnosticCode } from '../../src/runtime/backend/index.ts';
import type { LogicalExecutionPlan } from '../../src/domain/types/backend.ts';

declare const window: Window & { exportProbe: { select(index: number): void; dispose(): void } };
const backend = createVgpuBackend({ host: browserGpuHost() });
backend.onDiagnostic(d => {
  if (d.severity === 'error' || d.code === BackendDiagnosticCode.frameError) throw new Error(d.message);
});
await backend.initialize({});
const plan: LogicalExecutionPlan = {
  resources: ['a', 'b'].map(id => ({ kind: 'target' as const, id, size: [1920, 1080], format: 'rgba8unorm-srgb' as const })),
  passes: ['a', 'b'].map((id, index) => ({ kind: 'effect' as const, id: `draw-${id}`, target: id,
    shader: `@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
      return vec4f(${index === 0 ? '1.0' : '0.0'}, select(0.0, 0.5, p.y > 540.0), ${index === 1 ? '1.0' : '0.0'}, 1.0);
    }`, textures: [], samplers: [] })), diagnostics: [],
};
const compiled = await backend.compile(plan);
const canvas = document.querySelector('canvas');
if (!canvas) throw new Error('Missing dedicated output canvas');
const presentation = backend.present(canvas, { outputId: 'a' });
window.exportProbe = {
  select(index) {
    if (!Number.isInteger(index) || index < 0 || index > 2) throw new Error('Invalid selection');
    presentation.setOutput(index === 1 ? 'b' : 'a');
    backend.render(compiled, {
      frame: { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: 'offline', randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [1920, 1080],
    });
  },
  dispose() { presentation.dispose(); backend.dispose(); },
};
