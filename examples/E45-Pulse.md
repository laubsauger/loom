# E45 — Pulse

Two complete shots trade the frame on musical structure: a **constellation** of six hundred
webbed points, and a **scanline** raking an unseen terrain. The cut lands on a phrase
boundary, never on a timer.

A VJ set, not a picture. The constellation's points drift, webbed to their nearest
neighbours, and the web tightens on the beat; the scanline is a rain of rays marching
across the terrain once per bar, drawing the ground as a moving ridge of embers. A value
held for four bars decides which is on screen, and it **cuts hard** — the held pick is
reshaped toward the poles, so most phrases are one shot alone and a blend is the exception.
Between boundaries everything **holds**. That hold-and-cut is the owner's own definition of
evolution — "blend and swap between different shots in a single scene" — and it is a claim
in the test suite, not a hope.

## Downtime is a state of the picture

The pattern's own arrangement drops the top end in the last bar of every four, and the
frame follows it down: the web exists only while the music does (silence holds zero
links — that is the design, asserted both ways), the rain stops, the dots fall to a
quarter of themselves, and the ember ridge cools to a trace. Quiet **looks** quiet — the
same phrase's breakdown bar is measurably darker than its pattern bars, cross-frame in
the suite — which is what gives loud something to be louder than.

## The colour evolves on the same structure

A second phrase-held value (its own seed, so palette and shot select independently)
swings the whole frame's hue through ±160° in one `hsv` turn, snapping on the boundary
so the cut and the colour land together. Hue rotation on purpose, not a lookup remap: a
hue turn preserves luminance exactly, so the additive glow keeps reading while the
palette becomes the thing that changes per phrase — one axis of evolution that adds no
density at all.

## The constellation is the new node's sentence

Shot A is `pointProximity` doing the one thing it was built for: each point linked to its
nearest neighbours, the links drawn as beams with the node's own distance-fade in their
tint — nearer links brighter, absent links zero-length and free. The **radius rides the
high band** (rest-subtracted, then enveloped), so connection density is the music made
visible: the web knits on the hats and dissolves in the quiet. The swarm itself is
derived, never integrated — each point's orbit comes from its own index and the clock, so
a scrub reproduces and the low band's breath scales the whole body without a particle of
state.

## The scanline is the rays' own shot

Sequential shots do not composite, so they do not dilute: the rays that would have
muddied the constellation get the frame to themselves. A line of casters sweeps
front-to-back exactly once per bar (`barPhase` **is** the position, so the sweep is
timeline-anchored and a scrub lands mid-stride), each firing a `pointRay` march down at a
noise terrain that is never drawn — the amber impact ridge and a sparse rain of beams say
the relief on their own, hot where the ground is near, gone where the ray ran out.

## The set

`audioPattern`'s bar count feeds `valueStep` — hold four bars, then step to a new value —
and a short `valueLag` turns each step into an eased crossfade on `cross`. The held value
is continuous on purpose: a phrase parked at 0.8 is the scanline with the constellation
ghosting through it, which is the "blend" half of the owner's sentence; phrases near the
poles read as clean cuts. The claim is exact and cross-frame: the held mix may change
**only** when the 4-bar phrase index changes, asserted channel-by-channel over 1,900
frames — a timer-based cut fails it on its first frame.

The glitch is global, not a shot: E43's splice kernel reused byte-for-byte in a
`customWgsl`, driven by the enveloped high band through a threshold — so the tear is an
**event**, a burst of chromatic-aberration and horizontal slicing on a strong hit, not an
ambient strobe. Every band drive goes through an envelope (fast attack, slow release)
before it touches anything visible; a raw per-frame band is jitter, which is a lesson this
catalogue has now paid for twice.

## One node exchanges the clock

Every lane references `clock1`, never the audio pattern directly. `clock1` is a
`valueSwitch` with the pattern on its first input, so the whole set's tempo source is one
node to swap. This is the seam for a real track: a file publishes no bar or barPhase, so
playing to one means an `audioPattern` beside it at the known BPM — wire that as the
switch's second input and flip Index, and pattern↔track is a one-node change instead of
rewiring every drive.

## What to drive

- `prox1.radius` — THE knob. Wider = denser web; drive it from anything.
- `step1.every` — phrase length in bars. 1 = cut every bar, frantic; 8 = long holds.
- `paint1.hueoffset` — the palette. Already phrase-held; point it at anything else.
- `spliceP1.amount` — the tear. Already on the high band; scale `hd1`'s operand.
- `beat1.arrangement` — the downtime's depth. 0 flattens the breakdown away entirely.
- `beat1.bpm` — the whole set's clock; every hold, sweep and breakdown follows it.
