import { describe, expect, it } from "vitest";

import type { GraphDocument } from "@domain/types/graph.ts";
import { captureConfigOf } from "./use-audio-input.ts";

/**
 * T434: WHICH capture the session runs, pinned as a pure function.
 *
 * The precedence is the design: a BOUND file beats the microphone (a bound file is
 * deliberate authoring; a mic node is often just present), first-by-id breaks ties,
 * and the mic carries its device selection. The asset value is read with the same
 * tolerance media sources use — a plain string or `{ url }`.
 */

function graphOf(nodes: Record<string, { type: string; parameters?: Record<string, unknown> }>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, entry]) => [
        id,
        { id, type: entry.type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: entry.parameters ?? {} },
      ]),
    ),
    edges: {},
    groups: {},
  } as never;
}

describe("captureConfigOf (T434)", () => {
  it("no audio nodes: no capture", () => {
    expect(captureConfigOf(graphOf({ n: { type: "noise" } }))).toBeNull();
  });

  it("a mic node opens the default device; its device param carries through", () => {
    expect(captureConfigOf(graphOf({ a: { type: "audioIn" } }))).toEqual({
      source: "mic",
      url: "",
      device: "",
      monitor: false,
      // T493: a mic has no playhead, so there is no node whose transport drives it.
      nodeId: null,
    });
    expect(
      captureConfigOf(graphOf({ a: { type: "audioIn", parameters: { device: "dev-42" } } }))?.device,
    ).toBe("dev-42");
  });

  it("a BOUND file beats the microphone; an UNBOUND audioFileIn does not", () => {
    const bound = captureConfigOf(
      graphOf({
        z: { type: "audioIn" },
        a: { type: "audioFileIn", parameters: { file: "blob:track" } },
      }),
    );
    // T493: the config names WHICH node's transport drives the capture — the session has
    // one capture, so it has one transport, and it belongs to the node that supplied it.
    expect(bound).toEqual({
      source: "file",
      url: "blob:track",
      device: "",
      monitor: true,
      nodeId: "a",
    });
    // No file chosen yet: the node is waiting, not capturing — the mic keeps the session.
    const unbound = captureConfigOf(
      graphOf({
        z: { type: "audioIn" },
        a: { type: "audioFileIn" },
      }),
    );
    expect(unbound?.source).toBe("mic");
  });

  it("reads the asset value with media-source tolerance: string or { url }", () => {
    const wrapped = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: { url: "https://x/track.mp3" } } } }),
    );
    expect(wrapped?.url).toBe("https://x/track.mp3");
  });

  it("monitor: false carries through for a file capture", () => {
    const config = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:t", monitor: false } } }),
    );
    expect(config?.monitor).toBe(false);
  });
});
