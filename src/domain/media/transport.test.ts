import { describe, expect, it } from "vitest";

import {
  MEDIA_TRANSPORT_KEYS,
  MEDIA_TRANSPORT_PARAMETERS,
  createMediaClock,
  freeRunMediaNodes,
  freeRunRenderWarning,
  hasMediaTransport,
  mediaPlayhead,
  mediaTransportFrom,
  type MediaTransportValues,
} from "./transport.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterValue } from "../types/parameters.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { resolveParameters } from "../parameters/index.ts";

/**
 * T493 — the media transport, asserted at EXACT VALUES.
 *
 * §V147's rule applied to arithmetic: a transport test that would still pass with the
 * transport ripped out proves nothing. "Speed changes the position" is satisfied by any
 * function of speed; "speed 2 at t=1 into a 10s file is at 2.0 and speed 1 is at 1.0" is
 * satisfied by one. So every case below names the number, and the cases are chosen where a
 * plausible wrong implementation gives a DIFFERENT number — a negative modulo, a mirror
 * that reflects about the wrong end, a trim window measured from zero instead of the in
 * point.
 */

const BASE: MediaTransportValues = {
  playMode: "timeline",
  play: true,
  speed: 1,
  cue: false,
  cuePoint: 0,
  trimStart: 0,
  trimEnd: 0,
  extend: "loop",
};

const at = (transport: Partial<MediaTransportValues>, elapsed: number, duration = 10) =>
  mediaPlayhead({ ...BASE, ...transport }, elapsed, duration);

describe("T493 — position derives from the clock", () => {
  it("runs at real time when speed is 1", () => {
    expect(at({}, 0).position).toBe(0);
    expect(at({}, 2.5).position).toBe(2.5);
  });

  it("speed 2.0 advances TWICE as far as speed 1.0 over the same elapsed time", () => {
    expect(at({ speed: 1 }, 3).position).toBe(3);
    expect(at({ speed: 2 }, 3).position).toBe(6);
    expect(at({ speed: 0.5 }, 3).position).toBe(1.5);
  });

  it("speed 0 freezes at the in point rather than drifting", () => {
    expect(at({ speed: 0 }, 999).position).toBe(0);
    expect(at({ speed: 0, trimStart: 4 }, 999).position).toBe(4);
  });

  it("a NEGATIVE speed runs backwards and wraps in from the END, not to -1", () => {
    // The positive-modulo case. `-1 % 10` is -1 in JavaScript, so the naive version puts
    // the playhead one second BEFORE the file starts.
    expect(at({ speed: -1 }, 1).position).toBe(9);
    expect(at({ speed: -1 }, 11).position).toBe(9);
  });
});

describe("T493 — trim is an in/out point, and the window is measured from the in point", () => {
  it("trimStart moves the in point, and t=0 lands ON it", () => {
    expect(at({ trimStart: 4 }, 0).position).toBe(4);
    expect(at({ trimStart: 4 }, 1).position).toBe(5);
  });

  it("trimEnd stops at THIS index and loops back to the in point, not to zero", () => {
    // Window is 4→7, three seconds long. At t=3 the loop has just come round.
    const head = at({ trimStart: 4, trimEnd: 7 }, 3);
    expect(head.start).toBe(4);
    expect(head.end).toBe(7);
    expect(head.position).toBe(4);
    // t=3.5 is half a second into the second pass — 4.5, NOT 0.5 and NOT 7.5.
    expect(at({ trimStart: 4, trimEnd: 7 }, 3.5).position).toBe(4.5);
  });

  it("trimEnd 0 means the end of the file, so the window is the whole duration", () => {
    expect(at({ trimEnd: 0 }, 0).end).toBe(10);
    expect(at({ trimEnd: 0 }, 12).position).toBe(2);
  });

  it("clamps a trim window that runs past the file rather than playing past the end", () => {
    expect(at({ trimEnd: 40 }, 0).end).toBe(10);
    expect(at({ trimStart: 40 }, 0).start).toBe(10);
  });
});

