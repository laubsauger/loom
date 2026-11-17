import { synthesizeSourceReferenceEdges } from "@compiler/source-reference-edges.ts";
import { bypassPassthroughPairs } from "@domain/graph/bypass.ts";
import { parameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import type { ResolvedParameters } from "@domain/parameters/resolve.ts";
import type { LiveParameterReads } from "@domain/parameters/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { FlatOrAuthoredGraph, GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { applyHomography, cornerPinNode, cornerPinQuads, invertMat3, outputToSquare, quadDegeneracy, squareToQuad } from "@nodes/definitions/corner-pin.ts";
import type { Mat3 } from "@nodes/definitions/corner-pin.ts";
import { gridWarpNode } from "@nodes/definitions/grid-warp.ts";
import { fitInsideRegion } from "@editor/nodes/preview-fit.ts";

/**
 * §T1536b — WHICH MAPPING NODE A PERFORM WINDOW CAN EDIT, AND WHERE ITS HANDLES LAND THERE.
 *
 * Mapping is done looking at the projector, so a Window Out's "edit mapping" mode draws the
 * handles of the Corner Pin / Grid Warp upstream of it ON the perform window. A handle's
 * value lives in the mapping node's OWN picture (normalised, y up — the T935/§T1491b picture
 * handle), and the window shows that picture after everything downstream of the node. This
 * module answers the two questions that decides, purely, so a test can call them:
 *
 *  1. `mappingTargetsOf` — the mapping nodes on the window's input chain, nearest first, each
 *     with `null` when its picture reaches the window exactly mappable, or the named reason it
 *     does not; and the Corner Pins its picture goes through on the way (§T1538b).
 *  2. `pictureLensFor` — those Corner Pins as exact maps of the picture (`LensStep`s), or the
 *     named refusal of a degenerate one.
 *  3. `windowPicture` — the exact map between the mapping node's picture and the window's CSS
 *     pixels: through the lens, then the Window Out's Fit (the shader's `placed`, restated),
 *     then the canvas's `object-fit: contain` of the W×H target into the window.
 *
 * The viewer pane asks the same questions (§T1536b, viewer slice): `mappingTargetsAt` walks
 * from the node the viewer shows (itself first), and `viewerPicture` is its frame — the lens,
 * then the viewer's own contain-fit, with no Fit step.
 *
 * ## Exact, or refused — never guessed
 *
 * Between the mapping node and the window only nodes that keep every point of the picture
 * where it was (in normalised coordinates) are crossed: a bypassed node and a declared
 * passthrough (a wire, §T250), and the colour-only nodes in `GEOMETRY_PRESERVING`. Anything
 * else — a Transform, a Crop, a Flip, a Grid Warp, a composite, a node this list has never
 * heard of — REFUSES that target with the blocking node named. The list fails closed on
 * purpose: a node missing from it costs a refusal the operator can read; a node wrongly on it
 * would put a handle where the parameter is not.
 *
 * ## A Corner Pin is crossed exactly (§T1538b)
 *
 * The documented stack is Grid Warp → Corner Pin (the outer perspective), so a Corner Pin is
 * the one warp that does NOT block: it is an invertible homography, and its own CPU solve
 * (`squareToQuad`, `invertMat3`, `outputToSquare` — imported, never restated) gives the map
 * both ways. A point of its input goes extract quad → unit square → pin quad (forward, for
 * drawing); a window point goes back the shader's way, pin quad → unit square → extract quad
 * (inverse, for a drag). Corner Pins chain, so a Corner Pin behind a Corner Pin is edited
 * through the one in front. The quads are read, through the node's own reader, from the
 * parameters RESOLVED as the window shows them (the last rendered frame, channels, morphs).
 *
 * Refused, by name: a Corner Pin whose Pin or Extract quad is degenerate (the node's own
 * `quadDegeneracy` — its `cornerPin.pin/extract.degenerate` warning, on which it renders
 * nothing, so nothing behind it has a place), and a handle whose point lies past a Corner
 * Pin's horizon (the homogeneous w is not positive: the shader shows nothing there in any
 * Outside mode, and the projective division would put the handle on the wrong side).
 * NOT refused: a handle outside the Extract quad. It is drawn where the pinned plane,
 * continued, puts it — clamp-free, so it may sit outside the pin quad or off the window — and
 * drags from there exactly. The Corner Pin does not show that point (Outside continues the
 * Extract quad's own content in every mode, never the input beyond it), but the position is
 * still the true one, and a clamped or hidden handle could not be dragged back in. Hold Edge /
 * Repeat / Mirror copies are not handles: each point is drawn at its one homography position.
 *
 * A resolution change on a crossed node does not matter: the picture is stretched to the new
 * size in normalised coordinates, and Fit reads the size the Window Out actually samples
 * (`inputSize`, off the compiled plan), not the mapping node's.
 *
 * ## Which one, when there are several
 *
 * Every Corner Pin / Grid Warp on the chain is listed (the inspector picks), nearest first;
 * the nearest is the default. One behind Corner Pins only is placed through them (§T1538b);
 * one behind any other warp is listed with that refusal rather than hidden — the operator
 * sees it exists and why it cannot be dragged here. The chain past a non-preserving node is followed through the node's
 * resolution input (the input its picture derives from) only to list what lies beyond; a
 * node with none ends the walk. Nodes inside a component are not reached (the walk reads the
 * document root, where Window Outs live).
 */

export type MappingKind = "cornerPin" | "gridWarp";

export interface MappingTarget {
  readonly nodeId: string;
  /** The node's name (its label), or its id when it has none. */
  readonly name: string;
  readonly kind: MappingKind;
  /** "Corner Pin" / "Grid Warp". */
  readonly title: string;
  /** Null when its handles land exactly on this window; the named reason they cannot, otherwise. */
  readonly refusal: string | null;
  /**
   * §T1538b: the Corner Pins its picture goes through to reach the window, in picture order
   * (the one this node feeds first). Empty when nothing between moves the picture.
   */
  readonly through: readonly CornerPinCrossing[];
}

/** A Corner Pin crossed between a mapping node and the window. */
export interface CornerPinCrossing {
  readonly nodeId: string;
  /** Its label, or its id when it has none. */
  readonly name: string;
}

/**
 * Nodes whose output shows every point of the followed input exactly where it was, keyed to
 * that input. Per-pixel colour operations only; fail closed (see above).
 */
export const GEOMETRY_PRESERVING: Readonly<Record<string, string>> = {
  filmGrade: "input",
  hsv: "input",
  level: "input",
  limit: "input",
  premultiply: "input",
  threshold: "input",
  lookup: "source",
};

const MAPPING_KINDS: Readonly<Record<string, MappingKind>> = {
  [cornerPinNode.type]: "cornerPin",
  [gridWarpNode.type]: "gridWarp",
};

const WINDOW_INPUT = "input";

/** The mapping nodes feeding `windowNodeId`, nearest first. */
export function mappingTargetsOf(graph: GraphDocument, registry: NodeRegistryView, windowNodeId: string): readonly MappingTarget[] {
  return walkMappingTargets(graph, registry, (into) => into(windowNodeId, WINDOW_INPUT), [windowNodeId], "this window");
}

/**
 * §T1536b (viewer) — the mapping nodes whose handles the viewer can draw while it shows
 * `nodeId`'s output, nearest first: `nodeId` itself when it is a Corner Pin / Grid Warp,
 * then the chain behind it, crossed by exactly the window's rules. Upstream of a mapping
 * node, or unrelated to one, the list is empty.
 */
export function mappingTargetsAt(graph: GraphDocument, registry: NodeRegistryView, nodeId: string): readonly MappingTarget[] {
  return walkMappingTargets(graph, registry, () => nodeId, [], "the viewer");
}

/** The walk both surfaces share; `where` names the surface in a refusal ("this window", "the viewer"). */
function walkMappingTargets(
  graph: GraphDocument,
  registry: NodeRegistryView,
  start: (into: (nodeId: string, portId: string) => string | undefined) => string | undefined,
  skip: readonly string[],
  where: string,
): readonly MappingTarget[] {
  // By-name sources become the edges the compile would synthesize (B233's wire-or-name rule).
  const wired = synthesizeSourceReferenceEdges(graph, registry).graph;
  const edges = Object.values(wired.edges);
  /**
   * T1779b: the OUTPUT the walk came in by, beside the node — a bypassed node passes each
   * output its own input (§V1035), so which input to follow depends on the port read.
   * Undefined where the walk starts ON a node (the viewer): its first output.
   */
  let enteredBy: string | undefined;
  const into = (nodeId: string, portId: string): string | undefined => {
    const source = edges.find((edge) => edge.target.nodeId === nodeId && edge.target.portId === portId)?.source;
    enteredBy = source?.portId;
    return source?.nodeId;
  };

  const targets: MappingTarget[] = [];
  /** §T1538b: the Corner Pins crossed so far with nothing blocking, nearest the window first. */
  const lens: CornerPinCrossing[] = [];
  /** The first node on the way that moves the picture, as "<Title> "<name>" <what it does>". */
  let blocker: string | null = null;
  const refusal = (title: string, name: string): string | null =>
    blocker === null ? null : `${blocker} between ${title} "${name}" and ${where}, so its handles cannot be placed exactly here.`;

  const seen = new Set<string>(skip);
  let current = start(into);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const node = wired.nodes[current];
    const definition = node === undefined ? undefined : registry.get(node.type);
    if (node === undefined || definition === undefined) break;
    const name = node.label ?? current;
    const named = `${definition.title} "${name}"`;
    /** Past a node that blocks, the walk goes on through its resolution input only to LIST what lies beyond. */
    const listOn = (): string | undefined => {
      const policy = definition.resolutionPolicy;
      return policy?.kind === "inherit" ? policy.input : undefined;
    };
    // §T250, §V1035: a bypassed node is a wire, from the output read to the input paired with it.
    const readOutput = enteredBy ?? definition.outputs[0]?.id;
    const bypass = node.ui?.bypassed === true && readOutput !== undefined ? bypassPassthroughPairs(definition).get(readOutput) : undefined;
    let follow: string | undefined;
    if (node.ui?.muted === true || (node.ui?.bypassed === true && bypass === undefined)) {
      blocker ??= `${named} is muted`;
      follow = listOn();
    } else if (bypass !== undefined) {
      follow = bypass;
    } else if (definition.passthrough !== undefined) {
      follow = definition.passthrough.input;
    } else if (MAPPING_KINDS[node.type] !== undefined) {
      const kind = MAPPING_KINDS[node.type] as MappingKind;
      const through = blocker === null ? [...lens].reverse() : [];
      targets.push({ nodeId: current, name, kind, title: definition.title, refusal: refusal(definition.title, name), through });
      // §T1538b: a Corner Pin is an exact, invertible map — crossed, never a blocker.
      if (kind === "cornerPin") {
        if (blocker === null) lens.push({ nodeId: current, name });
      } else blocker ??= `${named} warps the picture again`;
      follow = "input";
    } else if (GEOMETRY_PRESERVING[node.type] !== undefined) {
      follow = GEOMETRY_PRESERVING[node.type];
    } else {
      blocker ??= `${named} moves the picture`;
      follow = listOn();
    }
    current = follow === undefined ? undefined : into(current, follow);
  }
  return targets;
}

