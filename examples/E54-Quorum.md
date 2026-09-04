# E54 — Quorum

Four communities find each other in the dark, agree on a colour, and hold. Nothing in this
file says where a cluster goes or what shade it is — one operator does both jobs, and the
picture is that operator converging.

## One matrix, read twice

A force-directed layout **is** gradient descent on the graph Laplacian: spring attraction
along edges minimises `xᵀLx`, and the low-energy configurations **are** the low
eigenvectors. Diffusion over the same operator is power iteration: averaging a value with
its neighbours, over and over, drives it toward those same low eigenvectors — which is
exactly what "colour by community" means.

So `mesh1(pointKernel)` runs a single loop over every pair of points, and inside it one
weight `w` accumulates two things: a positional pull (the layout) and a colour average (the
embedding). The clusters and their colours are not two effects that agree. They are one
matrix, read twice.

The weight has two positive terms. A **background tie** on every pair at every distance —
that is what makes this one field rather than four that drift apart the moment they lose
sight of each other. A **community bond** on top, only between two points of the same
community and only inside `reach`. **Contrast** is the ratio between them; at 0 they are
equal, the operator cannot see the blocks at all, and the field can only be one blob.
Keeping communities apart is a separate **Coulomb push** over every pair inside the same
radius, which is also what stops a settled community from contracting to a single point.

## What is authored, and what emerges

**Authored: the graph, and nothing else.** Which community a point belongs to is a hash of
its **id** — a stochastic block model, 26 / 20 / 15 / 11 % of the population in four
communities and the remaining 28 % affiliated with nobody. That is not a cheat, it is the
input: a Laplacian is an operator *on* a graph, and a graph with no community structure has
no communities to find. The split is deliberately lopsided; four equal blocks settle into a
rosette that looks designed.

**Emergent: everything you can see.** Where each cluster sits. How tightly it holds. Which
bridges survive between clusters. How large each node draws — that is its weighted degree in
the community graph, measured in the same loop. And what colour each community settles on:
the seed colours are one independent random draw per point per channel, and four coherent
hues come out of that noise because the operator puts them there.

**The proof is one parameter.** `mesh1`'s Seed feeds the scatter that starts the field and
nothing else; every fact about the graph comes from a separate identity hash that does not
read it. Change Seed and the same graph starts somewhere else — the same communities condense
in different places, wearing the same colours. `e54-quorum.gpu.test.ts` renders both seeds
and asserts exactly that, in both directions: the layouts differ, the palette does not.

## How a point sees a neighbour

Until T1070 a point kernel was a pure per-point function: one point, no way to reach another.
The catalogue's only neighbour query is Proximity, whose answer is a drawable link set rather
than data a kernel can consume, and a kernel over links cannot scatter back to points — this
project's points machinery has no atomics. Every coupled system in the shipped set is
therefore an honest fake and says so; E16's flock is a shared flow field whose birds never see
each other.

`pointAt(slot)` hands a kernel the Point in another slot, read from the same **pre-frame
half** the wrapper loads `p` from. That is the whole of its correctness: every reader sees
last frame's values whatever order the workgroups ran in, so a coupled update is a Jacobi
iteration — order-independent, device-independent, reproducible frame for frame. It costs no
binding and no uniform; it is sugar over storage the wrapper had already bound.

The cost is O(N²), stated rather than hidden: 480 points is 230k pair evaluations a frame.

## One reach, two consumers

The kernel's `reach` and `web1(pointProximity)`'s Radius are the same number, both reading
`reach1(valueMath)`. A picture that draws links its operator is not using lies about its own
mechanism, so every filament on screen is one of the operator's own edges — the six strongest
at each node. `bound1(pointRange)` parks the unaffiliated before the query runs, because the
background tie is identical for every pair in the field and so carries no structure: it is
the field, not a filament. The unaffiliated are still drawn — `dots1(geometry)` reads the
full set — as loose points joined to nothing, which is what they are in the graph.