describe("T493 — the at-end behaviours are four DIFFERENT numbers at the same instant", () => {
  // One elapsed time, one window, four answers. If any two agreed the control would be
  // decorative, which is the shape a vacuous enum test misses.
  const elapsed = 13; // 3 seconds past the end of a 10s window.

  it("loop cycles", () => {
    expect(at({ extend: "loop" }, elapsed).position).toBe(3);
    expect(at({ extend: "loop" }, elapsed).done).toBe(false);
  });

  it("hold freezes on the last frame and reports done", () => {
    const head = at({ extend: "hold" }, elapsed);
    expect(head.position).toBe(10);
    expect(head.done).toBe(true);
    expect(head.visible).toBe(true);
  });

  it("mirror ping-pongs — 3 past the end is 3 BEFORE it, not 3 after the start", () => {
    expect(at({ extend: "mirror" }, elapsed).position).toBe(7);
    // And it comes back: one full period is two windows.
    expect(at({ extend: "mirror" }, 20).position).toBe(0);
    expect(at({ extend: "mirror" }, 25).position).toBe(5);
    expect(at({ extend: "mirror" }, elapsed).done).toBe(false);
  });

  it("black stops being visible at all — distinct from hold, which shows a frozen frame", () => {
    const head = at({ extend: "black" }, elapsed);
    expect(head.position).toBe(10);
    expect(head.visible).toBe(false);
    expect(head.done).toBe(true);
    // Inside the window it is perfectly ordinary.
    expect(at({ extend: "black" }, 4).visible).toBe(true);
  });

  it("mirror reflects about the TRIMMED window, not about zero", () => {
    // Window 2→6 (four seconds). One second past the out point is 5, not 3 and not 7.
    expect(at({ extend: "mirror", trimStart: 2, trimEnd: 6 }, 5).position).toBe(5);
  });
});

describe("T493 — cue jumps to THIS second and holds there", () => {
  it("holds at the cue point regardless of how much time has passed", () => {
    expect(at({ cue: true, cuePoint: 6 }, 0).position).toBe(6);
    expect(at({ cue: true, cuePoint: 6 }, 3).position).toBe(6);
    expect(at({ cue: true, cuePoint: 6 }, 900).position).toBe(6);
    expect(at({ cue: true, cuePoint: 6 }, 3).cued).toBe(true);
  });

  it("is a pure function of the frame, so it holds under the timeline lock too", () => {
    // The reason `cue` is NOT inactive when locked to the timeline, unlike `play`.
    expect(at({ playMode: "timeline", cue: true, cuePoint: 2.25 }, 7).position).toBe(2.25);
  });

  it("clamps the cue point into the trim window rather than escaping it", () => {
    expect(at({ cue: true, cuePoint: 9, trimStart: 1, trimEnd: 5 }, 0).position).toBe(5);
    expect(at({ cue: true, cuePoint: 0, trimStart: 1, trimEnd: 5 }, 0).position).toBe(1);
  });

  it("releases to exactly where the clock says, not to where it was cued", () => {
    expect(at({ cue: true, cuePoint: 6 }, 3).position).toBe(6);
    expect(at({ cue: false, cuePoint: 6 }, 3).position).toBe(3);
  });
});

describe("T493 — an unloaded file refuses by name rather than lying (§V369)", () => {
  it("an unknown duration advances honestly and never claims to be done", () => {
    const head = mediaPlayhead(BASE, 12, 0);
    expect(head.position).toBe(12);
    expect(head.end).toBe(0);
    expect(head.done).toBe(false);
  });

  it("a COLLAPSED window holds the one frame the user asked for, and never divides by zero", () => {
    const head = at({ trimStart: 3, trimEnd: 3 }, 5);
    expect(Number.isFinite(head.position)).toBe(true);
    expect(head.position).toBe(3);
    // ...and it stays there however long the timeline runs.
    expect(at({ trimStart: 3, trimEnd: 3 }, 5000).position).toBe(3);
  });
});

