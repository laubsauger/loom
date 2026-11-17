import { describe, expect, it } from "vitest";

import { CHROMA_NAMES } from "../../domain/audio/tonal-fields.ts";
import { appendMidiEvent, packMidiEvent } from "../../domain/midi/midi-events.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1762b — MIDI Notes through its real seam: bytes into the ring the session writes, the
 * node's own value hook reading `channels`, frame by frame. What is asserted is what a
 * consumer reads off the node.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const DELTA = 1 / 60;

/** A session and a node over it. `send` is a port delivering bytes; `frame` evaluates the node once. */
function rig(parameters: Readonly<Record<string, ParameterValue>> = {}, device = "") {
  const definition = registry.get("midiNotes");
  if (definition?.valueEvaluate === undefined) throw new Error("midiNotes has no value hook");
  const hook = definition.valueEvaluate;
  const store = new Map<string, number>();
  const counts = new Map<string, number>();
  const state: Record<string, unknown> = {};
  let index = 0;
  const values = { decayTracking: 0, ...parameters };
  return {
    send(bytes: readonly number[], port = "port-a"): void {
      const packed = packMidiEvent(Uint8Array.from(bytes));
      if (packed === null) return;
      for (const name of [port, ""]) counts.set(name, appendMidiEvent((key, value) => void store.set(key, value), name, counts.get(name) ?? 0, packed));
    },
    frame(deltaSeconds = DELTA): Record<string, number> {
      const frame: FrameEvaluationInput = { timeSeconds: index * DELTA, deltaSeconds, frameIndex: index, mode: "offline", randomSeed: 7 };
      index += 1;
      return hook({ inputs: {}, values: { ...values, device }, frame, state, channels: (name) => store.get(name) });
    },
    now: (): number => (index - 1) * DELTA,
  };
}

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CC = 0xb0;
const V = 100 / 127;

