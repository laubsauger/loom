# E45 — Pulse

A VJ set, not a picture. Two complete shots trade the frame on musical structure: a
**constellation** — six hundred drifting points webbed to their nearest neighbours, the
web tightening on the beat — and a **scanline** — a rain of rays marching across an
unseen terrain once per bar, drawing the ground as a moving ridge of embers. A value held
for four bars decides how much of each is on screen; the crossfade lands on a phrase
boundary, never on a timer. Between boundaries the mix **holds**. That hold-and-cut is
the owner's own definition of evolution — "blend and swap between different shots in a
single scene" — and it is a claim in the test suite, not a hope.

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
`customWgsl`, driven by the same enveloped high band — so the tears land on hits and the
quiet passes untouched. Every band drive here goes through an envelope (fast attack, slow
release) before it touches anything visible; a raw per-frame band is jitter, which is a
lesson this catalogue has now paid for twice.

## What to drive

- `prox1.radius` — THE knob. Wider = denser web; drive it from anything.
- `step1.every` — phrase length in bars. 1 = cut every bar, frantic; 8 = long holds.
- `spliceP1.amount` — the tear. Already on the high band; scale `hd1`'s operand.
- `beat1.bpm` — the whole set's clock; every hold and sweep follows it.