describe("T493 — the free-run clock is the only state, and only in free-run", () => {
  it("under the timeline lock it IGNORES its accumulator and returns the timeline", () => {
    const clock = createMediaClock();
    // Ten frames of a paused transport: a stateful implementation would hold at 0.
    for (let index = 0; index < 10; index += 1) {
      clock.advance({ ...BASE, play: false }, 1 / 60, index / 60);
    }
    expect(clock.advance({ ...BASE, play: false }, 1 / 60, 4)).toBe(4);
  });

  it("in free-run, PAUSE actually holds and PLAY actually advances", () => {
    const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun" };
    const clock = createMediaClock();
    expect(clock.advance(freeRun, 1, 1)).toBe(1);
    expect(clock.advance(freeRun, 1, 2)).toBe(2);
    expect(clock.advance({ ...freeRun, play: false }, 1, 3)).toBe(2);
    expect(clock.advance({ ...freeRun, play: false }, 1, 4)).toBe(2);
    expect(clock.advance(freeRun, 1, 5)).toBe(3);
  });

  it("a cue PULSE lands the playhead on the cue point and carries on from there", () => {
    const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun", speed: 2 };
    const clock = createMediaClock();
    clock.advance(freeRun, 1, 1);
    const head = mediaPlayhead(freeRun, 1, 10);
    expect(head.position).toBe(2);
    clock.cueTo(freeRun, head, 7);
    // The jump inverts through the SAME arithmetic: elapsed 3.5 × speed 2 = 7.
    expect(mediaPlayhead(freeRun, clock.advance(freeRun, 0, 1), 10).position).toBe(7);
    // ...and one more second at speed 2 is 9, not back to 2.
    expect(mediaPlayhead(freeRun, clock.advance(freeRun, 1, 2), 10).position).toBe(9);
  });

  it("a cue pulse into a TRIMMED window lands on the point, not on the point plus the in", () => {
    const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun", trimStart: 3, trimEnd: 8 };
    const clock = createMediaClock();
    const head = mediaPlayhead(freeRun, clock.advance(freeRun, 1, 1), 10);
    clock.cueTo(freeRun, head, 6);
    expect(mediaPlayhead(freeRun, clock.advance(freeRun, 0, 1), 10).position).toBe(6);
  });
});

describe("T493 — one vocabulary, read tolerantly (§V61, §V10)", () => {
  it("a document with none of the keys reads the SCHEMA defaults, and the reader cannot drift from them", () => {
    const transport = mediaTransportFrom(() => undefined);
    expect(transport).toEqual({
      // T586: free run, the owner's default. The `toMatchObject` pair below is what stops
      // this and the manifest becoming two answers about what a missing key means — a
      // document stores `playMode` only when the user picked one, so "missing" IS the
      // default state and a divergence here is a node that plays differently depending on
      // which reader looked at it.
      playMode: "freeRun",
      play: true,
      speed: 1,
      cue: false,
      cuePoint: 0,
      trimStart: 0,
      trimEnd: 0,
      extend: "loop",
    });
    // ...and those defaults are the manifest's, not a second copy that can drift.
    const schema = MEDIA_TRANSPORT_PARAMETERS;
    expect(schema["playMode"]).toMatchObject({ default: transport.playMode });
    expect(schema["speed"]).toMatchObject({ default: transport.speed });
    expect(schema["extend"]).toMatchObject({ default: transport.extend });
  });

  it("a wrong-typed or unknown value falls back rather than producing NaN", () => {
    const values: Record<string, ParameterValue> = {
      speed: "fast" as unknown as ParameterValue,
      playMode: "sequential",
      extend: "cycle",
      cue: 1 as unknown as ParameterValue,
    };
    const transport = mediaTransportFrom((key) => values[key]);
    expect(transport.speed).toBe(1);
    expect(transport.playMode).toBe("freeRun");
    expect(transport.extend).toBe("loop");
    expect(transport.cue).toBe(false);
  });

  it("reads real values through", () => {
    const values: Record<string, ParameterValue> = {
      playMode: "freeRun",
      play: false,
      speed: -2,
      cue: true,
      cuePoint: 1.5,
      trimStart: 2,
      trimEnd: 8,
      extend: "mirror",
    };
    expect(mediaTransportFrom((key) => values[key])).toEqual(values);
  });
});

