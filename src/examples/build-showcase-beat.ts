/**
 * T1236 — the showcase clip, SYNTHESISED so the legend is checkable.
 *
 * E66 demonstrates the audio analysis on a bound file. Nothing shipped carried audio, and a
 * real track's contents cannot be stated in a docblock; this one's can, and E66's `.md`
 * legend ("the snare on 2 and 4 flashes the ring") is only checkable because what is on 2
 * and 4 is written down here. `SHOWCASE_BEAT` is that statement, and `e66-showcase.test.ts`
 * reads it against the `.md` so the two cannot drift apart.
 *
 * ## The grid
 *
 * 124 BPM, 4/4, one silent lead-in beat then 16 bars, 48 kHz mono, 31.45 s. Beat one is
 * at 0.484 s (the source's Beat Offset) and every sound sits on the grid from there, so
 * a declared tempo of 124 on the source makes the component's `beat`/`bar` lanes FACTS
 * rather than estimates.
 *
 *   bars  1–4   full: kick, snare, closed hats on eighths, bass, ping
 *   bars  5–8   HATS DROPPED — `levels` loses its brightest lane and re-ranks
 *   bars  9–10  SILENCE — the normaliser's window empties, and the settle lag shows on
 *               the way back in (a scrub into bar 11 is the demo); the bed swells back
 *               in over the last beat of bar 10
 *   bars 11–16  full again, with an OPEN hat on the last off-beat of every bar
 *
 *   kick   every beat                      sine at the bar's bass note, 150 ms decay
 *   snare  beats 2 and 4                   400–2000 Hz noise burst + 400 Hz tone, 120 ms
 *   hat    every eighth (closed, 40 ms)    noise above 7 kHz; the open one decays 250 ms
 *                                          and rings through the next downbeat, which
 *                                          therefore has no closed hat (bars 12–16)
 *   bass   one held note per bar           A1 A1 F1 G1 (55, 55, 43.65, 49 Hz) sine, 50 ms
 *                                          attack under the downbeat kick, held all bar
 *   bed    every played bar                600–2000 Hz noise, 30 dB under the snare
 *   ping   downbeat of every odd bar       three sines at 2.8–4.2 kHz, 60 ms swell
 *
 * So the shipped detector, at its defaults, counts EXACTLY: 56 kicks (14 bars × 4),
 * 28 snares (14 × 2), 75 hats (bars 1–4: 32; bar 11: 8; bars 12–16: 7 each).
 * `e66-showcase.test.ts` measures those three numbers off `renderShowcaseBeat()`, and
 * E66's `.md` legend quotes them.
 *
 * Each voice sits INSIDE one detector band or in the gap between two (`audio.ts`: kick
 * 30–150, snare 150–2500, hat 5000–16000 Hz), so the counts are the drums and nothing
 * else: the bass attacks only under a kick, and the ping lives in the 2.5–5 kHz gap that
 * no count listens to — it moves `centroid`, which is its job. The rest of the design is
 * what the analyser's scale demanded, and each comment below names the false count it
 * removed: the analyser works on an AnalyserNode-style BYTE spectrum (-100..-30 dB per
 * bin), so a bin above -30 dBFS saturates and cannot rise, a band that is otherwise
 * empty counts a -60 dB sidelobe, and a pure sine is far louder per bin than a noise
 * burst of the same peak. Hence the quiet sines (kick 0.12, bass 0.04 against a snare
 * burst at 2), the noise bed under the snare band, and the fades.
 *
 * Deterministic: the noise comes from a seeded PRNG, so the WAV is the same bytes every
 * run. The .m4a is committed; ffmpeg is only the encoder, never a build step.
 *
 * Run: `node --import ./src/tooling/alias-hooks.ts src/examples/build-showcase-beat.ts`
 * writes `public/media/showcase-beat.wav` and, if ffmpeg is on the path, encodes
 * `public/media/showcase-beat.m4a` (AAC 128 kbps mono) and removes the WAV.
 */

import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const SHOWCASE_BEAT = {
  bpm: 124,
  beatsPerBar: 4,
  bars: 16,
  sampleRate: 48_000,
  /** Silent beats before bar 1: the detector needs a hop to rise FROM, so 0 s is empty. */
  leadInBeats: 1,
  /** 1-based bar ranges, inclusive, as the docblock and the `.md` state them. */
  hatsDropped: { from: 5, to: 8 },
  silence: { from: 9, to: 10 },
  openHatFrom: 11,
  bassNotesHz: [55, 55, 43.65, 49],
} as const;

/**
 * The address E66 binds — RELATIVE, like `vesper.ts`'s clip, so it resolves under both the
 * dev server's `/` and Pages' `/loom/`. Headless renders never fetch it: `shipped-clip-audio.ts`
 * recognises this string and hears `renderShowcaseBeat()` instead.
 */
