# The reference prism, read from its own debug mode

Captured 2026-09-02 from `https://vgpu.sh/?debug`, which renders the live pipeline as a
node graph with working parameter panels. Everything below is quoted from that graph, not
inferred. Recorded because our own prism has been rebuilt three times against a *picture*
(T710, T718, T758) and this is the first time we have seen the *structure*.

## The finding that matters: the light is GEOMETRY, not a screen-space effect

```
Spectral light mesh   GEOMETRY
  Geometry   92,160 vertices
  Sampling   128 wavelengths × 24 beam slices
```

They build an actual mesh of the spectrum — **128 discrete wavelengths, each swept across
24 slices of the beam** — and draw it additively. The rainbow is not a gradient painted
onto a quad and it is not a screen-space refraction: it is 128 separately-refracted beams
whose overlap *is* the continuous spectrum.

That is why theirs behaves differently at the apex than at the base, and ours does not.
We have been approximating the *result* of dispersion; they are drawing the *cause*.

## Dispersion is Cauchy, with named presets

```
CAUCHY DISPERSION
  Glass preset   Stylized | Crown glass | Dense flint | Custom
  Base IOR       1.2      (the A term)
  Dispersion B   0.1      (the B term)
```

Cauchy: `n(λ) = A + B/λ²`. Per-wavelength IOR from two numbers, which is what makes 128
beams cheap to place correctly. The presets are real glass types, so the physical
vocabulary is exposed rather than hidden behind a "dispersion amount" slider.

## The pass structure, in order

| Node | Kind | Detail |
|---|---|---|
| Backdrop clear color | STATE | render-pass clear, **no wall draw**; wall `#000000` |
| Backdrop render pass | PASS | `dark.backdrop` — 1 render bundle, 4 draws |
| Backdrop HDR target | TARGET | **`rgba16float`**, full render resolution, 1× |
| 1 · Back glass draw | DRAW | `shared/glass/glass-back.wgsl`, blend **premultiplied** |
| 2 · Front glass draw | DRAW | `shared/glass/glass.wgsl`, blend **replace** |
| 3 · Exterior light draws | DRAW | `dark/passes/light/light.wgsl` — 2 draws: white beam + outgoing spectrum, **additive** |
| 4 · Internal light draw | DRAW | same light pipeline, 1 draw: internal spectrum, **additive** |
| Backdrop copy draw | DRAW | `shared/presentation/copy-linear.wgsl`, full screen |
| Studio environment | ASSET | **mipmapped equirectangular HDR** |

Edge labels seen: `internal span`, `refract background`, `reflect`, `back faces`,
`front faces`, `texture read`, `store color`, `clear attachment`.

**Front and back faces are separate draws with different blend modes.** Back faces
premultiplied, front faces replace, then light added over both. We draw the body once.

## Exposed parameters, verbatim

- **Beam geometry** — Width `0.025`, Pointer top `-35°`, Pointer bottom `75°`
- **Cauchy** — preset, Base IOR, Dispersion B
- **Light appearance** — Beam opacity `1`, Edge falloff `16`, Rainbow rate `3.8`, Rainbow power `3.7`
- **Transmission** — Surface IOR `1.645`, Absorption R/G/B
- **Environment reflection** — Reflection strength, Environment exposure

Note the two IORs are *different numbers*: the beam geometry refracts at `1.2` (base, before
dispersion) while the glass body transmits at `1.645`. The light and the body are separately
parameterised, which is only possible because they are separate passes.

## What this says about ours

1. **Our beam is faked and theirs is built.** The single highest-value change is drawing N
   wavelength beams as geometry rather than tinting one beam.
2. **A studio HDR environment is doing a lot of the work.** Ours has no environment asset.
3. **Their body is two draws (back, then front) with different blends.** Ours is one.
4. **An HDR target with a separate linear copy at the end**, rather than compositing into
   the display buffer as we go.

This is a reference for a Prism v2, not a spec for one. It is not our architecture and
copying the pass list would be the wrong lesson; the transferable finding is the first one.
