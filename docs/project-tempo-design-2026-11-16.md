# Project tempo and the global beat clock (T1785b, T1786b)

2026-11-16. Loom gets one tempo and one beat clock for the whole project, kept in the
transport, readable by any expression. Before this the only tempo in the engine was the
audio analysis' claim (`bpm` / `bpmConfidence` on Audio In, T1227) and the Declared
tempo each audio node counts for itself.

## How TouchDesigner and Notch do it

**TouchDesigner.** Tempo is a property of the timeline, not of an operator. The
transport bar holds the BPM field, a Tap button and the time signature; the values live
on the root timeline component (`op('/local/time')`, `tempo`, `signature1/2`). Operators
read it: the Beat CHOP outputs `ramp`, `pulse`, `count`, `beat`, `bar` and `bpm` off the
global tempo, and has a Reset pulse for the downbeat; expressions reach the same clock
through `absTime` and the timeline component. Sync to the outside is a separate
operator that WRITES the global tempo: MIDI In CHOP exposes the clock ticks and
start/stop, Ableton Link CHOP and the Audio Analysis / beat-detect tools feed the tempo
field. Tap is the average of the recent tap intervals, and the tap sets the beat.

**Notch.** The project has a BPM in its settings; the timeline can show bars and beats
and nodes read tempo-synced time (modifiers with a "BPM sync" rate, the Beat/Tempo
modifiers). Live, the tempo comes from tap tempo or from the host (media server
timecode, Ableton Link, MIDI). Offline, the project BPM and the timeline position give
the beat, so a render is reproducible.

What both agree on, and what Loom takes: (1) one tempo, in the transport, saved with the
project; (2) every node reads the one clock, no node owns it; (3) tap and resync are
transport verbs; (4) external sync replaces the tempo source, it does not add a second
clock; (5) offline the beat is a function of the position and the stored BPM.

## The Loom shape

**Where the state lives.** The BPM and the source are document state:
`ProjectSettings.bpm` (20..999, absent = 120) and `ProjectSettings.tempoSource`
(`manual` | `audio` | `midiClock`, absent = `manual`). Both are optional fields of the
existing settings object, so documents written before them load unchanged and no schema
migration is needed (§V68); neither is structural (§V178), nothing recompiles. They are
written through `applySettings`, the primitive `project.setSettings` uses, so they save,
undo and reach agents like every setting. The beat PHASE is session state, on the same
line as `playing` and `looping`: where the beat sits depends on when somebody tapped or
when a clock master started, which is a fact about this performance and would be wrong
in a file. It lives in one `ProjectTempo` object the composition root builds beside the
bus (`AppRuntime.tempo`).

**How the clock reaches expressions and nodes (§V44, §V1038).** Taps, MIDI pulses and
audio claims happen on the wall clock; node definitions may never read one. So the beat
arrives the way every other time does: as a field of `FrameEvaluationInput`. The
transport asks a `TempoReader` once per frame it produces and stamps `frame.tempo`
(`bpm`, `beats`, `pulse`, `source`, `locked`). `scopeFromFrame` turns that into bare
expression names, exactly as it does for `time`, `abstime` and `fps`, so every place an
expression is evaluated (texture parameters, value nodes, components, Panel values)
reads the clock with no further wiring, and the value graph gets it through any value
node's expression. No new channel namespace, no second resolver. A frame from a
transport that stamps none (`tempoOf`) counts the default 120 along its absolute clock.

**Names.** `bpm`, `beat` (whole beats since the downbeat), `beatphase` (0..1), `bar`,
`barphase` (0..1), `beatpulse` (beats that landed in this frame: 0, and 1 on the frame a
beat lands), `tempolocked` (1 while the source delivers, 0 while the last tempo is
held). Lowercase one-word, as `abstime` and `absframe` are, and `beat` / `bar` COUNT
while the phases RAMP, as the audio nodes' `beat` / `beatPhase` / `bar` / `barPhase`
channels do. The pulse is `beatpulse` and not `beatcount` (the audio channel's name for
the same quantity) because a bare `beatcount` reads as the running count. These names
are placed BEFORE a node's own context in the scope, so a node that already hands `bpm`
or `beat` to its expressions (an Audio In wired into an Expression) keeps its own.
Bars are 4/4; a time signature is T1790b.

**Live.** `ProjectTempo.read` advances the beat by the wall clock while the transport
presents, so a tap or a MIDI master stays in phase through dropped frames and a pause.
Sources: `manual` counts the document BPM; `audio` takes the analysis' `bpm` while
`bpmConfidence >= 0.5` and otherwise holds the last tempo, unlocked (tempo only: phase
is tapped or resynced, T1789b); `midiClock` takes tempo and position from MIDI realtime
(24 pulses a quarter note, mean over up to two beats, lock in a quarter beat, start /
continue / stop, unlocked after 0.5 s without a pulse). A source that is not selected
is not read. Tap: the tap lands on the nearest beat (the latest tap sets the phase);
from two taps on the BPM is 60 over the median of the last intervals (eight taps kept,
a two second gap starts over) and is stored in the document.

**Offline.** `pnpm render` and every offline transport stamp `documentTempo(settings)`:
the document BPM along the frame's absolute time, whatever the source (a follower has
nothing to follow offline: it reads the document BPM, `tempolocked` 0). The same file
renders the same beats on any day. A take inside the app steps a paused transport; the
live clock then moves the beat by each frame's own step and the take restarts it at the
take's zero, so it counts the same beats.

**Commands.** `tempo.set { bpm }`, `tempo.tap`, `tempo.resync`,
`tempo.setSource { source }`: bus commands (`inSession: "app"`), one code path for the
transport bar, the `t` key, and agents. Switching back to `manual` stores the tempo that
was playing.

**The Tempo node (T1787b).** Value node `tempo` (kind `tempo`). It owns nothing: it reads
`frame.tempo` as the expression scope does and publishes `bpm`, `beat`, `beatPhase`,
`beatCount`, `bar`, `barPhase`, `locked` (the audio nodes' names; equal to the bare names
on every frame) and `ramp`, `pulse`, `count` (the Beat CHOP's names) on the grid its Every
parameter sets: a quarter, a half, one, two or four beats. Its Tap and Resync are pulse
parameters that fire `tempo.tap` and `tempo.resync`, which is how a control reaches the
tap with no new mapping mechanism: an expression on Tap fires it on its rising edge, so
`op('button_tap').chan.value` is a Panel (and phone) tile and
`op('midiin1').chan.tap >= 0.5` is a learned MIDI key or pedal. MIDI In learns a note as
a gate for this. A tap fired this way is heard on the frame the expression turns on, so
it is quantised to the frame (about 8 ms of jitter at 60 Hz, which the median absorbs).
During a take neither pulse fires. `beatpulse` is 0 on a session's first frame and on a
frame with no step that carries no tempo (the compile's zero frame); a MIDI clock that
stops and comes back with no Start carries on from the position the project clock held.

**Not built here.** The phone sending its own tap time: T1788b. Audio phase follow: T1789b.
Time signature: T1790b. Previews with their own clock and the headless server stamp no
project tempo yet: T1791b. Each tap is its own undo entry: T1792b.
