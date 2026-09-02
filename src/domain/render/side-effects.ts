import type { NodeDefinition, SideEffect } from "../types/node-definition.ts";

/**
 * T949 — "DOES THIS NODE ACT ON THE WORLD", AS A PROPERTY OVER THE WHOLE CATALOGUE.
 *
 * ## Why this is not a value of `Reproducibility`
 *
 * `reproducibility.ts` sits beside this file deliberately, because the two answer
 * questions that look adjacent and are not. Every value of `Reproducibility` describes
 * HOW A NODE'S OUTPUT DEPENDS ON THE WORLD. A `laserOut` has no output, so it is a pure
 * function of its inputs, so it classifies as `pure` — CORRECT under that axis and
 * DANGEROUS, because `pure` is precisely the class that makes a node safe to evaluate in
 * a headless export, and `src/tests/headless/**` plus the example GPU gates render EVERY
 * example. A laser that fires because a suite rendered an example is the failure this
 * file exists to prevent, and it would have arrived wearing a correct classification.
 *
 * A fourth `Reproducibility` value was ruled out and the reason is on the record: one
 * field would answer two unrelated questions, and every existing reader branches on "is
 * this `pure`" meaning "does the render reproduce". They would each have quietly
 * mis-handled the new value in a different direction. So: a second record, a second gate,
 * and `Reproducibility` unchanged.
 *
 * ## THE LEDGER IS THE FORCING FUNCTION, NOT THE FIELD
 *
 * `NodeDefinition.sideEffect` is optional and absent means `"none"`, which on its own
 * would be exactly the hazard: a laser node whose author never thought about the question
 * would be treated as inert. This table is what makes the question mandatory — the gate
 * in `side-effects.test.ts` asks the REGISTRY for every node it can instantiate and fails
 * when one is missing here, so the hundredth node cannot land without its author deciding. The two
 * are pinned to each other in BOTH directions by that gate, the shape `sourceReferences`
 * and `SOURCE_REFERENCE_PARAMETERS` already use.
 *
 * The division of labour is the reason for two places rather than one: this table is
 * REVIEW — one file, one diff, no churn across the 99 definition modules that other
 * tracks own — and the FIELD is what the emission site reads, because a pump already
 * holds the definition and has no business importing a 99-entry table.
 *
 * ## THE EMISSION MUST NOT LIVE IN THE NODE, AND THAT IS CHECKED
 *
 * `oscOut` got this right before there was a rule: its `valueEvaluate` is a passthrough
 * and the send is pumped from the app's live frame loop, so an offline render, a headless
 * export and every Dawn gate install no pump and transmit nothing. That is the shape
 * every world-acting node must take, and `side-effects.test.ts` scans the definition
 * sources for the transport APIs a node could use to break it. A send inside
 * `valueEvaluate` would make a background export fire at a lighting rig once per exported
 * frame, silently, and no policy check at a pump could stop it.
 *
 * ## DENY BY DEFAULT, AND PHRASED SO A NEW CONTEXT DENIES
 *
 * `emissionRefusal` below is phrased as "is this a live presentation?" rather than "is
 * this an export?", for the reason `blocksForResult` states one module over (§V586): a
 * context added later must land on the SAFE side without anyone remembering to add it to
 * a list.
 */

/**
 * May a world-acting node emit right now?
 *
 * `"live-session"` is the app's interactive frame loop, with a person watching. Everything
 * else is `"blocked"`: a take, a headless export, the MCP server's object graph, the
 * render harness, every Dawn gate. There is deliberately no third value — "which export"
 * is not a question a laser cares about.
 */
export type SideEffectPolicy = "live-session" | "blocked";

/** T949: does this node push something out of the process? */
export function actsOnWorld(definition: NodeDefinition | undefined): boolean {
  return definition?.sideEffect === "emits";
}

/**
 * Why this node must NOT emit under this policy — or `null` when it may. The one
 * predicate every emission site passes.
 *
 * A SENTENCE rather than a boolean, because the refusal has to reach a surface (§V365):
 * a laser that goes dark during a take with no explanation is indistinguishable from a
 * laser that is broken, and the second is what the user will conclude.
 */
export function emissionRefusal(
  definition: NodeDefinition | undefined,
  policy: SideEffectPolicy,
): string | null {
  if (!actsOnWorld(definition)) return null;
  if (policy === "live-session") return null;
  return (
    `${definition?.title ?? "This node"} drives something outside Loom, and only a live session may do that. ` +
    `A take, a headless export and the test suites all render this document, and none of them may ` +
    `reach your hardware — so nothing was sent.`
  );
}

/**
 * EVERY NODE THE REGISTRY CAN INSTANTIATE, ANSWERING ONE QUESTION (T949).
 *
 * Grouped as the catalogue groups them, and the exercise is finding the ones that are not
 * `"none"` — there is exactly ONE today, and it is not a hypothetical: `oscOut` sends UDP
 * to whatever a document names, which is a lighting desk as often as it is a synth.
 *
 * A node is `"none"` when the only thing it changes is the picture. That covers every
 * generator, filter, composite, point and scene node here, and it also covers the LIVE
 * INPUTS — `webcam`, `audioIn`, `midiIn`, `oscIn`, `mouse` — which read the world and do
 * not touch it. Reading is the other axis's problem: those five are `external-live` in
 * `NODE_REPRODUCIBILITY`, and the fact that this table and that one disagree about them
 * is the clearest evidence the two axes are not the same axis.
 */
