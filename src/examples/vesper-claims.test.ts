import { describe, expect, it } from "vitest";

import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { mediaPlayhead, mediaTransportFrom } from "../domain/media/transport.ts";
import { createParameterReadOptions, resolveParameters } from "../domain/parameters/index.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * ⚑ E56 VESPER'S ONE CLAIM: THE AUDIO MOVES THE PICTURE — and here that means it moves the
 * PLAYHEAD, because on this file the playhead IS the picture (T1155, T1152, T1149).
 *
 * ## Why the claim lands here and not on Dawn
 *
 * `cuePoint` is a TRANSPORT parameter. The compiler never reads it — `compileMedia` reads
 * zero parameters and declares one external texture — so nothing about which video frame is
 * showing exists anywhere in the render plan. The path that decides it is
 *
 *   value graph → `resolveParameters` → `mediaTransportFrom` → `mediaPlayhead` → `<video>`
 *
 * and every link but the last is pure, headless, and exercised below on THE SHIPPED BYTES.
 * A Dawn gate over this document renders `registerSyntheticMediaSources`' test card at
 * whatever the harness feels like, which would be green with the drive severed — the exact
 * §V918 shape, an instrument reporting from a path adjacent to the one under test. So the
 * seek itself is measured where it actually happens (real Chrome, `scratchpad/t1155`, and
 * the numbers are in the `.md`), and what is GATED here is the thing a code change can
 * silently break: that the envelope reaches the cue point and sweeps the clip with it.
 *
 * ## What each claim would catch
 *
 *   1. THE LANE SWEEPS. A retuned envelope, a mis-set Range, a channel renamed — anything
 *      that leaves the playhead parked catches here, and §V903 says to state the DUTY and
 *      the LONGEST SILENT RUN rather than the range, because a mean gap hides a hole.
 *   2. §V914 — the retained value lies inside what the drive produces, so the no-audio
 *      state is not a time of day the music never reaches.
 *   3. THE INVERSION. Loud is the START of the clip. Getting this backwards still sweeps,
 *      still passes duty, and shows a sunrise where the file promises a sunset.
 *   4. ⚑ THE LOAD-BEARING ONE, AND IT IS LAST (§V910): CUT THE DRIVE AND THE FRAME STOPS
 *      MOVING. Everything above is a statement about a number this file computes; this is
 *      the one that says the number came from the AUDIO. An assertion placed before it
 *      could return early and leave it unexercised, so nothing follows it.
 */

const registry = createNodeRegistry(allNodeDefinitions);
const view = registry.view();

/** The clip's real length, and the same number `sun1` maps onto. */
const DURATION = 9.7;
/** 291 frames at 30fps. The grid the decoder can actually land on. */
const SOURCE_FRAMES = 291;
const HORIZON = 3600;
/** The follower needs about four bars to settle; before that it sits pinned at daylight. */
const SETTLED = 600;

function vesper(): GraphDocument {
  const file = listExamples().find((entry) => entry.fileName === "E56-Vesper.loom.json");
  if (file === undefined) throw new Error("E56-Vesper.loom.json is not in examples/");
  const { document } = requireExample(file);
  /* Read UNFLATTENED, and guarded rather than assumed: this file has no component
     instances, so flattening is a no-op — but a future edit that added one would make
     every label below resolve against the wrong graph, silently. The guard is what turns
     that into a failure with a name on it. */
  const component = Object.values(document.graph.nodes).find((entry) =>
    entry.type.startsWith("component:"),
  );
  if (component !== undefined) {
    throw new Error(`E56 gained a component instance (${component.type}) — flatten before reading labels`);
  }
  return structuredClone(document.graph) as GraphDocument;
}

function nodeNamed(graph: GraphDocument, label: string): GraphNode {
  const found = Object.values(graph.nodes).find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`no node labelled ${label}`);
  return found;
}

