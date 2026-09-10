/* global window, navigator, GPUTextureUsage, GPUBufferUsage, GPUMapMode */
function half(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const mantissa = bits & 1023;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24);
}

async function run() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  let expectingDeviceLoss = false;
  device.addEventListener('uncapturederror', event => window.proof.fail(event.error.message));
  device.lost.then(info => {
    if (!expectingDeviceLoss) window.proof.fail(`Device lost: ${info.message}`);
  });
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var source: texture_external;
    @group(0) @binding(1) var sampleSource: sampler;
    @vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      let p = array(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
      return vec4f(p[i], 0, 1);
    }
    @fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
      return textureSampleBaseClampToEdge(source, sampleSource, p.xy / 64.0);
    }` });
  const pipeline = await device.createRenderPipelineAsync({ layout: 'auto',
    vertex: { module, entryPoint: 'vertex' },
    fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
  });
  const target = device.createTexture({ size: [64, 64], format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 64 * 64 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  window.proof.receive(async (frame, { sequence, format, fault }, release) => {
    if (frame.timestamp !== sequence) throw new Error('Wrong frame timestamp');
    const external = device.importExternalTexture({ source: frame, colorSpace: 'srgb' });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: external }, { binding: 1, resource: sampler },
    ] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    // Readback is the TEST ORACLE only. It is not part of native frame transport.
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 512 }, [64, 64]);
    device.queue.submit([encoder.finish()]);
    const earlyReleased = fault === 'early-release';
    if (earlyReleased) release();
    if (fault === 'gpu-loss') {
      expectingDeviceLoss = true;
      window.proof.submitted(sequence);
      // Keep both native references held until explicit device loss. Submission
      // precedes the kill, but does not prove hardware execution overlaps it.
      const info = await device.lost;
      if (info.reason === 'destroyed') throw new Error('Expected process loss, not device.destroy()');
      return;
    }
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint16Array(readback.getMappedRange());
    let maxError = 0;
    const samples = [];
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const red = format === 0 ? ((Math.floor(x / 8) + sequence) % 4) / 3
        : x < 16 ? -0.25 : x < 32 ? 0.125 : x < 48 ? 0.5 : 2;
      const expected = [red, ((Math.floor(y / 8) + sequence) % 4) / 3, sequence % 2, 1];
      for (let c = 0; c < 4; c++) {
        const actual = half(pixels[(y * 64 + x) * 4 + c]);
        if (!Number.isFinite(actual)) throw new Error('Non-finite imported pixel');
        maxError = Math.max(maxError, Math.abs(actual - expected[c]));
        if (y === 4 && x % 16 === 4 && c === 0) samples.push(actual);
      }
    }
    readback.unmap();
    return { sequence, format, maxError, samples, earlyReleased, adapter: {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
    } };
  });
  window.proof.ready();
}
run().catch(error => window.proof.fail(String(error.stack ?? error)));
