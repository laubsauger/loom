import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { PortType } from "../../domain/types/ports.ts";
import { RGBA_TEXTURE, VALUE_PORT } from "./common-ports.ts";

/**
 * Component boundary nodes (T607) — the TD / ComfyUI idiom the owner asked for:
 * "subgraph input nodes that then produce sockets on the top level".
 *
 * An `In` placed inside a component becomes an input socket on every instance; an `Out`
 * becomes an output socket. NO NEW MECHANISM anywhere behind them (T423's finding):
 * each is a `passthrough` wire exactly like the Null node, so the compiler's existing
 * splice (stage 1b, after flatten) rewires every consumer of `In.out` to the producer
 * the PARENT wired into the socket — which is also what fixes fan-in: one outer source
 * feeding three inner nodes is ONE socket and one In, where the selection-save path
 * used to mint three sockets all wired to the same producer.
 *
 * The dangling side is `optional`, exactly as the Null's input is: an unwired socket is
 * a legitimate state (the splice drops the consumers' edges, the honest disconnect),
 * never a `validateRequiredInputs` error. The canvas draws that side as a lead — the
 * "dangling input cable" of the owner's framing — keyed off `isComponentBoundary`.
 *
 * ONE VARIANT PER PORT KIND, deliberately (§V349: do not start a second mapping): a
 * generic In whose type follows its wire needs the port-type union opened and the
 * frozen `NodeDefinition` contract changed. The two kinds below are the two the product
 * wires by edge today; the next kind copies this file's pattern.
 */

const POINTSET: PortType = { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] };

/** Category shared with component instances, so the library files them together. */
const BOUNDARY_CATEGORY = "component";

const noPasses = (): CompiledNodeDescription => ({ passes: [] });

export const componentInput: NodeDefinition = {
  type: "componentIn",
  version: 1,
  title: "In",
  category: BOUNDARY_CATEGORY,
  description:
    "A component input socket. Place inside a component: whatever the parent wires into the matching socket flows out of this node. RENAME THIS NODE to name the socket — a speaking name here is the name every instance shows, and renaming never rewires anything. Socket order follows canvas position, top to bottom.",
  inputs: [{ id: "in", label: "From parent", type: RGBA_TEXTURE, optional: true }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  resolutionPolicy: { kind: "inherit", input: "in" },
  formatPolicy: { kind: "inherit", input: "in" },
  compile: noPasses,
};

export const componentOutput: NodeDefinition = {
  type: "componentOut",
  version: 1,
  title: "Out",
  category: BOUNDARY_CATEGORY,
  description:
    "A component output socket. Place inside a component: whatever is wired into this node flows out of the matching socket on every instance. RENAME THIS NODE to name the socket — a speaking name here is the name every instance shows, and renaming never rewires anything. Socket order follows canvas position, top to bottom.",
  inputs: [{ id: "in", label: "In", type: RGBA_TEXTURE, optional: true }],
  outputs: [{ id: "out", label: "To parent", type: RGBA_TEXTURE }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  resolutionPolicy: { kind: "inherit", input: "in" },
  formatPolicy: { kind: "inherit", input: "in" },
  compile: noPasses,
};

export const componentInputPoints: NodeDefinition = {
  type: "componentInPoints",
  version: 1,
  title: "In (points)",
  category: BOUNDARY_CATEGORY,
  description:
    "A component input socket for a pointset. Place inside a component: the parent's points flow out of this node. Rename this node to name the socket on every instance.",
  inputs: [{ id: "in", label: "From parent", type: POINTSET, optional: true }],
  outputs: [{ id: "out", label: "Out", type: POINTSET }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  compile: noPasses,
};

export const componentOutputPoints: NodeDefinition = {
  type: "componentOutPoints",
  version: 1,
  title: "Out (points)",
  category: BOUNDARY_CATEGORY,
  description:
    "A component output socket for a pointset. Place inside a component: the points wired into this node flow out of the matching socket. Rename this node to name the socket on every instance.",
  inputs: [{ id: "in", label: "In", type: POINTSET, optional: true }],
  outputs: [{ id: "out", label: "To parent", type: POINTSET }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  compile: noPasses,
};

/**
 * The value kind (T822). A component can pass pictures and points across its boundary but
 * not NUMBERS, which is the whole point of an analyser component: it hears the track inside
 * and must publish its channels to the parent. Same passthrough splice as every boundary
 * above — but a value node is one that declares `valueEvaluate`/`valueChannel`
 * (`isValueSourceDefinition`), and without that the value-graph walk does not recognise the
 * boundary and the chain breaks AT it, unspliced. So these two, alone among the boundary
 * nodes, carry a one-line passthrough evaluator: forward the input bag unchanged. It reads
 * no clock (CLOCKLESS): whatever clock the wired source owns, the boundary inherits.
 */
export const componentInputValue: NodeDefinition = {
  type: "componentInValue",
  version: 1,
  title: "In (value)",
  category: BOUNDARY_CATEGORY,
  description:
    "A component input socket for a value. Place inside a component: whatever value the parent wires into the matching socket flows out of this node. Rename this node to name the socket on every instance.",
  inputs: [{ id: "in", label: "From parent", type: VALUE_PORT, optional: true }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  valueEvaluate: ({ inputs }) => inputs["in"] ?? {},
  compile: noPasses,
};

export const componentOutputValue: NodeDefinition = {
  type: "componentOutValue",
  version: 1,
  title: "Out (value)",
  category: BOUNDARY_CATEGORY,
  description:
    "A component output socket for a value. Place inside a component: the value wired into this node flows out of the matching socket on every instance — how a component publishes its channels to the parent. Rename this node to name the socket.",
  inputs: [{ id: "in", label: "In", type: VALUE_PORT, optional: true }],
  outputs: [{ id: "out", label: "To parent", type: VALUE_PORT }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  valueEvaluate: ({ inputs }) => inputs["in"] ?? {},
  compile: noPasses,
};

const INPUT_TYPES = new Set(["componentIn", "componentInPoints", "componentInValue"]);
const OUTPUT_TYPES = new Set(["componentOut", "componentOutPoints", "componentOutValue"]);

/** Is this node type a component INPUT boundary (socket on the left of the instance)? */
export function isComponentInputBoundary(type: string): boolean {
  return INPUT_TYPES.has(type);
}

/** Is this node type a component OUTPUT boundary (socket on the right of the instance)? */
export function isComponentOutputBoundary(type: string): boolean {
  return OUTPUT_TYPES.has(type);
}

/** Either boundary — the canvas draws the dangling lead off this. */
export function isComponentBoundary(type: string): boolean {
  return isComponentInputBoundary(type) || isComponentOutputBoundary(type);
}

/** The boundary variant matching a port kind, for the selection-save synthesis (T607). */
export function boundaryTypeFor(kind: string, direction: "input" | "output"): string | undefined {
  if (kind === "texture2d") return direction === "input" ? "componentIn" : "componentOut";
  if (kind === "pointset") return direction === "input" ? "componentInPoints" : "componentOutPoints";
  if (kind === "value") return direction === "input" ? "componentInValue" : "componentOutValue";
  return undefined;
}

export const componentIoDefinitions: readonly NodeDefinition[] = [
  componentInput,
  componentOutput,
  componentInputPoints,
  componentOutputPoints,
  componentInputValue,
  componentOutputValue,
];