/**
 * The playhead, frame by frame, through the app's own two functions.
 *
 * Deliberately NOT a re-implementation of the mapping: `mediaTransportFrom` and
 * `mediaPlayhead` are the exact pair `use-media-sources` hands to `applyMediaPlayhead`, so
 * a change to how a cue is interpreted reddens this file rather than sliding past it.
 */
function playheads(graph: GraphDocument, frames = HORIZON): number[] {
  const clip = nodeNamed(graph, "clip1");
  const definition = view.get(clip.type);
  const session = createValueGraphSession(registry);
  const out: number[] = [];
  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const frame: FrameEvaluationInput = {
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      frameIndex,
      mode: "offline",
      randomSeed: 56,
    };
    const evaluated = session.evaluate(graph, frame, {});
    /* §V837's ONE factory. `op('sun1').chan.high` is read inside the NODE REFERENCE
       READER, not off `channels` — a resolve handed only `channels` answers every chan
       read with "no resolver", falls back to §V108's retained static, and reports a lane
       that never moves while the app animates. That is §B8's shape and it has recurred
       four times; `createParameterReadOptions` is why it cannot recur here. */
    const resolved = resolveParameters(clip, definition, createParameterReadOptions({
      graph,
      registry: view,
      frame,
      channels: evaluated.resolver,
    }));
    /* `.get(key)?.value`, exactly as `createMediaTransportRunner` reads it. */
    const read = (key: string): ParameterValue | undefined => resolved.get(key)?.value;
    out.push(mediaPlayhead(mediaTransportFrom(read), frameIndex / 60, DURATION).position);
  }
  return out;
}

/** Which of the clip's 291 stored frames a position lands on. */
const sourceFrameAt = (seconds: number): number =>
  Math.min(SOURCE_FRAMES - 1, Math.floor((seconds / DURATION) * SOURCE_FRAMES));

