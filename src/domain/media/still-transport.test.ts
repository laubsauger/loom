import { describe, expect, it } from "vitest";

import {
  MEDIA_TRANSPORT_KEYS,
  MEDIA_TRANSPORT_PARAMETERS,
  STILL_ACTIVE_KEY,
  freeRunMediaNodes,
} from "./transport.ts";
import type { GraphDocument } from "../types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * T1223 — A STILL HAS NO CLOCK, and every control that reads one says so (§V146).
 *
 * §T1190 found `speed`, `play` and `extend` silently dead under a held cue and gave each an
 * `inactiveWhen` naming the cue. A still kills the SAME set and more — the still path in
 * `use-media-sources` builds no transport runner at all — so this is that treatment applied
 * to the second set of dead controls, in the same shape and the same wording.
 *
 * ⚑ THE SET IS DERIVED FROM `MEDIA_TRANSPORT_KEYS`, NOT LISTED HERE. That is the whole
 * value of this file: a twelfth transport parameter is covered the day it lands, or this
 * reddens. A hand list would have gone green forever the moment it was written, which is
 * exactly what §V500 refuses.
 */

const stillFile = { file: "blob:x#photo.png", playMode: "freeRun", cue: false };
const videoFile = { file: "blob:x#clip.mp4", playMode: "freeRun", cue: false };

describe("every transport verb dims for a still, by derivation (T1223, §V146)", () => {
  it("names the still and says what it means, for every key but Reload", () => {
    const clockVerbs = MEDIA_TRANSPORT_KEYS.filter((key) => key !== STILL_ACTIVE_KEY);
    // The derivation is only meaningful if there is something to derive over.
    expect(clockVerbs.length).toBeGreaterThan(5);

    for (const key of clockVerbs) {
      const reason = MEDIA_TRANSPORT_PARAMETERS[key]?.inactiveWhen?.(stillFile);
      expect(reason, key).toBeTypeOf("string");
      expect(reason, key).toContain("STILL IMAGE");
      // §V403: the sentence must name what would make the control work again.
      expect(reason, key).toContain("video file");
    }
  });

  /**
   * Reload is the one File-group verb that still acts on a picture: it re-opens the file.
   * The still path registers it, so dimming it would be the inverse lie — a working
   * control marked dead.
   */
  it("leaves Reload alone, because re-opening the file still means something", () => {
    expect(MEDIA_TRANSPORT_PARAMETERS[STILL_ACTIVE_KEY]?.inactiveWhen?.(stillFile) ?? null)
      .toBeNull();
  });

  /**
   * BOTH DIRECTIONS (§V461). A gate that dimmed everything always would pass every
   * assertion above and would be identical to shipping no transport at all.
   */
  it("dims none of them for a video, and none for an unpicked file", () => {
    for (const key of MEDIA_TRANSPORT_KEYS) {
      expect(MEDIA_TRANSPORT_PARAMETERS[key]?.inactiveWhen?.(videoFile) ?? null, key).toBeNull();
      expect(
        MEDIA_TRANSPORT_PARAMETERS[key]?.inactiveWhen?.({ ...videoFile, file: "" }) ?? null,
        key,
      ).toBeNull();
    }
  });

  /**
   * The still reason wins over the cue reason when both hold. Two true sentences about one
   * control is worse than one: "Cue is on, so Speed does nothing" invites you to turn Cue
   * off, and on a still that would change nothing.
   */
  it("says STILL rather than CUE when a still is also cued", () => {
    const reason = MEDIA_TRANSPORT_PARAMETERS["speed"]?.inactiveWhen?.({
      ...stillFile,
      cue: true,
    });
    expect(reason).toContain("STILL IMAGE");
    expect(reason).not.toContain("turn Cue off");
  });
});

/**
 * ⚑ T1223 — THE NEW LIE THIS CHANGE COULD HAVE INTRODUCED, caught by asking what dimming
 * Play Mode implies for the OTHER reader of `playMode`.
 *
 * T586's render warning names every free-running media node, because a free-run playhead is
 * not `f(frame)` and its take will not reproduce. A still in free run has no playhead at
 * all — one frame, a constant `frameId`, the same pixels on every frame of every render —
 * so naming it would tell the user their take is unreliable when it is exact. §V338's rule
 * cuts both ways: not silently diverging, and not warning about something that is fine.
 */
describe("a still that free-runs is not a reproducibility risk (T1223, T586)", () => {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const graphWith = (parameters: Record<string, unknown>): GraphDocument =>
    ({
      revision: 1,
      nodes: {
        clip: {
          id: "clip",
          type: "movieFileIn",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          label: "clip",
          parameters,
        },
      },
      edges: {},
      groups: {},
    }) as unknown as GraphDocument;

  it("names a free-running VIDEO, which is the warning doing its job", () => {
    const named = freeRunMediaNodes(graphWith({ file: "clip.mp4", playMode: "freeRun" }), registry);
    expect(named.map((entry) => entry.nodeId)).toEqual(["clip"]);
  });

  it("does NOT name a free-running still, whose pixels are the same in every take", () => {
    const named = freeRunMediaNodes(graphWith({ file: "photo.png", playMode: "freeRun" }), registry);
    expect(named).toEqual([]);
  });
});
