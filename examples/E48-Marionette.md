# E48 — Marionette

Pose, showcased: a figure of light — seventeen joints as soft points, a skeleton of
glowing bones — walking a procedural cycle, ready to become whoever stands in front of
the webcam.

The shipped performer is SYNTHETIC: `dancer1` emits a procedural walk cycle as the SAME
17×1 keypoint texture MoveNet produces — one texel per joint, red and green the position
across the frame, blue the confidence — so every gate and the gallery card see a dancer,
deterministically. Flip `pick1` to 1 and the same two consumers read `pose1` tracking
whoever is at the camera. Webcam permission is only requested when `cam1` activates,
never on load.

## The keypoint texture is the contract

Neither consumer knows which source is live:

- `joints1` is `pointsFromTexture` in VALUE mode — texel i's contents are point i, "the
  model says where the wrist is, so the texture's layout is irrelevant".
- `bones1` textureLoads the same seventeen texels and draws the skeleton's segments
  analytically, each bone weighted by the lesser of its two joints' confidence — a
  person walking out of shot dissolves limb by limb instead of snapping to garbage.

Without the model, `pose1` publishes zero-confidence keypoints: nothing draws on the ML
branch, never a failure (§T715), and the switch's default keeps the document opening on
the synthetic dancer regardless.

```
cam1(webcam) ─► pose1(pose) ── index 1 ─┐
seed1(ramp) ─► dancer1(customWgsl) ── 0 ┴─► pick1(switch) ─┬─► bones1(customWgsl)
                                                            └─► joints1(pointsFromTexture)
joints1 ─► marks1(geometry) ─► shot1(render) ─► glow1(add) ◄─ bones1 ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `seed1` | `ramp` | 17×1, black — exists only to size the keypoint canvas |
| `dancer1` | `customWgsl` | the walk cycle, emitted in MoveNet's own texture contract |
| `cam1` | `webcam` | the live source — permission only on activation |
| `pose1` | `pose` | MoveNet keypoints, stale-tolerant, zero-confidence without the model |
| `pick1` | `switch` | WHICH performer both consumers read |
| `joints1` | `pointsFromTexture` | VALUE mode: texel i is point i; low confidence parks |
| `marks1` | `geometry` | the joints as soft spherical points, warm against the cyan bones |
| `bones1` | `customWgsl` | the skeleton, confidence-faded per bone, at frame resolution |
| `spark1` | `materialUnlit` | the joints' material |
| `eye1` | `camera` | a straight-on stage |
| `shot1` | `render` | `antialias: msaa` for the point sprites |
| `glow1` | `add` | joints over bones — one figure |
