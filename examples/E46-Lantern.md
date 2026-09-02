# E46 — Lantern

A dark room lit by drifting lanterns, with static obstacles the light rakes across and
casts soft shadows from. The owner asked for "SDF stuff for cool light glow effects", then
refined it: objects the light interacts with, shadows, and lanterns that steer *around* the
obstacles rather than clip through them. Every one of those comes off a single distance
field — the sdf-tricks article's point is that glow and soft shadows are the same field read
two ways, so nothing here is a post-process.

```
bed1(noise, near-black) ─► lantern1(customWgsl: the SDF lit scene) ─► out1
                                 ▲
                 pulse1(lfo) ┄breath┄► lantern1.amount
```

## The field is the scene, the light, and the shadows

One `scene(p)` function returns the distance to the nearest obstacle — four large ones
ringing the centre, four small ones in the corners. From that single field the shader reads:

- **the light** — each lantern paints the floor, attenuating with distance;
- **soft shadows** — a ray marched from the lit point toward a lantern; the closest it
  passes to an obstacle over the distance travelled *is* the penumbra (`min(K·h/t)`), and a
  hit before the light is full shadow. The obstacles are analytic SDF shapes, so a shadow is
  only ever as smooth as the march — 72 fine steps keep it a gradient, not a staircase;
- **lit surfaces** — an obstacle's facing side is shaded by the field's gradient, its own 2D
  normal, so the side toward a lantern is bright and the far side falls to ambient;
- **occlusion** — a lantern's bright core is drawn only on open floor, so an obstacle it
  drifts behind hides it. The light cannot clip through the thing it is lighting.

## Smooth, constant-speed motion that goes around

The lanterns orbit on **circles**. A circle has constant angular speed and therefore
constant linear speed; a lissajous races through its middle and crawls at its ends, and that
uneven pace reads as jumping. Where an orbit would pass near an obstacle, a smooth
`smoothstep` repulsion — summed per obstacle, so it has no medial-axis flip — bends the path
gently aside. The orbits are sized to clear every obstacle's core, so the bend is a graze and
never a snap: across nine hundred frames the largest step any lantern takes is under 0.006
world units and its acceleration is essentially zero.

## It breathes, and that is the drive

`pulse1` swings `lantern1.amount` on a slow sine, so the whole room's light swells and dims.
A floor of gain always remains, so the picture never blacks out — the breath dims the light,
never erases the scene. `amount` is the one generic scalar the custom-WGSL contract carries;
the kernel makes it the light gain.

`sounding-claims`' sibling here, `lantern-claims.gpu.test.ts`, pins what a screenshot cannot
tell from a wash: the light breathes without going black, the frame holds a real range from
black shadow to bright core rather than an even flood, and an obstacle is an opaque lit
surface with no lantern core bleeding through it — the proof the lanterns steer around the
obstacles and never into one.

## Reproducibility

`customWgsl` is a pure fragment effect: its only clock is the frame's own `absTime`, so the
lanterns' drift and the shadows sweeping with it replay frame for frame on any GPU and
survive a timeline lap without a jump.
