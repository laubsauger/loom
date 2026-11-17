import { effectiveParameterSchema, resolveParameters, type ParameterReadOptions } from "@domain/parameters/resolve.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { parameterReadOptions, type ParameterReadContext } from "@domain/parameters/node-references.ts";
import type { CameraPose } from "./camera-gizmo-store.ts";
import { cameraFrame, worldUpInCameraFrame } from "@domain/geometry/camera.ts";
import { MODE_LABELS } from "@ui/controls/parameter-slot.ts";
import { componentKey } from "@domain/parameters/slots.ts";

/**
 * T1314b / §B219 — WHAT THE CAMERA GIZMO IS ALLOWED TO MOVE, read from the RESOLVED
 * document rather than the stored one.
 *
 * ## The corruption this exists to end
 *
 * §T692's gizmo guarded on the BARE `eye` key: present and a plain 3-array meant "static,
 * go ahead". But §V113 makes a compound COMPONENT-ADDRESSABLE — a driven channel stores
 * its own slot under `eye.x`, and the bare key supplies only the base tuple — so the guard
 * never saw the one thing that decides whether a channel may be written. Measured on the
 * shipped catalogue: 12 of 20 camera nodes armed the gizmo while a channel was driven, and
 * FOUR (E25 ×2, E28, E69) store no bare `eye` at all, so the read fell through to a
 * hardcoded copy of the schema default `[0, 0.5, 3]` — E69 Burnish's camera actually sits
 * near `[·, 1.9, 8.4]`.
 *
 * The write then landed on the INACTIVE static binding while `mode: "expression"` stayed in
 * place. Net effect, and it is the nastiest shape available: the drag lands, the camera does
 * not move, and §V914's retained value — what every thumbnail, headless render and claim
 * uses when nothing is driving — is replaced by an arbitrary dragged pose. Silent in the
 * app, visible only later in a render nobody connected to a drag.
 *
 * ## Why RESOLVED, and why that needs no new plumbing
 *
 * A driven channel's stored static is stale by construction: it is the retained value, not
 * where the camera is. Orbiting about a pivot derived from stale numbers would swing the
 * free channels through the wrong arc. So the pose is resolved — through the bus's read scope
 * (`bus.readScope()`: the channel resolver, the frame on screen, the flattening), which
 * `graph-pane` already holds. §T1557b: it used to be handed `{ channels }` alone, with no
 * cross-node reader, so an `op('k1').chan.value` channel read its static (§B181's shape).
 *
 * ## The rule, which is one control over and already written
 *
 * `label-drag.ts` solved this for the inspector's vector label: `movableMask` refuses to
 * write a driven channel's displayed value back, and says which channel is held and by
 * what. This module is that answer applied to the tile's gesture, so the two surfaces refuse
 * identically. (§T970: the SENTENCE is this module's own. It used to be the label's, "Drag
 * the name to move y and z together", which is about a gesture nobody makes on a tile, and
 * nothing read it.) Refusal is ABSENT rather than
 * disabled (§T1049) and total refusal comes only when EVERY channel is driven — there is
 * then nothing to fly. A partly driven camera still flies, on the channels that are free.
 */

/** Axis spelling, matching `AXIS_LABELS` in `ui/controls/vector-field.tsx` (kept React-free here). */
const AXIS = ["x", "y", "z"] as const;

/** One channel of a camera vector: where it is, and what (if anything) decides it. */
export interface CameraChannel {
  /** `x` / `y` / `z`, as the inspector's fields name them. */
  readonly name: string;
  /** The RESOLVED value — where the camera actually is, driver included. */
  readonly value: number;
  /** The mode's display name when another mode decides this channel, else null. */
  readonly drivenBy: string | null;
}

export interface CameraPoseFacts {
  readonly eye: readonly CameraChannel[];
  readonly lookAt: readonly CameraChannel[];
  /** §T1671b: the world's up in the pose's own coordinates, when it is not +y (`CameraPose.up`). */
  readonly up?: readonly [number, number, number] | undefined;
  /**
   * §V830 — what the gesture will do INCLUDING what it refuses, in the label's own voice.
   * Empty when nothing is held, so the caller adds no chrome for the ordinary case.
   */
  readonly held: string;
}