export const SHOWCASE_BEAT_FILE = "media/showcase-beat.m4a";

const SECONDS_PER_BEAT = 60 / SHOWCASE_BEAT.bpm;
/** Where beat one falls in the file — the source's Beat Offset. */
export const SHOWCASE_BEAT_OFFSET_SECONDS = SHOWCASE_BEAT.leadInBeats * SECONDS_PER_BEAT;
/** Seconds into the file where 1-based `bar` begins. */
export function showcaseBarStart(bar: number): number {
  return SHOWCASE_BEAT_OFFSET_SECONDS + (bar - 1) * SHOWCASE_BEAT.beatsPerBar * SECONDS_PER_BEAT;
}

/** mulberry32 — small, seeded, and the same on every platform. */
function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Renders the whole clip as float samples in [-1, 1]. Pure: same bytes every call. */
export function renderShowcaseBeat(): Float32Array {
  const { sampleRate, bars, beatsPerBar } = SHOWCASE_BEAT;
  const totalBeats = SHOWCASE_BEAT.leadInBeats + bars * beatsPerBar;
  const length = Math.round(totalBeats * SECONDS_PER_BEAT * sampleRate);
  const out = new Float32Array(length);
  const noise = seededNoise(0x5eed);

  const inBars = (bar: number, range: { from: number; to: number }): boolean => bar >= range.from && bar <= range.to;

  // Every voice ends on a 5 ms fade, and is given six time constants to decay first: a
  // decay cut off short is a broadband click, and at -55 dBFS a click still lands well
  // above the analyser's floor in a band that is otherwise EMPTY — the kick's cut, 70 ms
  // before the next beat, counted as a kick of its own.
  const add = (startSeconds: number, seconds: number, voice: (t: number) => number): void => {
    const start = Math.round(startSeconds * sampleRate);
    const count = Math.round(seconds * sampleRate);
    const fade = Math.round(0.005 * sampleRate);
    for (let i = 0; i < count && start + i < length; i += 1) {
      const tail = count - i;
      const window = tail < fade ? 0.5 - 0.5 * Math.cos((Math.PI * tail) / fade) : 1;
      out[start + i] = (out[start + i] as number) + voice(i / sampleRate) * window;
    }
  };

  // Tuned to the bar's bass note AND in phase with it (`offset` is the kick's start within
  // the bar): a fixed 55 Hz kick over an F1 bass BEATS at 11 Hz as it decays, and the swell
  // of that beat counted as a second kick 200 ms after the real one; tuned but free-phased,
  // beat 2 of every A1 bar landed 220° against the bass, half cancelled, and was missed.
  // The 20 ms ramp is for the snare band, which counted an instant start as a click.
  const kick = (hz: number, offset: number) => (t: number): number =>
    0.12 * Math.sin(2 * Math.PI * hz * (t + offset)) * Math.min(1, t / 0.02) * Math.exp(-t / 0.15);
  // One-pole filters with state kept across a burst, so the band limit is real and not
  // per-sample. Four poles each way keep the noise inside its band by 24 dB/octave —
  // measured necessary: at two poles the snare's noise above 5 kHz counted as hats.
  const onePole = (hz: number, highPass: boolean) => {
    const alpha = Math.exp((-2 * Math.PI * hz) / sampleRate);
    let previousIn = 0;
    let previousOut = 0;
    return (sample: number): number => {
      previousOut = highPass ? alpha * (previousOut + sample - previousIn) : alpha * previousOut + (1 - alpha) * sample;
      previousIn = sample;
      return previousOut;
    };
  };
  const cascade = (hz: number, highPass: boolean, poles: number) => {
    const stages = Array.from({ length: poles }, () => onePole(hz, highPass));
    return (sample: number): number => stages.reduce((value, pole) => pole(value), sample);
  };
  const highPass = (hz: number, poles = 4) => cascade(hz, true, poles);
  const lowPass = (hz: number, poles = 4) => cascade(hz, false, poles);
  const snare = () => {
    // Eight poles on top: in bars 5–8 the hat band is EMPTY, and the snare's noise 32 dB
    // down at 5 kHz (four poles) counted as a hat on every snare there.
    const band = { high: highPass(400), low: lowPass(2000, 8) };
    return (t: number): number =>
      2 * band.low(band.high(noise())) * Math.exp(-t / 0.12) + 0.3 * Math.sin(2 * Math.PI * 400 * t) * Math.exp(-t / 0.06);
  };
  const hat = (decay: number, gain: number) => {
    const high = highPass(7000);
    return (t: number): number => gain * high(noise()) * Math.exp(-t / decay);
  };
  // Held for the bar with a 100 ms release: at 55 Hz the 5 ms fade below is a quarter
  // cycle, i.e. a cut, and the note's end counted as a kick on the silent downbeat of bar 9.
  const bass = (hz: number, seconds: number) => (t: number): number =>
    0.04 * Math.sin(2 * Math.PI * hz * t) * Math.min(1, t / 0.05, (seconds - t) / 0.1) * Math.exp(-t / 1.2);
  // A soft noise bed across the snare band. Without it that band's floor between hits is
  // SILENCE (byte 0 on the analyser's -100..-30 dB scale), and a kick's -58 dB window
  // sidelobes land at byte ~140 in every bin there: a rise the picker counted as a snare
  // on every beat. Real music has a floor; this gives the clip one, 30 dB under the snare.
  const bed = (seconds: number) => {
    const band = { high: highPass(600), low: lowPass(2000) };
    // The swell is exponential — 60 dB over the beat: on the analyser's dB scale a linear
    // ramp out of silence is a step at its foot, and the riser into bar 11 counted as a snare.
    return (t: number): number => {
      const edge = 0.001 ** (1 - Math.max(0, Math.min(1, t / SECONDS_PER_BEAT, (seconds - t) / SECONDS_PER_BEAT)));
      return 0.3 * band.low(band.high(noise())) * edge;
    };
  };
  const ping = (t: number): number => {
    let sum = 0;
    for (const hz of [2793.83, 3520, 4186.01]) sum += Math.sin(2 * Math.PI * hz * t);
    // A 60 ms swell, not a hit: a sharp start this close above the snare band (2.5 kHz)
    // counted as a snare through the window's sidelobes. It moves the centroid either way.
    return 0.2 * sum * Math.min(1, t / 0.06) * Math.exp(-t / 0.4);
  };

  // The bed runs unbroken through each played stretch, and swells in over the beat BEFORE
  // it (the lead-in, and a riser out of the silence): restarted per bar, its fade-in was
  // a rise across the whole snare band that counted as a snare on every downbeat, and
  // arriving WITH the first kick it left that kick's sidelobes alone against an empty
  // history, which counted too.
  const barSeconds = beatsPerBar * SECONDS_PER_BEAT;
  for (const stretch of [{ from: 1, to: SHOWCASE_BEAT.silence.from - 1 }, { from: SHOWCASE_BEAT.silence.to + 1, to: bars }]) {
    const seconds = (stretch.to - stretch.from + 1) * barSeconds + SECONDS_PER_BEAT;
    add(showcaseBarStart(stretch.from) - SECONDS_PER_BEAT, seconds, bed(seconds));
  }

  for (let bar = 1; bar <= bars; bar += 1) {
    if (inBars(bar, SHOWCASE_BEAT.silence)) continue;
    const barStart = showcaseBarStart(bar);
    const bassHz = SHOWCASE_BEAT.bassNotesHz[(bar - 1) % SHOWCASE_BEAT.bassNotesHz.length] as number;
    add(barStart, barSeconds, bass(bassHz, barSeconds));
    for (let beat = 0; beat < beatsPerBar; beat += 1) {
      const beatStart = barStart + beat * SECONDS_PER_BEAT;
      add(beatStart, 0.9, kick(bassHz, beat * SECONDS_PER_BEAT));
      if (beat === 1 || beat === 3) add(beatStart, 0.72, snare());
      if (inBars(bar, SHOWCASE_BEAT.hatsDropped)) continue;
      for (const eighth of [0, 0.5]) {
        // An open hat rings through the next downbeat, so that downbeat has no closed hat
        // (the detector would not have counted one 240 ms into an open hat's ring anyway).
        if (bar > SHOWCASE_BEAT.openHatFrom && beat === 0 && eighth === 0) continue;
        const open = bar >= SHOWCASE_BEAT.openHatFrom && beat === beatsPerBar - 1 && eighth === 0.5;
        add(beatStart + eighth * SECONDS_PER_BEAT, open ? 1.5 : 0.24, open ? hat(0.25, 0.35) : hat(0.04, 0.3));
      }
    }
    if (bar % 2 === 1) add(barStart, 2.4, ping);
  }

  // Normalise to -1 dBFS so the encoder sees the same headroom every run. No clipper: a
  // soft clip on the kick put its harmonics into the snare band, and they counted.
  let peak = 0;
  for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(out[i] as number));
  const gain = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < length; i += 1) out[i] = (out[i] as number) * gain;
  return out;
}

function wavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) data.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  data.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  ascii(36, "data");
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    data.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i] as number)) * 32767), true);
  }
  return new Uint8Array(data.buffer);
}

function main(): void {
  const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
  const m4a = resolve(publicDir, SHOWCASE_BEAT_FILE);
  const wav = m4a.replace(/\.m4a$/, ".wav");
  writeFileSync(wav, wavBytes(renderShowcaseBeat(), SHOWCASE_BEAT.sampleRate));
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", "128k", "-ac", "1", m4a]);
    unlinkSync(wav);
    console.log(`wrote ${m4a}`);
  } catch (error) {
    console.error(`ffmpeg encode failed; the WAV is at ${wav}:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
