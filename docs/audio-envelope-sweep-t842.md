# The audio-drive envelope sweep (§T842)

The class behind §T820 (E27) and §T824 (E43): a per-frame audio BAND driving a
*continuous* slot with no `valueLag`/`valueFilter` between them reads as jitter — the
shader's own §V681 warning ("glitch that merely wobbles per-frame is noise") generalised
to every reactive parameter. §V775 says closing two instances by accident does not close
the class, so this is the full enumeration.

## Method

`scratchpad/sweep-t842.ts` loads all eleven audio examples, and for every **driven** slot
traces the value lane back to its `audioPattern` source, flagging whether any
`valueLag`/`valueFilter` sits on the path. The eleven: audioRd, corona, descent, nave,
novaTorus, pasture, pulse, relief, rosette, splice, wake — 56 driven slots total, matching
§T821's count.

## The verdict: the pump-jitter class is closed by two fixes

**Every continuous-band → continuous-drive lane in the tree now carries an envelope.** Only
two ever lacked one, and both are fixed:

| Example | Slot | Band lane | Fix |
|---|---|---|---|
| E27 Relief | `lift1.value1` | `kick1:low` | §T820 — `valueLag` inserted (`… > valueLag > valueMath`) |
| E43 Splice | `splice1.amount`, `punch1.opacity` | `gd1:high`, `ed1:low` | §T824 — `genv1`/`lenv1` `valueLag` (this working tree) |

The E43 fix is judged on the frame the way §T809 measures: `f0max` **unchanged**
(0.3874 → 0.3874) proves the 3/s deal-slam clock survives untouched — the §T749
hold-and-slam is the shader's own `floor(absTime·DEALS)`, independent of `amount` — while
`phrase` falls 0.04805 → 0.03713 (−23%): the per-frame band wobble is gone. Both numbers
move together and both are recorded (§V751).

## The RAW slots that are NOT defects (should slam, not pump)

Six driven slots reach their parameter with no `valueLag`/`valueFilter`. Each is a slam by
construction, not a pump — the frame judgement is topological and exact, so no retune is
owed:

- **valueTrigger events** — `audioRd seedcut1:onsetCount` (gate threshold),
  `audioRd flash1:onsetCount` (crest opacity), `pasture burst1:onsetCount` (herd burst),
  `descent lamp1:low` (a `hit1` trigger at threshold 0.84 → a one-frame lamp strobe on hard
  kicks). `valueTrigger` emits `1` on the crossing frame and `0` otherwise (§V436, a pulse
  not a level) — it IS the chop; an envelope would erase the punctuation the trigger exists
  to make.
- **barPhase ramp** — `pulse aimB1 <= clock1:barPhase`. A 0→1 sawtooth per bar is already
  continuous and monotone; it has no per-frame band noise to smooth. Enveloping a phase
  would bend the ramp.
- **valueStep bar-hold** — `pulse paint1.hueoffset <= pal1:bar`. `valueStep` holds one value
  per bar (§T548); the palette is meant to cut on the downbeat, not glide.

## The one fix shape

For a continuous band driving a continuous slot: a `valueLag` between the band's gain and
the slot, fast attack / slow release (§T814 `releaseRatio`) so a hit blooms and decays like
a hit. This is exactly the E27 and E43 shape — nothing new was invented, and there is
nothing left in the tree to apply it to. Adoption of the reusable analyser component
(§T821/§T822) is a separate per-example row and does not change this verdict: the mechanism
is already correct everywhere.
