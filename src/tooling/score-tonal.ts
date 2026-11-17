import { readFileSync } from "node:fs";
import { analyseOffline } from "../app/audio-offline-analysis.ts";
import { PRE_ANALYSIS_SAMPLE_RATE } from "../app/audio-pre-analysis.ts";
import { featureTrackLength, readFeatureFrame } from "../domain/audio/feature-track.ts";
import { CHROMA_NAMES, NOTE_VOICE_COUNT } from "../domain/audio/tonal-fields.ts";
import { matchTriad } from "../domain/audio/triads.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "../nodes/definitions/audio.ts";
import { decodeAudio, requireFfmpeg } from "./offline-render.ts";

/**
 * T1756b — SCORE THE TONAL ANALYSIS AGAINST A PERFORMANCE WHOSE NOTES ARE KNOWN.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/tooling/score-tonal.ts <audio> <notes.json> [fps]
 *
 * `notes.json` is `{ notes: [{ on, off, eff, p, v }] }`: seconds into the audio a key went
 * down, came up and stopped sounding (the pedal holds it past `off`), its MIDI pitch and
 * velocity. The audio is walked by the app's own offline analysis, as a pre-analysed file
 * is, and each frame is compared with what was sounding.
 *
 * A measurement, not a gate, and the data is never in this repository: the performance this
 * was written for (MAESTRO) is licensed non-commercial share-alike. The script is here
 * because a number a later change depends on must be reproducible (§V798); the gates use
 * synthesised signals only.
 */
interface ScoreNote {
  readonly on: number;
  readonly off: number;
  readonly eff: number;
  readonly p: number;
  readonly v: number;
}

