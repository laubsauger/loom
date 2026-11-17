import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { storedStaticValue, isParameterSlot } from "@domain/parameters/slots.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { placeFree } from "@domain/graph/layout.ts";
import { freeRoleName, nodeNames, renumberedName, uniqueNodeName } from "@domain/graph/names.ts";
import { kindOfType } from "@domain/graph/node-kinds.ts";
import { parseMidiMapping, serialiseMidiMapping, type MidiBinding, type MidiSource } from "@domain/midi/midi-mapping.ts";
import { controlNameOf } from "@nodes/definitions/controls.ts";
import { channelFromLabel, controlReadSource, controlSlot, unbindOperations, type ControlPlan } from "./parameter-controls.ts";

const KEYS: Readonly<Record<string, readonly string[]>> = {
  slider: ["value"], toggle: ["on"], button: ["held"], xyPad: ["x", "y"],
};
const refuse = (code: string, reason: string): ControlPlan => ({ ok: false, code, reason });
const supported = (node: GraphNode, key: string) => KEYS[node.type]?.includes(key) === true;
const expressionOf = (stored: StoredParameter | undefined): string | undefined =>
  isParameterSlot(stored) && stored.bindings.expression?.kind === "expression" ? stored.bindings.expression.source : undefined;
const staticMode = (stored: StoredParameter | undefined) => !isParameterSlot(stored) || stored.mode === "static";
const midiRead = (control: GraphNode, name: string, channel: string) =>
  `${controlReadSource(name, channel)}${control.type === "button" ? " >= 0.5" : ""}`;

function retained(node: GraphNode, registry: NodeRegistryView, key: string): unknown {
  const value = storedStaticValue(node.parameters[key]);
  if (value !== undefined) return value;
  const definition = effectiveParameterSchema(registry.get(node.type), node.parameters)[key];
  return definition !== undefined && "default" in definition ? definition.default : undefined;
}

export interface ControlMidiBinding {
  readonly midiId: string;
  readonly channel: string;
  readonly binding: MidiBinding;
}

/** The active, exact MIDI channel read by a widget, for Learn/Unlearn affordances. */
export function controlMidiBinding(graph: GraphDocument, nodeId: string, parameterKey: string): ControlMidiBinding | null {
  const control = graph.nodes[nodeId];
  if (control === undefined || !supported(control, parameterKey)) return null;
  const stored = control.parameters[parameterKey];
  if (!isParameterSlot(stored) || stored.mode !== "expression") return null;
  const expression = expressionOf(stored);
  for (const midi of Object.values(graph.nodes)) {
    if (midi.type !== "midiIn" || midi.label === undefined || !staticMode(midi.parameters["mapping"])) continue;
    const mapping = storedStaticValue(midi.parameters["mapping"]) ?? "[]";
    if (typeof mapping !== "string") continue;
    const parsed = parseMidiMapping(mapping);
    if (parsed.error !== null) continue;
    const binding = parsed.bindings.find((each) => expression === midiRead(control, controlNameOf(midi), each.channel));
    if (binding !== undefined) return { midiId: midi.id, channel: binding.channel, binding };
  }
  return null;
}