describe("T493 — §V146: a control that cannot act says so", () => {
  const inactive = (key: string, playMode: string) =>
    MEDIA_TRANSPORT_PARAMETERS[key]?.inactiveWhen?.({ playMode });

  it("Play is inactive under the timeline lock, and the reason names the timeline", () => {
    const reason = inactive("play", "timeline");
    expect(reason).toBeTypeOf("string");
    expect(reason).toContain("Locked to Timeline");
    expect(inactive("play", "freeRun")).toBeNull();
  });

  /**
   * T586 — THE OWNER'S SYMPTOM, asserted where it actually happens.
   *
   * The two cases above hand `inactiveWhen` a literal `playMode`, which can never see the
   * bug the owner hit: they dropped in a file and found Play DIMMED, and the value that
   * dimmed it came from `resolveParameters` filling in the manifest default for a node
   * that stores nothing. So this goes through the real resolver on a real registry node —
   * the same call `inspector.tsx` makes — and asserts the control is LIVE.
   *
   * §V146's logic is untouched and still right; it is simply now describing the mode you
   * opted into rather than the one you were dropped in.
   */
  it("Play is ACTIVE on a freshly dropped-in node, through the resolver the inspector uses", () => {
    const registry = createNodeRegistry(allNodeDefinitions);
    for (const type of ["audioFileIn", "movieFileIn"]) {
      const definition = registry.get(type);
      const node = {
        id: "n",
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      } as unknown as Parameters<typeof resolveParameters>[0];
      const resolved = resolveParameters(node, definition as NodeDefinition, {});
      expect(resolved.values["playMode"], type).toBe("freeRun");
      // The whole point of the flip: no dimming, no "this control cannot act" sentence.
      expect(MEDIA_TRANSPORT_PARAMETERS["play"]?.inactiveWhen?.(resolved.values), type).toBeNull();
      expect(
        MEDIA_TRANSPORT_PARAMETERS["cuePulse"]?.inactiveWhen?.(resolved.values),
        type,
      ).toBeNull();
    }
  });

  it("Cue Pulse is inactive under the lock, but Cue itself is NOT", () => {
    expect(inactive("cuePulse", "timeline")).toBeTypeOf("string");
    expect(inactive("cuePulse", "freeRun")).toBeNull();
    // The distinction the whole clock argument rests on: holding is pure, jumping is not.
    expect(MEDIA_TRANSPORT_PARAMETERS["cue"]?.inactiveWhen).toBeUndefined();
    expect(MEDIA_TRANSPORT_PARAMETERS["speed"]?.inactiveWhen).toBeUndefined();
    expect(MEDIA_TRANSPORT_PARAMETERS["trimStart"]?.inactiveWhen).toBeUndefined();
  });
});

describe("T493 — hasMediaTransport derives from the schema (§V316, §V453)", () => {
  const definition = (parameters: Record<string, unknown>) =>
    ({ type: "x", version: 1, title: "X", category: "input", inputs: [], outputs: [], parameters } as unknown as NodeDefinition);

  it("is true only when EVERY transport key is present", () => {
    expect(hasMediaTransport(definition({ ...MEDIA_TRANSPORT_PARAMETERS }))).toBe(true);
    const { play: _play, ...missingOne } = MEDIA_TRANSPORT_PARAMETERS;
    expect(hasMediaTransport(definition(missingOne))).toBe(false);
    expect(hasMediaTransport(definition({ file: { type: "asset" } }))).toBe(false);
  });

  it("names every key the vocabulary owns", () => {
    expect([...MEDIA_TRANSPORT_KEYS].sort()).toEqual([
      "cue",
      "cuePoint",
      "cuePulse",
      "extend",
      "play",
      "playMode",
      "reload",
      "speed",
      "trimEnd",
      "trimStart",
    ]);
  });
});

