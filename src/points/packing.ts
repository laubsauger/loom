import {
  ATTRIBUTE_STRIDES,
  COMPONENT_COUNTS,
  type PointAttributeSchema,
  type PointAttributeType,
} from "./attributes.ts";

/**
 * PACKED point storage (T1076): every attribute of one producer in ONE buffer per half,
 * addressed by REGION OFFSET instead of by binding.
 *
 * ## What changed and what did not
 *
 * The bytes and their order are IDENTICAL to the per-attribute buffers this replaces —
 * still structure-of-arrays, still `stride × capacity` contiguous per attribute, still
 * `vec3f` at stride 16. The only difference is that the regions are concatenated into one
 * allocation, so an attribute is reached by adding its base rather than by binding its own
 * buffer. Coalescing is therefore unchanged, and that is measured rather than asserted:
 * on Dawn/Metal at 1M points, packed `array<u32>` with natural strides matched separate
 * `array<T>` at four attributes and still saturated the same bandwidth at eight, where the
 * separate layout cannot be built at all.
 *
 * ## Why this exists — the ceiling was arithmetic, not physics
 *
 * `codegen.ts` spent exactly 2n storage bindings for n attributes, against WebGPU's
 * baseline of 8 per stage (§V588, B33) — so four attributes, and the fifth failed the
 * pipeline SILENTLY. Packing makes a kernel spend one binding per distinct producer it
 * reads plus one for what it writes, INDEPENDENT of n. The limit stops being a COUNT and
 * becomes a SIZE, checked below.
 *
 * ## Element type: `array<u32>` with natural strides, decided by measurement
 *
 * The obvious alternative — one `array<vec4f>` with a uniform 16-byte stride, so every
 * vector stays a single vectorized load — is ~7.5% faster on a vector-only schema and
 * loses badly the moment a schema carries `f32`/`u32`/`vec2f`: +41% time and +88% bytes,
 * because a scalar attribute then costs four times its own width. Real schemas carry
 * scalars (`life`, `age`, `id`), so the scalar case decides. Natural strides also keep the
 * byte layout identical to the pre-T1076 buffers, which is what lets an unchanged
 * `array<vec3f>` consumer bind ONE REGION of a packed buffer and read exactly what it read
 * before (see `PointRegion.offset`).
 *
 * ## Region bases are 256-aligned, and that is load-bearing
 *
 * A region is reached two ways: by offset arithmetic inside a kernel's single `array<u32>`
 * binding (which needs only 4-byte alignment), and by BINDING that region alone to a
 * consumer that still declares `array<vec3f>` — every renderer does. The second needs
 * `minStorageBufferOffsetAlignment`, whose baseline is 256. So every base is rounded up to
 * 256 and both addressings work off the same table. The waste is under 256 bytes per
 * attribute, against `stride × capacity` per attribute.
 */

/**
 * WebGPU's baseline `minStorageBufferOffsetAlignment`. §V12/§V588: the baseline is what a
 * conforming device GUARANTEES, so aligning to it is knowledge; aligning to the dev
 * device's (Metal reports 32) would be the generosity that hid the old ceiling.
 */
export const STORAGE_OFFSET_ALIGNMENT = 256;

/**
 * WebGPU's baseline `maxStorageBufferBindingSize` — 128 MiB. THE NEW BOUND (T1076): with
 * one buffer per half, a schema is limited by the bytes one binding may carry rather than
 * by how many bindings a stage may hold.
 *
 * Refused HERE rather than at the nodes, for the reason the binding count was refused in
 * `codegen.ts`: the number is the length of the layout this function just built, and an
 * arithmetic copy in a node is a second answer that can drift (§V349). The compiler's
 * per-pass budget (`compiler/bindings.ts`) is the device-aware backstop — a real device
 * reporting a SMALLER limit lowers it there, exactly as it lowers every count budget.
 */
export const MAX_STORAGE_BUFFER_BINDING_BYTES = 134_217_728;

export interface PointRegion {
  readonly name: string;
  readonly type: PointAttributeType;
  /** Byte offset of the region's first element inside the packed buffer; 256-aligned. */
  readonly offset: number;
  /** Bytes the region occupies: `stride × capacity`, unpadded. */
  readonly bytes: number;
  /** Element stride in bytes — `vec3f` is 16, not 12 (WGSL alignment). */
  readonly stride: number;
}

export interface PackedLayout {
  readonly ok: true;
  /** Regions in SCHEMA order, so the generated text is deterministic. */
  readonly regions: ReadonlyArray<PointRegion>;
  readonly byName: ReadonlyMap<string, PointRegion>;
  /** Total allocation for ONE half, including inter-region alignment padding. */
  readonly bytes: number;
  readonly capacity: number;
}

export interface PackedLayoutFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<string>;
}