/** Learn writes document bindings once; hardware readings continue through the value graph. */
export function learnControlMidiPlan(
  graph: GraphDocument, registry: NodeRegistryView, nodeId: string, parameterKey: string,
  source: MidiSource, portId: string,
): ControlPlan {
  const control = graph.nodes[nodeId];
  if (control === undefined) return refuse("control.node", `No node "${nodeId}".`);
  if (!supported(control, parameterKey)) return refuse("control.midi.target", `"${controlNameOf(control)}.${parameterKey}" is not a MIDI control target.`);
  if (portId === "" || !Number.isInteger(source.channel) || source.channel < 1 || source.channel > 16 ||
      (source.kind !== "cc" && source.kind !== "pitchBend" && source.kind !== "note") ||
      (source.kind !== "pitchBend" && (!Number.isInteger(source.number) || (source.number ?? -1) < 0 || (source.number ?? 128) > 127))) {
    return refuse("control.midi.source", "MIDI learning requires a captured input port and a valid CC, note or pitch bend source.");
  }
  const current = retained(control, registry, parameterKey);
  const boolean = control.type === "toggle" || control.type === "button";
  if (boolean ? typeof current !== "boolean" : typeof current !== "number" || !Number.isFinite(current)) {
    return refuse("control.midi.value", `"${controlNameOf(control)}.${parameterKey}" has no valid retained value.`);
  }
  let range: readonly [number, number];
  const rest = current === true ? 1 : current === false ? 0 : current as number;
  if (control.type === "toggle") range = [rest, rest === 1 ? 0 : 1];
  else if (control.type === "button") range = [0, 1];
  else {
    const min = retained(control, registry, "min");
    const max = retained(control, registry, "max");
    if (typeof min !== "number" || !Number.isFinite(min) || typeof max !== "number" || !Number.isFinite(max)) {
      return refuse("control.midi.range", `"${controlNameOf(control)}" needs finite Min and Max values.`);
    }
    range = [min, max];
  }

  const previous = expressionOf(control.parameters[parameterKey]);
  // Legacy unnamed nodes have no op() address; keep them intact and create a named source.
  const candidates = Object.values(graph.nodes).filter((node) => node.type === "midiIn" && node.label !== undefined &&
    staticMode(node.parameters["device"]) && retained(node, registry, "device") === portId).sort((a, b) => a.id.localeCompare(b.id));
  const midi = candidates.find((node) => previous?.startsWith(`op('${controlNameOf(node)}').chan.`)) ?? candidates[0];
  if (midi !== undefined && !staticMode(midi.parameters["mapping"])) return refuse("control.midi.mapping", `"${controlNameOf(midi)}" has a driven mapping; edit its static mapping before learning.`);
  const mapping = midi === undefined ? "[]" : retained(midi, registry, "mapping");
  const parsed = parseMidiMapping(mapping);
  if (typeof mapping !== "string" || parsed.error !== null) return refuse("control.midi.mapping", `"${midi === undefined ? "MIDI In" : controlNameOf(midi)}": ${parsed.error ?? "Mapping must be JSON text."}`);

  const operations: GraphPatchOperation[] = [];
  const midiId = midi?.id ?? "$controlMidi";
  // T1593b: named under the node's kind, as any new node is (`midiin1`).
  const midiName = midi === undefined ? uniqueNodeName(graph, kindOfType("midiIn")) : controlNameOf(midi);
  const midiDefinition = registry.get("midiIn");
  if (midiDefinition === undefined) return refuse("control.midi.unavailable", "MIDI In is not installed in this node registry.");
  const existing = parsed.bindings.find((binding) => previous === midiRead(control, midiName, binding.channel));
  const taken = new Set(parsed.bindings.map((binding) => binding.channel));
  const base = channelFromLabel(`${controlNameOf(control)} ${parameterKey}`);
  const channel = existing?.channel ?? (taken.has(base) ? renumberedName(base, (name) => taken.has(name)) : base);
  const binding: MidiBinding = { channel, source, range, mode: control.type === "toggle" ? "toggle" : "absolute", rest: control.type === "button" ? 0 : rest };
  const bindings = existing === undefined ? [...parsed.bindings, binding] : parsed.bindings.map((each) => each.channel === channel ? binding : each);
  const parameters = { device: portId, mapping: serialiseMidiMapping(bindings) };
  let placed = graph;
  if (midi === undefined) {
    const position = placeFree(graph, registry, "midiIn");
    operations.push({ op: "addNode", ref: midiId, type: "midiIn", position, label: midiName, parameters });
    const provisional: GraphNode = { id: midiId, type: "midiIn", definitionVersion: midiDefinition.version, position, label: midiName, parameters };
    placed = { ...graph, nodes: { ...graph.nodes, [midiId]: provisional } };
  } else operations.push({ op: "setParameters", nodeId: midiId, parameters: { mapping: parameters.mapping } });

  const widget: Record<string, StoredParameter> = {
    [parameterKey]: controlSlot(control.parameters[parameterKey], midiRead(control, midiName, channel), current as number | boolean),
  };
  if (control.type === "button") {
    if (registry.get("valueCount") === undefined) return refuse("control.midi.unavailable", "Count is not installed in this node registry.");
    const presses = retained(control, registry, "presses");
    if (typeof presses !== "number" || !Number.isFinite(presses) || presses < 0) return refuse("control.midi.value", `"${controlNameOf(control)}" needs a valid retained press count.`);
    const pressExpression = expressionOf(control.parameters["presses"]);
    const count = Object.values(graph.nodes).find((node) => {
      if (node.type !== "valueCount" || node.label === undefined || pressExpression !== `${presses} + ${controlReadSource(controlNameOf(node), channel)}` ||
        retained(node, registry, "holdoff") !== 0 || retained(node, registry, "threshold") !== 0.5 ||
        !staticMode(node.parameters["holdoff"]) || !staticMode(node.parameters["threshold"])) return false;
      const incoming = Object.values(graph.edges).filter((edge) => edge.target.nodeId === node.id && edge.target.portId === "in");
      return incoming.length === 1 && incoming[0]?.source.nodeId === midiId && incoming[0]?.source.portId === "out";
    });
    // T1593b: `count_midi`, the Count's kind and what it counts.
    const placedNames = new Set(nodeNames(placed).keys());
    const countName = count === undefined ? freeRoleName("valueCount", "midi", (name) => placedNames.has(name)) : controlNameOf(count);
    if (count === undefined) {
      const countId = "$controlMidiCount";
      operations.push({ op: "addNode", ref: countId, type: "valueCount", label: countName, position: placeFree(placed, registry, "valueCount"), parameters: { threshold: 0.5, holdoff: 0 } });
      operations.push({ op: "connect", source: { nodeId: midiId, portId: "out" }, target: { nodeId: countId, portId: "in" } });
    }
    widget["presses"] = controlSlot(control.parameters["presses"], `${presses} + ${controlReadSource(countName, channel)}`, presses);
  }
  operations.push({ op: "setParameters", nodeId, parameters: widget });
  return { ok: true, label: `Learn MIDI for ${controlNameOf(control)}.${parameterKey}`, operations };
}

