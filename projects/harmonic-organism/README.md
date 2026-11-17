# Harmonic Organism

A seeded, continuing piano composition and suspended visual instrument. Open `harmonic-organism.loom.json` in Loom and press Play; a browser gesture enables audio. Reopen the saved network to load external file edits into an existing editor session.

The [approved concept](art-direction.png) remains the artistic reference. This is a working revision; technical validation does not establish that it matches that reference’s photographic finish.

## Current composition

Harmony scores functional chord candidates and actual voicings, with a separate bass, restrained upper spacing, tendency resolution, repetition memory, borrowed harmony, and related-key exploration. Harmonic rhythm varies with tension. The tempo remains the actual quarter-note clock.

A persistent four-cell melodic motif develops across variable-length phrases. Bass, accompaniment, and melody have separate dynamics and articulation. Cadences leave space; weak-beat dissonances resolve by step. The composition has no stored progression or finite song timeline. Five harmonic voices remain available as graph channels; additional melodic events reach the same per-pitch signal bus and piano player.

The piano uses recorded Salamander Grand Piano samples, two velocity layers, measured tuning correction, overlapping key releases, and a finite stereo room response. A fixed soft output bound retains headroom as releases accumulate. Loading is explicit and holds musical time. Missing recordings report an error; there is no substitute instrument. The lossless bank adds about 65 MB to shipped assets and about 195 MB of decoded audio memory, shared per AudioContext.

Music checkpoint version is **3**. Earlier versions are explicitly rejected because the state, timing, and event identity model changed. Checkpoints include harmonic time, phrase development, and melodic memory. The same seed and configuration reproduce the revised composition.

## Visual instrument

Two fans contain 48 individually mapped strings. The bank begins at the bass octave, keeping the authored register’s bass and melody on the instrument. Persistent note identity, exact onset, and finite envelopes drive plucks and a brief outward wave; there is no continuously looping light chase.

One brushed bronze structural ribbon and two thin glass ribbons turn together. Their paths move slowly between notes; attacks create small torsional changes. Thin-film color is confined to angle-dependent reflections. Crystals have real bevel faces and sit in a separate suspension plane. `clearance.json` records conservative analytic bounds for pendant and cable separation from the ribbons and maximum string deflection. Projected overlap at some viewing angles is occlusion, not a physical intersection.

Five restrained note lights follow the pendants. The scene uses small brass fittings, ceiling wires, a shadowed key, brushed concrete, a filtered half-resolution planar reflection, and a depth-aware finish. Kernels are analytic, not physical cloth/string simulations; offline reviews therefore use `--warmup 0`.

## Controls

- `harmony_score`: seed, tempo, initial key/mode, complexity, evolution, energy, volume. This patch starts at complexity **0.52**, energy **0.55**.
- `slider_rotationSpeed`: shared turn in degrees/second; **0** holds the turn, default **2.8**.
- `slider_reactivity`: note motion/light strength, range **0–2**, default **1**.
- `slider_particleDensity`: sparse dust population.
- `notefield_attractors`: spatial scale, visual intensity, color richness.

## Review and verification

`renders/piano-review-v3.wav` is a 48-second capture of the actual live composition. `renders/kinetic-review.mp4` pairs a short offline motion review with the corresponding opening of that audition. Earlier `piano-review` files are retained for comparison. The preview is not an added offline audio-export feature: ordinary `pnpm render` video is still silent.

The project roundtrips through Loom’s versioned serializer and loader with **82 nodes**, no external project assets, and no load diagnostics. Piano samples are built-in instrument assets. The live editor bridge was unavailable, so network persistence used the supported file-only serializer route; GPU validation uses Loom’s normal renderer.

75 focused model/channel/player/loader/session tests and a real Chromium audio test pass. Typecheck and lint pass; lint retains four existing warnings. Production build and runtime measurements are recorded alongside the review artifacts. Previous structural gates passed 2327 tests with one unrelated failure on retained scalar tint values in `projects/silk-medusa/silk-medusa.loom.json`; that project was left untouched.

`browser-proof.json` records editor playback, diagnostics, and published musical channels. `performance.json` records Dawn/Metal frame extents separately from the editor. Measurements describe this machine and interval, not every device or arbitrary concurrent GPU load. The project’s 2 GiB allocation ceiling accommodates the loader’s conservative node-based estimate; it does not allocate 2 GiB eagerly. Actual GPU resources are measured in the performance report.

Optical limits: screen-space glass cannot refract objects absent from the rendered image. Thin-film studio reflections and the depth-aware finish are artistic approximations, not traced optics.

## Recording attribution

**Salamander Grand Piano v3, Alexander Holm — CC BY 3.0.** Original license and attribution: `src/assets/piano/LICENSE.txt`. Pinned origins, revision, tuning measurements and checksums: `src/assets/piano/instrument.json`. Include the attribution when distributing recordings of this instrument. Local sharp-note filenames use `sharp` so URL fragment syntax cannot break Vite imports; source recordings and checksums are unchanged.