/**
 * T1525b's live reads, as a perform window and the viewer pane hold them: the live read
 * world (§T1551b: the compile's channel resolver and the runtime's flattening) and the
 * frame the loop last rendered. Getters, read at the moment of a resolve; no frame yet is
 * the zero frame.
 */
export interface LiveReads extends LiveParameterReads {
  readonly frame: () => FrameEvaluationInput | undefined;
}

/**
 * A node's parameters as the one read path resolves them NOW (§V61) — at `at`, or the frame
 * last rendered — with the channels and the morphs: what is on screen. §T1539b: the ONE
 * resolve both the perform window and the viewer place a crossed Corner Pin with, so the two
 * put the same handle at the same picture point (and a Window Out's own Screen, Fullscreen,
 * Hide cursor and Fit are read through it too).
 */
export function liveParameters(
  node: GraphNode,
  graph: FlatOrAuthoredGraph,
  registry: NodeRegistryView,
  reads: LiveReads,
  at?: FrameEvaluationInput,
): ResolvedParameters {
  const options = parameterReadOptions({
    graph,
    registry,
    frame: at ?? reads.frame(),
    channels: reads.channels(),
    flattening: reads.flattening(),
  });
  return resolveParameters(node, registry.get(node.type), options);
}

/** The note a window in edit mode shows when there is nothing to draw. */
export function mappingAbsentNote(): string {
  return "No Corner Pin or Grid Warp feeds this window.";
}

