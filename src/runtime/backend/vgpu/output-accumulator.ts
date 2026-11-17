import type { TextureFormat } from "../../../domain/types/node-definition.ts";
import type { AccumulatedSum, LinearDecode } from "../backend-types.ts";

/**
 * T1739b — AN OUTPUT'S FRAMES SUMMED ON THE GPU, in linear light: the device half of
 * `LoomBackend.accumulateOutput`.
 *
 * `add` copies the output texture's STORED bytes into a buffer and runs one compute pass
 * that decodes each channel through the caller's tables, indexed by the raw stored pattern,
 * and adds it into a float32 sum per pixel. Indexing by the pattern is what makes the decode
 * the same f32 a CPU table lookup of a readback gives, an `-srgb` texture included (a
 * sampled read of one is decoded by the hardware's own curve). Nothing is read back until
 * `read`, which copies the sum out once and zeroes it.
 *
 * Bit for bit against a CPU sum of the same readbacks wherever alpha is 1: colour times one
 * is exact, and one f32 addition is correctly rounded on both sides. Where alpha is
 * fractional the GPU rounds the product before the addition (or fuses the two) while the CPU
 * rounds once, so a sum can differ in its last bit.
 */

const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_STORAGE = 0x0080;
const MAP_MODE_READ = 0x0001;

/** The formats a table can decode: bytes per texel, and how many patterns one channel has. */
const LAYOUTS: Partial<Record<TextureFormat, { readonly bytes: 4 | 8; readonly patterns: number }>> = {
  rgba16float: { bytes: 8, patterns: 65_536 },
  rgba8unorm: { bytes: 4, patterns: 256 },
  "rgba8unorm-srgb": { bytes: 4, patterns: 256 },
};

/** The four stored channels of a texel, as table indices. A half is 16 bits, a byte 8 (little-endian rows). */
const READ_TEXEL: Readonly<Record<4 | 8, string>> = {
  8: `let at = id.y * shape.wordsPerRow + id.x * 2u;
  let low = texels[at];
  let high = texels[at + 1u];
  let r = colour[low & 0xffffu];
  let g = colour[low >> 16u];
  let b = colour[high & 0xffffu];
  let a = alpha[high >> 16u];`,
  4: `let word = texels[id.y * shape.wordsPerRow + id.x];
  let r = colour[word & 0xffu];
  let g = colour[(word >> 8u) & 0xffu];
  let b = colour[(word >> 16u) & 0xffu];
  let a = alpha[word >> 24u];`,
};

const shaderFor = (bytes: 4 | 8): string => `struct Shape {
  width: u32,
  height: u32,
  wordsPerRow: u32,
  premultiply: u32,
};
@group(0) @binding(0) var<storage, read> texels: array<u32>;
@group(0) @binding(1) var<storage, read_write> sums: array<vec4f>;
@group(0) @binding(2) var<storage, read> colour: array<f32>;
@group(0) @binding(3) var<storage, read> alpha: array<f32>;
@group(0) @binding(4) var<uniform> shape: Shape;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= shape.width || id.y >= shape.height) {
    return;
  }
  ${READ_TEXEL[bytes]}
  let weight = select(1.0, a, shape.premultiply == 1u);
  let i = id.y * shape.width + id.x;
  sums[i] = sums[i] + vec4f(r * weight, g * weight, b * weight, a);
}
`;

export interface AccumulatorShape {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
}

/** One output's running sum on one device; the backend wraps it with its guards and counters. */
export interface DeviceOutputAccumulator {
  /** Adds what `texture` holds now (it must have the shape the accumulator was made for). */
  add(texture: GPUTexture): void;
  readonly count: number;
  read(): Promise<AccumulatedSum>;
  dispose(): void;
}

/**
 * Builds the sum for an output of `shape`. Throws, naming why, for a format no table
 * decodes (a one-channel `r32float`), tables of the wrong length, or a sum larger than the
 * device can bind as one storage buffer (4K, 3840 × 2160, fits the WebGPU default of 128 MiB).
 */
