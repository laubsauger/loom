import type { NodeId } from "@domain/types/ids.ts";
import type {
  ParameterDefinition,
  ParameterMode,
  ParameterSchema,
  ParameterValue,
} from "@domain/types/parameters.ts";

/**
 * T935 — A DRAGGABLE POINT IN SPACE, for any world-space `vec3` in the document.
 *
 * ## What this generalises, and why the argument is already won
 *
 * §T692's `camera-gizmo-store.ts` settled the hard question: "every gesture goes through
 * the parameter editor onto the command bus as an ordinary `setParameters` patch, so what
 * you see move IS the document moving." That store answers it for ONE parameter pair on
 * ONE node type. This one answers it for a POINT — it knows nothing about cameras, lights
 * or the prism, and it gains nothing by learning. A node offers handles; a handle is a
 * parameter key and a world value; a drag writes that key. The owner's "a target vector
 * for the light to follow" is one instance of that, not its shape.
 *
 * §V29/§V30 hold by construction, exactly as they do for T692: the only thing this store
 * can do is call `setStored`, which is the inspector's own `ParameterEditor`. There is no
 * second write path, so a gizmo edit IS a typed edit — same patch op, same audit entry,
 * same actor, same undo group.
 *
 * ## §T935(b) — a gizmo REFUSES when its parameter is not static, and says so
 *
 * A vec3 driven by an expression, bound to a sibling or mapped from an attribute is
 * decided by its driver. Dragging it would write a plain value the resolver overrides on
 * the next frame — the drag would appear to work and then be undone by nothing the user
 * did — or, worse, replace the envelope and silently delete the driver.
 *
 * The rule is §V113's, as the colour picker states it (§T896, `PICKER_LOCKED_REASON`) and
 * as §T893's disabled field states it: the affordance is SHOWN, the write is REFUSED, and
 * the reason is one string that the tooltip, the accessible name and the test all read.
 * Hiding the handle would be the wrong repair for the same reason a hidden picker was: it
 * makes a driven parameter look like one that could never have a gizmo, when the honest
 * report is that it has one and its driver currently owns it.
 *
 * Because §V113 makes a compound parameter component-addressable, ONE non-static axis is
 * enough to refuse: the gizmo writes all three at once and cannot write two of them.
 *
 * ## §V657 — the value is read at the START of a gesture and not again
 *
 * `begin` takes the world value from the caller and the session keeps it. Re-reading the
 * document mid-drag would sample the editor's own frame-coalesced writes, which lag the
 * pointer, and feed them back into the next frame's arithmetic. `end` drops the session so
 * the next drag re-reads — an undo between gestures must not be overwritten by a stale
 * local value, which is the property T692's `release` pinned by test.
 *
 * ## §T935(d) — two handles on one node, with no special case for the pair
 *
 * A session is keyed by node AND parameter key, so `eye` and `lookAt`, or `position` and
 * `direction`, are two independent gestures on one node: separate begins, separate
 * refusals, separate `setStored` calls and therefore separate undo groups (the editor
 * keys its transaction by node plus sorted keys). Nothing here knows the two are related,
 * which is what makes "a vector is a pair of handles" fall out rather than be built.
 */

/** The slice of `ParameterEditor` this store needs — structural, so tests stay small. */
export interface Vec3GizmoEditor {
  setStored(
    nodeId: NodeId,
    entries: Readonly<Record<string, ParameterValue>>,
    phase: "live" | "commit",
  ): void;
}

/**
 * Terse, and stated once (§V92, §T896's shape): chrome states the fact, it does not
 * explain it in a sentence. The mode itself is already legible on the inspector's row.
 */
export const GIZMO_LOCKED_REASON = "not Constant — the gizmo writes all 3 axes";

/** One draggable point: a node's world-space vec3 parameter, as the picture shows it. */
export interface GizmoHandle {
  /** The parameter key the drag writes. Also the handle's identity within its node. */
  readonly key: string;
  /** The manifest's label, for the accessible name. */
  readonly label: string;
  /** The EFFECTIVE value — a driven handle is drawn where its driver put it. */
  readonly value: readonly [number, number, number];
  /** Null when the drag may proceed; the reason it may not, otherwise (§T935(b)). */
  readonly refusal: string | null;
}

/** The resolved facts one node's handles are derived from (`resolveParameters`'s shape). */
export interface GizmoParameterFacts {
  readonly schema: ParameterSchema;
  readonly resolved: ReadonlyArray<{
    readonly key: string;
    readonly value: ParameterValue;
    readonly mode: ParameterMode;
    readonly components?:
      | ReadonlyArray<{ readonly name: string; readonly mode: ParameterMode }>
      | undefined;
  }>;
  /** Effective values, keyed as the manifest keys them — §V146's `inactiveWhen` input. */
  readonly values: Readonly<Record<string, ParameterValue>>;
}

const isVec3 = (definition: ParameterDefinition): boolean =>
  definition.type === "vector" && definition.size === 3;

const asVec3 = (value: ParameterValue): readonly [number, number, number] | null => {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value as readonly unknown[];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
};