/**
 * T586 — THE HONEST EDGE, asserted in BOTH directions.
 *
 * The flip's one real cost is that a free-run playhead is not a function of the frame, so
 * an offline render does not reproduce what was heard (§V44/§V47). The requirement is that
 * a project holding one SAYS SO at render time — and the test that only checks the warning
 * FIRES would pass on an implementation that warns about every project, which would be the
 * same as not warning at all. So the locked case is asserted just as hard as the free-run
 * one (§V461: the fixture must be able to distinguish what it asserts).
 */
describe("T586 — a free-run media node is named at render time, and a locked one is not", () => {
  const registry = createNodeRegistry(allNodeDefinitions);

  const graphWith = (nodes: Record<string, unknown>): GraphDocument =>
    ({ revision: 1, nodes, edges: {} }) as unknown as GraphDocument;

  const mediaNode = (type: string, label: string, parameters: Record<string, unknown>) => ({
    id: label,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    label,
    parameters,
  });

  it("a node that stores NOTHING is free-running, so it warns — the default IS the case", () => {
    // The case that matters: nobody opted into free run, they simply opened the app.
    const graph = graphWith({ track1: mediaNode("audioFileIn", "track1", {}) });
    expect(freeRunMediaNodes(graph, registry).map((node) => node.label)).toEqual(["track1"]);

    const warning = freeRunRenderWarning(graph, registry);
    expect(warning?.severity).toBe("warning");
    expect(warning?.code).toBe("export.freeRunMedia");
    expect(warning?.nodeId).toBe("track1");
    // NAMED, not counted — §V338/§V403: the node, and the fix, in the text the user reads.
    expect(warning?.message).toContain('Audio File In "track1"');
    expect(warning?.suggestion).toContain('Audio File In "track1"');
    expect(warning?.suggestion).toContain("Locked to Timeline");
  });

  it("a node LOCKED to the timeline produces NO warning — the fix actually works", () => {
    const graph = graphWith({
      track1: mediaNode("audioFileIn", "track1", { playMode: "timeline" }),
    });
    expect(freeRunMediaNodes(graph, registry)).toEqual([]);
    expect(freeRunRenderWarning(graph, registry)).toBeNull();
  });

  it("a graph with no media at all produces no warning", () => {
    const graph = graphWith({
      n1: { id: "n1", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    });
    expect(freeRunRenderWarning(graph, registry)).toBeNull();
  });

  it("BOTH doors are covered, and a mixed graph names only the offender", () => {
    const graph = graphWith({
      clip1: mediaNode("movieFileIn", "clip1", {}),
      track1: mediaNode("audioFileIn", "track1", { playMode: "timeline" }),
    });
    const warning = freeRunRenderWarning(graph, registry);
    expect(warning?.message).toContain('Movie File In "clip1"');
    // The half that stops it degenerating into "your project has media in it".
    expect(warning?.message).not.toContain("track1");
  });

  it("names EVERY free-run node, because fixing one of three is not fixing it", () => {
    const graph = graphWith({
      clip1: mediaNode("movieFileIn", "clip1", {}),
      track1: mediaNode("audioFileIn", "track1", { playMode: "freeRun" }),
    });
    const warning = freeRunRenderWarning(graph, registry);
    expect(warning?.message).toContain('Movie File In "clip1"');
    expect(warning?.message).toContain('Audio File In "track1"');
    expect(warning?.message).toContain("are on Free Run");
  });

  it("a playMode reached by EXPRESSION is read the same way a typed one is (§V107)", () => {
    // The proof that this goes through `resolveParameters` rather than peeking at the
    // stored value: an expression resolving to the lock silences the warning.
    const graph = graphWith({
      track1: mediaNode("audioFileIn", "track1", {
        playMode: {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "0" } },
        },
      }),
    });
    // Enum by index (§V107's resolver rule): index 0 is "timeline".
    expect(freeRunRenderWarning(graph, registry)).toBeNull();
  });
});
