# E14 — Self-Regulating Bloom

A bloom that watches itself. An `analyze` node meters the finished frame's average
luminance, and a proportional controller trims the picture's brightness toward a setpoint.

The meter reads the finished frame — glow, palette, everything — and a `channelIn` brings
that number back into the value graph. An LFO meanwhile breathes the noise field's
amplitude up and down to give the controller something to fight. This is §V144's
image → parameter → image loop, closed through processing for the first time (§V615):
before `channelIn` existed the measured channel could drive a parameter directly, but
nothing could subtract it from a target, scale it, or clamp it on the way.

## Graph

```
sway(lfo 0.013 Hz) ─► field.amp        (the disturbance)

field(noise) ─► gain(level) ─► clipbase(limit) ─┬─► cut(level) ─► clip(limit) ─► halo(blur) ─► tint(lookup) ─► glow(add).in1
                    ▲                           └────────────────────────────────────────────────────────────► glow.in2
                    │ brightness                          palette(ramp) ─► tint.lookup ◄─ phase: swirl1
                    │                                     glow ─► out(output)
                    │                                     glow ─► meter(analyze "meter1")
                    │
  probe(channelIn "meter1") ─► neg(valueMath ×−1) ─► err(valueMath +0.18) ─┬─► push(×2) ─► lift(+1.3) ─► clampg(valueLimit) ─► engage(valueSwitch) = "gain1"
                                                                           │                              rest(constant 1.3) ─► engage.in2
                                                                           └─► swirl(×0.15) ─► swirlbias(+0.03) ─► swirlclamp(valueLimit) = "swirl1"
```

The controller, spelled out: `gain1 = clamp(1.3 + 2.0 · (0.18 − meter1), 0.8, 1.8)`.
Too bright and the brightness comes down; too dark and it comes up. `err1` is the shared
error; a second tap scales it into a small palette-phase nudge, so the halo's colour
leans warmer when the picture is starving and cooler when it is overshooting.

`engage` is the experiment, shipped: index 0 is the closed loop, index 1 swaps in
`rest`'s bare 1.3 — the open loop, one integer away, with everything else identical.

## The stability argument, with the measurements it rests on

A feedback loop is not stable because it feels gentle; it is stable because its loop
gain is below one. Both numbers here are measured, not assumed.

One sentence about *where* they are measured, because §V618 exists: every meter number
in this file is a LINEAR-light mean — the space `analyze` reduces in, reading the
working texture before the output's display encode. The pictures described are the
display-encoded tile a viewer sees, where the settled 0.206 linear averages out near
mid-grey — a document vague about which of those two spaces its numbers live in is
how a loop gets tuned against one image and judged against another.

**The plant.** With the controller frozen, brightness `b` in, meter out (640×360, the
settled frame): 0.80 → 0.110, 1.00 → 0.138, 1.20 → 0.166, 1.40 → 0.203, 1.60 → 0.250.
Local slope at the operating point (b ≈ 1.35): **G ≈ 0.23** meter per unit brightness.

**The loop.** Two paths close it. The brightness path contributes K·G = 2.0 × 0.23 ≈
0.47; the palette path (phase sensitivity measured at ≈ +1.8 meter per unit phase,
times the 0.15 tap) adds ≈ 0.27 more, in the same corrective direction. Total loop
gain **≈ 0.7**, and the measurement arrives one frame late (§V144), so the closed loop
is a delayed iteration with coefficient −0.7: it *overshoots on alternate frames* and
each overshoot is 0.7 of the last. That is exactly what ships: from a cold open the
meter reads 0.216, 0.194, 0.207, 0.199, 0.204… settled to ±0.001 within a dozen
frames. The ringing on open is not a flaw; it is the loop gain, visible.

**And the argument's blind spot, which this file paid for (§V616, §B124).** That 0.7
was computed, correct, and *silent about the wrap*: the first builds of this exact
loop saturated to a white frame in five frames with a loop gain their linearisation
said would settle. Local gain describes behaviour near the operating point; the ramp's
seam at zero is not near the operating point, and crossing it flips the loop's sign. A
correct stability number and a saturated white frame at the same time is the failure
to carry out of this example — see the palette section below for the mechanism.

