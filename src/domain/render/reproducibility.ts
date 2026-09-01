import type { GraphDocument } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { freeRunMediaNodes } from "../media/transport.ts";

/**
 * §V329 AS A PROPERTY OVER THE WHOLE CATALOGUE (T645), not as a note about one node.
 *
 * §V329 has been on the record since the ML program was first sketched — "an async result
 * in a per-frame graph must expose its staleness, and an offline/seek render must not
 * depend on wall-clock arrival; same project, two renders, two outputs is not acceptable,
 * so block, or declare non-reproducible loudly." It had ZERO implementation sites: a grep
 * found it in two comments and in nothing that runs. Meanwhile two nodes that already ship
 * violate it, and one of them (Webcam) fell outside T586's render warning entirely, so a
 * take over a live camera produced a different file every time and said nothing at all
 * (T644).
 *
 * This file is the missing mechanism, and it is deliberately a PROPERTY rather than a
 * patch at the two known sites — §V437's whole lesson, learned three times over `absTime`:
 * a requirement delivered site-by-site is not delivered. So the map below is exhaustive
 * over the registry and the gate beside it fails when node #86 lands without a decision.
 *
 * ## Why this is not a second warning surface
 *
 * T586 already emits `export.freeRunMedia` at render time, and its precedent was decided
 * deliberately: the take PROCEEDS rather than being refused, because refusing would hand
 * the user back a different take from the one they approved on screen. Adding a second,
 * parallel "this graph is not reproducible" diagnostic would give a user two answers to
 * one question (§V109). So `nonReproducibleRenderWarning` below SUBSUMES T586's: the
 * free-run clause is word for word what T586 shipped, and the two new clauses join it in
 * the same sentence, under one code, from one call site.
 *
 * ## Why a node's CLASS and a node's PARAMETERS are both consulted
 *
 * They answer different questions and neither one covers the other. `movieFileIn` is
 * `pure` as a TYPE — locked to the timeline, its playhead is `f(frame)` and a take
 * reproduces exactly — and non-reproducible only when its `playMode` says so, which is a
 * document fact T586 already reads through `resolveParameters` (§V61/§V107). `webcam` is
 * non-reproducible as a TYPE: there is no parameter that makes a live camera replay. One
 * table cannot say both, and the version that tried would either exempt free-run movies
 * or condemn locked ones.
 */
export type Reproducibility =
  /**
   * A pure function of `FrameEvaluationInput` and the document. The same project, seed and
   * range render the same file twice — which is what `render-range.ts` already promises in
   * its header, and this is the enumeration that makes the promise checkable.
   */
  | "pure"
  /**
   * Reads a live external device. What it captures depends on WHEN the take runs, and no
   * parameter changes that — the only route to reproducibility is recording the device to
   * a file first and playing that back, which is what the suggestion says (§V403).
   */
  | "external-live"
  /**
   * Publishes the latest result of an asynchronous round trip, so its value depends on
   * when that result arrived rather than on the frame being rendered. §V329's first half
   * applies here and nowhere else: this is the class whose STALENESS must be visible.
   */
  | "async-cached";

/**
 * §V329's classification, DERIVED-AGAINST rather than hand-checked (§V437, and exactly the
 * shape `CLOCK_OWNERSHIP` proved in `loop-continuity.test.ts`).
 *
 * The gate in `reproducibility.test.ts` asks the REGISTRY for every node it can
 * instantiate and fails when one is missing here. So node #86 cannot land without its
 * author answering "does a take over this reproduce?" — which is the whole of B98, whose
 * LFO was put on the wrong clock by nobody deciding anything.
 *
 * MOST OF THE CATALOGUE IS PURE, and the exercise is finding the ones that are not. The
 * list below is the authority and deliberately carries no count in prose — it said "four"
 * while holding five for the whole of T654's life. Two of the originals were news:
 * `audioIn` and `mouse` are live devices in exactly the sense `webcam` is, and neither was
 * named anywhere as a reproducibility hazard.
 */
