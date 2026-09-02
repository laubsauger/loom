import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { LANTERN_WGSL } from "../shaders/lantern.wgsl.ts";

/**
 * E46 — Lantern (T850). SDF AS LIGHT — the owner's "cool light glow" ask, then their own
 * refinements: objects the light interacts with, soft shadows, lanterns that steer AROUND
 * the obstacles rather than clip through them. All of it off ONE distance field
 * (`docs/shader-example-references.md`: "glow and soft shadows come off the same field").
 *
 *   bed1(noise, near-black) ─► lantern1(customWgsl: the SDF lit scene) ─► out1
 *                                    ▲
 *                    pulse1(lfo) ┄breath┄► lantern1.amount
 *
 * ## What the picture is
 *
 * A dark room. Three coloured lanterns orbit its centre; static obstacles ring the edges
 * (with four small ones tucked in the corners, the owner's note, to catch a far beam). Each
 * lantern paints the floor with distance-attenuated light, every obstacle casts a soft
 * shadow marched along the field away from it, and an obstacle's facing side is lit by the
 * field's gradient — its own 2D normal. The shader's docblock names each effect.
 *
 * ## Smooth, constant-speed, and it goes AROUND (the owner's notes)
 *
 * The lanterns orbit on CIRCLES, so the angular speed is constant and the linear speed with
 * it — a lissajous races through its middle and dawdles at its ends, which read as jumping.
 * Where an orbit would near an obstacle, a smooth C1 repulsion bends it away; the orbits are
 * sized to clear every obstacle core, so the bend is a gentle graze and never a snap. A
 * lantern's bright core is drawn only on open floor, so an obstacle it passes hides it —
 * the light cannot clip through the thing it is lighting.
 *
 * ## It breathes, and that is the drive (§V471)
 *
 * `pulse1` swings `lantern1.amount` on a slow sine, so the light swells and dims — but the
 * room never blacks out (a floor of gain remains). `amount` is the customWgsl contract's one
 * generic scalar; the kernel makes it the light gain.
 *
 * ## The relationship to §T845
 *
 * The lanterns' cores are soft AA discs — `clamp(0.5 - d/AA, 0, 1)`, which IS a soft round
 * sprite. The example shows the technique in the open; the soft instance shape (§T845)
 * derives the same formula. This is a picture-space FIELD, not instances faked by hand.
 */
export const lanternDocument = document(
  "e46-lantern",
  "E46 Lantern",
  settings({ randomSeed: 46 }),
  graph(
    [
      /* A near-black ground the lanterns hang in — low amplitude and offset keep the noise
         dark, and the shader samples it at 0.12, so it reads as faint depth behind the light
         rather than a texture competing with it. Glowing lights want darkness to pop on. */
      node("bed", "noise", [-720, 0], {
        type: "perlin2d", period: 0.5, amp: 0.14, offset: 0.06,
      }, { label: "bed1" }),

      /* The breath — a slow sine into the glow gain (§V108: retained 0.8 is a sane still
         picture, so the examples gate frames a lit field even with no channel attached). */
      node("pulse", "lfo", [-720, 240], {
        shape: "sine", frequency: 0.11, amplitude: 0.2, offset: 0.8, phase: 0,
      }, { label: "pulse1" }),

      node("lantern", "customWgsl", [-420, 0], {
        source: LANTERN_WGSL,
        // T880: the shader's own `struct Params` reflects into these controls — drag any of
        // them to retune the scene without touching WGSL. The colours are RGBA pickers, the
        // rest are numbers, named by the shader's fields.
        lightColor1: [1, 0.62, 0.24, 1],
        lightColor2: [0.24, 0.7, 1, 1],
        lightColor3: [0.95, 0.32, 0.78, 1],
        orbitSpeed: 1,
        glowFalloff: 12,
        shadowSoftness: 11,
        floorLevel: 1,
      }, {
        label: "lantern1",
        parameters: { amount: drivenSlot("pulse1", 0.8) },
      }),

      node("out", "output", [-120, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-lantern", ["bed", "out"], ["lantern", "input"]),
      edge("e-lantern-out", ["lantern", "out"], ["out", "input"]),
    ],
  ),
);
