# E54 — Quorum

Three slime molds share one piece of ground. Nothing here says where a corridor goes or which
army holds it — agents lay a trail, smell it, and follow it, and the network you can see is
what that keeps doing.

## Two halves that had to be argued into one file

**The motion is a trail system.** `mesh1(pointKernel)` runs three thousand agents. Each one
deposits into a trail field, reads it a little way ahead through three sensors, turns toward
the better one and walks. The field decays. That is Physarum, and it was chosen for one
property: **it has no fixed point to fall into.** Corridors form because a path that gets
walked gets stronger; they die because a path that stops being walked fades; and both happen
at once, forever, because the same agents that thicken one corridor are abandoning another.

**The picture is nodes and a web.** `web1(pointProximity)` links each drawn agent to its six
nearest and `links1(geometry)` draws every link, so what is on screen is discrete units with
visible relationships between them. Because the units are actually going somewhere, the web
genuinely forms and breaks instead of converging on an adjacency and holding it.

**And the two halves want opposite populations**, which is the finding this file cost. A
trail system wants MANY agents — below about a thousand the field stops being a medium they
can find each other through and each army collapses to a single thread. A drawn k-nearest web
wants FEW: agents on a trail sit far closer to each other *along* it than the corridors sit
apart, so all six of a point's nearest are its own immediate line-neighbours and the web
renders as a bead chain rather than a network. Rendered at 3000, 2400, 900, 600, 420 and 250
agents, and the two failures meet in the middle: there is no count that is both. So the
scales are separated rather than averaged. Three thousand agents deposit and steer;
`bound1(pointRange)` parks all but the half with the lowest `sense.z` — a fixed per-agent
draw, so the sample never changes and a node cannot flicker in and out of the picture —
before the web is computed. Sampling lifts the spacing between drawn nodes enough that a link
reaches across to the next corridor instead of down its own.

## Three armies, one channel each

Red, green and blue. An agent is drawn to its own channel and pushed away from the other two,
and how hard it is pushed is **Envoy**, the phrase knob. So colour is not something an
operator has to resolve out of noise: colour **is** the channel, territory is where a channel
dominates, and two armies merging their ground is simply two channels overlapping. The nodes
go near-white and the armies' colours reach the frame through the haze.

**Authored: the armies, and nothing else.** Which one an agent belongs to is a hash of its
index — 42 / 34 / 24 % of the population, deliberately lopsided — and it never changes.

**Emergent: everything you can see.** Every corridor, every junction, every loop, where the
fronts run, which army holds which ground, how large each node draws (that is the depth of
the trail underneath it, measured in the same loop that steers), and how long any of it
lasts. Measured, the population is 42/34/24 and the territory is near-equal, with the lead
changing hands three times over a minute: a small army holds proportionally more ground per
agent, because a trail saturates and a crowded one wastes itself on scent already there.

## It does not settle, and that is the claim

Asserted as a **lag profile** over territory rather than as a churn number, because a churn
number cannot tell reorganisation from flicker — an earlier candidate for this file looked
sustained and its lag profile said *2-cycle*: odd lags flickering, even lags exactly zero.
Of the texels the trail holds in both frames, the fraction that changed hands climbs
monotonically from under 2 % at one frame to the high sixties by four seconds, at three base
frames twenty seconds apart, with no odd/even alternation anywhere. And the ceiling is
derived rather than chosen: with shares near 31/34/35 the Simpson index `1 − Σp²` is about
0.66, so past four seconds ownership is statistically independent of ownership now and the
profile can climb no further. The web says the same thing in pixels — four seconds on, almost
none of it is the same web.

## What this replaced, and what was given up

Until T1138 the operator here was a **graph Laplacian**: one loop over every pair of points
accumulating a positional pull and a colour average under the same weight, so the clusters
and their colours were one matrix read twice. It is a good idea and the file proved it. It is
also, exactly, gradient descent on a fixed energy — so settling was not its bug, it was its
purpose, and nine attempts to make it keep reorganising failed for that one reason. The
kernel's docblock keeps all nine measurements, because they are the reason not to try any of
them again.