**The residual.** It settles near 0.206, not at the 0.18 setpoint. A proportional
controller holds its output by *leaning on* the error, so the error never quite
reaches zero — the offset IS the mechanism, honestly displayed. Integral action would
remove it; the value graph has no integrator node, and this example does not pretend
otherwise.

**The regulation.** `sway` swings the field's amplitude ±0.35 over a 77-second cycle.
Open-loop that swings the meter 0.172 peak to peak; closed, 0.114 (both measured with
the sway sped up to 0.1 Hz so one run covers whole cycles). The ratio is 1/(1+L) doing
what it says — attenuation, not elimination: the residual *moves* with the
disturbance, because leaning on a moving error means following it. Flip `engage` to 1
and watch the difference disappear. And a correction to an earlier draft of this very
file, kept because it is instructive: the clamp does NOT saturate under the shipped
sway — at the sway's trough the loop settles at 0.189 with the gain near 1.28, well
inside its rails (measured, ceiling 1.8 against ceiling 6: identical pixels). The
rails' real job is below.

## The wrap is the trap (§V616)

The palette-phase tap looks innocent and very nearly wasn't. A ramp is periodic: a
NEGATIVE phase wraps the mask's near-zero majority — the whole background — past
position 0 into the ramp's white top end. Measured, a phase of just −0.02 lifted the
settled meter from 0.51 to 0.94: the background goes white, the meter reads brighter,
the error grows, the phase goes more negative. Negative feedback becomes positive at
the seam — §V616's statement, and this file is §B124, the build it was minted from.
`swirlbias` (+0.03) and `swirlclamp`'s floor (0.005) keep the phase on the safe side
of the wrap; the floor is gated, not commented, and the gpu gate reproduces the
runaway with the floor removed so the guarded picture and the runaway stay
distinguishable (§V461). Positive phase, by contrast, shifts the visible halo *up*
the palette gently and correctively — which is why the tap gets to exist.

## The rails, and what they actually hold

`clampg`'s 0.8–1.8 is not exercised by the sway (measured above). It is the guard
rail for the **stability boundary**: `push` is a knob, and past ~4 the loop's
coefficient crosses −1 and the picture pulses instead of settling. With the rails,
that pulse is bounded — meter swinging ≈0.11 to ≈0.41; with the rails opened the same
K slams the frame between black and blown (0.004 to 0.67, measured). The clamp is what
makes the instability *survivable to look at*, which matters in a file that invites
you to go find the boundary.

## The first frame tells the truth about latency

`analyze` answers with the last COMPLETED readback (§V144): the value visible while
frame N renders is the reduction of frame N−1, and on frame 0 there is nothing
completed at all. `probe`'s fallback is set to the setpoint itself, so frame 0 renders
at exactly `lift`'s base — the loop takes hold on frame 1, and the opening ring you
see IS the one-frame contract, not a defect. Pause the transport and the meter
freezes with the picture; the analyze node's staleness age (§V329) counts up in its
info popup while everything else stands still. Nothing here hides that the measurement
is a frame old — the example is tuned so you can watch it being a frame old.

Both `limit` nodes are E4/E34's lesson standing guard: `gain` and `cut` are signed
pipelines whose black points emit negatives, `blur` spreads them, and `add` would
subtract the halo from the picture — `clipbase` and `clip` pin the floor before
anything downstream can see it.

## What to look at

- **The open.** Brightness visibly ringing — two or three alternating over/undershoots
  — then settling. That decay ratio is the measured loop gain.
- **`engage`.** Flip it to 1: same sway, no controller, and the slow breathing gets
  visibly deeper. Flip it back and watch the loop re-acquire with the same ring it
  opened with.
- **`gain1` in the parameter panel**, sliding slowly against `sway`'s breathing: the
  controller doing its job in plain sight.
- **Kill `e-glow-meter`.** The channel disappears, `probe` falls back to the setpoint,
  the error reads zero, and the picture drifts with the sway, unregulated — the open
  loop reached a second way, by absence instead of by switch.
- **`push.operand` — THE stability knob.** 2 ships (ratio ≈ 0.7); at 4 the ring barely
  decays; past that it grows into a bounded pulse — bounded because `clampg` is
  holding it. The boundary is real and you can cross it safely.
- **The halo's hue** leaning warm when the field starves and pale when it floods:
  the same error, spent twice.
