# Silk Medusa: owner brief

Recorded 2026-11-12. This file holds the owner's original requirements, as given. The
quoted sections are the owner's text, unedited apart from formatting. Anything an agent
adds goes under "Working notes" at the end, never into the quoted sections.

Reference frames:

- [reference/choreography.png](reference/choreography.png): "Bioluminescent Jellyfish Silk Choreography" (calm / medium / peak, key art direction, colour range, musical mapping).
- [reference/stateboard.png](reference/stateboard.png): "Audiovisual Jellyfish Stateboard" (calm / medium / peak with energy, density and illumination meters, four colour moods, core music mechanics, audio to visual mapping).

## The request

> build out a project for this art direction. it is supposed to be not approximated but
> fully realized and then some, still with an aim to run reasonably at 30fps realtime. i
> want you to use subagents and the tools necessary (blender, blendkit, whatever,
> procedural, you decide what is needed). use the appropriate models for the subagents
> according to their work so we are not over or under using models re intelligence
> required and not waste tokens either.

> there is another agent working on something similar. so certain parts for harmonics and
> music generation are actually being actively developed and you can use those, its the
> harmonic-organism project that this agent is working on

In short:

- Fully realized, not approximated, "and then some".
- Runs reasonably at 30 fps in real time.
- Built with subagents, each on a model that fits its work.
- Tools are the builder's choice (Blender, BlenderKit, procedural).
- Music and harmony come from the work in progress on `projects/harmonic-organism` (the `harmony` and `noteField` nodes).

## What the reference frames say

Key art direction (choreography board):

- Alien jellyfish meets aerial silk dance
- Bioluminescent, translucent, iridescent materials
- Choreographed, music-driven motion
- Elegant negative space and deep depth
- Scalable visual complexity with musical intensity

Three states:

| State | Music | Picture |
| --- | --- | --- |
| Calm / minimal (introspective) | Sustained chords, low energy, wide space, slow motion | One jellyfish, a thin silk trail, sparse stars, near-black |
| Medium / progressing (evolving) | Chord change, growing motion, added voices, gentle rhythm | Larger performer, wide silk ribbons, two or three companions, thin luminous arcs |
| High / peak (expansive) | Climax, full harmony, complex motion, rich particles | Frame filled with ribbons, several companions, spectral arcs, dense particles |

Colour moods (stateboard): deep blue → amethyst → peach; teal → aqua → gold;
magenta → violet → cyan; amber → rose → lilac.

Mapping (both boards):

| Music | Visual |
| --- | --- |
| Melody | Path and gesture; silk motion |
| Harmony / chord | Form and layering; form and constellation |
| Energy / volume | Light and particle density; glow, bloom, trail intensity |
| Rhythm | Pulse and motion; ripple, particle flow |
| Tension / release | Expansion and flow; stretch, twist, colour shift |

## Making the rendering sane