Given up with it, said plainly: **the cross-seed community claim.** There is no operator
resolving hues out of a seed field any more, so "change Seed and the same communities condense
somewhere else wearing the same colours" is not a sentence this file can say. Colour is now
assigned rather than found — a smaller claim about colour, bought for a much larger one about
motion.

## The instrument

The phrase is **Envoy**, held four bars and eased in, landing 83 % of its draws inside its
limiter. At the floor each army keeps hard to its own network; at the ceiling the fronts
interpenetrate — measured, half again to twice the contested ground and a quarter more trail,
on one knob. The two-bar step is the **deposit**, how much scent a footfall leaves. On the
beat, the high band drives **Sense Distance**, which is *also* the web's radius, so a hit both
lengthens the agents' reach and thickens the drawn network. Neither lane has a silent state:
both ends of both are pictures, so the worst case is a different picture rather than no
picture.

| knob | at zero | turned up |
| --- | --- | --- |
| Envoy | the armies stop avoiding each other, share corridors and the field thins | three hard-edged networks with sharp fronts between them |
| Sense Distance | agents cannot smell past themselves and the network never forms | a few thick trunks and long links |
| Turn | agents cannot lock onto a corridor at all | every corridor is followed rigidly |
| Wander | the network consolidates and stops inventing new paths | it never consolidates at all |

`clock1(valueSwitch)` is the tempo seam: at index 0 it is the deterministic pattern that
ships, and one flip puts a real track's analysis in its place.

## The chain

```
mesh1(pointKernel) -> sow1(renderPoints) -> mix1(add) <- spread1(blur)
trail1(feedback) -> spread1(blur) -> mesh1(pointKernel)
mesh1(pointKernel) -> bound1(pointRange) -> web1(pointProximity) -> links1(geometry) -> webs1(render) -> thread1(level)
bound1(pointRange) -> dots1(geometry) -> nodes1(render) -> haze1(blur) -> pool1(multiply) <- neb1(noise)
bound1(pointRange) -> frontdots1(geometry) -> nodes1(render) -> white1(hsv)
pool1(multiply) -> bed1(hsv) -> sum1(add) <- white1(hsv), thread1(level)
sum1(add) -> glow1(blur) -> lit1(add) -> mask1(multiply) <- iris1(ramp)
mask1(multiply) -> paint1(hsv) -> out1(output)
beat1(audioPattern) -> clock1(valueSwitch) -> hsub1(valueMath) -> henv1(valueLag) -> rgain1(valueMath) -> reach1(valueMath)
clock1(valueSwitch) -> cstep1(valueStep) -> cmul1(valueMath) -> csub1(valueMath) -> clim1(valueLimit) -> clag1(valueLag)
clock1(valueSwitch) -> dstep1(valueStep) -> dlim1(valueLimit) -> dlag1(valueLag) -> mix1(add)
hue1(lfo) -> paint1(hsv)
cam1(camera) -> webs1(render), nodes1(render);  ink1(materialUnlit) -> links1(geometry), dots1(geometry)
```

## Four things that failed, and why

- **Drawing the trail field itself**, with the agents as bare particles. It renders as a
  handsome slime mold and it has no relationships in it to watch: *"we don't see these
  networks that are disintegrating and integrating — the different units are like tiny specks
  now."* Correct, and the reason the web came back.
- **An additive deposit.** A trail answers "is this path walked", which is bounded; additive,
  a dozen agents standing together leave a dozen times the scent, and a saturated texel has no
  gradient left for the three sensors to answer.
- **A long trail memory.** At persistence 0.85 and 0.95, across every deposit and wander
  tried, the network coarsens within a minute to a handful of thick cables: a corridor's pull
  is its traffic times its memory, so the busier corridor is proportionally stronger and
  nothing stops it taking the rest. The memory this file runs on is where the agents are.
- **A 16:9 trail grid.** The agents' space is isotropic, so a widescreen grid makes a world
  unit 1.78x more texels across than up: the sensors reach further sideways than forwards and
  the trails bend toward the vertical. The grid is square.