export const NODE_SIDE_EFFECTS: Readonly<Record<string, SideEffect>> = {
  /*
   * EMITS — the node's purpose is to reach something outside this process.
   *
   * The whole of the list, and the entry every future one is written against.
   */
  /*
   * T942 tier 3. `oscOut` transmits UDP to a host and port the document names, and the
   * receiver is a lighting desk, a synth or another machine's patch. It is `pure` in
   * `NODE_REPRODUCIBILITY` and that is CORRECT — it publishes its input bag unchanged, so
   * the render reproduces whether or not anything is listening — and it is the exact case
   * T949 was raised for: the reproducibility answer says nothing about the datagram.
   *
   * The send lives in `use-osc-bridge.ts`, never in the node, and that hook now consults
   * `emissionRefusal` per node per frame.
   */
  oscOut: "emits",
  /*
   * T950. `laserOut`'s PURPOSE is to reach a DAC that emits light — the node this axis
   * was created for (§T949's row names it). It is `pure` under NODE_REPRODUCIBILITY and
   * that is CORRECT (no output, no passes; the picture is identical with or without
   * it), which is precisely why that axis could never carry this answer. The pump is
   * `src/app/use-laser-bridge.ts` (registered in EMISSION_PUMPS, §T1005's gates), it
   * consults `emissionRefusal` per node, and in this build it constructs NO TRANSPORT
   * AT ALL — the Ether Dream helper driver has not landed, so today the mechanism on
   * every path is the absence of any sender, and the protocol that will carry it is
   * already emulator-gated (`src/mcp/ether-dream.ts`) with G3/G4/G9 enforced at the
   * only functions that produce point bytes.
   */
  laserOut: "emits",

  /*
   * NONE — everything else, grouped as `NODE_REPRODUCIBILITY` groups it so the two tables
   * can be read side by side.
   */
  // Generators: pixels from parameters.
  solid: "none",
  noise: "none",
  ramp: "none",
  uv: "none",
  checker: "none",
  circle: "none",
  rectangle: "none",
  text: "none",
  customWgsl: "none",
  // Geometry, colour, filters, composites.
  transform: "none",
  flip: "none",
  mirror: "none",
  crop: "none",
  tile: "none",
  level: "none",
  hsv: "none",
  threshold: "none",
  limit: "none",
  lookup: "none",
  reorder: "none",
  premultiply: "none",
  blur: "none",
  edge: "none",
  convolve: "none",
  displace: "none",
  remap: "none",
  slope: "none",
  composite: "none",
  cross: "none",
  over: "none",
  add: "none",
  multiply: "none",
  screen: "none",
  difference: "none",
  mask: "none",
  // Temporal.
  feedback: "none",
  cache: "none",
  slitScan: "none",
  // Points and their kernels.
  pointKernel: "none",
  pointKernelAdvanced: "none",
  pointRay: "none",
  textureToAttribute: "none",
  renderPoints: "none",
  pointGenerator: "none",
  pointsFromTexture: "none",
  pointGrid: "none",
  pointLine: "none",
  pointCircle: "none",
  pointSphere: "none",
  pointTube: "none",
  pointTorus: "none",
  renderInstances: "none",
  renderSurface: "none",
  pointTopology: "none",
  pointProximity: "none",
  pointRange: "none",
  /*
   * T947. THE PLANNER, NOT THE TRANSPORT — and this row is the first real exercise of the
   * split T949 exists to make, so it is argued rather than filled in.
   *
   * `laserPath` takes a pointset and emits a pointset: it inserts galvo dwell and carries
   * dwell out as a per-point attribute the renderer divides by segment length. Everything
   * it does is inside this process and lands in a texture. A HEADLESS EXPORT MAY RUN IT
   * FREELY, and it must — the example gates render it and assert its pixels.
   *
   * The node that will not be `"none"` is its sibling `laserOut`: same family, same
   * document, and the only one of the two that reaches a DAC. Reading the pair together is
   * the point — "it is about lasers" is not the question this table asks.
   */
  laserPath: "none",
  // Scene.
  camera: "none",
  projector: "none",
  light: "none",
  geometry: "none",
  render: "none",
  materialUnlit: "none",
  materialPhong: "none",
  materialPbr: "none",
  materialGlass: "none",
  // Structure.
  output: "none",
  null: "none",
  switch: "none",
  componentIn: "none",
  componentOut: "none",
  componentInPoints: "none",
  componentOutPoints: "none",
  componentInValue: "none",
  componentOutValue: "none",
  // Value nodes: numbers into the graph, nothing out of the process.
  lfo: "none",
  constant: "none",
  timer: "none",
  valueMath: "none",
  valueLimit: "none",
  valueSlope: "none",
  valueTrigger: "none",
  valueLag: "none",
  valueFilter: "none",
  valueSwitch: "none",
  valueStep: "none",
  audioPattern: "none",
  channelIn: "none",
  /*
   * READING IS NOT ACTING, and these are why the two axes had to be separate records.
   *
   * All five are `external-live` under `NODE_REPRODUCIBILITY` — the strongest answer that
   * axis has — and all five are `"none"` here, because a take over them is unrepeatable
   * and yet nothing in the world moves when one runs. `analyze` is the mirror image
   * (`async-cached` there, inert here), and `oscOut` is the mirror of all of them: the
   * most benign answer on that axis and the only `"emits"` on this one.
   */
  webcam: "none",
  audioIn: "none",
  mouse: "none",
  midiIn: "none",
  oscIn: "none",
  analyze: "none",
  // Media files and model nodes: a decode and a worker round trip, both inside the page.
  movieFileIn: "none",
  audioFileIn: "none",
  depth: "none",
  pose: "none",
  matte: "none",
};
