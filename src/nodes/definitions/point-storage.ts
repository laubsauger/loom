import { scratchResourceId } from "../../compiler/resources.ts";
import type { PointsetAttributeRef, ScratchBufferPairRequest } from "../../domain/types/node-definition.ts";
import { packAttributes, type PackedLayout, type PointRegion } from "../../points/packing.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import type {
  KernelStorageMap,
  KernelStorageRegion,
  PointBufferBinding,
} from "../../points/codegen.ts";
import type { BufferBindingDescriptor } from "../../runtime/backend/plan.ts";

/**
 * PACKED point storage at the NODE seam (T1076) — the one place a producer turns its
 * attribute schema into (a) the single bufferPair it allocates and (b) the edge payload
 * downstream binds.
 *
 * Before T1076 a producer declared one `bufferPair` per attribute and published one pair
 * id per attribute, so a kernel spent 2n storage bindings for n attributes against a
 * baseline of 8 per stage — four attributes, and the fifth failed the pipeline in silence
 * (§V588, B33). Now every attribute is a REGION of one buffer per half: the same bytes in
 * the same order, addressed by offset instead of by binding.
 *
 * Two functions rather than a convention, for the reason §V349 keeps naming: a producer
 * used to write its scratch `key` in one place and rebuild the published id with
 * `pointPairId(nodeId, name)` in another, and nothing checked that the two agreed. Here
 * both come out of one call, off one layout.
 */

/**
 * The scratch key of a producer's packed point buffer.
 *
 * `@` on purpose: an attribute name must match `/^[a-zA-Z][a-zA-Z0-9_]*$/` (a WGSL
 * identifier), so this cannot collide with a per-attribute scratch key — including
 * `pointGather`'s, which is a string the USER types.
 */
export const POINT_STORAGE_KEY = "@points";

/** The resource id of a node's packed point storage pair. */
export function pointStorageId(nodeId: string): string {
  return scratchResourceId(nodeId, POINT_STORAGE_KEY);
}

export interface PackedPointStorage {
  readonly ok: true;
  /** The ONE pair this producer allocates. Element type is the packed `u32` word. */
  readonly scratch: ScratchBufferPairRequest;
  /** The edge entries for the attributes this producer OWNS, ready to publish. */
  readonly pairs: Readonly<Record<string, PointsetAttributeRef>>;
  readonly layout: PackedLayout;
  readonly resourceId: string;
}

export interface PackedPointStorageFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<string>;
}

/**
 * One producer's packed storage: the pair to request, the layout to address it by, and the
 * payload to publish.
 *
 * `half` is the half that holds THIS frame's data (§V231/T322) — "write" for an ordinary
 * producer, "read" for a compacted one whose scatter lands in the read half. It is a
 * payload fact, so it is an argument here rather than a default a consumer must know.
 */
export function packedPointStorage(
  nodeId: string,
  attributes: ReadonlyArray<PointAttributeSchema>,
  capacity: number,
  half: "read" | "write",
  options: { readonly swap?: boolean } = {},
): PackedPointStorage | PackedPointStorageFailure {
  const layout = packAttributes(attributes, capacity);
  if (!layout.ok) return { ok: false, errors: layout.errors };
  const resourceId = pointStorageId(nodeId);
  const pairs: Record<string, PointsetAttributeRef> = {};
  for (const region of layout.regions) {
    pairs[region.name] = {
      buffer: resourceId,
      half,
      offset: region.offset,
      bytes: region.bytes,
      type: region.type,
    };
  }
  return {
    ok: true,
    // Stride 4 / capacity words: the packed buffer IS an `array<u32>` to the kernels that
    // read it whole, and `stride × capacity` is what the compiler allocates and reports.
    scratch: {
      kind: "bufferPair",
      key: POINT_STORAGE_KEY,
      stride: 4,
      capacity: layout.bytes / 4,
      ...(options.swap === undefined ? {} : { swap: options.swap }),
    },
    pairs,
    layout,
    resourceId,
  };
}

/**
 * Bind one attribute's REGION, from the edge payload, to a shader binding whose WGSL is
 * unchanged — `array<vec3f>`, `array<vec4f>`, whatever it always declared.
 *
 * Every consumer goes through this rather than spreading the fields by hand: an `offset`
 * forwarded without its `bytes` binds to the END of the packed buffer and reads happily
 * past the attribute into the next one, which is exactly the plausible-wrong answer that
 * has no symptom until someone looks at the pixels.
 *
 * `half` overrides the payload's when the caller genuinely knows better — the synthesized
 * previews run BETWEEN main frames, after the swap, so they pin "read" (T563).
 */