export const NODE_REPRODUCIBILITY: Readonly<Record<string, Reproducibility>> = {
  /*
   * EXTERNAL-LIVE — a live device, sampled at whatever moment the frame happened to run.
   *
   * A take steps frames as fast as they encode (T586's own sentence), so the device is
   * sampled at a rate that has nothing to do with the timeline. Two takes of the same
   * project see two different sets of samples. There is no parameter that fixes it.
   */
  // T644's shipping bug. `webcam` declares no transport parameters, so `hasMediaTransport`
  // is false, so `freeRunMediaNodes` never saw it and T586's warning returned null for a
  // document whose whole content was a live camera.
  webcam: "external-live",
  // FOUND BY THIS EXERCISE, not by the brief. The session's microphone, read through
  // `valueEvaluate({ audio })`. §V353 makes the ABSENCE of a track deterministic — no
  // track replays all-zeros, the same silence every run — but a live mic during a take is
  // the webcam problem with a different sensor, and nothing said so anywhere. Note this is
  // NOT `audioFileIn`: a bound file under the lock is `f(frame)` and reproduces.
  audioIn: "external-live",
  // FOUND BY THIS EXERCISE. The pointer is a live device too, and the least obvious one
  // because it has no permission prompt and no hardware to think about. `valueEvaluate`
  // reads wherever the cursor is at that instant; during a take it is wherever the user
  // left it, or wherever they moved it while the take ran.
  mouse: "external-live",

  /*
   * ASYNC-CACHED — a result that arrives on its own schedule, published latest-wins.
   *
   * §V144 decided Analyze's latency contract deliberately and correctly: the value visible
   * while frame N renders is the reduction of the last COMPLETED frame, because a stall in
   * the frame loop would be worse (§V184). What was never delivered is §V329's other half
   * — that the AGE be visible. Under load, or with a plan mid-swap, or with the device
   * recovering, "one frame late" quietly becomes "some number of frames late" and a driven
   * parameter shows a plausible, wrong number (§V147's family). `AnalyzeChannels` now
   * carries the age and the node info popup shows it.
   */
  analyze: "async-cached",
  // T654. `channelIn` reads whatever the composition PUBLISHES under a name — and its
  // canonical diet is an Analyze measurement, which arrives on the readback's own
  // schedule, one frame late by contract (§V144). The node itself is a pure lookup,
  // but what it looks up is async-cached, and a classification must answer for the
  // value a take actually renders, not for the machinery: a channelIn over analyze is
  // stale-by-frames, and a channelIn over a pure LFO channel should be WIRED instead
  // (its own docblock says external channels only). So: the cautious class, with
  // staleness visible, same as the thing it exists to read.
  channelIn: "async-cached",
  // T385/T715. Inference arrives LATE and at its own rate, and unlike Analyze its latency
  // is unbounded: a model slower than a frame is normal, not a fault. Live playback shows
  // the most recent result and reports its age; an offline render BLOCKS per frame
  // (§V586's `mode !== "realtime"`), so a take reproduces run to run on one machine. It
  // does NOT reproduce across MACHINES — different execution providers give different
  // numbers for the same input — which is why the gates replay a recorded result instead
  // of running a model, and why this is the cautious class rather than `pure`.
  depth: "async-cached",
  // T743. Same class and the same reason as depth: a result on the model's schedule, not
  // the frame's. Its unbounded latency is if anything more visible — a stale skeleton
  // lags a moving body, where a stale depth map merely lags a moving scene.
  pose: "async-cached",

  /*
   * PURE — a function of the frame and the document, and the reason the other four are
   * worth naming. Grouped as the catalogue groups them.
   */
  // Generators: pixels from parameters.
  solid: "pure",
  noise: "pure",
  ramp: "pure",
  uv: "pure",
  checker: "pure",
  circle: "pure",
  rectangle: "pure",
  // `text` rasterizes through the browser's font stack, which is a MACHINE fact rather
  // than a wall-clock one: the same machine renders the same glyphs every time, and a
  // different machine is a different question from the one §V329 asks (§V47 is about the
  // same graph and the same compiler, not about font portability).
  text: "pure",
  customWgsl: "pure",
  // Geometry, colour, filters, composites: all sampled functions of their inputs.
  transform: "pure",
  flip: "pure",
  mirror: "pure",
  crop: "pure",
  tile: "pure",
  level: "pure",
  hsv: "pure",
  threshold: "pure",
  limit: "pure",
  lookup: "pure",
  reorder: "pure",
  premultiply: "pure",
  blur: "pure",
  edge: "pure",
  convolve: "pure",
  displace: "pure",
  remap: "pure",
  slope: "pure",
  composite: "pure",
  cross: "pure",
  over: "pure",
  add: "pure",
  multiply: "pure",
  screen: "pure",
  difference: "pure",
  mask: "pure",
  // Temporal: history, not wall clock. A take seeks to the in point, which REPLAYS and
  // clears temporal state (§V170), so the take starts from the state that belongs to that
  // frame rather than from whatever was on screen.
  feedback: "pure",
  cache: "pure",
  slitScan: "pure",
  // Points and their kernels: GPU compute with a seeded RNG (§V45).
  pointKernel: "pure",
  pointKernelAdvanced: "pure",
  pointRay: "pure",
  textureToAttribute: "pure",
  renderPoints: "pure",
  pointGenerator: "pure",
  // T743. PURE despite its usual diet being a Depth output. The distinction from
  // `channelIn` is the PORT: an input edge makes the dependency explicit and the upstream
  // node carries its own class, exactly as `blur` and `displace` do when fed by Depth.
  // `channelIn` reads a PUBLISHED CHANNEL with no port to trace, which is why it had to
  // wear its source's class. Classify by what the node itself does with what it is handed.
  pointsFromTexture: "pure",
  pointGrid: "pure",
  pointLine: "pure",
  pointCircle: "pure",
  pointSphere: "pure",
  pointTube: "pure",
  pointTorus: "pure",
  renderInstances: "pure",
  renderSurface: "pure",
  pointTopology: "pure",
  // Scene: a 3D pass is as deterministic as a 2D one.
  camera: "pure",
  // T704: a projector is geometry + a texture reference — a pure function of the
  // document and its cookie input, like the camera it shares a pose with.
  projector: "pure",
  light: "pure",
  geometry: "pure",
  render: "pure",
  materialUnlit: "pure",
  materialPhong: "pure",
  materialPbr: "pure",
  materialGlass: "pure",
  // Structure: no state, no clock, no device.
  output: "pure",
  null: "pure",
  switch: "pure",
  componentIn: "pure",
  componentOut: "pure",
  componentInPoints: "pure",
  componentOutPoints: "pure",
  // Value nodes: every one of them reads `FrameEvaluationInput` or its own inputs and
  // nothing else (§V44, and `CLOCK_OWNERSHIP` is the table that pins WHICH clock).
  lfo: "pure",
  constant: "pure",
  timer: "pure",
  valueMath: "pure",
  valueLimit: "pure",
  valueSlope: "pure",
  valueTrigger: "pure",
  valueLag: "pure",
  valueFilter: "pure",
  valueSwitch: "pure",
  valueStep: "pure",
  audioPattern: "pure",
  // MEDIA FILES ARE PURE AS TYPES, and this is the split the module note argues for. A
  // bound file locked to the timeline is `f(frame)`; free run is a PARAMETER fact and
  // `freeRunMediaNodes` reads it per document, per node, through `resolveParameters`.
  // Classifying them `external-live` here would condemn the locked case, which is the one
  // configuration in the whole catalogue that was built specifically to reproduce.
  movieFileIn: "pure",
  audioFileIn: "pure",
};

