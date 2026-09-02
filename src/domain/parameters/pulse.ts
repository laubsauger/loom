import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { NodeId } from "../types/ids.ts";
import type {
  ParameterSchema,
  ParameterValue,
  PulseParameter,
} from "../types/parameters.ts";
import { isParameterSlot } from "./slots.ts";
import { effectiveParameterSchema, resolveParameter } from "./resolve.ts";
import type { ChannelResolver, ParameterSchemaSource } from "./resolve.ts";

/**
 * Pulse mechanics (T214, §V123, §V124, §V125).
 *
 * A pulse is momentary: it FIRES and it does not hold. Everything downstream of that one
 * sentence lives here, in the domain, because the two things that fire a pulse — a click
 * in the inspector and an expression crossing zero during a frame — must agree about what
 * firing means. Two answers would be a trigger that behaves differently depending on who
 * pulled it.
 *
 * Nothing in this module mutates anything. Firing is a bus command (§V29); this decides
 * WHICH command, with WHAT input, and WHEN an expression has just fired.
 */

/** Stands in for the firing node's id inside a pulse's declared command input. */
export const PULSE_NODE_TOKEN = "$node";

/**
 * The input the pulse's command is invoked with.
 *
 * `"$node"` is replaced with the firing node's id — as a bare value, or as an element of
 * an array value, which is the shape `runtime.resetFeedback` wants (`{nodeIds: ["$node"]}`).
 * Substitution is deliberately shallow: a node definition declaring a deeply nested
 * template is describing something the pulse contract does not promise, and a recursive
 * walk would make it look like it does.
 */
export function pulseCommandInput(
  definition: PulseParameter,
  nodeId: NodeId,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition.input ?? {})) {
    if (value === PULSE_NODE_TOKEN) {
      input[key] = nodeId;
    } else if (Array.isArray(value)) {
      input[key] = value.map((entry) => (entry === PULSE_NODE_TOKEN ? nodeId : entry));
    } else {
      input[key] = value;
    }
  }
  return input;
}

/**
 * Is a resolved pulse value ARMED this frame?
 *
 * `true`, or a non-zero number from an expression. `false` is the only value a pulse may
 * ever be stored as (§V124), so a document read never arms one — only a live expression
 * result can.
 */
export function isPulseArmed(value: ParameterValue): boolean {
  if (typeof value === "boolean") return value;
  return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

/** Every pulse a schema declares, in manifest order. */
export function pulseParametersOf(
  schema: ParameterSchema,
): ReadonlyArray<{ key: string; definition: PulseParameter }> {
  const found: Array<{ key: string; definition: PulseParameter }> = [];
  for (const [key, definition] of Object.entries(schema)) {
    if (definition.type === "pulse") found.push({ key, definition });
  }
  return found;
}

/**
 * A pulse that is armed by something other than a click — an expression, a bind, a
 * driven channel — and therefore has to be WATCHED rather than waited on.
 */
function isWatchable(node: GraphNode, key: string): boolean {
  const stored = node.parameters[key];
  return isParameterSlot(stored) && stored.mode !== "static";
}

export interface PulseFire {
  nodeId: NodeId;
  key: string;
  definition: PulseParameter;
}

export interface PulseWatcher {
  /**
   * Pulses that went from disarmed to ARMED since the last step.
   *
   * Edge-triggered, not level-triggered: `frame % 60 == 0` is true for one frame at a
   * time, but `time > 4` stays true forever, and a level-triggered reset would clear the
   * buffer on every frame after the fourth — a feedback loop that never accumulates, with
   * an expression that reads correct. The rising edge is the trigger.
   *
   * The first step of a pulse's life never fires: a project opened with an expression
   * that is already true must not reset on load (§V124's "would wipe your work every
   * open", reached by the other road).
   */
  step: (
    graph: GraphDocument,
    frame: FrameEvaluationInput,
    /** T628: the §V61 channel resolver — absent, a DRIVEN pulse reads its retained static and never fires. */
    channels?: ChannelResolver,
  ) => readonly PulseFire[];
  /** Forget every armed state. Used when the document is replaced. */
  reset: () => void;
}

/**
 * Just enough registry to answer "what parameters does this type have". Duck-typed so a test
 * can hand over a literal; §T903 pins the return to `ParameterSchemaSource` so this reads a
 * node's schema through the SAME funnel every other consumer does — a reflected pulse
 * (§T880) fires like a declared one, and a structural type stops being a way around the rule.
 */
interface SchemaSource {
  get: (type: string) => ParameterSchemaSource | undefined;
}

/*
 * The separator is an ESCAPE, not a raw NUL byte: the byte makes the whole FILE read as
 * binary to `grep` and `rg`, so every repo-wide search silently SKIPS this module — and a
 * search that finds no caller is how this project has concluded 'never wired' before.
 */
const armedKey = (nodeId: NodeId, key: string): string => `${nodeId}\u0000${key}`;

/**
 * Watches every non-static pulse in a document and reports rising edges (§V125).
 *
 * Stateful by necessity — an edge is a comparison with the previous frame — and
 * deterministic given the same frame sequence, because every value it compares comes from
 * the one parameter read path (§V61) driven by `FrameEvaluationInput` (§V44). Replay the
 * frames, get the same fires.
 */
export function createPulseWatcher(registry: SchemaSource): PulseWatcher {
  /** Key → armed last step. A key absent from the map has never been seen. */
  let armed = new Map<string, boolean>();

  return {
    reset() {
      armed = new Map();
    },
    step(graph, frame, channels) {
      const fires: PulseFire[] = [];
      const next = new Map<string, boolean>();

      for (const nodeId of Object.keys(graph.nodes).sort()) {
        const node = graph.nodes[nodeId];
        if (node === undefined) continue;
        const definition = registry.get(node.type);
        if (definition === undefined) continue;
        const schema = effectiveParameterSchema(definition, node.parameters);
        for (const { key, definition } of pulseParametersOf(schema)) {
          if (!isWatchable(node, key)) continue;
          /*
           * T628 (T593's class, fourth instance): the CHANNEL RESOLVER rides along, or
           * a DRIVEN pulse silently resolves to its retained static and never fires —
           * an LFO wired to a reset pulse was a wire that did nothing, with every unit
           * suite green because each was handed the resolver it was testing.
           */
          const resolved = resolveParameter(node, key, definition, {
            frame,
            schema,
            ...(channels === undefined ? {} : { channels }),
          });
          const isArmed = isPulseArmed(resolved.value);
          const mapKey = armedKey(nodeId, key);
          next.set(mapKey, isArmed);
          const was = armed.get(mapKey);
          // `was === undefined` is the first sighting: record the level, fire nothing.
          if (was === false && isArmed) fires.push({ nodeId, key, definition });
        }
      }

      armed = next;
      return fires;
    },
  };
}