const vectorChannels = (
  entry:
    | {
        value: unknown;
        mode: string;
        components?: readonly { name: string; mode: string; value: number }[] | undefined;
      }
    | undefined,
  fallback: readonly [number, number, number],
): readonly CameraChannel[] => {
  const tuple = Array.isArray(entry?.value) ? (entry.value as readonly unknown[]) : fallback;
  // The compound's own mode is the default for every channel; a component with its own slot
  // overrides it — the same precedence the inspector's fields use.
  const compoundDriven = entry === undefined || entry.mode === "static" ? null : (MODE_LABELS[entry.mode as never] ?? entry.mode);
  return AXIS.map((name, index) => {
    const component = entry?.components?.[index];
    const value = typeof component?.value === "number" ? component.value : Number(tuple[index] ?? fallback[index] ?? 0);
    const mode = component?.mode;
    const drivenBy =
      mode === undefined ? compoundDriven : mode === "static" ? null : (MODE_LABELS[mode as never] ?? mode);
    return { name, value, drivenBy };
  });
};

const poseChannels = (
  node: GraphNode,
  definition: NodeDefinition | undefined,
  read: ParameterReadOptions,
): { eye: readonly CameraChannel[]; lookAt: readonly CameraChannel[]; up: readonly [number, number, number] | undefined } => {
  const resolved = resolveParameters(node, definition, read);
  /*
   * §T1671b: a camera whose Frame is Aimed stores its pose down a Heading that may climb,
   * so the world's up is not the pose's +y. Read here, with the pose and by the same
   * resolution, so the axis a gesture turns about is the one its numbers were read in.
   */
  let up: readonly [number, number, number] | undefined;
  if (resolved.get("frame")?.value === "aimed") {
    const heading = vectorChannels(resolved.get("heading"), [0, 0, 0]).map((channel) => channel.value);
    // A Heading that neither climbs nor dives is a level frame: no axis, the +y maths exactly.
    if ((heading[1] ?? 0) !== 0) {
      up = worldUpInCameraFrame(cameraFrame([0, 0, 0], [heading[0] ?? 0, heading[1] ?? 0, heading[2] ?? 0], "aimed"));
    }
  }
  return {
    eye: vectorChannels(resolved.get("eye"), [0, 0.5, 3]),
    lookAt: vectorChannels(resolved.get("lookAt"), [0, 0, 0]),
    up,
  };
};

/**
 * What THIS node calls the two vectors of its pose. A Camera's are "Eye" and "Look At"; a
 * Render Surface and a Render Instances call the first "Camera Eye". The sentences below
 * name the fields a reader will go and look for, so they take the names from the node's own
 * parameters: one rule, and a node that relabels its pose is followed.
 */
const poseLabels = (node: GraphNode, definition: NodeDefinition | undefined): { readonly eye: string; readonly lookAt: string } => {
  const schema = definition === undefined ? undefined : effectiveParameterSchema(definition, node.parameters);
  return { eye: schema?.["eye"]?.label ?? "Eye", lookAt: schema?.["lookAt"]?.label ?? "Look At" };
};

/**
 * T1655b — THE SENTENCE FOR A POSE NOTHING HERE CAN MOVE, or null while a channel is free.
 *
 * `readCameraPoseFacts` answers null for a fully driven pose and the caller offers no
 * control, which is right (§T1049) and was half of the rule: the other half is that the
 * absence is SAID where the control would have been. The owner's own camera has all six
 * channels on expressions, and its tile showed nothing at all in that corner, so "this
 * camera cannot be moved from here" and "this app forgot the control" were the same pixels.
 *
 * It names what decides the pose and where that is changed. It does not offer to free a
 * channel: that would replace the rig the expressions are (§T970, §T1656b).
 */
export function cameraPoseDrivenSentence(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  /** The bus's read scope, as `cameraPoseAt` takes it: the same read the gizmo starts from. */
  scope: ParameterReadContext,
): string | null {
  const { eye, lookAt } = poseChannels(node, definition, parameterReadOptions(scope));
  const drivers = new Set<string>();
  for (const channel of [...eye, ...lookAt]) {
    if (channel.drivenBy === null) return null;
    drivers.add(channel.drivenBy);
  }
  const by =
    drivers.size === 1 && drivers.has(MODE_LABELS.expression)
      ? "expressions"
      : [...drivers].sort().join(" and ");
  // Two short lines on a tile: what decides the pose, and the two parameters it is decided in.
  const labels = poseLabels(node, definition);
  return `Driven by ${by} (${labels.eye}, ${labels.lookAt}).`;
}