Two render passes, one camera, and the split is why the haze has a colour at all: blurring a
single render that held both layers would smear 2880 pale filaments over 480 coloured nodes
and the bed would come back grey. `haze1(blur)` blurs the **nodes**, so the bed pools where
the graph is dense because the graph is dense there, in each community's own colour.

## The instrument

It rests and strikes rather than vibrating. The structural move is on the **phrase**:
`cstep1(valueStep)` holds a value for four bars and `clag1(valueLag)` eases it into Coupling.
92 % of its draws land inside the limiter rather than on it, so the phrases genuinely settle
and open — condensed while the colour resolves out of the seed field, open from 8.3 s with
the communities interpenetrating, alternating after — a different picture, not a wobble. That
is stated as a **duty cycle** and not as a range on purpose: the version that stated it as a
range spanned 2.6 into a clamp 0.7 wide and spent thirty-three continuous seconds pinned at
maximum coupling, which from outside is a step that never fires. The second lane says the
same thing: `dstep1 -> dlim1 -> dlag1` shoves the two closest colonies through each other on
55 % of its two-bar draws — ten times in the first minute, never silent for more than 8.3 s —
and lets them separate again into a new arrangement, which is why the ring comes back in a
different order instead of the same one. The
fine motion is on the **beat**: the high band drives `reach1`, so connection density is the
music made visible; the web tightens on a hit and thins in the quiet. Nothing else runs on a
free clock but the hue, which turns once every 80 seconds, and the nebular bed, which drifts.

Four knobs on `mesh1` are left bare for a hand, and each range goes somewhere:

| knob | at zero | turned up |
| --- | --- | --- |
| Contrast | one undifferentiated blob — the block structure is invisible to the operator | four communities that barely acknowledge each other |
| Repulsion | every community collapses to a single dot | clusters open into lace, then drift apart |
| Diffusion | the seed dust never agrees on anything | communities resolve in a few frames |
| Anchor | every community melts into one colour | back to salt-and-pepper noise |

`clock1(valueSwitch)` is the tempo seam: at index 0 it is the deterministic pattern that
ships, and one flip puts a real track's analysis in its place.

## The chain

```
mesh1(pointKernel) -> bound1(pointRange) -> web1(pointProximity) -> links1(geometry) -> webs1(render) -> thread1(level)
mesh1(pointKernel) -> dots1(geometry) -> nodes1(render) -> haze1(blur) -> pool1(multiply) <- neb1(noise)
pool1(multiply) -> bed1(hsv) -> sum1(add) <- nodes1(render), thread1(level)
sum1(add) -> glow1(blur) -> lit1(add) -> mask1(multiply) <- iris1(ramp)
mask1(multiply) -> paint1(hsv) -> out1(output)
beat1(audioPattern) -> clock1(valueSwitch) -> hsub1(valueMath) -> henv1(valueLag) -> rgain1(valueMath) -> reach1(valueMath)
clock1(valueSwitch) -> cstep1(valueStep) -> cmul1(valueMath) -> csub1(valueMath) -> clim1(valueLimit) -> clag1(valueLag)
hue1(lfo) -> paint1(hsv)
cam1(camera) -> webs1(render), nodes1(render);  ink1(materialUnlit) -> links1(geometry), dots1(geometry)
```

## Three cuts that failed, and why

Recorded at their lines in the kernel, because each was a plausible design:

- **A negative between-community weight**, to force the clusters apart. It laid out
  beautifully and destroyed the colour — a signed operator makes the power iteration
  anti-align, and after clamping the whole field came back grey. Separation is the push's
  job, not the weight's.
- **An unbounded Coulomb push.** The aggregate of many negligible far pairs, each one
  outward, blew the field clean off the frame inside a hundred frames.
- **A hard containment sphere.** Every point the push sent outward piled onto it, and the
  picture wore a wire cage.