describe("midiNotes (T1762b)", () => {
  it("with no session, no permission or no keyboard it publishes every channel at rest — and the document renders", () => {
    const definition = registry.get("midiNotes")!;
    const bag = definition.valueEvaluate!({
      inputs: {},
      values: {},
      frame: { timeSeconds: 0, deltaSeconds: DELTA, frameIndex: 0, mode: "offline", randomSeed: 7 },
      state: {},
    });
    // Eight voices by default, twelve channels each, then the globals.
    expect(Object.keys(bag).filter((name) => name.startsWith("voice") && name !== "voiceCount")).toHaveLength(8 * 12);
    const { voice0Start, ...rest } = bag;
    expect(voice0Start).toBe(-1);
    expect(Object.entries(rest).filter(([name, value]) => value !== 0 && !name.endsWith("Start"))).toEqual([]);
    for (const name of ["sustain", "sostenuto", "soft", "pressure", "bend", "noteOnCount", "noteOffCount", "heldCount", "voiceCount", "noteDensity", ...CHROMA_NAMES, "chromaConfidence", "root", "chordQuality", "chordConfidence", "chordChangeCount", "chordAge", "tonalCenter", "keyMode", "keyConfidence", "lagSeconds", "lagFrames"]) {
      expect(bag[name], name).toBe(0);
    }
  });

  it("a struck key is a voice: pitch, class, velocity, the whole velocity as its envelope on the frame it is read, a start time and an id", () => {
    const keys = rig();
    keys.frame();
    keys.send([NOTE_ON, 61, 100]);
    const bag = keys.frame();
    expect([bag["voice0Pitch"], bag["voice0PitchClass"], bag["voice0Velocity"], bag["voice0Envelope"]]).toEqual([61, 1, V, V]);
    expect([bag["voice0Held"], bag["voice0Sounding"], bag["voice0Id"], bag["voice0OnsetCount"], bag["voice0Start"]]).toEqual([1, 1, 1, 1, keys.now()]);
    expect([bag["noteOnCount"], bag["heldCount"], bag["voiceCount"], bag["noteDensity"]]).toEqual([1, 1, 1, 1]);
    // The next frame it has decayed by one step of the string, and the events are over.
    const next = keys.frame();
    expect(next["voice0Envelope"]).toBeCloseTo(V * Math.exp(-DELTA / 4), 12);
    expect([next["voice0OnsetCount"], next["noteOnCount"], next["voice0Id"]]).toEqual([0, 0, 1]);
  });

  it("messages from before the node's first frame are not its to act on", () => {
    const keys = rig();
    keys.send([NOTE_ON, 60, 100]);
    expect(keys.frame()["heldCount"]).toBe(0);
  });

  it("two strikes of one key between two frames are two onsets, one voice", () => {
    const keys = rig();
    keys.frame();
    keys.send([NOTE_ON, 60, 100]);
    keys.send([NOTE_OFF, 60, 0]);
    keys.send([NOTE_ON, 60, 80]);
    const bag = keys.frame();
    expect([bag["voice0OnsetCount"], bag["noteOnCount"], bag["noteOffCount"], bag["voice0Id"], bag["voice0Velocity"], bag["voiceCount"]]).toEqual([2, 2, 1, 2, 80 / 127, 1]);
  });

  it("PEDAL: released under the pedal the voice is not held but still sounding, at the string's level; pedal up and it rings out and frees its slot", () => {
    const keys = rig();
    keys.frame();
    keys.send([NOTE_ON, 60, 100]);
    keys.send([CC, 64, 127]);
    keys.send([NOTE_OFF, 60, 64]);
    const caught = keys.frame();
    expect([caught["voice0Held"], caught["voice0Sounding"], caught["voice0Envelope"], caught["sustain"], caught["voice0ReleaseVelocity"]]).toEqual([0, 1, V, 1, 64 / 127]);
    const later = keys.frame();
    expect(later["voice0Envelope"]).toBeCloseTo(V * Math.exp(-DELTA / 4), 12);
    keys.send([CC, 64, 0]);
    const lifted = keys.frame();
    expect([lifted["voice0Sounding"], lifted["sustain"]]).toEqual([0, 0]);
    const damped = keys.frame();
    expect(damped["voice0Envelope"]).toBeCloseTo(V * Math.exp(-3 * DELTA / 4) * Math.exp(-DELTA / 0.15), 12);
    for (let i = 0; i < 120; i += 1) keys.frame();
    const gone = keys.frame();
    // The slot is free, and it REMEMBERS the note it carried: a picture placed by pitch does not snap to 0.
    expect([gone["voiceCount"], gone["voice0Envelope"], gone["voice0Pitch"], gone["voice0Velocity"], gone["voice0Id"]]).toEqual([0, 0, 60, V, 1]);
  });

  it("the same three messages in the other order release the note: key up, then pedal", () => {
    const keys = rig();
    keys.frame();
    keys.send([NOTE_ON, 60, 100]);
    keys.send([NOTE_OFF, 60, 64]);
    keys.send([CC, 64, 127]);
    expect(keys.frame()["voice0Sounding"]).toBe(0);
  });

  it("half pedal reaches the envelope: at 89 of 127 the note fades at 30 % of the release rate", () => {
    const keys = rig();
    keys.frame();
    keys.send([NOTE_ON, 60, 100]);
    keys.send([CC, 64, 89]);
    keys.send([NOTE_OFF, 60, 0]);
    keys.frame();
    const bag = keys.frame();
    expect(bag["sustain"]).toBe(89 / 127);
    expect(bag["voice0Envelope"]).toBeCloseTo(V * Math.exp(-DELTA * (1 / 4 + (1 - 89 / 127) / 0.15)), 12);
  });

  it("sostenuto and soft are published, and sostenuto holds only what was down when it engaged", () => {
    const keys = rig();
    keys.frame();
    keys.send([NOTE_ON, 48, 100]);
    keys.send([CC, 66, 127]);
    keys.send([CC, 67, 64]);
    keys.send([NOTE_ON, 60, 100]);
    keys.send([NOTE_OFF, 48, 0]);
    keys.send([NOTE_OFF, 60, 0]);
    const bag = keys.frame();
    expect([bag["sostenuto"], bag["soft"]]).toEqual([1, 64 / 127]);
    expect([bag["voice0Pitch"], bag["voice0Sounding"], bag["voice1Pitch"], bag["voice1Sounding"]]).toEqual([48, 1, 60, 0]);
  });

  it("the pitch classes and the chord are the sounding keys': C major held, then A minor arpeggiated under the pedal", () => {
    const keys = rig();
    keys.frame();
    for (const pitch of [48, 64, 67]) keys.send([NOTE_ON, pitch, 100]);
    const major = keys.frame();
    expect(CHROMA_NAMES.map((name) => major[name])).toEqual([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
    expect([major["root"], major["chordQuality"], major["chordConfidence"], major["chordChangeCount"], major["chromaConfidence"]]).toEqual([0, 1, 1, 1, 1]);
    const held = keys.frame();
    expect([held["chordChangeCount"], held["chordAge"]]).toEqual([0, DELTA]);
    for (const pitch of [48, 64, 67]) keys.send([NOTE_OFF, pitch, 0]);
    for (let i = 0; i < 240; i += 1) keys.frame();
    expect(keys.frame()["chordQuality"]).toBe(0);
    keys.send([CC, 64, 127]);
    for (const pitch of [57, 60, 64]) {
      keys.send([NOTE_ON, pitch, 100]);
      keys.send([NOTE_OFF, pitch, 0]);
    }
    const minor = keys.frame();
    expect([minor["heldCount"], minor["root"], minor["chordQuality"], minor["chordConfidence"], minor["chordChangeCount"]]).toEqual([0, 9, 2, 1, 1]);
  });

  it("T1764b — the KEY of what is played: a C major cadence, a chord a second, is C major after half a minute, and nothing is claimed before any music", () => {
    const keys = rig();
    expect([keys.frame()["tonalCenter"], keys.frame()["keyMode"], keys.frame()["keyConfidence"]]).toEqual([0, 0, 0]);
    let last: Record<string, number> = {};
    for (let second = 0; second < 30; second += 1) {
      const root = [48, 53, 55, 48][second % 4] as number;
      for (const interval of [0, 4, 7]) keys.send([NOTE_ON, root + interval, 100]);
      for (let i = 0; i < 59; i += 1) keys.frame();
      for (const interval of [0, 4, 7]) keys.send([NOTE_OFF, root + interval, 0]);
      last = keys.frame();
    }
    expect([last["tonalCenter"], last["keyMode"]]).toEqual([0, 1]);
    expect(last["keyConfidence"]).toBeGreaterThan(0.5);
  });

  it("aftertouch and the bend wheel: per voice, per channel, and in the position pitch", () => {
    const keys = rig({ bendRange: 2 });
    keys.frame();
    keys.send([NOTE_ON, 60, 100]);
    keys.send([0xa0, 60, 127]);
    keys.send([0xd0, 32]);
    keys.send([0xe0, 127, 127]);
    const bag = keys.frame();
    expect([bag["voice0Pressure"], bag["pressure"], bag["bend"]]).toEqual([1, 32 / 127, 16383 / 8192 - 1]);
    expect(bag["voice0PositionPitch"]).toBe(60 + 2 * (16383 / 8192 - 1));
    expect(bag["voice0Pitch"]).toBe(60);
  });

  it("Voices sets how many are published; Per Key adds every key's level and start for a Note Field", () => {
    const keys = rig({ voices: 5, perKey: true });
    keys.frame();
    keys.send([NOTE_ON, 60, 100]);
    const bag = keys.frame();
    expect("voice4Pitch" in bag && !("voice5Pitch" in bag)).toBe(true);
    expect([bag["note60Envelope"], bag["note60Start"], bag["note61Envelope"], bag["note61Start"]]).toEqual([V, keys.now(), 0, -1]);
    expect(Object.keys(bag).filter((name) => /^note\d+(Envelope|Start)$/.test(name))).toHaveLength(256);
    expect("note60Envelope" in rig().frame()).toBe(false);
  });

  it("a picked device hears only that port; no device hears any", () => {
    const picked = rig({}, "port-b");
    picked.frame();
    picked.send([NOTE_ON, 60, 100], "port-a");
    expect(picked.frame()["heldCount"]).toBe(0);
    picked.send([NOTE_ON, 62, 100], "port-b");
    expect(picked.frame()["heldCount"]).toBe(1);
    const any = rig();
    any.frame();
    any.send([NOTE_ON, 60, 100], "port-a");
    any.send([NOTE_ON, 62, 100], "port-b");
    expect(any.frame()["heldCount"]).toBe(2);
  });

  it("a cleared state (the transport's reset) starts over from now: no stuck notes from before", () => {
    const definition = registry.get("midiNotes")!;
    const store = new Map<string, number>();
    let count = 0;
    const send = (bytes: number[]): void => {
      count = appendMidiEvent((key, value) => void store.set(key, value), "", count, packMidiEvent(Uint8Array.from(bytes)) as number);
    };
    const at = (state: Record<string, unknown>) =>
      definition.valueEvaluate!({ inputs: {}, values: {}, frame: { timeSeconds: 0, deltaSeconds: DELTA, frameIndex: 0, mode: "offline", randomSeed: 7 }, state, channels: (name) => store.get(name) });
    const state: Record<string, unknown> = {};
    at(state);
    send([NOTE_ON, 60, 100]);
    expect(at(state)["heldCount"]).toBe(1);
    expect(at({})["heldCount"]).toBe(0);
  });
});
