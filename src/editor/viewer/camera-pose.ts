import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { resolveParameters } from "@domain/parameters/resolve.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { MODE_LABELS } from "@ui/controls/parameter-slot.ts";
import { describeLabelDrag, type LabelDragChannel } from "@ui/controls/label-drag.ts";

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
 * free channels through the wrong arc. So the pose is resolved — and the resolver is already
 * on the bus (`attachChannelResolver`, `bus.channelResolver()`), attached by
 * `use-graph-compile.ts`, which `graph-pane` already holds. No new prop, no new seam.
 *
 * ## The rule, which is one control over and already written
 *
 * `label-drag.ts` solved this for the inspector's vector label: `movableMask` refuses to
 * write a driven channel's displayed value back, and `describeLabelDrag` says which channel
 * is held and by what. This module is that answer applied to the tile's gesture, so the two
 * surfaces refuse identically and say the same sentence. Refusal is ABSENT rather than
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
  /**
   * §V830 — what the gesture will do INCLUDING what it refuses, in the label's own voice.
   * Empty when nothing is held, so the caller adds no chrome for the ordinary case.
   */
  readonly held: string;
}

export interface CameraPoseOptions {
  /** Resolves `op('x').chan.y`. Absent = driven channels report their retained static (§V108). */
  readonly channels?: ChannelResolver | undefined;
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

const asChannels = (channels: readonly CameraChannel[]): readonly LabelDragChannel[] =>
  channels.map((channel) => ({ name: channel.name, drivenBy: channel.drivenBy }));

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
  options: CameraPoseOptions = {},
): CameraPoseFacts | null {
  const resolved = resolveParameters(node, definition, {
    ...(options.channels === undefined ? {} : { channels: options.channels }),
  });
  const eye = vectorChannels(resolved.get("eye"), [0, 0.5, 3]);
  const lookAt = vectorChannels(resolved.get("lookAt"), [0, 0, 0]);
  const free = [...eye, ...lookAt].some((channel) => channel.drivenBy === null);
  if (!free) return null;

  const heldParts: string[] = [];
  for (const [label, channels] of [
    ["Eye", eye],
    ["Look At", lookAt],
  ] as const) {
    if (channels.every((channel) => channel.drivenBy === null)) continue;
    heldParts.push(`${label}: ${describeLabelDrag(asChannels(channels))}`);
  }
  return { eye, lookAt, held: heldParts.join(" ") };
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