> The core principle should be AAA visual quality through art direction and clever
> rendering, not brute-force simulation.
>
> The darkness is particularly useful here. We can make a small number of exquisite
> luminous objects feel spectacular without rendering a fully illuminated universe.
>
> **1. Treat darkness as a first-class visual parameter**
>
> Instead of making quiet moments pale, reduce the amount of illuminated space. The
> creatures retain their beautiful materials, but most of the world falls into near-black.
>
> A starting target for the proportion of the frame that feels substantially illuminated:
>
> | Musical state | Illuminated area | Visual behavior |
> | --- | --- | --- |
> | Calm | 10–20% | Isolated luminous forms, extremely dark surroundings |
> | Medium | 25–40% | More ribbons, selective halos, interacting performers |
> | Peak | 50–70% | Expanding choreography, richer particles and spectral light |
>
> These are artistic targets, not hard pixel thresholds. Sustained notes should not
> necessarily brighten the whole environment.
>
> **2. Build the jellyfish from a few inexpensive primitives**
>
> *Bell / head.* One moderately tessellated mesh with procedural deformation,
> Fresnel-based rim lighting, thin-film-inspired iridescence, and selectively masked
> emission. Avoid genuine multi-layer refraction.
>
> *Aerial silk ribbons.* GPU-deformed mesh strips driven by splines, traveling waves, and
> musical envelopes. Use a small number of beautifully choreographed ribbons rather than
> hundreds of independently simulated strands.
>
> *Tentacles and particles.* Render tentacles as thin curves or camera-facing strips. Use
> GPU-instanced particles, with the brightest points concentrated near active musical
> features.
>
> *Deep background.* A near-black procedural sky, sparse stars, and extremely restrained
> atmospheric gradients. Avoid expensive volumetric cloud rendering and full-screen
> raymarching.
>
> **3. Spend the rendering budget where it matters**
>
> Initial performance strategy:
>
> | Feature | Recommended approach |
> | --- | --- |
> | Jellyfish membranes | Deformed meshes with procedural shaders |
> | Silk choreography | GPU vertex animation |
> | Iridescence | Approximate thin-film color using viewing angle |
> | Bioluminescence | Emissive masks with reduced-resolution bloom |
> | Particles | Instancing or GPU simulation |
> | Volumetric atmosphere | Analytic depth fog and selective light sprites |
> | Distant jellyfish | Simplified meshes or impostors |
> | Transparent layers | Limit screen coverage and overdraw |
> | Audio reactivity | Uniforms, structured buffers and envelopes |
>
> Transparency is likely to become one of the biggest performance constraints. Multiple
> overlapping translucent ribbons can be more expensive than a large amount of opaque
> geometry.
>
> I would therefore introduce a transparent pixel overdraw budget, not just a polygon or
> particle count.
>
> **4. Musical activity should not directly equal computational cost**
>
> This is particularly important.
>
> A ten-note chord should not require ten expensive jellyfish, ten independent
> simulations, and ten times the particle population.
>
> Instead, map the music onto a fixed-capacity visual ensemble.
>
> For example, a chord might influence the curvature of a main performer, the appearance
> of its membrane, the positions of a few companion jellyfish, and the behavior of
> existing ribbons.
>
> New notes can redistribute an existing population of particles rather than continuously
> spawning more.
>
> This preserves musical expressiveness without unpredictable performance.

## Core music mechanics, condensed

> The system is a seeded, self-evolving composition engine, not a random chord player or a
> collection of prerecorded progressions.
>
> 1. **Harmony:** Generate possible successor chords from music theory, scoring functional
>    relationships, voice leading, tension, resolution, and novelty. Choose
>    probabilistically, allowing surprising progressions and gradual key changes.
> 2. **Melody:** Generate beautiful, independent melodic phrases that follow the harmony.
>    Use motifs, repetition with variation, expressive timing, passing notes, and melodic
>    arcs rather than randomly selecting notes from a scale.
> 3. **Backing and atmosphere:** Layer soft piano chords with restrained evolving pads,
>    delicate bass movement, resonant overtones, and occasional shimmering textures. The
>    backing fills space without overwhelming the melody.
> 4. **Rhythm:** Generate intriguing, subtly shifting rhythmic patterns, including
>    syncopation, polyrhythmic accents, and evolving subdivisions. Use gentle percussive
>    textures and rhythmic note articulation rather than relying on a conventional drum
>    beat.
> 5. **Long-term evolution:** Maintain musical memory across short phrases, longer
>    sections, and tonal changes. Let density, energy, harmonic complexity,
>    instrumentation, and rhythmic activity evolve organically, without a fixed song
>    structure or ending.
>
> For the shader graph: Harmony controls formations, melody drives the silk choreography,
> rhythm produces pulses and traveling waves, and musical energy controls illumination and
> particle activity.
>
> Crucially, keep harmony, melody, rhythm, and visual brightness independently
> controllable. A complex melody can exist in near darkness, and a simple sustained chord
> can create one spectacular luminous gesture.

## Visual familiarity: notes as characters

