import { describe, expect, it } from "vitest";

import {
  NODE_REPRODUCIBILITY,
  nonReproducibleNodes,
  nonReproducibleRenderWarning,
  type Reproducibility,
} from "./reproducibility.ts";
import type { GraphDocument } from "../types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * §V329 AS A GATE (T645), in the two halves the property actually has.
 *
 * Half one is the §V437 half: the map is EXHAUSTIVE over the registry, so node #86 fails
 * this file until its author decides whether a take over it reproduces. That half alone is
 * worth little — classify `webcam` and it goes green forever, which is precisely the
 * unfalsifiable guard §V500 refuses. So half two asserts the CONSEQUENCE: that the render
 * warning names the node, on a document containing one. Delete the classification and half
 * one fails; delete the warning's use of it and half two fails; and neither can be made
 * green by touching the other.
 *
 * Both directions, every time (§V461, §V537): a document of only pure nodes must produce
 * NO warning. An implementation that warns about every project would pass every positive
 * assertion in this file and would be the same as not warning at all.
 */

const registry = createNodeRegistry(allNodeDefinitions);

const graphWith = (nodes: Record<string, unknown>): GraphDocument =>
  ({ revision: 1, nodes, edges: {} }) as unknown as GraphDocument;

const node = (type: string, label: string, parameters: Record<string, unknown> = {}) => ({
  id: label,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  label,
  parameters,
});

describe("T645 — every registered node type is classified, or this fails (§V437)", () => {
  it("names every node the registry can instantiate", () => {
    const missing = allNodeDefinitions
      .map((definition) => definition.type)
      .filter((type) => NODE_REPRODUCIBILITY[type] === undefined);

    expect(
      missing,
      "A node cannot ship without answering whether a take over it reproduces (§V329). " +
        "Add it to NODE_REPRODUCIBILITY — `pure` if it is a function of the frame and the " +
        "document, `external-live` if it reads a device, `async-cached` if it publishes a " +
        "result that arrives on its own schedule — and say why beside the entry. T644 is " +
        "what defaulting cost: `webcam` was never classified anywhere and a take over one " +
        "produced a different file every time with no diagnostic at all.",
    ).toEqual([]);
  });

  it("names no node that has stopped existing (§V421 rot)", () => {
    const live = new Set(allNodeDefinitions.map((definition) => definition.type));
    const stale = Object.keys(NODE_REPRODUCIBILITY).filter((type) => !live.has(type));
    expect(stale, "NODE_REPRODUCIBILITY classifies a node the registry no longer has.").toEqual([]);
  });

  it("classifies exactly four nodes as not pure, and they are the four found", () => {
    const notPure = Object.entries(NODE_REPRODUCIBILITY)
      .filter(([, value]) => value !== "pure")
      .map(([type, value]) => `${type}:${value}`)
      .sort();
    // Named rather than counted, so a fifth arriving is a decision someone made on purpose
    // and a fourth going missing is a red test rather than a quiet loss of coverage.
    expect(notPure).toEqual([
      "analyze:async-cached",
      "audioIn:external-live",
      // T654: the fifth, on purpose — channelIn's canonical diet is analyze's readback,
      // so it wears the same class as the thing it reads (see the table's entry).
      "channelIn:async-cached",
      "mouse:external-live",
      "webcam:external-live",
    ]);
  });

  it("keeps media FILES pure as types — the split the free-run check depends on", () => {
    // If these were `external-live`, a movie locked to the timeline would warn, and the one
    // configuration built specifically to reproduce would be reported as not reproducing.
    const asType: Reproducibility | undefined = NODE_REPRODUCIBILITY["movieFileIn"];
    expect(asType).toBe("pure");
    expect(NODE_REPRODUCIBILITY["audioFileIn"]).toBe("pure");
    expect(nonReproducibleNodes(graphWith({ clip1: node("movieFileIn", "clip1", { playMode: "timeline" }) }), registry)).toEqual([]);
  });
});

/**
 * T644 — THE SHIPPING BUG, as the test that could not pass before the fix.
 *
 * `webcam` declares no transport parameters, so `hasMediaTransport` was false, so
 * `freeRunMediaNodes` never saw it, so the render warning returned `null` for a document
 * whose entire content was a live camera. Every assertion here fails against the code as it
 * shipped, and classifying the node without wiring the classification into the warning does
 * not make any of them pass.
 */
describe("T644 — a take over a live device is named at render time", () => {
  it("names the WEBCAM, which produced a different file every time and said nothing", () => {
    const warning = nonReproducibleRenderWarning(graphWith({ cam1: node("webcam", "cam1") }), registry);
    expect(warning, "a document whose whole content is a live camera warned about nothing").not.toBeNull();
    expect(warning?.severity).toBe("warning");
    expect(warning?.code).toBe("export.nonReproducible");
    expect(warning?.nodeId).toBe("cam1");
    expect(warning?.message).toContain('Webcam "cam1"');
    expect(warning?.message).toContain("Rendering the same range twice gives two different files.");
    // §V403: the route to having it, not just the absence of it.
    expect(warning?.suggestion).toContain('Webcam "cam1"');
    expect(warning?.suggestion).toContain("Record the input to a file");
  });

  it("names ANALYZE, whose value is from an unknown number of frames ago", () => {
    const warning = nonReproducibleRenderWarning(graphWith({ bright: node("analyze", "bright") }), registry);
    expect(warning?.message).toContain('Analyze "bright"');
    expect(warning?.message).toContain("latest completed readback");
    expect(warning?.suggestion).toContain("node info popup");
  });

  it("names the two live devices nobody had written down: Audio In and Mouse", () => {
    const warning = nonReproducibleRenderWarning(
      graphWith({ mic: node("audioIn", "mic"), cursor: node("mouse", "cursor") }),
      registry,
    );
    expect(warning?.message).toContain('Audio In "mic"');
    expect(warning?.message).toContain('Mouse "cursor"');
    expect(warning?.message).toContain("read live devices");
  });

  it("says each thing ONCE, as one clause per cause rather than one sentence per node", () => {
    const warning = nonReproducibleRenderWarning(
      graphWith({ cam1: node("webcam", "cam1"), cam2: node("webcam", "cam2") }),
      registry,
    );
    // Both named, one sentence. Three free-run tracks should read as one statement about
    // free run, not as three identical paragraphs.
    expect(warning?.message).toContain('Webcam "cam1", Webcam "cam2"');
    expect(warning?.message?.match(/read live devices/g)).toHaveLength(1);
  });
});

