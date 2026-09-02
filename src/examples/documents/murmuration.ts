import { settings, node, edge, graph, document } from "./builders.ts";

/**
 * E16 — Murmuration (T410).
 *
 * The SOP-chain showcase: a sphere of anchor points flows through TWO kernels before it
 * is drawn — `sphere → flock → part → birds` — which is the shape T401 made possible and
 * nothing else demonstrates. Points are a PIPELINE here, not a source-to-sink hop.
 *
 * The flock kernel is the interesting half of T401's ownership rule (§V197) in one node:
 * `position` IS carried by the upstream sphere, so `in_position` binds the GENERATOR's
 * pair and arrives fresh every frame — the formation is re-asserted, never integrated.
 * `offset`, `velocity` and `tint` are NOT carried upstream, so they live in the kernel's
 * OWN pairs and persist across frames — which is what lets a processor still be a
 * simulation: the anchor comes from upstream, the motion accumulates locally, and
 * `position = anchor + offset` writes the kernel's own output pair. No neighbour reads
 * (a kernel sees one point), so the flocking is a shared FLOW FIELD — three phase-shifted
 * sines keyed by the anchor — plus a spring home and damping: coherent swirl, birds that
 * never abandon the formation, zero O(N²) anywhere.
 *
 * `tint` is the colour-BY-VELOCITY channel: computed from `length(velocity)` in the
 * flock kernel (slow = deep blue, fast = warm white), then it crosses the SECOND kernel
 * BY REFERENCE — `part` declares only `position`, so tint passes through as the flock's
 * own pair, untouched and uncopied (§V197's narrowing, live in a shipped file).
 *
 * `part` is the E9 cursor push as a PROCESSOR: stateless, reads the flock's positions,
 * shoves the nearby ones away from the pointer (§V182/§V236 mapping written in the
 * kernel, Gaussian falloff for the same air-not-edge reason as E9). A bird pushed too
 * far leaves the DRAW — the renderer's `group` predicate (T333) culls anything beyond
 * radius 1.7 at draw time, so strays vanish without any kernel writing a kill.
 */
const MURMURATION_FLOCK_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "offset", type: "vec3f", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0.25, 0.35, 0.9, 1] },
]);

const MURMURATION_FLOCK_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* T401: p.position is the UPSTREAM sphere's pair, fresh every frame — the anchor.
     offset/velocity are this kernel's OWN state and persist (§V197). */
  let anchor = p.position;
  /* FREE-RUNNING (§V436, T497): ctx.absTime, not ctx.time. The flow field is the wind, and
     wind does not restart when the piece does — ctx.time wraps at the out point (T455) and
     put every phase back where it was at frame zero, snapping the whole flock at each lap.
     ctx.delta below is untouched: a step is continuous across a lap by construction (T464). */
  let t = ctx.absTime * 0.6;
  /* The "flock": one shared flow field, phase-keyed by the anchor, so neighbours on the
     formation swirl together without any neighbour reads. */
  let flow = vec3f(
    sin(anchor.y * 3.1 + t) + 0.5 * sin(anchor.z * 4.7 - t * 1.3),
    sin(anchor.z * 2.9 + t * 1.1) + 0.5 * sin(anchor.x * 5.3 + t),
    sin(anchor.x * 3.7 - t) + 0.5 * sin(anchor.y * 4.1 + t * 0.7),
  );
  let spring = -q.offset * 1.8; /* home pull: the murmuration never abandons the sphere */
  q.velocity = (q.velocity + (flow * 0.9 + spring) * ctx.delta) * 0.985;
  q.offset = q.offset + q.velocity * ctx.delta;
  q.position = anchor + q.offset;
  /* Colour BY VELOCITY: slow birds sit deep blue, fast ones flare toward warm white. */
  let heat = clamp(length(q.velocity) * 1.4, 0.0, 1.0);
  q.tint = vec4f(0.25 + 0.75 * heat, 0.35 + 0.45 * heat, 0.9 - 0.35 * heat, 1.0);
  return q;
}`;

const MURMURATION_PART_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The E9 cursor push, as a stateless PROCESSOR: same §V182 pointer, same §V236
     v-down mapping written where the clip convention is known, same Gaussian-not-edge. */
  let cursor = vec3f(ctx.pointer.x * 2.0 - 1.0, 1.0 - ctx.pointer.y * 2.0, 0.0);
  let away = q.position - cursor;
  let distance = max(length(away), 0.0001);
  let falloff = exp(-(distance * distance) / 0.16);
  q.position = q.position + (away / distance) * falloff * 0.9;
  return q;
}`;

export const murmurationDocument = document(
  "e16-murmuration",
  "E16 Murmuration",
  settings({ randomSeed: 31 }),
  graph(
    [
      node("sphere", "pointSphere", [-1180, 0], { count: 2000, radius: 0.9 }, { label: "sphere1" }),
      node(
        "flock",
        "pointKernel",
        [-880, 0],
        { capacity: 2000, seed: 31, attributes: MURMURATION_FLOCK_ATTRIBUTES, kernel: MURMURATION_FLOCK_KERNEL },
        { label: "flock1" },
      ),
      node(
        "part",
        "pointKernel",
        [-580, 0],
        {
          capacity: 2000,
          seed: 31,
          attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
          kernel: MURMURATION_PART_KERNEL,
        },
        { label: "part1" },
      ),
      node(
        "birds",
        "renderInstances",
        [-280, 0],
        {
          count: 2000,
          shape: "octahedron",
          scale: 0.016,
          rotate: [0, 0, 0],
          eye: [0, 0.35, 2.7],
          lookAt: [0, 0, 0],
          fov: 55,
          /* T333: strays the cursor shoved past the flock's airspace vanish at DRAW time. */
          group: "length(p.position) < 1.7",
        },
        {
          label: "birds1",
          parameters: {
            color: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: [1, 1, 1, 1] },
                /* tint authored two nodes UPSTREAM, crossing `part` by reference (§V197). */
                map: { kind: "map", attribute: "tint" },
              },
            },
          },
        },
      ),
      node("out", "output", [40, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-sphere-flock", ["sphere", "out"], ["flock", "in"]),
      edge("e-flock-part", ["flock", "out"], ["part", "in"]),
      edge("e-part-birds", ["part", "out"], ["birds", "points"]),
      edge("e-birds-out", ["birds", "out"], ["out", "input"]),
    ],
  ),
);