/**
 * T1655b: a picture drawn through its own node's pose, seen in the VIEWER, which cannot move
 * it yet (flying a camera from there is §T970). Kept beside the sentence above so the two
 * things a pose tile can say when it has no control are in one place.
 */
export const POSE_MOVED_FROM_ITS_TILE = "Drawn through this node's Eye and Look At: drag on its tile in the graph to move it.";

/**
 * The camera's pose as the gesture must see it, or null when there is nothing to fly.
 *
 * Null means EVERY channel of both vectors is decided elsewhere. The caller offers no
 * control at all then (§T1049: absent, never disabled) — a gizmo that can move nothing is
 * the inert-and-unexplained state §V830 exists to end, and the sentence explaining it
 * belongs where the control would have been, not on a dead handle.
 */
export function readCameraPoseFacts(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  /** §T1557b: `parameterReadOptions(…)` for where the camera IS; `STORED_READ` for the document. */
  read: ParameterReadOptions,
): CameraPoseFacts | null {
  const { eye, lookAt, up } = poseChannels(node, definition, read);
  const free = [...eye, ...lookAt].some((channel) => channel.drivenBy === null);
  if (!free) return null;

  const heldParts: string[] = [];
  const labels = poseLabels(node, definition);
  for (const [label, channels] of [
    [labels.eye, eye],
    [labels.lookAt, lookAt],
  ] as const) {
    for (const channel of channels) {
      if (channel.drivenBy !== null) heldParts.push(`${label} ${channel.name} (${channel.drivenBy})`);
    }
  }
  return { eye, lookAt, ...(up === undefined ? {} : { up }), held: heldParts.length === 0 ? "" : `Stays driven: ${heldParts.join(", ")}.` };
}

/**
 * §T970 — what a pose tile or the viewer's lock has to SAY about this node's pose: the
 * sentence that stands in for the control when nothing is free (`driven`), and, when the
 * control is there, the channels its gestures will leave alone (`held`, empty for none).
 * A partly driven camera flew on its free channels and told nobody which were held.
 */
export function cameraPoseSaid(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  scope: ParameterReadContext,
): { readonly driven: string | null; readonly held: string } {
  const driven = cameraPoseDrivenSentence(node, definition, scope);
  if (driven !== null) return { driven, held: "" };
  return { driven: null, held: readCameraPoseFacts(node, definition, parameterReadOptions(scope))?.held ?? "" };
}

/** The numbers, for the orbit maths. */
export function poseFromFacts(facts: CameraPoseFacts): {
  eye: readonly [number, number, number];
  lookAt: readonly [number, number, number];
} {
  const vec = (channels: readonly CameraChannel[]): readonly [number, number, number] => [
    channels[0]?.value ?? 0,
    channels[1]?.value ?? 0,
    channels[2]?.value ?? 0,
  ];
  return { eye: vec(facts.eye), lookAt: vec(facts.lookAt) };
}

/** Which channels the gesture may write: the ones no other mode is deciding (`movableMask`'s rule). */
export function movableChannels(channels: readonly CameraChannel[]): readonly boolean[] {
  return channels.map((channel) => channel.drivenBy === null);
}

/**
 * §T1557b — THE POSE AS THE GIZMO READS IT AT GESTURE START (§V657), from the bus's read
 * scope over the graph the pane shows: the numbers and which channels a drag may write.
 * `graph-pane.tsx` calls exactly this, so the read a gesture starts from is the one tested.
 */
export function cameraPoseAt(node: GraphNode, definition: NodeDefinition | undefined, scope: ParameterReadContext): CameraPose | null {
  const facts = readCameraPoseFacts(node, definition, parameterReadOptions(scope));
  if (facts === null) return null;
  const { eye, lookAt } = poseFromFacts(facts);
  const eyeComponents = AXIS.map((axis) => node.parameters[componentKey("eye", axis)] !== undefined);
  const lookAtComponents = AXIS.map((axis) => node.parameters[componentKey("lookAt", axis)] !== undefined);
  return {
    eye,
    lookAt,
    eyeMask: movableChannels(facts.eye),
    lookAtMask: movableChannels(facts.lookAt),
    ...(facts.eye.every((channel) => channel.drivenBy === null) && eyeComponents.some(Boolean) ? { eyeComponents } : {}),
    ...(facts.lookAt.every((channel) => channel.drivenBy === null) && lookAtComponents.some(Boolean) ? { lookAtComponents } : {}),
    ...(facts.up === undefined ? {} : { up: facts.up }),
  };
}
