import { harmonyNotesBetween, HARMONY_NOTE_DURATION, NOTE_GAIN_FLOOR, type HarmonyConfig, type HarmonyNote } from "../domain/music/harmony.ts";

const LOOKAHEAD = 0.2;
const MAX_VOICES = 64;
import { loadHarmonyPiano, pianoLayers, type PianoBank } from "./harmony-piano.ts";

export interface HarmonyAudio {
  readiness(): { kind: "loading" | "ready" } | { kind: "error"; message: string };
  update(timeSeconds: number, config: HarmonyConfig, playing: boolean, gain: number): void;
  timeSeconds(): number | undefined;
  dispose(): void;
}

/** A shared-context instrument. The supplied playhead is only a start/seek signal. */
export function createHarmonyAudio(context: AudioContext, suppliedBank?: PianoBank): HarmonyAudio {
  for (const method of ["createGain", "createBufferSource", "createWaveShaper", "createStereoPanner", "createConvolver", "createBuffer"] as const) {
    if (typeof context[method] !== "function") throw new Error(`Harmony audio requires Web Audio ${method}.`);
  }
  if (context.state === "closed") throw new Error("Harmony audio requires an open AudioContext.");
  let bank = suppliedBank;
  let loadError: string | undefined;
  if (bank === undefined) void loadHarmonyPiano(context).then(value => { if (!disposed) bank = value; }, error => { if (!disposed) loadError = `Recorded piano could not load: ${String(error)}`; });
  const master = context.createGain();
  master.gain.value = 0;
  // A fixed soft bound retains headroom as independent piano releases accumulate.
  const limiter = context.createWaveShaper();
  const curve = new Float32Array(4097);
  for (let i = 0; i < curve.length; i++) curve[i] = 0.92 * Math.tanh(1.6 * (2 * i / (curve.length - 1) - 1));
  limiter.curve = curve;
  limiter.oversample = "2x";
  master.connect(limiter);
  limiter.connect(context.destination);
  const reverb = context.createConvolver();
  const wet = context.createGain();
  wet.gain.value = 1;
  reverb.normalize = false;
  reverb.connect(wet);
  wet.connect(master);
  const impulse = context.createBuffer(2, Math.ceil(context.sampleRate * 3.2), context.sampleRate);
  let random = 0x12345678;
  const unit = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (const [delay, gain] of [[0.037, 0.12], [0.061, 0.09], [0.101, 0.07], [0.173, 0.05]] as const) {
      data[Math.round((delay + channel * 0.0023) * context.sampleRate)]! += gain;
    }
    for (let reflection = 0; reflection < 5200; reflection++) {
      const time = 0.08 + unit() * 3.118;
      data[Math.round(time * context.sampleRate)]! += (unit() * 2 - 1) * Math.exp(-time / 0.74) * 0.019;
    }
    const raw = data.slice();
    const filter = [0.12, 0.23, 0.3, 0.23, 0.12];
    for (let i = 2; i < data.length - 2; i++) data[i] = filter.reduce((sum, weight, tap) => sum + raw[i + tap - 2]! * weight, 0);
  }
  reverb.buffer = impulse;
  const voices = new Set<{ end: number; release(): void }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let config: HarmonyConfig | undefined;
  let signature = "";
  let active = false;
  let disposed = false;
  let anchorTime = 0;
  let anchorClock = context.currentTime;
  let cursor = 0;
  let firstWindow = true;
  let frozen: number | undefined;
  let lastInput: number | undefined;
  let lastUpdateClock = context.currentTime;
  let level = 0;

  function position(): number {
    return frozen ?? anchorTime + context.currentTime - anchorClock;
  }
  function clearVoices(): void {
    for (const voice of voices) voice.release();
    // Remove the convolution tail on stop/seek as well as the dry voices.
    reverb.buffer = null;
    reverb.buffer = impulse;
  }
  function voice(note: HarmonyNote): void {
    if (voices.size >= MAX_VOICES) voices.values().next().value?.release();
    const onset = anchorClock + note.startTime - anchorTime;
    const start = Math.max(context.currentTime, onset);
    const age = Math.max(0, start - onset);
    const duration = Math.max(0.01, note.duration - age);
    const end = start + duration;
    const pan = context.createStereoPanner();
    pan.pan.value = Math.max(-0.7, Math.min(0.7, (note.pitch - 60) / 48));
    pan.connect(master);
    pan.connect(reverb);
    const oscillators: AudioBufferSourceNode[] = [];
    const envelopes: GainNode[] = [];
    let released = false;
    const entry = { end, release() {
      if (released) return;
      released = true;
      for (const source of oscillators) { source.onended = null; source.stop(); source.disconnect(); }
      for (const envelope of envelopes) envelope.disconnect();
      pan.disconnect(); voices.delete(entry);
    } };
    if (bank === undefined) throw new Error("Recorded piano is not loaded.");
    const hold = note.holdDuration ?? Math.max(0, note.duration - 6);
    for (const layer of pianoLayers(bank, note.pitch, note.velocity)) {
      if (layer.gain <= 0) continue;
      const source = context.createBufferSource();
      source.buffer = layer.buffer;
      source.playbackRate.value = layer.playbackRate;
      const envelope = context.createGain();
      const peak = layer.gain * 2.2;
      const releaseAge = Math.max(0, age - hold);
      envelope.gain.setValueAtTime(age > 0 ? peak * Math.exp(-releaseAge / 0.78) : NOTE_GAIN_FLOOR, start);
      if (age === 0) envelope.gain.linearRampToValueAtTime(peak, start + 0.0015);
      const releaseStart = Math.max(start + 0.002, onset + hold);
      envelope.gain.setValueAtTime(peak * Math.exp(-releaseAge / 0.78), releaseStart);
      envelope.gain.exponentialRampToValueAtTime(NOTE_GAIN_FLOOR, Math.max(releaseStart + 0.001, end));
      source.connect(envelope); envelope.connect(pan);
      oscillators.push(source); envelopes.push(envelope);
      source.start(start, age * layer.playbackRate); source.stop(end);
    }
    if (oscillators.length === 0) { entry.release(); return; }
    voices.add(entry);
    // The timer also reclaims ended voices when a browser delays ended events.
    oscillators[0]!.onended = () => entry.release();
  }
  function tick(): void {
    if (!active || disposed || !config) return;
    if (context.state !== "running" || bank === undefined) {
      if (frozen === undefined) {
        frozen = position();
        clearVoices();
      }
      master.gain.value = 0;
      return;
    }
    if (frozen !== undefined) {
      anchorTime = frozen;
      anchorClock = context.currentTime;
      cursor = frozen;
      firstWindow = true;
      frozen = undefined;
    }
    master.gain.value = level;
    for (const entry of voices) if (entry.end <= context.currentTime) entry.release();
    const now = position();
    // Preserve an onset exactly at a requested start even if setup took a few samples.
    if (firstWindow && cursor > 0) {
      // Reconstruct voices already ringing at a start or seek, at their elapsed decay.
      for (const note of harmonyNotesBetween(Math.max(0, cursor - HARMONY_NOTE_DURATION), cursor, config)) {
        if (note.startTime + note.duration > cursor) voice(note);
      }
    }
    const from = firstWindow ? cursor : Math.max(cursor, now);
    firstWindow = false;
    const to = now + LOOKAHEAD;
    if (to <= from) return;
    for (const note of harmonyNotesBetween(from, to, config)) voice(note);
    cursor = to;
  }
  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }
  return {
    readiness: () => loadError !== undefined ? { kind: "error", message: loadError } : { kind: bank === undefined ? "loading" : "ready" },
    update(time, nextConfig, playing, gain) {
      if (disposed) return;
      if (!Number.isFinite(time) || !Number.isFinite(gain)) throw new Error("Harmony audio requires finite time and gain.");
      if (context.state === "closed") throw new Error("Harmony audio AudioContext is closed.");
      const nextSignature = JSON.stringify([
        nextConfig.seed, nextConfig.tempo, nextConfig.initialKey, nextConfig.initialMode,
        nextConfig.harmonicComplexity, nextConfig.evolutionRate, nextConfig.musicalEnergy,
      ]);
      const enabled = playing && gain > 0;
      // Judge jumps in the supplied transport, never accumulated drift from our clock.
      // Small frame steps after a render stall and steps while suspended must not seek.
      const inputStep = lastInput === undefined ? 0 : time - lastInput;
      const clockStep = context.currentTime - lastUpdateClock;
      const seek = lastInput !== undefined && (inputStep < 0 || inputStep > Math.max(0.35, clockStep + 0.35));
      if (enabled !== active || signature !== nextSignature || seek) {
        clearVoices();
        anchorTime = time;
        anchorClock = context.currentTime;
        cursor = time;
        firstWindow = true;
        frozen = context.state === "running" && bank !== undefined ? undefined : time;
      }
      config = { ...nextConfig };
      signature = nextSignature;
      lastInput = time;
      lastUpdateClock = context.currentTime;
      active = enabled;
      level = Math.max(0, Math.min(1, gain));
      if (!enabled) {
        master.gain.value = 0;
        stopTimer();
        return;
      }
      tick();
      timer ??= setInterval(tick, 25);
    },
    timeSeconds: () => active && !disposed ? position() : undefined,
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      stopTimer();
      master.gain.value = 0;
      clearVoices();
      master.disconnect();
      limiter.disconnect();
      wet.disconnect();
      reverb.disconnect();
      reverb.buffer = null;
    },
  };
}
