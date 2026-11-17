import type { CompiledNodeDescription, NodeDefinition, StatefulDeclaration } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { BEATS_PER_BAR, tempoOf } from "../../domain/types/frame.ts";
import { TEMPO_RESYNC_COMMAND, TEMPO_TAP_COMMAND } from "../../domain/tempo/project-tempo.ts";
import { VALUE_PORT } from "./common-ports.ts";

/**
 * T1787b — Tempo: the PROJECT clock on wires, and Tap / Resync as pulses.
 *
 * The project has one tempo and one beat clock, in the transport (T1785b,
 * `docs/project-tempo-design-2026-11-16.md`). Any expression already reads it by bare name
 * (`bpm`, `beatphase`, …). This node is the same clock as a channel bag, for the two things
 * a bare name cannot do:
 *
 *  - a WIRE: `tempo1 → lag1`, a Select, a plot of the beat, `op('tempo_main').chan.ramp`;
 *  - a TRIGGER: no mechanism maps a MIDI control, a Panel tile or the phone to a bus
 *    command. Controls drive node parameters, and a pulse parameter fires its node's
 *    command (Cue List's GO). So Tap and Resync are pulse parameters here, and an
 *    expression on Tap (`op('button_tap').chan.value`, a learned MIDI key or pedal) is tap
 *    tempo from that control.
 *
 * It OWNS nothing (the design's rule: every node reads the one clock, no node owns it).
 * Two Tempo nodes publish the same numbers and their Tap pulses tap the same tempo.
 *
 * ## It reads the frame (§V44, §V1038)
 *
 * `tempoOf(frame)`, exactly as the expression scope does, so `op('tempo1').chan.bpm` and a
 * bare `bpm` are one number on any frame. No clock is read here: taps happen on the app's
 * wall clock inside `ProjectTempo`, and reach this node as the next frame's reading.
 *
 * ## The channels
 *
 * `bpm`, `beat`, `beatPhase`, `beatCount`, `bar`, `barPhase` are the audio nodes' names
 * with the audio nodes' meanings (`beat` and `bar` count, the phases ramp, `beatCount` is
 * the beats that landed in this frame), and are the bare names `bpm`, `beat`, `beatphase`,
 * `beatpulse`, `bar`, `barphase`. `locked` is `tempolocked`.
 *
 * `ramp`, `pulse` and `count` are TouchDesigner's Beat CHOP names, on the grid Every sets:
 * one period is a quarter, a half, one, two or four beats. At one beat they are
 * `beatPhase`, `beatCount` and `beat`.
 *
 * ## Why it keeps the last position
 *
 * A period shorter than a beat lands between two beats, and the frame carries only where
 * the beat IS and how many whole beats landed. So `pulse` is counted from the position the
 * node saw on its previous frame. A position that went backwards (a resync, a tap that
 * pulled the beat back, a take starting over) is not a run of periods: it pulses only if
 * the frame says a beat was put on the grid and that beat is a period's first.
 */
const TEMPO_STATEFUL: StatefulDeclaration = {
  reset: true,
  deterministicReplay: true,
  checkpoint: false,
  randomAccess: false,
};

/** The grid `ramp` / `pulse` / `count` run on, in beats. Powers of two, so the division is exact. */
export const TEMPO_PERIODS = ["0.25", "0.5", "1", "2", "4"] as const;

function periodOf(value: ParameterValue | undefined): number {
  const period = typeof value === "string" && (TEMPO_PERIODS as readonly string[]).includes(value) ? Number(value) : 1;
  return period;
}

export const tempoNode: NodeDefinition = {
  type: "tempo",
  version: 1,
  title: "Tempo",
  category: "value",
  description:
    "The project tempo and beat clock as channels, with Tap and Resync as pulses. bpm is the tempo in effect; beat and bar count since the downbeat (four beats to the bar); beatPhase and barPhase ramp 0..1 inside each; beatCount is the beats that landed in this frame (0, and 1 on the frame a beat lands); locked is 1 while the tempo source is delivering and 0 while the last tempo is held. ramp, pulse and count are the same clock on the grid Every sets (a quarter, a half, one, two or four beats). These are the numbers an expression reads as bpm, beat, beatphase, beatpulse, bar, barphase and tempolocked: the node is for wiring them, and for tapping. Drive Tap with an expression to tap the tempo from a MIDI key or pedal, a Panel button or the phone: it taps once each time the expression turns on, and two taps make a tempo. Resync puts beat zero of bar zero at now. The node owns no tempo: the project has one, in the transport bar, and every Tempo node reads and taps that one. FREE-RUNNING (§V436): the beat counts along the absolute clock and from the last tap or resync, never the timeline position, so a timeline loop passes straight through it; a render counts the project tempo from the take's start.",
  tags: ["value", "tempo", "bpm", "beat", "bar", "clock", "tap", "tap tempo", "resync", "sync", "metronome", "midi", "perform", "live"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    tap: {
      type: "pulse",
      label: "Tap",
      fires: TEMPO_TAP_COMMAND,
      description:
        "Taps the project tempo: the tap lands on the nearest beat, and from the second tap the tempo is the median of the last tap intervals. Drive it with an expression to tap from a MIDI key or pedal or a Panel button; it taps once each time the expression turns on.",
    },
    resync: {
      type: "pulse",
      label: "Resync",
      fires: TEMPO_RESYNC_COMMAND,
      description: "Puts beat zero of bar zero at now, keeping the tempo.",
    },
    every: {
      type: "enum",
      label: "Every",
      default: "1",
      options: [
        { value: "0.25", label: "1/4 beat" },
        { value: "0.5", label: "1/2 beat" },
        { value: "1", label: "1 beat" },
        { value: "2", label: "2 beats" },
        { value: "4", label: "4 beats" },
      ],
      description: "The period ramp, pulse and count run on. The beat and bar channels are not affected.",
    },
  },
  stateful: TEMPO_STATEFUL,
  valueEvaluate: ({ values, frame, state }) => {
    const tempo = tempoOf(frame);
    const period = periodOf(values["every"]);
    const beat = Math.floor(tempo.beats);
    const bars = tempo.beats / BEATS_PER_BAR;
    const periods = tempo.beats / period;
    const count = Math.floor(periods);

    const previous = state["beats"];
    state["beats"] = tempo.beats;
    const ran = typeof previous === "number" && tempo.beats >= previous;
    const beatsRun = ran ? beat - Math.floor(previous) : 0;
    const periodsRun = ran ? count - Math.floor(previous / period) : 0;
    // The frame reports a beat this node did not see the clock run through: it was PUT there.
    const put = tempo.pulse > beatsRun && Number.isInteger(beat / period) ? 1 : 0;

    return {
      bpm: tempo.bpm,
      beat,
      beatPhase: tempo.beats - beat,
      beatCount: tempo.pulse,
      bar: Math.floor(bars),
      barPhase: bars - Math.floor(bars),
      locked: tempo.locked ? 1 : 0,
      ramp: periods - count,
      // At one beat the pulse IS the frame's, so it cannot differ from `beatCount`.
      pulse: period === 1 ? tempo.pulse : Math.max(periodsRun, put),
      count,
    };
  },
  valueChannelMeta: {
    beatPhase: { kind: "bounded", low: 0, high: 1 },
    barPhase: { kind: "bounded", low: 0, high: 1 },
    ramp: { kind: "bounded", low: 0, high: 1 },
    locked: { kind: "boolean" },
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