export type WindowFit = "fit" | "fill" | "stretch";
export type Size = readonly [number, number];
export type Point = readonly [number, number];

/** What decides where the mapping node's picture lands in the window. */
export interface WindowPictureFacts {
  /** The Window Out's Fit. */
  readonly fit: WindowFit;
  /** The size of the texture the Window Out samples (its input, as compiled). */
  readonly inputSize: Size;
  /** The Window Out's target, W × H — the canvas bitmap. */
  readonly targetSize: Size;
}

/** `ratio` exactly as `windowOutShader` computes it. */
function fitRatio({ inputSize, targetSize }: WindowPictureFacts): number {
  const inputAspect = inputSize[0] / Math.max(inputSize[1], 1);
  const targetAspect = targetSize[0] / targetSize[1];
  return targetAspect / Math.max(inputAspect, 1e-6);
}

/**
 * The Window Out shader's `placed`, restated: a point of its target (normalised) → the point
 * of its input sampled there. Symmetric about the centre on each axis, so it holds for y up
 * as for y down.
 */
export function fitPlaced(facts: WindowPictureFacts, [x, y]: Point): Point {
  const ratio = fitRatio(facts);
  if (facts.fit === "fit") return ratio < 1 ? [x, (y - 0.5) / ratio + 0.5] : [(x - 0.5) * ratio + 0.5, y];
  if (facts.fit === "fill") return ratio < 1 ? [(x - 0.5) * ratio + 0.5, y] : [x, (y - 0.5) / ratio + 0.5];
  return [x, y];
}

