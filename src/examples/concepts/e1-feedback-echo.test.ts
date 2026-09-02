import { describe, expect, it } from "vitest";
import { example } from "./helpers.ts";

describe("E1 Feedback Echo", () => {
  const { document } = example("E1-Feedback-Echo.loom.json");

  /**
   * The fade lives on the Feedback node. At `persistence: 1` the loop is a pure delay and
   * the trail never dies — the example would render a smear that fills the frame and stays.
   */
  it("fades inside the loop rather than accumulating forever", () => {
    const echo = document.graph.nodes["echo"];
    expect(echo?.type).toBe("feedback");
    const persistence = echo?.parameters["persistence"];
    expect(typeof persistence).toBe("number");
    expect(persistence).toBeGreaterThan(0);
    expect(persistence).toBeLessThan(1);
    // Fading toward an opaque colour would tint the whole frame instead of clearing it.
    expect(echo?.parameters["clearColor"]).toEqual([0, 0, 0, 0]);
  });

  /** The loop is not a bare delay: it transforms and filters between the two ends. */
  it("transforms and filters inside the loop", () => {
    const types = ["drift", "soften", "decay"].map((id) => document.graph.nodes[id]?.type);
    expect(types).toEqual(["transform", "blur", "level"]);
  });
});
