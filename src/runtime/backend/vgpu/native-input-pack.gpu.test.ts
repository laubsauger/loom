import { expect, it } from "vitest";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import type { GpuSession } from "./gpu-host.ts";
import { nativeInputTransportSize } from "../../models/native-input-layout.ts";

it("packs every RGBA channel like the CPU, including alpha and quantization boundaries", async () => {
  const base = nodeGpuHost();
  let session: GpuSession;
  const backend = createVgpuBackend({ host: { label: base.label, create: async options => (session = await base.create(options)) } });
  const errors: string[] = [];
  backend.onDiagnostic(d => { if (d.severity === "error") errors.push(d.message); });
  await backend.initialize({});
  const device = session!.gpu.device.gpu;
  const side = 64;
  const [width, height] = nativeInputTransportSize([side, side]);
  let texture: GPUTexture;
  const canvas = { width, height, getContext: () => ({
    configure: ({ format }: { format: GPUTextureFormat }) => {
      texture = device.createTexture({ size: [width, height], format, usage: 0x15 });
    },
    unconfigure() {}, getCurrentTexture: () => texture,
  }) };
  try {
    const plan = await backend.compile({ diagnostics: [],
      resources: [{ kind: "buffer", id: "input", stride: 16, capacity: side * side, usage: "storage" }],
      passes: [{ kind: "dispatch", id: "fill", entryPoint: "main", workgroups: [side, 1, 1],
        buffers: [{ binding: "input", resourceId: "input" }], shader: `
@group(0) @binding(0) var<storage, read_write> input: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x % 255u;
  let bits = bitcast<u32>((f32(k) + 0.5) / 255.0);
  input[gid.x] = vec4f(bitcast<f32>(bits-1u), bitcast<f32>(bits), bitcast<f32>(bits+1u), select(-0.25, 2.0, gid.x%2u==0u));
}` }],
    });
    const attached = backend.present(canvas, { outputId: "input", modelInputSize: [side, side] });
    backend.render(plan, { frame: { frameIndex: 0, timeSeconds: 0, deltaSeconds: 1 / 60, mode: "offline", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [side, side] });
    expect(errors).toEqual([]);
    expect(attached.describe!().presentedFrames).toBe(1);
    const floats = new Float32Array(await backend.readBuffer("input"));
    const stride = Math.ceil(width * 4 / 256) * 256;
    const staging = device.createBuffer({ size: stride * height, usage: 9 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: texture! }, { buffer: staging, bytesPerRow: stride }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const bytes = new Uint8Array(staging.getMappedRange());
    const mismatches: unknown[] = [];
    for (let index = 0; index < floats.length; index++) {
      const pixel = Math.floor(index / 3);
      const offset = Math.floor(pixel / width) * stride + (pixel % width) * 4;
      const component = [2, 1, 0][index % 3]!; // Dawn's preferred surface is BGRA8.
      const actual = bytes[offset + component];
      const expected = Math.max(0, Math.min(255, Math.round(floats[index]! * 255)));
      if (actual !== expected && mismatches.length < 10) mismatches.push({ index, value: floats[index], expected, actual });
      expect(bytes[offset + 3]).toBe(255);
    }
    staging.unmap(); staging.destroy(); attached.dispose();
    expect(mismatches).toEqual([]);
  } finally { backend.dispose(); }
}, 60_000);
