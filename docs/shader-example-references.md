# Three reference articles, read and reduced to recipes

Read 2026-09-02 from fragcoord.xyz (Xor's GM Shaders reprints, plus a guest piece by
Yaazarai). Recorded so the examples are built from the *technique*, not from a screenshot
of it — the mistake the prism made three times (§T710, §T718, §T758).

---

## 1. Noise — `gm-shaders-mini-noise`

**Hash.** `fract(sin(p.x*0.129898 + p.y*0.78233) * 43758.5453)`. The magic numbers matter:
simplified ones (`0.12`, `0.78`) produce visible patterning. Not a ratio, not obvious.

**Value noise.** Floor to cells → hash the 4 corners → interpolate.
- `cell = floor(p)`, `sub = p - cell`
- cubic ease: `cube = sub*sub*(3 - 2*sub)`
- mix horizontally twice, then vertically once.

**Perlin noise.** Same skeleton, but interpolates *gradients* rather than *values*.
- `hash2` returns a vec2; `hash2_norm = normalize(hash2(p) - 0.5)` gives a random unit vector
- per corner: `grad = dot(dir_corner, corner_offset - sub)` — how far along the random axis
  the sample sits
- **quintic** ease instead of cubic: `sub*sub*sub*(10 + sub*(-15 + 6*sub))`
- range is ±√2, so `* (0.5/sqrt(2)) + 0.5` to land in 0..1

**The teachable difference, and the example's sentence:** value and Perlin differ in
*what* is interpolated (values vs gradients) and *how* (cubic vs quintic). Shown side by
side at the same scale and seed, that difference is visible and explains itself.

The article stops before Worley/Voronoi/fractal noise. We already ship `lm_fbm` and
`lm_ridged` (E31/E35's prelude), so fractal is in hand.

---

## 2. SDF tricks — `gm-shaders-mini-sdf-tricks`

**Circle:** `length(p) - r`.
**Box:** `b = abs(p) - s; length(max(b, 0.0)) + min(max(b.x, b.y), 0.0)`.

**Anti-aliasing is free.** `alpha = clamp(0.5 - dist/AA_SPREAD, 0.0, 1.0)`. Spread 1–3 px,
2 typical.

**Outlines are free.** `outline_dist = dist - thickness`, then blend the same way.

**Tiling is free.** Repeat the input coordinates with `mod`/`fract` — every pixel still
evaluates one shape, but you are drawing thousands. Snowflakes, rain, stars.

**Glow and soft shadows** come off the same distance field — this is the owner's ask.

> **Note for §T845:** an SDF circle with the AA formula above *is* a soft round sprite.
> Three examples have wanted one (E41 rounds quads with bloom; E45 has no bloom so its
> quads stay hard; E44's boxes read as a wall). The SDF example and the soft-shape gap are
> the same technique from two directions.

---

## 3. Radiance cascades — guest piece, Yaazarai

Alexander Sannikov's method. Noiseless GI by casting *few* rays in a *structured* way.

**Penumbra hypothesis.** A shadow's penumbra needs high *linear* resolution near the light
and high *angular* resolution far from it, and the two are inversely proportional. So trade
one for the other as distance grows.

**Cascade layout.** Cascade *n+1* has ¼ the probes and 4× the rays. Total rays per cascade
is therefore constant — cascade0 at 16×16 probes × 8×8 rays and cascade3 at 2×2 probes ×
64×64 rays are both 16,384 rays. In a 2D texture the ¼/4× becomes ×2 per dimension.

**Ray geometry**, per cascade index `n` with a base `interval`:
- `origin = interval * (1 - pow(4, n)) / (1 - 4)`
- `length = interval * pow(4, n)`
- `cascadeCount = ceil(log4(3 * diagonal / interval0 + 1))` — stop when a ray would start
  off-screen

**Per-pixel indexing:** `ray_index = (pixel.y % probeH) * probeW + (pixel.x % probeW)`,
`ray_angle = ray_index / (probeW*probeH) * 2π`.

**Merging, in reverse** — N−1 with N, down to 0. For a ray in cascade N, find the 4 nearest
probes in N+1, take the matching directions in each, and **bilinearly interpolate** by the
current probe's relative position among them. This interpolation is where "infinite rays
from finite directions" comes from.

**Ray visibility term — the part that is easy to get wrong.** Store hit as alpha 1, miss as
alpha 0. **Merge only on a miss.** A hit must block farther intervals, or the penumbra
hypothesis breaks and light leaks through occluders.

**Resolve.** Sum every ray in a probe, divide by the ray count → one texel per cascade0
probe. Scale that up with hardware interpolation.

Known limits, stated in the article: occasional light leaks, non-linear attenuation
transitions. The 4×-rays/constant-memory atlas described here is a community layout, not
the paper's 2D optimum (which scales by 2× and halves memory per cascade).