/**
 * WHICH PARAMETERS GET A HANDLE — derived, never listed (§V437).
 *
 * The predicate is one line — a `vector` of size 3 — and it is only correct because of
 * WHERE it is asked. A handle is offered on a tile that publishes an orbit basis, which
 * is the compiler's own declaration (`compiler/preview-orbit.ts`) that the tile draws a
 * SCENE IN WORLD SPACE through a known camera. That single fact separates the catalogue
 * for us with no table to maintain: `light.direction`, `light.position` and
 * `pointRay.direction` are world vectors on nodes whose preview is that scene, while
 * `convolve.row0` (a kernel row), `noise.t` (a domain translate) and
 * `renderInstances.rotate` (Euler degrees) sit on nodes whose preview is a TEXTURE and
 * therefore publishes no basis and reaches this function never.
 *
 * That is a necessary condition doing the work of a sufficient one, and the limit is
 * worth naming: a future 3D-payload node could grow a `vector`/3 that is an orientation
 * rather than a place, and it would be offered a handle it should not have. The honest
 * repair is a `space: "world"` field on `VectorParameter` — a frozen-contract change in
 * `src/domain/types/parameters.ts` plus one line per parameter in `src/nodes/definitions`,
 * neither of which this track owns. Until then this function is the single site that
 * decides, so that repair is an edit here rather than a hunt (§V437's rule).
 *
 * INACTIVE PARAMETERS GET NO HANDLE (§V146). `inactiveWhen` says the parameter cannot
 * affect the output — a point light's `direction`, a directional light's `position` — and
 * §V146's own rule is that inactive is not disabled, so the inspector field stays
 * editable and nothing is taken away. But a handle's entire claim is "this is where this
 * thing is IN THIS PICTURE", and for an inactive parameter that claim is false. A field
 * that does nothing is a wasted control; a marker drawn in a scene that does not contain
 * the thing it marks is a lie about the scene.
 */
export function gizmoHandlesFor(facts: GizmoParameterFacts): readonly GizmoHandle[] {
  const handles: GizmoHandle[] = [];
  for (const entry of facts.resolved) {
    const definition = facts.schema[entry.key];
    if (definition === undefined || !isVec3(definition)) continue;
    if (definition.inactiveWhen?.(facts.values) != null) continue;
    const value = asVec3(entry.value);
    if (value === null) continue;
    // §V113: the compound head AND every component. One non-static axis refuses the
    // whole handle, because the write is all three or nothing.
    const locked =
      entry.mode !== "static" ||
      (entry.components ?? []).some((component) => component.mode !== "static");
    handles.push({
      key: entry.key,
      label: definition.label,
      value,
      refusal: locked ? GIZMO_LOCKED_REASON : null,
    });
  }
  return handles;
}

export interface Vec3GizmoStore {
  /**
   * Open a gesture on one handle. Returns null when it may proceed, or the refusal
   * reason when it may not — the caller neither captures the pointer nor writes.
   */
  begin(nodeId: NodeId, handle: GizmoHandle): string | null;
  /** A live world position for an open gesture. Coalesced by the editor, per frame. */
  drag(nodeId: NodeId, key: string, world: readonly [number, number, number]): void;
  /** Close the gesture: one commit, one undo step, only if anything actually moved. */
  end(nodeId: NodeId, key: string): void;
  /** True while this handle owns a gesture — the caller's cursor and capture follow it. */
  isDragging(nodeId: NodeId, key: string): boolean;
}

/** Six decimals, as T692 writes them: a drag must not author float noise into the file. */
const round6 = (value: number): number => Number(value.toFixed(6));

interface Session {
  /**
   * The last value written live, or null when the gesture has not moved yet. The commit
   * re-sends it under the SAME key, which is what closes the editor's transaction: the
   * gesture's identity there is the node plus its sorted key set, so a commit carrying
   * different keys — an empty record most of all — would open a second group and leave
   * the drag's own one hanging (§V15).
   */
  last: readonly [number, number, number] | null;
}

export function createVec3GizmoStore(options: { editor: Vec3GizmoEditor }): Vec3GizmoStore {
  /** Keyed by node AND parameter, so two handles on one node never share a gesture. */
  const sessions = new Map<string, Session>();
  const identity = (nodeId: NodeId, key: string): string => `${nodeId} ${key}`;

  return {
    begin(nodeId, handle) {
      if (handle.refusal !== null) return handle.refusal;
      sessions.set(identity(nodeId, handle.key), { last: null });
      return null;
    },

    drag(nodeId, key, world) {
      const session = sessions.get(identity(nodeId, key));
      if (session === undefined) return;
      const value: readonly [number, number, number] = [
        round6(world[0]),
        round6(world[1]),
        round6(world[2]),
      ];
      session.last = value;
      options.editor.setStored(nodeId, { [key]: value }, "live");
    },

    end(nodeId, key) {
      const id = identity(nodeId, key);
      const session = sessions.get(id);
      if (session === undefined) return;
      sessions.delete(id);
      // Nothing to commit after a press with no movement: the editor never opened a
      // transaction, and a commit here would make one undo step out of a click.
      if (session.last === null) return;
      // The same key and the same value the last frame carried: that supersedes anything
      // this frame queued and closes the transaction the gesture opened (§V15), so one
      // drag is one undo step landing back where the drag began.
      options.editor.setStored(nodeId, { [key]: session.last }, "commit");
    },

    isDragging: (nodeId, key) => sessions.has(identity(nodeId, key)),
  };
}