> Yes. You're describing visual familiarity rather than explicit identification.
>
> The viewer doesn't need to know that something represents C♯. But when C♯ returns,
> something about its visual expression should feel familiar, even if the scene, color
> palette, chord, and energy have changed.
>
> Think of it as recognizing a dancer by their movement, even when they're wearing a
> different costume.
>
> I'd design this around three principles:
>
> **1. Each note has a visual personality**
>
> Not necessarily a fixed color, position, or object. Instead, each note has a consistent
> combination of subtle characteristics:
>
> - A characteristic curvature or twist in its silk.
> - A preferred movement trajectory or orbital tendency.
> - A particular rhythmic quality to its motion.
> - A recognizable texture, shimmer, or internal structure.
> - A subtle relationship to other visual performers.
>
> These characteristics form a kind of visual fingerprint.
>
> A note might be expressed as a jellyfish, a ribbon, or a luminous current, but retain
> enough of that fingerprint to feel like the same presence.
>
> **2. Chords create relationships between personalities**
>
> A chord isn't simply three or four note-objects appearing together.
>
> It's a shared choreography.
>
> The same chord should tend to produce a familiar spatial and kinetic relationship, even
> when it returns with a different voicing, lighting, or intensity.
>
> For example, a chord might be recognizable through how three ribbons intertwine, how
> their movements synchronize, or how the jellyfish arrange themselves.
>
> When the harmony changes, some of those relationships persist while others transform.
> This gives the impression of an evolving dance rather than a succession of unrelated
> scenes.
>
> **3. Separate identity from expression**
>
> This is the key architectural decision.
>
> | Layer | Holds |
> | --- | --- |
> | Musical identity | Note · interval · chord · melodic motif |
> | Stable visual fingerprint | Shape tendencies · motion signature · relative relationships |
> | Current expression | Energy · palette · harmony · atmosphere · dynamics |
>
> For instance, the same note could appear as:
>
> - Calm: A barely luminous jellyfish slowly curling one distinctive tendril.
> - Medium: The same curling gesture becomes a floating silk spiral, illuminated in teal
>   and gold.
> - Peak: The gesture expands into an enormous iridescent ribbon, with particles tracing
>   its characteristic movement.
>
> Different visual intensity, but a familiar underlying behavior.
>
> **One refinement I'd make**
>
> I wouldn't assign completely arbitrary personalities to the 12 notes.
>
> I'd derive their fingerprints from a coherent visual grammar, so neighboring pitches
> have related characteristics and musical intervals produce meaningful relationships.
>
> Also, absolute note identity and harmonic role should both matter. The same E should
> retain a subtle recognizable quality, but an E functioning as the major third of C
> should interact differently than an E functioning as the root of E minor.
>
> That produces something much more interesting than a fixed note-to-color lookup.
>
> The goal is that someone watching for ten minutes begins to subconsciously recognize
> recurring musical characters and relationships, without ever needing to understand the
> mapping.
>
> Almost like watching an alien ballet whose dancers have individual personalities, yet
> constantly change roles, costumes, and formations.

## Working notes

- Deliverable: a Loom network, `projects/silk-medusa/silk-medusa.loom.json`, with its WGSL and point kernels embedded.
- Second file, `silk-medusa-clair.loom.json`: the same network driven by a piano performance of Debussy's "Clair de Lune" through an `automation_score` node, with the audio at `public/media/silk-medusa/clair-de-lune-piano.m4a`. The performance MIDI comes from the MAESTRO v3 dataset (CC BY-NC-SA 4.0), so the lanes and the audio are for non-commercial use and share-alike. The piano SoundFont is Salamander Grand (CC BY 3.0).
- Owner direction on motion (2026-11-12): meditative, slow, believable water friction. Music is a force, not a position: a note is an impulse that an appendage answers as a heavy damped body (builds over 0.6 to 1 s, travels tipward as a slow wave), and slow musical state sets posture over seconds. Speed is free; abrupt change is the fault (no flutter, nothing ahead of the bell). A backing pad under the piano was tried and rejected.
- Controls on the canvas: `slider_auto` (1 = the music drives the state, 0 = manual), `slider_state` (manual calm 0 to peak 1), `slider_lum`, `slider_density`, `slider_energy` (trims), `slider_palette` (colour mood offset). Added 2026-11-12, all eased 0.8 s and gathered on `panel_medusa`: `slider_cammove` (camera motion amount), `slider_camdist` (camera distance trim), `slider_herosize`, `slider_roam` (hero roaming range), `slider_react` (music reaction strength), `slider_environment`, `slider_companions` (presence), `slider_glow`, `slider_focus` (depth of field amount), `slider_journey` (colour journey: moods per minute, default 0.4, integrated so a speed change never jumps the colour; 0 holds the mood, and `slider_palette` still offsets it).
- Performance target: 1920 × 1080 at 30 fps on the owner's Apple M3 Max, measured, not assumed.
- The `harmony` node currently publishes chord state and five voices (identity, pitch, envelope), tension, brightness, energy, beat and phrase progress. Melody and rhythm layers named in "Core music mechanics" are the other agent's work in progress; this project reads whatever channels exist and must not edit that agent's files.