/**
 * T586 — THE HONEST EDGE, asserted in BOTH directions.
 *
 * Moved here from `domain/media/transport.test.ts` with the function it exercises (T645).
 * The sentence is unchanged, word for word: T586's warning was not replaced, it became one
 * CLAUSE of a warning that also covers the class it could not see. What moved is where the
 * clause is assembled; what did not move is what the user reads.
 *
 * The flip's one real cost is that a free-run playhead is not a function of the frame, so
 * an offline render does not reproduce what was heard (§V44/§V47). The requirement is that
 * a project holding one SAYS SO at render time — and the test that only checks the warning
 * FIRES would pass on an implementation that warns about every project, which would be the
 * same as not warning at all. So the locked case is asserted just as hard as the free-run
 * one (§V461: the fixture must be able to distinguish what it asserts).
 */
describe("T586 — a free-run media node is named at render time, and a locked one is not", () => {
  it("a node that stores NOTHING is free-running, so it warns — the default IS the case", () => {
    // The case that matters: nobody opted into free run, they simply opened the app.
    const graph = graphWith({ track1: node("audioFileIn", "track1") });
    expect(nonReproducibleNodes(graph, registry).map((found) => found.label)).toEqual(["track1"]);

    const warning = nonReproducibleRenderWarning(graph, registry);
    expect(warning?.severity).toBe("warning");
    expect(warning?.code).toBe("export.nonReproducible");
    expect(warning?.nodeId).toBe("track1");
    // NAMED, not counted — §V338/§V403: the node, and the fix, in the text the user reads.
    expect(warning?.message).toContain('Audio File In "track1"');
    expect(warning?.suggestion).toContain('Audio File In "track1"');
    expect(warning?.suggestion).toContain("Locked to Timeline");
  });

  it("a node LOCKED to the timeline produces NO warning — the fix actually works", () => {
    const graph = graphWith({ track1: node("audioFileIn", "track1", { playMode: "timeline" }) });
    expect(nonReproducibleNodes(graph, registry)).toEqual([]);
    expect(nonReproducibleRenderWarning(graph, registry)).toBeNull();
  });

  it("a graph of only PURE nodes produces no warning — the half that keeps it worth reading", () => {
    // §V537's shape: a warning that fires on every project is a warning everybody ignores.
    const graph = graphWith({
      n1: node("noise", "n1"),
      b1: node("blur", "b1"),
      t1: node("timer", "t1"),
      l1: node("lfo", "l1"),
      f1: node("feedback", "f1"),
      o1: node("output", "o1"),
      c1: node("camera", "c1"),
      p1: node("pointGrid", "p1"),
      x1: node("text", "x1"),
      clip1: node("movieFileIn", "clip1", { playMode: "timeline" }),
    });
    expect(nonReproducibleRenderWarning(graph, registry)).toBeNull();
  });

  it("BOTH doors are covered, and a mixed graph names only the offender", () => {
    const graph = graphWith({
      clip1: node("movieFileIn", "clip1"),
      track1: node("audioFileIn", "track1", { playMode: "timeline" }),
    });
    const warning = nonReproducibleRenderWarning(graph, registry);
    expect(warning?.message).toContain('Movie File In "clip1"');
    // The half that stops it degenerating into "your project has media in it".
    expect(warning?.message).not.toContain("track1");
  });

  it("names EVERY free-run node, because fixing one of three is not fixing it", () => {
    const graph = graphWith({
      clip1: node("movieFileIn", "clip1"),
      track1: node("audioFileIn", "track1", { playMode: "freeRun" }),
    });
    const warning = nonReproducibleRenderWarning(graph, registry);
    expect(warning?.message).toContain('Movie File In "clip1"');
    expect(warning?.message).toContain('Audio File In "track1"');
    expect(warning?.message).toContain("are on Free Run");
  });

  it("a playMode reached by EXPRESSION is read the same way a typed one is (§V107)", () => {
    // The proof that this goes through `resolveParameters` rather than peeking at the
    // stored value: an expression resolving to the lock silences the warning.
    const graph = graphWith({
      track1: node("audioFileIn", "track1", {
        playMode: {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "0" } },
        },
      }),
    });
    // Enum by index (§V107's resolver rule): index 0 is "timeline".
    expect(nonReproducibleRenderWarning(graph, registry)).toBeNull();
  });

  it("a free-run movie and a webcam land in ONE warning, not two", () => {
    // §V109: one warning surface. Before T645 this document produced a warning that named
    // the movie and was silent about the camera, which read as "the camera is fine".
    const graph = graphWith({ clip1: node("movieFileIn", "clip1"), cam1: node("webcam", "cam1") });
    const warning = nonReproducibleRenderWarning(graph, registry);
    expect(warning?.message).toContain('Movie File In "clip1"');
    expect(warning?.message).toContain('Webcam "cam1"');
    expect(warning?.suggestion).toContain("Locked to Timeline");
    expect(warning?.suggestion).toContain("Record the input to a file");
  });
});