export function attributeBinding(
  binding: string,
  ref: Pick<PointsetAttributeRef, "buffer" | "half" | "offset" | "bytes">,
  half?: "read" | "write",
): BufferBindingDescriptor {
  return {
    binding,
    resourceId: ref.buffer,
    half: half ?? ref.half,
    offset: ref.offset,
    bytes: ref.bytes,
  };
}

/** Bind one region of THIS node's own packed storage, at a half the node chooses. */
export function regionBinding(
  binding: string,
  resourceId: string,
  half: "read" | "write",
  region: Pick<PointRegion, "offset" | "bytes">,
): BufferBindingDescriptor {
  return { binding, resourceId, half, offset: region.offset, bytes: region.bytes };
}

/** Which resource and half one generated storage GROUP resolves to. */
export interface KernelStorageBinding {
  readonly resourceId: string;
  readonly half: "read" | "write";
}

export interface KernelStoragePlan {
  /** Handed to codegen: where every touched attribute is read from and written to. */
  readonly storage: KernelStorageMap;
  /** Handed back by codegen as `PointBufferBinding.group`; resolved here to a resource. */
  readonly groups: ReadonlyMap<string, KernelStorageBinding>;
}

/**
 * The addressing table for a generated kernel (T1076, T401, §V197).
 *
 * A processor reads an attribute it SHARES with its upstream from the upstream's own
 * region — that is the entire by-reference mechanism, and it is why codegen cannot compute
 * its own offsets. Everything else comes off this node's packed pair: pre-frame values
 * from the read half, results into the write half, so the §V22 swap makes this frame's
 * writes next frame's reads.
 *
 * The group key is `buffer:half`, so two attributes from one upstream producer collapse to
 * ONE binding — which is the whole reason the count stopped growing with n.
 */
export function kernelStorage(options: {
  readonly own: PackedPointStorage;
  /** Attributes the generated Point carries in. */
  readonly touched: ReadonlyArray<string>;
  /** Attributes the kernel writes. */
  readonly written: ReadonlyArray<string>;
  /** The incoming pointset's regions, when a processor port is wired (T401). */
  readonly upstream?: Readonly<Record<string, Readonly<PointsetAttributeRef>>> | undefined;
  /**
   * T339: the spawn hook edits the READ halves in place, so reads and writes name the same
   * group and codegen emits one `read_write` binding. Absent = the ordinary in/out split.
   */
  readonly inPlace?: "read" | "write";
}): KernelStoragePlan {
  const groups = new Map<string, KernelStorageBinding>();
  const key = (resourceId: string, half: "read" | "write"): string => `${resourceId}:${half}`;
  const groupFor = (resourceId: string, half: "read" | "write"): string => {
    const group = key(resourceId, half);
    if (!groups.has(group)) groups.set(group, { resourceId, half });
    return group;
  };
  const reads: Record<string, KernelStorageRegion> = {};
  const writes: Record<string, KernelStorageRegion> = {};
  const ownHalf = (role: "in" | "out"): "read" | "write" =>
    options.inPlace ?? (role === "in" ? "read" : "write");

  for (const name of options.touched) {
    const shared = options.upstream?.[name];
    if (shared !== undefined) {
      reads[name] = { group: groupFor(shared.buffer, shared.half), offset: shared.offset };
      continue;
    }
    const region = options.own.layout.byName.get(name);
    if (region === undefined) continue;
    reads[name] = { group: groupFor(options.own.resourceId, ownHalf("in")), offset: region.offset };
  }
  for (const name of options.written) {
    const region = options.own.layout.byName.get(name);
    if (region === undefined) continue;
    writes[name] = { group: groupFor(options.own.resourceId, ownHalf("out")), offset: region.offset };
  }
  return { storage: { reads, writes }, groups };
}

/**
 * Turn codegen's emitted bindings back into plan bindings. A `storage` binding names a
 * group this node minted; a `live` one is the lifecycle count buffer the caller supplies.
 */
export function kernelBufferBindings(
  buffers: ReadonlyArray<PointBufferBinding>,
  plan: KernelStoragePlan,
  liveResourceId?: string,
): BufferBindingDescriptor[] {
  return buffers.map((binding) => {
    if (binding.role === "live") {
      if (liveResourceId === undefined) {
        throw new Error(`point kernel binding "${binding.variable}" needs a live-count buffer.`);
      }
      return { binding: binding.variable, resourceId: liveResourceId };
    }
    const group = plan.groups.get(binding.group as string);
    if (group === undefined) {
      throw new Error(`point kernel binding "${binding.variable}" names unknown storage group "${String(binding.group)}".`);
    }
    // The WHOLE packed buffer: the generated WGSL addresses regions by offset inside it,
    // which is what makes the binding count independent of the attribute count (T1076).
    return { binding: binding.variable, resourceId: group.resourceId, half: group.half };
  });
}