export function createOutputAccumulator(device: GPUDevice, shape: AccumulatorShape, decode: LinearDecode): DeviceOutputAccumulator {
  const { width, height, format } = shape;
  const layout = LAYOUTS[format];
  if (layout === undefined) {
    throw new Error(`A ${format} output cannot be summed on the GPU: only rgba16float, rgba8unorm and rgba8unorm-srgb have a per-pattern decode.`);
  }
  if (decode.colour.length !== layout.patterns || decode.alpha.length !== layout.patterns) {
    throw new Error(`A ${format} output decodes through tables of ${layout.patterns} entries; got ${decode.colour.length} (colour) and ${decode.alpha.length} (alpha).`);
  }
  const rowBytes = Math.ceil((width * layout.bytes) / 256) * 256;
  const sumBytes = width * height * 16;
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  if (sumBytes > limit || rowBytes * height > limit) {
    throw new Error(`A ${width}×${height} sum needs ${sumBytes} bytes in one storage buffer, and this device binds at most ${limit}.`);
  }

  const buffers: GPUBuffer[] = [];
  const buffer = (label: string, size: number, usage: number): GPUBuffer => {
    const made = device.createBuffer({ label: `output accumulate: ${label}`, size, usage });
    buffers.push(made);
    return made;
  };
  const texels = buffer("texels", rowBytes * height, BUFFER_STORAGE | BUFFER_COPY_DST);
  // A new buffer is zero-filled (WebGPU), so the first sum starts at nothing.
  const sums = buffer("sums", sumBytes, BUFFER_STORAGE | BUFFER_COPY_SRC | BUFFER_COPY_DST);
  const colour = buffer("colour table", decode.colour.byteLength, BUFFER_STORAGE | BUFFER_COPY_DST);
  const alpha = buffer("alpha table", decode.alpha.byteLength, BUFFER_STORAGE | BUFFER_COPY_DST);
  const uniform = buffer("shape", 16, BUFFER_UNIFORM | BUFFER_COPY_DST);
  const staging = buffer("readback", sumBytes, BUFFER_MAP_READ | BUFFER_COPY_DST);
  device.queue.writeBuffer(colour, 0, decode.colour as BufferSource);
  device.queue.writeBuffer(alpha, 0, decode.alpha as BufferSource);
  device.queue.writeBuffer(uniform, 0, Uint32Array.from([width, height, rowBytes / 4, decode.premultiply ? 1 : 0]));

  const pipeline = device.createComputePipeline({
    label: `output accumulate (${format})`,
    layout: "auto",
    compute: { module: device.createShaderModule({ label: `output accumulate (${format})`, code: shaderFor(layout.bytes) }), entryPoint: "main" },
  });
  const bindings = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [texels, sums, colour, alpha, uniform].map((entry, binding) => ({ binding, resource: { buffer: entry } })),
  });

  let count = 0;
  let reading = false;
  let disposed = false;
  const live = (what: string): void => {
    if (disposed) throw new Error(`output accumulate: ${what} after dispose().`);
    if (reading) throw new Error(`output accumulate: ${what} while the sum is being read.`);
  };
  return {
    get count() {
      return count;
    },
    add(texture) {
      live("add()");
      if (texture.width !== width || texture.height !== height) {
        throw new Error(`output accumulate: the output is ${texture.width}×${texture.height} now and the sum is ${width}×${height}; a sum of two sizes is no picture.`);
      }
      const encoder = device.createCommandEncoder({ label: "output accumulate: add" });
      encoder.copyTextureToBuffer({ texture }, { buffer: texels, bytesPerRow: rowBytes, rowsPerImage: height }, [width, height]);
      const pass = encoder.beginComputePass({ label: "output accumulate: add" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      // Queue order puts this after the frame that drew the output and before the next one.
      device.queue.submit([encoder.finish()]);
      count += 1;
    },
    async read() {
      live("read()");
      reading = true;
      try {
        const encoder = device.createCommandEncoder({ label: "output accumulate: read" });
        encoder.copyBufferToBuffer(sums, 0, staging, 0, sumBytes);
        encoder.clearBuffer(sums);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(MAP_MODE_READ);
        // Copied out: unmapping detaches the mapped range.
        const sum = new Float32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        const added = count;
        count = 0;
        return { width, height, count: added, sum };
      } finally {
        reading = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of buffers) entry.destroy();
    },
  };
}
