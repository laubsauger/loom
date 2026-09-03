import type { PointAttributeSchema, PointAttributeType } from "../../points/attributes.ts";
import { COMPONENT_COUNTS } from "../../points/attributes.ts";
import { packAttributes } from "../../points/packing.ts";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";

/**
 * Windowed point-attribute readback (T125, §V48, §V16).
 *
 * The export-interface half of the `read_points` agent tool and the future attribute
 * spreadsheet. A WINDOW, never the whole buffer: the tool's job is "show me points
 * 4000–4032", and a full-capacity readback to answer that would be the wrong shape by
 * orders of magnitude. Throttled to ≤10Hz (§V16) with an injectable clock; the CPU
 * mirrors in `src/points/rng.ts` double as its oracle in tests.
 *
 * Decoding uses the SAME layout function the producer allocated with (`packAttributes`)
 * and the same component table the codegen uses — the vec3f stride-16 trap and, since
 * T1076, the region offset are each answered in exactly one place, here included by
 * import. Before T1076 this rebuilt a per-attribute resource id by convention
 * (`scratch:<node>:<attribute>`); attributes no longer have buffers of their own, so the
 * read is now "the node's packed buffer, at this attribute's offset".
 */

export interface PointsWindowRequest {
  readonly nodeId: string;
  /** Attribute to read. Defaults to "position". */
  readonly attribute?: string;
  /** First point (slot) of the window. Default 0. */
  readonly start?: number;
  /** Window length. Default 32, capped at 256 — a window, not a dump. */
  readonly count?: number;
}

export interface PointsWindow {
  readonly nodeId: string;
  readonly attribute: string;
  readonly type: PointAttributeType;
  readonly start: number;
  readonly count: number;
  readonly capacity: number;
  /** One row per point, `COMPONENT_COUNTS[type]` numbers each, in slot order. */
  readonly values: ReadonlyArray<ReadonlyArray<number>>;
}

/** What a point-producing node's schema resolved to; the composition root supplies it. */
export interface PointSetInfo {
  readonly attributes: ReadonlyArray<PointAttributeSchema>;
  readonly capacity: number;
}

export interface PointsReadbackOptions {
  /** The backend's buffer readback (§V48's sanctioned path). */
  readonly readBuffer: (resourceId: string) => Promise<ArrayBuffer>;
  /** Resolves a node id to its point schema, or undefined for a non-point node. */
  readonly pointSetInfo: (nodeId: string) => PointSetInfo | undefined;
  /**
   * Clock for the throttle, INJECTED — this module reads no wall time itself (§V44's
   * boundary test enforces it). The composition root passes Date.now.
   */
  readonly now: () => number;
  /** §V16: reads are throttled; calls inside the window are refused, not queued. */
  readonly minIntervalMs?: number;
}

export interface PointsReadback {
  read(request: PointsWindowRequest): Promise<PointsWindow>;
}

const MAX_WINDOW = 256;

export function createPointsReadback(options: PointsReadbackOptions): PointsReadback {
  const now = options.now;
  const minInterval = options.minIntervalMs ?? 100;
  let lastReadAt = Number.NEGATIVE_INFINITY;

  return {
    async read(request) {
      const at = now();
      if (at - lastReadAt < minInterval) {
        throw new Error(
          `read_points is throttled to one read per ${minInterval}ms (§V16); try again shortly.`,
        );
      }

      const info = options.pointSetInfo(request.nodeId);
      if (info === undefined) {
        throw new Error(`Node "${request.nodeId}" produces no point set.`);
      }
      const attributeName = request.attribute ?? "position";
      const attribute = info.attributes.find((entry) => entry.name === attributeName);
      if (attribute === undefined) {
        throw new Error(
          `Node "${request.nodeId}" declares no attribute "${attributeName}". Declared: ${info.attributes.map((entry) => entry.name).join(", ")}.`,
        );
      }

      const start = Math.max(0, Math.min(Math.floor(request.start ?? 0), info.capacity));
      const count = Math.max(0, Math.min(Math.floor(request.count ?? 32), MAX_WINDOW, info.capacity - start));

      /* T1076: the attribute's REGION inside the node's packed buffer, from the same
         layout function the producer allocated with — never a second offset table. */
      const layout = packAttributes(info.attributes, info.capacity);
      if (!layout.ok) throw new Error(`Node "${request.nodeId}": ${layout.errors.join(" ")}`);
      const region = layout.byName.get(attributeName);
      if (region === undefined) {
        throw new Error(`Node "${request.nodeId}" allocates no storage for "${attributeName}".`);
      }

      // The whole pair half still crosses the bus (readBuffer has no range yet — same
      // interim as texture regions, T173); the WINDOW is what leaves this function.
      lastReadAt = at;
      const raw = await options.readBuffer(pointStorageId(request.nodeId));

      const components = COMPONENT_COUNTS[attribute.type];
      const isUnsigned = attribute.type === "u32" || attribute.type === "vec4u";
      const values: number[][] = [];
      for (let index = 0; index < count; index += 1) {
        const base = region.offset + (start + index) * region.stride;
        const view = isUnsigned
          ? new Uint32Array(raw, base, components)
          : new Float32Array(raw, base, components);
        values.push([...view]);
      }

      return {
        nodeId: request.nodeId,
        attribute: attributeName,
        type: attribute.type,
        start,
        count,
        capacity: info.capacity,
        values,
      };
    },
  };
}