export type PackedLayoutResult = PackedLayout | PackedLayoutFailure;

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function describeBytes(bytes: number): string {
  const mib = bytes / 1_048_576;
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${bytes} B`;
}

/**
 * The layout for one producer's attributes at one capacity. Both halves of the pair use
 * it, so a kernel's `in_` and `out_` addressing is the same arithmetic.
 */
export function packAttributes(
  attributes: ReadonlyArray<PointAttributeSchema>,
  capacity: number,
): PackedLayoutResult {
  if (!Number.isInteger(capacity) || capacity < 1) {
    return { ok: false, errors: [`capacity ${String(capacity)} must be a positive integer`] };
  }
  const regions: PointRegion[] = [];
  let cursor = 0;
  for (const attribute of attributes) {
    const stride = ATTRIBUTE_STRIDES[attribute.type];
    if (stride === undefined) {
      return { ok: false, errors: [`attribute "${attribute.name}" has unknown type "${String(attribute.type)}"`] };
    }
    const offset = alignUp(cursor, STORAGE_OFFSET_ALIGNMENT);
    const bytes = stride * capacity;
    regions.push({ name: attribute.name, type: attribute.type, offset, bytes, stride });
    cursor = offset + bytes;
  }
  // The allocation is padded to the alignment too: the next half starts at a base a
  // region could legally be bound at, and `array<u32>` needs a multiple of 4 regardless.
  const bytes = alignUp(cursor, STORAGE_OFFSET_ALIGNMENT);
  if (bytes > MAX_STORAGE_BUFFER_BINDING_BYTES) {
    const perPoint = attributes.reduce((total, attribute) => total + ATTRIBUTE_STRIDES[attribute.type], 0);
    return {
      ok: false,
      errors: [
        `${attributes.length} attributes at capacity ${capacity} need ${describeBytes(bytes)} of point storage ` +
          `per half; the WebGPU baseline maxStorageBufferBindingSize is ` +
          `${describeBytes(MAX_STORAGE_BUFFER_BINDING_BYTES)} (§V588, T1076). ` +
          `This schema costs ${perPoint} bytes per point, so it fits ` +
          `${Math.floor(MAX_STORAGE_BUFFER_BINDING_BYTES / perPoint)} points — lower the capacity, ` +
          `or drop attributes.`,
      ],
    };
  }
  return {
    ok: true,
    regions,
    byName: new Map(regions.map((region) => [region.name, region])),
    bytes,
    capacity,
  };
}

/**
 * One attribute's LOAD out of a packed `array<u32>` binding, as a named WGSL function.
 *
 * `bitcast` rather than a typed view because a single binding cannot be two element types;
 * the reads are word-wise at the attribute's natural stride, which is the layout the
 * measurement chose. `vec3f` reads three words out of its four-word stride — the same
 * padding the separate `array<vec3f>` buffer already carried.
 *
 * A function rather than an inlined expression because WGSL has no statement-expression and
 * every load needs a local for the word offset — and because it gives the generated module
 * ONE place per (buffer, attribute) that the store below mirrors exactly.
 */
export function regionAccessorWgsl(
  fnName: string,
  variable: string,
  region: Pick<PointRegion, "type" | "offset" | "stride">,
): string {
  const words = Array.from({ length: COMPONENT_COUNTS[region.type] }, (_, k) =>
    k === 0 ? `${variable}[o]` : `${variable}[o + ${k}u]`,
  );
  const body =
    region.type === "u32"
      ? words[0]
      : region.type === "f32"
        ? `bitcast<f32>(${words[0]})`
        : region.type === "vec4u"
          ? `vec4u(${words.join(", ")})`
          : `bitcast<${region.type}>(vec${COMPONENT_COUNTS[region.type]}u(${words.join(", ")}))`;
  return `fn ${fnName}(slot: u32) -> ${region.type} {
  let o = ${region.offset / 4}u + slot * ${region.stride / 4}u;
  return ${body};
}`;
}

/** The store mirror of `regionAccessorWgsl` — same arithmetic, written once. */
export function regionStoreWgsl(
  fnName: string,
  variable: string,
  region: Pick<PointRegion, "type" | "offset" | "stride">,
): string {
  const components = COMPONENT_COUNTS[region.type];
  const base = `  let o = ${region.offset / 4}u + slot * ${region.stride / 4}u;`;
  if (region.type === "u32") {
    return `fn ${fnName}(slot: u32, value: u32) {
${base}
  ${variable}[o] = value;
}`;
  }
  if (region.type === "f32") {
    return `fn ${fnName}(slot: u32, value: f32) {
${base}
  ${variable}[o] = bitcast<u32>(value);
}`;
  }
  const wordsExpr = region.type === "vec4u" ? "value" : `bitcast<vec${components}u>(value)`;
  const stores = Array.from(
    { length: components },
    (_, k) => `  ${variable}[o${k === 0 ? "" : ` + ${k}u`}] = w[${k}];`,
  ).join("\n");
  return `fn ${fnName}(slot: u32, value: ${region.type}) {
${base}
  let w = ${wordsExpr};
${stores}
}`;
}
