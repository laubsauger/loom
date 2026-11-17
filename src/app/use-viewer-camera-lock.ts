import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { authoredGraph, type GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { enteredThrough, fromInstance, type InstancePath } from "@domain/components/addressing.ts";
import { kindOf } from "@domain/graph/node-kinds.ts";
import { cameraBasis, cameraFrame, inCameraFrame } from "@domain/geometry/camera.ts";
import { resolveParameters } from "@domain/parameters/resolve.ts";
import { parameterReadOptions } from "@domain/parameters/node-references.ts";
import { kindLabelParts } from "@editor/nodes/kind-label.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { createCameraGizmoStore } from "@editor/viewer/camera-gizmo-store.ts";
import { cameraPoseAt, cameraPoseSaid } from "@editor/viewer/camera-pose.ts";
import type { PreviewOrbitStore } from "@editor/viewer/index.ts";
import type { ViewerAxisCameraController } from "@editor/viewer/viewer-axis-gizmo.tsx";
import { axisSnapDelta } from "@editor/viewer/axis-gizmo.ts";
import { DEFAULT_PREVIEW_ORBIT } from "@runtime/previews/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * §T970 — THE VIEWER LOCKS TO THE CAMERA ITS PICTURE IS DRAWN THROUGH, AND FLIES IT.
 *
 * The owner, twice: "i'm still missing a way to actually change the position of the camera
 * in the camera node via flying around in that preview instead of manually having to deal
 * with it". A camera could be dragged on its own 170 px tile (§T692) and nowhere else; the
 * viewer, where the scene can actually be seen, said "drag on its tile in the graph".
 *
 * ## What is locked to what
 *
 * The compiler already says whose camera a picture is taken through
 * (`ResolvedOutput.previewCamera`, §T1655b): a row drawn through its own node's Eye and Look
 * At (`pose`: a camera, a projector, a Render Surface or Render Instances with no camera
 * named), or a picture FRAMED by another node (`through-camera`: a Render). Either way there
 * is exactly one node whose pose the picture follows, and that is the target. The button
 * NAMES it before the first press, because the gestures that follow edit a node that may not
 * be the one the viewer is showing (§T692 refused this on the Render's TILE for that reason;
 * a named target in the viewer is the answer to it).
 *
 * ## Every move is an edit
 *
 * Armed, the viewer's own gestures (drag, shift-drag, the wheel, the fly keys) go to a
 * `createCameraGizmoStore` instead of the inspection store: ordinary `setParameters`
 * patches through the bus, attributed and undoable. The picture is the camera's own at every
 * moment, so nothing is falsified (§T614 holds by construction) and nothing is rendered
 * twice. One drag, one wheel burst and one flight are one undo step each.
 *
 * `h`, which returns an INSPECTION camera home, here only leaves the mode: home must never
 * be an edit, and the way back from an edit is undo.
 *
 * ## A driven pose
 *
 * A target with no free channel of Eye or Look At cannot be flown and is not offered: the
 * button is absent and the driven sentence stands (§T1049). Its rig belongs in Origin and
 * Heading (§T1656b), which leaves Eye and Look At as the offsets flown here.
 */
export interface ViewerCameraLock {
  /** The node whose Eye and Look At this picture is drawn through and can be moved by, or null. */
  readonly target: NodeId | null;
  /** That node's name, for the button and its sentences. Empty when there is no target. */
  readonly name: string;
  /**
   * The name where its kind ends (`camera` + `_rig`), as a node's own label splits it, so
   * a button with no room gives up the KIND and keeps the role, which is what tells two
   * cameras apart. `rest` is the whole name when it does not carry its kind.
   */
  readonly nameParts: { readonly kind: string; readonly rest: string };
  /** A picture drawn through a pose nothing here can move: why. Null otherwise. */
  readonly refusal: string | null;
  /** The channels of a partly driven pose the flight will leave alone. Empty for none. */
  readonly held: string;
  /** The document-writing camera the viewer's gestures go to while `armed`. */
  readonly store: PreviewOrbitStore;
  readonly armed: boolean;
  /** The authored camera's live world pose and undoable axis snap, for Fly camera mode. */
  readonly axisCamera: ViewerAxisCameraController;
  /** Arm, disarm, or (undefined) toggle. Answers the state it left; false when nothing can be flown. */
  set(on: boolean | undefined): boolean;
}

/** The node a row's picture is drawn through, or null: its own pose, or the camera that frames it. */
export function cameraOfPicture(row: ResolvedOutput | null | undefined): NodeId | null {
  const control = row?.previewCamera;
  if (row === null || row === undefined || control === undefined) return null;
  if (control.kind === "pose") return row.nodeId;
  if (control.kind === "none" && control.reason.because === "through-camera") return control.reason.camera;
  return null;
}

/**
 * WHERE A PICTURE'S CAMERA IS, AND WHICH DOCUMENT CAN EDIT IT. The plan speaks flat ids: a
 * camera inside an instance is `rig/camera_shot`. One with no `/` is in the root document;
 * one directly inside the component the editor is in (`path`) is in that component's
 * document, under its own id; anything else is inside a component nobody here is editing.
 */
export type CameraPlace =
  | { readonly in: "root" | "component"; readonly id: NodeId }
  | { readonly in: "elsewhere"; readonly camera: string; readonly instance: NodeId };

export function cameraPlace(flat: NodeId, path: InstancePath): CameraPlace {
  const local = fromInstance(path, flat);
  if (local !== undefined) return { in: path.length === 0 ? "root" : "component", id: local };
  if (enteredThrough(flat) === undefined) return { in: "root", id: flat };
  // Named from where the editor is: the instance to dive into next, and the camera's path inside it.
  let rest = flat;
  for (const instance of path) {
    const step = enteredThrough(rest);
    if (step?.instance !== instance) {
      rest = flat;
      break;
    }
    rest = step.rest;
  }
  const entry = enteredThrough(rest);
  return { in: "elsewhere", camera: entry?.rest ?? rest, instance: entry?.instance ?? rest };
}

/** Why a camera inside a component the editor is not in has no button: the way to it. */
export const cameraInsideSentence = (camera: string, instance: string): string => `Dive into ${instance} to fly ${camera}.`;

/** The button's face: what it will fly, by name. */
export const flyCameraLabel = (name: string): string => `Fly ${name}`;

/** The button's hover and focus text, in both states. The keys are the keymap's defaults. */
export function flyCameraHint(name: string, armed: boolean, held = ""): string {
  const said = armed
    ? `Flying ${name}. Drag orbits, shift-drag trucks, the wheel dollies, W A S D + E Q fly (shift is faster). Every move is an edit and undo steps back. C or H leaves.`
    : `Fly ${name} from this picture (C): drag, shift-drag, the wheel and W A S D + E Q move the camera itself. Every move is an edit and undo steps back.`;
  return held === "" ? said : `${said} ${held}`;
}

/** The readout's line while armed: the one thing a pilot must not be surprised by, and what will not move. */
export const flyingCameraSentence = (name: string, held = ""): string =>
  `Flying ${name}: every move is an edit, undo steps back.${held === "" ? "" : ` ${held}`}`;

/** §T1732b: the readout's line while the picture is looked around: its gestures are NOT edits. */
export const LOOKING_SENTENCE = "Looking around: view only, the camera does not move. H returns to the camera.";

export function useViewerCameraLock(options: {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly registry: NodeRegistryView;
  /** The document as the pane last rendered it: the NAMES. Poses are read off the store. */
  readonly graph: GraphDocument;
  readonly selected: ResolvedOutput | null | undefined;
  /**
   * The component the editor is inside, when it is: its path from the root, the session bus
   * that edits its definition, and that definition's graph. A camera directly inside it is
   * flown through that bus, as the inspector and the tile edit it there.
   */
  readonly component?: { readonly path: readonly NodeId[]; readonly bus: LoomBus; readonly graph: GraphDocument } | undefined;
}): ViewerCameraLock {
  const { invocation, registry, selected, component } = options;

  const flat = cameraOfPicture(selected);
  const place = flat === null ? null : cameraPlace(flat, component?.path ?? []);
  const inside = place?.in === "component" && component !== undefined;
  const bus = inside ? component.bus : options.bus;
  const graph = inside ? component.graph : options.graph;

  const editor = useMemo(() => createParameterEditor({ bus, context: invocation }), [bus, invocation]);
  useEffect(() => () => editor.dispose(), [editor]);
  // Values-only edits do not rerender this pane. Retain the document when commands
  // change it; frame polling resolves drivers against that snapshot without reading
  // the raw graph store every frame.
  const cameraDocument = useMemo(() => {
    const readDocument = () => bus.store.getGraph();
    let current = readDocument();
    return { read: () => current, refresh: () => { current = readDocument(); } };
  }, [bus]);
  useEffect(() => {
    const unsubscribe = bus.store.subscribe(cameraDocument.refresh);
    cameraDocument.refresh();
    return unsubscribe;
  }, [bus, cameraDocument]);
  const readPose = useCallback(
    (nodeId: NodeId) => {
      const current = cameraDocument.read();
      const node = current.nodes[nodeId];
      if (node === undefined) return null;
      return cameraPoseAt(node, registry.get(node.type), { ...bus.readScope(), graph: authoredGraph(current), registry });
    },
    [bus, cameraDocument, registry],
  );
  const store = useMemo(() => createCameraGizmoStore({ editor, readPose }), [editor, readPose]);

  const candidate = place === null || place.in === "elsewhere" ? null : place.id;
  const elsewhere = place?.in === "elsewhere" ? place : null;
  const instanceName = elsewhere === null ? "" : (options.graph.nodes[elsewhere.instance]?.label ?? component?.graph.nodes[elsewhere.instance]?.label ?? elsewhere.instance);
  /* WHICH MODE decides each channel is a fact of the revision this pane rendered with (a
     mode change is structural, so the pane is rendered for it): `graph` is the right key. */
  const { target, refusal, held } = useMemo((): { target: NodeId | null; refusal: string | null; held: string } => {
    // A camera inside a component the editor is not in: say where it is, not nothing.
    if (elsewhere !== null) return { target: null, refusal: cameraInsideSentence(elsewhere.camera, instanceName), held: "" };
    const node = candidate === null ? undefined : graph.nodes[candidate];
    if (candidate === null || node === undefined) return { target: null, refusal: null, held: "" };
    const said = cameraPoseSaid(node, registry.get(node.type), { ...bus.readScope(), graph: authoredGraph(graph), registry });
    return said.driven === null ? { target: candidate, refusal: null, held: said.held } : { target: null, refusal: said.driven, held: "" };
  }, [bus, candidate, elsewhere, graph, instanceName, registry]);
  const name = target === null ? "" : (graph.nodes[target]?.label ?? target);
  const nameParts = useMemo(() => {
    const definition = target === null ? undefined : registry.get(graph.nodes[target]?.type ?? "");
    if (definition === undefined) return { kind: "", rest: name };
    const parts = kindLabelParts(name, kindOf(definition));
    return parts.joined ? { kind: parts.kind, rest: parts.rest } : { kind: "", rest: name };
  }, [graph, name, registry, target]);

  const subscribe = useCallback(
    (listener: () => void) => (target === null ? () => {} : store.subscribe(target, listener)),
    [store, target],
  );
  const read = useCallback(() => target !== null && store.mode(target) === "adjustable", [store, target]);
  const armed = useSyncExternalStore(subscribe, read, read);

  // The lock belongs to the picture it was armed on: another subject, or a target that can
  // no longer be flown, leaves it (and closes whatever gesture was open).
  useEffect(() => {
    if (target === null) return;
    return () => store.setMode(target, "home");
  }, [store, target]);

  const set = useCallback(
    (on: boolean | undefined): boolean => {
      if (target === null) return false;
      const next = on ?? store.mode(target) !== "adjustable";
      store.setMode(target, next ? "adjustable" : "home");
      return next;
    },
    [store, target],
  );

  const worldPose = useCallback(() => {
    if (target === null) return null;
    if (store.pose === undefined) throw new Error("The camera gesture store must expose its live pose.");
    const local = store.pose(target);
    const resolved = readPose(target);
    const current = cameraDocument.read();
    const node = current.nodes[target];
    if (local === null || resolved === null || node === undefined) return null;
    const values = resolveParameters(node, registry.get(node.type), parameterReadOptions({ ...bus.readScope(), graph: authoredGraph(current), registry }));
    const vector = (key: string): readonly [number, number, number] => {
      const value = values.get(key)?.value;
      if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
        throw new Error(`Camera ${key} must resolve to a finite vec3.`);
      }
      return [value[0] as number, value[1] as number, value[2] as number];
    };
    // Camera nodes compose offsets in Origin/Heading. Other pose-owning renderers
    // and projectors already store their Eye and Look At in world coordinates.
    const frame = node.type === "camera"
      ? cameraFrame(vector("origin"), vector("heading"), values.get("frame")?.value === "aimed" ? "aimed" : "level")
      : cameraFrame([0, 0, 0], [0, 0, 0]);
    // A gesture accumulates its editable channels locally. Driven channels keep
    // evaluating on the transport and must be sampled again for the displayed pose.
    const liveVector = (
      session: readonly [number, number, number],
      driven: readonly [number, number, number],
      mask: readonly boolean[] | undefined,
    ): readonly [number, number, number] => [
      mask?.[0] === false ? driven[0] : session[0],
      mask?.[1] === false ? driven[1] : session[1],
      mask?.[2] === false ? driven[2] : session[2],
    ];
    const eye = inCameraFrame(frame, liveVector(local.eye, resolved.eye, resolved.eyeMask));
    const lookAt = inCameraFrame(frame, liveVector(local.lookAt, resolved.lookAt, resolved.lookAtMask));
    const roll = values.get("roll")?.value;
    if (roll !== undefined && (typeof roll !== "number" || !Number.isFinite(roll))) throw new Error("Camera roll must resolve to a finite number.");
    const orientation = cameraBasis(eye, lookAt, roll === undefined ? 0 : roll);
    return { eye, lookAt, right: orientation.right, up: orientation.up, frame };
  }, [bus, cameraDocument, readPose, registry, store, target]);
  const axisCamera = useMemo<ViewerAxisCameraController>(() => {
    let pending = Promise.resolve();
    const enqueue = (change: (nodeId: NodeId) => void): Promise<void> => {
      // Serialize the entire gesture, including the queued command writes. Two
      // button presses may otherwise both begin from the same pre-commit pose.
      pending = pending.then(async () => {
        if (target === null || store.mode(target) !== "adjustable") return;
        store.release?.(target);
        await editor.settled();
        if (store.mode(target) !== "adjustable") return;
        change(target);
        store.release?.(target);
        await editor.settled();
      });
      return pending;
    };
    return {
      readPose: worldPose,
      adjust(change) {
        return enqueue((nodeId) => {
          if (change.zoom !== undefined) {
            store.zoom(nodeId, change.zoom);
            return;
          }
          const pose = worldPose();
          if (pose === null) return;
          if (store.fly === undefined) throw new Error("The camera gesture store must support translation.");
          // Pan follows the rolled screen axes in world space. Project that
          // direction into the authored frame; fly scales it by the local camera
          // distance and applies the existing per-channel movement masks.
          const world = pose.right.map((right, axis) => right * (change.panX ?? 0) + pose.up[axis]! * (change.panY ?? 0));
          const along = (axis: readonly [number, number, number]): number =>
            axis[0] * world[0]! + axis[1] * world[1]! + axis[2] * world[2]!;
          store.fly(nodeId, [along(pose.frame.right), along(pose.frame.up), along(pose.frame.back)]);
        });
      },
      snap(mark) {
        return enqueue((nodeId) => {
          const pose = worldPose();
          if (pose === null) return;
          // The gesture store rotates about world up expressed in the authored
          // frame, preserving the world-space angular delta and its channel masks.
          store.apply(nodeId, axisSnapDelta(pose, DEFAULT_PREVIEW_ORBIT, mark));
        });
      },
    };
  }, [editor, store, target, worldPose]);

  return { target, name, nameParts, refusal, held, store, armed, set, axisCamera };
}
