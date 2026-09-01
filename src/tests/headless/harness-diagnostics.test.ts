import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../../domain/types/graph.ts";
import {
  nodeGpuHost as dawnGpuHost,
  probeDawn,
} from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T630 — THE HARNESS IS NOT ALLOWED TO BE QUIETER THAN THE APP.
 *
 * `renderHeadless` reported BACKEND diagnostics only. A compiler warning lives on
 * `plan.diagnostics`, and the harness threw on compiler errors but silently dropped
 * everything below that severity — so `compiler/substeps-refused` never surfaced, and
 * three example builds shipped believing substeps worked while the render was
 * byte-identical to one step. This harness is what every example agent verifies with:
 * a build that reads its diagnostics must see what the app's problems pane would show.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** The shipped mistake, verbatim: substeps on a feedback that closes no loop. */
function substepsWithoutALoop(): GraphDocument {
  const doc: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };
  const add = (id: string, type: string, parameters: Record<string, unknown>, x: number): void => {
    doc.nodes[id] = { id, type, definitionVersion: 1, position: { x, y: 0 }, parameters } as never;
  };
  add("solid", "solid", { color: [0.25, 0.5, 0.75, 1] }, 0);
  add("feedback", "feedback", { substeps: 4 }, 200);
  add("out", "output", {}, 400);
  doc.edges["e0"] = { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "feedback", portId: "in" } } as never;
  doc.edges["e1"] = { id: "e1", source: { nodeId: "feedback", portId: "out" }, target: { nodeId: "out", portId: "input" } } as never;
  return doc;
}

describe("T630 — renderHeadless surfaces compiler warnings", () => {
  it("substeps on a loopless feedback reaches the result's diagnostics", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const result = await renderHeadless({
      host: dawnGpuHost(),
      graph: substepsWithoutALoop(),
      frames: 2,
    });

    // The exact code the shipped builds never saw. Not "some warning": the claim is that
    // THIS class of quiet refusal travels to the caller.
    const refused = result.diagnostics.filter((d) => d.code === "compiler/substeps-refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.severity).toBe("warning");
    // And it is the plan's own copy, message and all — the caller can print it verbatim.
    expect(refused[0]?.message).toContain("no loop to iterate");
  });
});

/**
 * T791 — THE PER-FRAME PLAN'S DIAGNOSTICS ARE READ.
 *
 * Under `animate`, the harness recompiles every frame with the live channel resolver and
 * used to hand the result straight to `animator.push` — nobody read its diagnostics, so a
 * per-frame ERROR was structurally invisible to every animated gate. That is the third
 * blind spot B155 exposed: the app blacked out on diagnostics 935 green tests never saw.
 *
 * The fixture drives an ENUM parameter from an LFO channel. A channel delivers a number,
 * an enum in driven mode refuses it at error severity, and — decisive for this test —
 * the error exists ONLY in the per-frame compile: the structural compile has no channel
 * resolver, so the driven parameter falls back at info severity and compiles clean.
 * (If driven enums ever learn the expression path's index coercion, this fixture stops
 * erroring and this test needs a new per-frame-only error — that is the test working.)
 */
describe("T791 — a per-frame compile error fails the render", () => {
  it("throws, naming the frame, on an error only the animated path can produce", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const doc: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };
    const add = (id: string, type: string, parameters: Record<string, unknown>, label?: string): void => {
      doc.nodes[id] = {
        id,
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters,
        ...(label === undefined ? {} : { label }),
      } as never;
    };
    add("wob", "lfo", { shape: "sine", frequency: 1, amplitude: 1, offset: 0, phase: 0 }, "wob1");
    add("solid", "solid", { color: [0.25, 0.5, 0.75, 1] });
    add("fold", "mirror", {
      extend: {
        mode: "driven",
        bindings: {
          driven: { kind: "driven", channel: "wob1" },
          static: { kind: "static", value: "hold" },
        },
      },
    });
    add("out", "output", {});
    doc.edges["e0"] = { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fold", portId: "input" } } as never;
    doc.edges["e1"] = { id: "e1", source: { nodeId: "fold", portId: "out" }, target: { nodeId: "out", portId: "input" } } as never;

    await expect(
      renderHeadless({ host: dawnGpuHost(), graph: doc, frames: 3, animate: true }),
    ).rejects.toThrow(/Per-frame compile produced errors[\s\S]*frame \d/);
  });
});