const [audioPath, notesPath, fpsText] = process.argv.slice(2);
if (audioPath === undefined || notesPath === undefined) {
  console.error("usage: score-tonal.ts <audio> <notes.json> [fps]");
  process.exit(2);
}
const fps = fpsText === undefined ? 30 : Number(fpsText);
requireFfmpeg("decoding the audio to score");
const notes = (JSON.parse(readFileSync(notesPath, "utf8")) as { notes: ScoreNote[] }).notes;
const samples = decodeAudio(audioPath, PRE_ANALYSIS_SAMPLE_RATE);
const started = performance.now();
const { track } = analyseOffline(samples, PRE_ANALYSIS_SAMPLE_RATE, fps, AUDIO_DETECTOR_DEFAULTS, true, 0);
const walked = (performance.now() - started) / 1000;
const frames = featureTrackLength(track);
const percent = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)} %`);

/** The notes sounding at `time`, loudest strike first. A struck string has all but gone after six seconds. */
const soundingAt = (time: number): ScoreNote[] => notes.filter((note) => note.on <= time && time < Math.min(note.eff, note.on + 6)).sort((a, b) => b.v - a.v);

let scored = 0;
let chromaOnTruth = 0;
let strongestIsTruth = 0;
let voiceFrames = 0;
let voicesHeard = 0;
let voicesRight = 0;
let voicesRightClass = 0;
let truthTopHeard = 0;
let truthTop = 0;
let leadFrames = 0;
let leadRight = 0;
let chordFrames = 0;
let chordBoth = 0;
let chordAgree = 0;
let chordRootAgree = 0;
let chordChanges = 0;
const keys = new Map<string, number>();
const idsSeen = new Set<number>();
const heardOnsets: number[] = [];
const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

for (let index = 0; index < frames; index += 1) {
  const time = index / fps;
  const frame = readFeatureFrame(track, index);
  const sounding = soundingAt(time);
  const truthClasses = new Set(sounding.map((note) => note.p % 12));
  chordChanges += frame.chordChangeCount;
  const key = frame.keyConfidence > 0 ? `${NAMES[frame.keyTonic] as string} ${frame.keyMode === 1 ? "major" : "minor"}` : "none";
  keys.set(key, (keys.get(key) ?? 0) + 1 / fps);
  for (let slot = 0; slot < NOTE_VOICE_COUNT; slot += 1) {
    const record = frame as unknown as Record<string, number>;
    if ((record[`voice${String(slot)}OnsetCount`] as number) > 0) heardOnsets.push(time);
    const id = record[`voice${String(slot)}Id`] as number;
    if ((record[`voice${String(slot)}Confidence`] as number) > 0) idsSeen.add(id);
  }
  if (sounding.length === 0) continue;
  scored += 1;

  // Chroma: how much of the profile's energy lies on classes that are sounding.
  const profile = CHROMA_NAMES.map((name) => frame[name]);
  const energy = profile.map((value) => value * value);
  const total = energy.reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    chromaOnTruth += energy.reduce((sum, value, pitchClass) => sum + (truthClasses.has(pitchClass) ? value : 0), 0) / total;
    if (truthClasses.has(profile.indexOf(Math.max(...profile)))) strongestIsTruth += 1;
  }

  // Voices: are the notes they name sounding, and are the loudest sounding notes named.
  const record = frame as unknown as Record<string, number>;
  const heard: number[] = [];
  for (let slot = 0; slot < NOTE_VOICE_COUNT; slot += 1) {
    if ((record[`voice${String(slot)}Confidence`] as number) > 0) heard.push(Math.round(record[`voice${String(slot)}Pitch`] as number));
  }
  if (heard.length > 0) voiceFrames += 1;
  voicesHeard += heard.length;
  voicesRight += heard.filter((pitch) => sounding.some((note) => note.p === pitch)).length;
  voicesRightClass += heard.filter((pitch) => truthClasses.has(((pitch % 12) + 12) % 12)).length;
  const top = sounding.slice(0, 3);
  truthTop += top.length;
  truthTopHeard += top.filter((note) => heard.includes(note.p)).length;

  if (frame.pitchConfidence > 0) {
    leadFrames += 1;
    if (sounding.some((note) => note.p === Math.round(frame.pitch))) leadRight += 1;
  }

  // Chord: against the triad the SOUNDING classes make, by the keyboard's matcher.
  const truthProfile = Array.from({ length: 12 }, (_, pitchClass) => (truthClasses.has(pitchClass) ? 1 : 0));
  const lowest = Math.min(...sounding.map((note) => note.p));
  const truthChord = matchTriad(truthProfile, lowest % 12);
  if (frame.chordConfidence > 0) chordFrames += 1;
  if (frame.chordConfidence > 0 && truthChord.confidence > 0) {
    chordBoth += 1;
    if (frame.chordRoot === truthChord.root) chordRootAgree += 1;
    if (frame.chordRoot === truthChord.root && frame.chordQuality === truthChord.quality) chordAgree += 1;
  }
}

// Onsets: a heard onset within a tenth of a second of a struck note, and the other way round.
const struck = notes.map((note) => note.on).sort((a, b) => a - b);
const near = (times: readonly number[], time: number): boolean => times.some((other) => Math.abs(other - time) <= 0.1);
const onsetsRight = heardOnsets.filter((time) => near(struck, time)).length;
const struckHeard = struck.filter((time) => near(heardOnsets, time)).length;

const minutes = frames / fps / 60;
console.log(`${audioPath}: ${(samples.length / PRE_ANALYSIS_SAMPLE_RATE).toFixed(1)} s, ${notes.length} notes, ${frames} frames at ${fps} fps, walked in ${walked.toFixed(1)} s`);
console.log(`frames with a note sounding: ${scored}`);
console.log(`CHROMA  energy on sounding classes: ${percent(chromaOnTruth, scored)}; strongest class is sounding: ${percent(strongestIsTruth, scored)}`);
console.log(`VOICES  frames with a voice: ${percent(voiceFrames, scored)}; voices per frame: ${(voicesHeard / Math.max(1, scored)).toFixed(2)}`);
console.log(`        a voice's note is sounding: ${percent(voicesRight, voicesHeard)} (its pitch class: ${percent(voicesRightClass, voicesHeard)})`);
console.log(`        of the three loudest sounding notes, heard as a voice: ${percent(truthTopHeard, truthTop)}`);
console.log(`        notes begun: ${idsSeen.size} voices' ids against ${notes.length} struck; an onset is within 0.1 s of a strike: ${percent(onsetsRight, heardOnsets.length)}; a strike has an onset: ${percent(struckHeard, struck.length)}`);
console.log(`LEAD    frames claiming a pitch: ${percent(leadFrames, scored)}; of those, a sounding note: ${percent(leadRight, leadFrames)}`);
console.log(`CHORD   frames claiming a chord: ${percent(chordFrames, scored)}; changes: ${chordChanges} (${(chordChanges / minutes).toFixed(1)} a minute)`);
console.log(`        where the sounding classes make a triad too: same root ${percent(chordRootAgree, chordBoth)}, same root and quality ${percent(chordAgree, chordBoth)} (${chordBoth} frames)`);
console.log(`KEY     ${[...keys.entries()].sort((a, b) => b[1] - a[1]).map(([name, seconds]) => `${name} ${seconds.toFixed(0)} s`).join(", ")}`);