describe("E56 Vesper — the envelope drives the playhead", () => {
  it("holds the element at the cue point rather than playing it", () => {
    /* The mechanism in one assertion: without `cue`, `cuePoint` is inert and everything
       below would be measuring a free-running clock instead of the drive. */
    const clip = nodeNamed(vesper(), "clip1");
    expect(clip.parameters["cue"]).toBe(true);
    expect(clip.type).toBe("movieFileIn");
  });

  it("sweeps the clip, and §V903's duty and longest silent run say by how much", () => {
    const positions = playheads(vesper());
    const settled = positions.slice(SETTLED);
    const pinned = (value: number): boolean => value <= 1e-9 || value >= DURATION - 1e-9;

    const interior = settled.filter((value) => !pinned(value)).length;
    let longest = 0;
    let run = 0;
    for (const value of settled) {
      run = pinned(value) ? run + 1 : 0;
      if (run > longest) longest = run;
    }

    /* Measured, and asserted as floors rather than as the exact figures: these are
       properties of the SHAPE of the lane (93.4% interior, longest pin 38 frames), and a
       floor is what distinguishes "the author retuned the envelope" from "the lane died".
       §V903's own failure — a clamp several draw-widths narrower than its input — reads
       here as an interior fraction collapsing, which is what the floor catches. */
    expect(interior / settled.length).toBeGreaterThan(0.85);
    expect(longest).toBeLessThan(120); // two seconds is the longest hold this picture may sit still for

    /* It reaches BOTH ends of the clip: broad daylight and fully dark are both in the
       piece, which is what "the clamp is the picture" has to mean to be true. */
    expect(Math.min(...positions)).toBeLessThanOrEqual(0);
    expect(Math.max(...positions)).toBeGreaterThanOrEqual(DURATION - 1e-9);

    /* And it visits most of the footage rather than shuttling between two frames. */
    const visited = new Set(positions.map(sourceFrameAt));
    expect(visited.size).toBeGreaterThan(250);
  });

  it("§V914 — the retained cue point is a time of day the drive actually produces", () => {
    const positions = playheads(vesper());
    const retained = nodeNamed(vesper(), "clip1").parameters["cuePoint"] as {
      bindings?: { static?: { value?: number } };
    };
    const stood = retained.bindings?.static?.value;
    expect(typeof stood).toBe("number");

    /* Strictly inside, not merely within the parameter's declared range: a fallback at an
       end would open every no-audio host on a frame the music never chooses. */
    expect(stood!).toBeGreaterThan(Math.min(...positions));
    expect(stood!).toBeLessThan(Math.max(...positions));

    /* And it is the driven MEAN, which is the honest default §V914 names. */
    const mean = positions.reduce((total, value) => total + value, 0) / positions.length;
    expect(stood!).toBeCloseTo(mean, 1);
  });

  it("is INVERTED: loud is the start of the clip, where the sun is still up", () => {
    /* The file's whole promise. A correct-looking sweep with the sign flipped is a sunRISE
       driven by silence, and passes every other assertion here. */
    const graph = vesper();
    const positions = playheads(graph);
    const session = createValueGraphSession(registry);
    const envelope: number[] = [];
    for (let frameIndex = 0; frameIndex < HORIZON; frameIndex += 1) {
      const value = session.evaluate(graph, {
        timeSeconds: frameIndex / 60,
        deltaSeconds: 1 / 60,
        frameIndex,
        mode: "offline",
        randomSeed: 56,
      }, {}).resolver("env1:high", undefined as never);
      envelope.push(typeof value === "number" ? value : Number.NaN);
    }

    /* Compare the loudest tenth of the settled run against the quietest tenth. */
    const settled = envelope.map((level, index) => ({ level, position: positions[index]! })).slice(SETTLED);
    const byLevel = [...settled].sort((a, b) => a.level - b.level);
    const tenth = Math.floor(byLevel.length / 10);
    const quietMean = byLevel.slice(0, tenth).reduce((t, e) => t + e.position, 0) / tenth;
    const loudMean = byLevel.slice(-tenth).reduce((t, e) => t + e.position, 0) / tenth;

    expect(loudMean).toBeLessThan(quietMean);
    /* And by most of the clip, not by a hair — the two ends are actually the two ends. */
    expect(quietMean - loudMean).toBeGreaterThan(DURATION * 0.6);
  });

  /**
   * ⚑ LAST, AND THE ONLY ONE THAT NAMES THE BEHAVIOUR (§V910).
   *
   * Everything above says a number moves. This says the number moves BECAUSE OF THE AUDIO:
   * take the same shipped document, sever the drive at the cue point exactly as §V108
   * severs it — the static binding is what stands when no channel answers — and the
   * playhead becomes one frame, forever. If a future edit made the sweep come from the
   * clock, or from the Range's own defaults, or from anything but the envelope, this is the
   * assertion that reddens and none of the others would.
   */
  it("CUT THE DRIVE AND THE FRAME STOPS MOVING", () => {
    const driven = playheads(vesper());
    expect(new Set(driven.map(sourceFrameAt)).size).toBeGreaterThan(250);

    const cut = vesper();
    const clip = nodeNamed(cut, "clip1");
    const slot = clip.parameters["cuePoint"] as { bindings: { static: { value: number } } };
    /* §V108's own fallback path: drop the expression and the retained static stands. This
       is severance rather than deletion on purpose — a document with no `cuePoint` at all
       would fall to the SCHEMA default (0) and pass a "it stopped moving" check for the
       wrong reason. */
    (clip.parameters as Record<string, ParameterValue>)["cuePoint"] =
      slot.bindings.static.value as ParameterValue;

    const still = playheads(cut);
    expect(new Set(still).size).toBe(1);
    expect(still[0]).toBeCloseTo(slot.bindings.static.value, 6);
    /* Same document, same clock, same 3600 frames: 1 frame against more than 250. */
    expect(new Set(still.map(sourceFrameAt)).size).toBe(1);
  });
});