/** Why one node in the document will not reproduce. */
export type NonReproducibleCause = "external-live" | "async-cached" | "free-run-media";

/** One node a take cannot promise to reproduce, and enough to name it to the user. */
export interface NonReproducibleNode {
  readonly nodeId: NodeId;
  /** The node's label if it has one, else its id — whatever the user sees in the graph. */
  readonly label: string;
  /** "Webcam" / "Analyze" — the definition's title, not the type key. */
  readonly title: string;
  readonly cause: NonReproducibleCause;
}

/**
 * Every node in the document a take cannot promise to reproduce, in document order.
 *
 * The union of the two derivations, and both halves are needed (see the module note): the
 * TYPE classification above, and T586's per-document `playMode` read. Nothing here is a
 * hand list — a node is covered because the registry knows it exists, or because it
 * declares the media transport, so there is no third place to remember to update.
 */
export function nonReproducibleNodes(
  graph: GraphDocument,
  registry: NodeRegistryView,
): readonly NonReproducibleNode[] {
  const found: NonReproducibleNode[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const definition = registry.get(node.type);
    if (definition === undefined) continue;
    const classification = NODE_REPRODUCIBILITY[definition.type];
    if (classification === undefined || classification === "pure") continue;
    found.push({
      nodeId: nodeId as NodeId,
      label: node.label !== undefined && node.label !== "" ? node.label : nodeId,
      title: definition.title,
      cause: classification,
    });
  }
  for (const media of freeRunMediaNodes(graph, registry)) {
    found.push({ ...media, cause: "free-run-media" });
  }
  return found;
}