/** Restore retained constants. Source mappings and counters remain for other consumers. */
export function unlearnControlMidiPlan(graph: GraphDocument, registry: NodeRegistryView, nodeId: string, parameterKey: string): ControlPlan {
  const node = graph.nodes[nodeId];
  if (node === undefined) return refuse("control.node", `No node "${nodeId}".`);
  if (!supported(node, parameterKey)) return refuse("control.midi.target", `"${controlNameOf(node)}.${parameterKey}" is not a MIDI control target.`);
  const binding = controlMidiBinding(graph, nodeId, parameterKey);
  if (binding === null) return refuse("control.midi.unbound", `"${controlNameOf(node)}.${parameterKey}" is not bound to MIDI.`);
  const keys = [parameterKey];
  const pressSlot = node.parameters["presses"];
  if (node.type === "button" && isParameterSlot(pressSlot) && pressSlot.mode === "expression") {
    const presses = retained(node, registry, "presses");
    const expression = expressionOf(node.parameters["presses"]);
    const counter = Object.values(graph.nodes).find((each) => each.type === "valueCount" && each.label !== undefined &&
      expression === `${presses} + ${controlReadSource(controlNameOf(each), binding.channel)}` &&
      Object.values(graph.edges).some((edge) => edge.source.nodeId === binding.midiId && edge.source.portId === "out" && edge.target.nodeId === each.id && edge.target.portId === "in"));
    if (counter !== undefined) keys.push("presses");
  }
  return { ok: true, label: `Unlearn MIDI for ${controlNameOf(node)}.${parameterKey}`, operations: unbindOperations(graph, registry, nodeId, keys) };
}
