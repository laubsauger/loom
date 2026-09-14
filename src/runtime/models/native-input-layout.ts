import { wgsl } from "../backend/wgsl.ts";
/** Four numeric RGBA bytes per model pixel, carried in opaque RGB compositor pixels. */
export function nativeInputTransportSize(size: readonly [number, number]): readonly [number, number] {
  const [width, height] = size;
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 8192))
    throw new Error("Invalid native model input dimensions");
  return [width, Math.ceil(height * 4 / 3)];
}

/** Same clamp/round as the CPU model packer, with alpha carried as ordinary data. */
export const NATIVE_INPUT_PACK_WGSL = wgsl`
struct InputShape { width: u32, height: u32 };
@group(0) @binding(0) var<uniform> shape: InputShape;
@group(0) @binding(1) var<storage, read> modelInput: array<vec4f>;
fn byteValue(value: f32) -> u32 {
  if (!(value > 0.0)) { return 0u; }
  if (value >= 1.0) { return 255u; }
  /* JS multiplies the exact f32 value in double precision. A floating GPU
     multiply rounds just-below-half values UP before floor, changing bytes.
     The 24-bit significand times 255 fits u32; round that exact product. */
  let bits = bitcast<u32>(value);
  let exponent = (bits >> 23u) & 255u;
  if (exponent < 118u) { return 0u; }
  let product = ((bits & 0x7fffffu) | 0x800000u) * 255u;
  let shift = 150u - exponent;
  if (shift == 32u) { return select(0u, 1u, product >= 0x80000000u); }
  let tail = product & ((1u << shift) - 1u);
  return (product >> shift) + select(0u, 1u, tail >= (1u << (shift - 1u)));
}
fn channel(index: u32) -> f32 {
  if (index >= shape.width * shape.height * 4u) { return 0.0; }
  let value = modelInput[index / 4u][index % 4u];
  return f32(byteValue(value)) / 255.0;
}
@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let index = (u32(position.y) * shape.width + u32(position.x)) * 3u;
  return vec4f(channel(index), channel(index + 1u), channel(index + 2u), 1.0);
}`;