/** The inverse of `fitPlaced`: a point of the input picture → where the target shows it. */
export function fitShown(facts: WindowPictureFacts, [u, v]: Point): Point {
  const ratio = fitRatio(facts);
  if (facts.fit === "fit") return ratio < 1 ? [u, (v - 0.5) * ratio + 0.5] : [(u - 0.5) / ratio + 0.5, v];
  if (facts.fit === "fill") return ratio < 1 ? [(u - 0.5) / ratio + 0.5, v] : [u, (v - 0.5) * ratio + 0.5];
  return [u, v];
}

/**
 * §T1538b — one Corner Pin as a map of the picture (normalised, y up). Null where the point
 * lies past the pinned plane's horizon in that direction: it has no place.
 */
export interface LensStep {
  /** `Corner Pin "<name>"`, for a refusal. */
  readonly named: string;
  /** A point of its input → where its output shows it (extract quad → pin quad). */
  forward(point: Point): Point | null;
  /** A point of its output → the point of its input shown there (the shader's way). */
  inverse(point: Point): Point | null;
}

/** The Corner Pins crossed, in picture order; empty is the identity. */
export type PictureLens = readonly LensStep[];

/** `m` applied with the projective division, or null when the homogeneous w is not positive. */
function projected(m: Mat3, point: Point): Point | null {
  return m[6] * point[0] + m[7] * point[1] + m[8] > 0 ? applyHomography(m, point) : null;
}

/**
 * The Corner Pins `target` reaches the window through, as exact maps built from their
 * RESOLVED values (`valuesOf`: the values the compile reads); or the named refusal when one's
 * quad is degenerate — the node's own `quadDegeneracy`, the condition its pass renders
 * nothing on.
 */