function named(nodes: readonly NonReproducibleNode[]): string {
  return nodes.map((node) => `${node.title} "${node.label}"`).join(", ");
}

/**
 * T586's SENTENCE, extended to cover the class it could not see (T645, §V329, §V338).
 *
 * One clause per CAUSE rather than one sentence per node: a project with three free-run
 * tracks should read as one statement about free run, not as three. And every offending
 * node is named in the clause that applies to it, because "one media node is free-running"
 * is the useless half of the warning and "your project is not reproducible" is worse.
 *
 * WARNING, not error, and deliberately — T586's ruling, unchanged: the take is fine, it is
 * simply not reproducible, which was the user's own choice in two of the three cases and
 * unavoidable in the third. Returning `null` for a clean document is what lets the caller
 * assert BOTH directions, which §V461 requires and §V537 explains the cost of skipping: a
 * warning that fires on every project is a warning nobody reads.
 */
export function nonReproducibleRenderWarning(
  graph: GraphDocument,
  registry: NodeRegistryView,
): RuntimeDiagnostic | null {
  const nodes = nonReproducibleNodes(graph, registry);
  const first = nodes[0];
  if (first === undefined) return null;

  const freeRun = nodes.filter((node) => node.cause === "free-run-media");
  const live = nodes.filter((node) => node.cause === "external-live");
  const async_ = nodes.filter((node) => node.cause === "async-cached");

  const clauses: string[] = [];
  const fixes: string[] = [];

  if (freeRun.length > 0) {
    const one = freeRun.length === 1;
    clauses.push(
      `${named(freeRun)} ${one ? "is" : "are"} on Free Run, so ${one ? "its playhead does" : "their playheads do"} ` +
        `not derive from the frame. A take is rendered as fast as the frames encode rather than in ` +
        `real time, so the media in this file will not line up with what you saw and heard live.`,
    );
    fixes.push(
      `Set Play Mode to "Locked to Timeline" on ${named(freeRun)} and render again — the position then ` +
        `derives from the frame, so the take reproduces exactly. Leave Free Run on if the live ` +
        `performance is what you wanted and this render is a rough.`,
    );
  }
  if (live.length > 0) {
    const one = live.length === 1;
    clauses.push(
      `${named(live)} ${one ? "reads a live device" : "read live devices"}, so what ` +
        `${one ? "it captures depends" : "they capture depends"} on when the take runs rather than on ` +
        `the frame. Rendering the same range twice gives two different files.`,
    );
    // §V403: name the ROUTE, not just the absence. There is no parameter that makes a
    // live device replay, so the honest fix is to record it once and play the recording.
    fixes.push(
      `A live device cannot replay, so ${named(live)} has no setting that fixes this. Record the ` +
        `input to a file and play that back through Movie File In or Audio File In on ` +
        `"Locked to Timeline" if the take needs to reproduce.`,
    );
  }
  if (async_.length > 0) {
    const one = async_.length === 1;
    clauses.push(
      `${named(async_)} ${one ? "publishes its" : "publish their"} latest completed readback, so ` +
        `${one ? "its value" : "their values"} depend on when a result arrived rather than on the frame ` +
        `being rendered.`,
    );
    // Honest about there being no fix today rather than inventing one (§V403's other half:
    // an absence we report must name what would make it present).
    fixes.push(
      `${named(async_)} cannot be made reproducible from the document today — the offline path that ` +
        `would wait for each readback is not built. Check the result age in the node info popup to ` +
        `see how far behind the value actually is.`,
    );
  }

  return {
    severity: "warning",
    code: "export.nonReproducible",
    message: clauses.join(" "),
    // The pane can point at one node; the message names every one of them.
    nodeId: first.nodeId,
    // §V338/§V403: the caveat names what would make it go away, per cause, per node.
    suggestion: fixes.join(" "),
  };
}
