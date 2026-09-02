import { settings, node, edge, graph, document } from "./builders.ts";

/**
 * E10 — Instanced Torus (T298, T299, T296).
 *
 * A torus of points wearing a box each: the generator publishes its pairs and analytic
 * topology on the edge (T296), renderInstances binds the position pair BY PAYLOAD and
 * puts a lit primitive on every point through the §V198 camera. An LFO drives
 * `rotate.y` in `driven` mode — the E7 mechanism, on one COMPONENT of a compound
 * parameter (§V113), without a recompile (§V5: rotation is sixteen uniform floats and
 * one integer away from any other frame).
 *
 * What that ROTATES is each box about its own centre, not the ring: §V198 composes
 * `rotate` INSIDE the translate to the point, so the torus stands still while 1152
 * primitives tumble in unison. The doc said "spinning the whole formation" for months
 * and listed the absence of that non-existent behaviour as a regression signature (B43).
 */
export const instancedTorusDocument = document(
  "e10-instanced-torus",
  "E10 Instanced Torus",
  settings({ randomSeed: 5 }),
  graph(
    [
      node("lfo", "lfo", [-640, 220], { shape: "saw", frequency: 0.1, amplitude: 360, offset: 0, phase: 0 }, { label: "lfo1" }),
      node(
        "points",
        "pointTorus",
        [-640, 0],
        { count: 1152, cols: 48, rows: 24, radius: 0.85, radius2: 0.33 },
        { label: "torus1" },
      ),
      node(
        "draw",
        "renderInstances",
        [-260, 0],
        {
          count: 1152,
          shape: "box",
          scale: 0.045,
          color: [1, 0.62, 0.25, 1],
          eye: [0, 1.1, 2.6],
          lookAt: [0, 0, 0],
          fov: 55,
        },
        {
          label: "instances1",
          // The slot merges OVER the base values (T348) — both survive.
          parameters: {
            "rotate.y": {
              mode: "driven",
              bindings: {
                static: { kind: "static", value: 0 },
                driven: { kind: "driven", channel: "lfo1" },
              },
            },
          },
        },
      ),
      node("out", "output", [120, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-points-draw", ["points", "out"], ["draw", "points"]),
      edge("e-draw-out", ["draw", "out"], ["out", "input"]),
    ],
  ),
);