export function pictureLensFor(
  target: MappingTarget,
  valuesOf: (nodeId: string) => Readonly<Record<string, ParameterValue>> | undefined,
  where = "this window",
): PictureLens | string {
  const steps: LensStep[] = [];
  for (const crossing of target.through) {
    const named = `Corner Pin "${crossing.name}"`;
    const nowhere = `It shows nothing, so ${target.title} "${target.name}"'s handles have no place on ${where}.`;
    const values = valuesOf(crossing.nodeId);
    if (values === undefined) return `${named} is not in the document. ${nowhere}`;
    const { pins, extract } = cornerPinQuads(values);
    for (const [quad, which] of [
      [pins, "Pin"],
      [extract, "Extract"],
    ] as const) {
      const reason = quadDegeneracy(quad);
      if (reason !== null) return `${named}'s ${which} quad cannot be pinned: ${reason}. ${nowhere}`;
    }
    const toPins = squareToQuad(pins);
    const toInput = squareToQuad(extract);
    const fromInput = invertMat3(toInput);
    const fromOutput = outputToSquare(pins);
    if (fromInput === null || fromOutput === null) return `${named}'s quads have no inverse. ${nowhere}`;
    steps.push({
      named,
      forward(point) {
        const square = projected(fromInput, point);
        return square === null ? null : projected(toPins, square);
      },
      inverse(point) {
        const square = projected(fromOutput, point);
        return square === null ? null : projected(toInput, square);
      },
    });
  }
  return steps;
}

/** The Corner Pin past whose horizon `point` lies, going forward through `lens`; null when none. */
export function lensHorizon(lens: PictureLens, point: Point): string | null {
  let at: Point | null = point;
  for (const step of lens) {
    at = step.forward(at);
    if (at === null) return step.named;
  }
  return null;
}

export interface WindowPicture {
  /** A point of the mapping node's picture (normalised, y up) → window CSS pixels; null past a Corner Pin's horizon. */
  toWindow(point: Point): Point | null;
  /** Window CSS pixels → the mapping node's picture; null where a Corner Pin shows no surface. */
  fromWindow(point: Point): Point | null;
}

/**
 * The whole map for a window of `windowSize` CSS pixels: through the Corner Pins crossed
 * (§T1538b), Fit into the target, then the canvas's `object-fit: contain`
 * (`perform-window.ts`), which is `fitInsideRegion`'s letterbox (§V118) — the bitmap is the
 * target's size (`sizing: "source"`).
 */
export function windowPicture(facts: WindowPictureFacts, windowSize: Size, lens: PictureLens = []): WindowPicture {
  const rect = fitInsideRegion({ width: windowSize[0], height: windowSize[1] }, facts.targetSize);
  return framedPicture(lens, rect, (point) => fitShown(facts, point), (point) => fitPlaced(facts, point));
}

/**
 * §T1536b (viewer) — the map for the viewer pane: through the Corner Pins crossed, then
 * straight into the picture box, which is `fitInsideRegion`'s letterbox of the shown output
 * (`pictureSize`) in the viewer's frame (`frameSize`, CSS pixels) — the identical call
 * `side-panes.tsx` sizes `.picture` with (T1158), whose canvas fills that box exactly. No Fit
 * step: the viewer shows the output whole.
 */
export function viewerPicture(pictureSize: Size, frameSize: Size, lens: PictureLens = []): WindowPicture {
  const rect = fitInsideRegion({ width: frameSize[0], height: frameSize[1] }, pictureSize);
  const same = (point: Point): Point => point;
  return framedPicture(lens, rect, same, same);
}

/** Through `lens`, then `shown` into the unit target, then into `rect` (CSS pixels, y down); and back. */
function framedPicture(
  lens: PictureLens,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  shown: (point: Point) => Point,
  placed: (point: Point) => Point,
): WindowPicture {
  return {
    toWindow(point) {
      let at: Point | null = point;
      for (const step of lens) if (at !== null) at = step.forward(at);
      if (at === null) return null;
      const [x, y] = shown(at);
      return [rect.x + x * rect.width, rect.y + (1 - y) * rect.height];
    },
    fromWindow([px, py]) {
      let at: Point | null = placed([(px - rect.x) / rect.width, 1 - (py - rect.y) / rect.height]);
      for (let index = lens.length - 1; index >= 0 && at !== null; index -= 1) at = (lens[index] as LensStep).inverse(at);
      return at;
    },
  };
}
