import { describe, expect, it } from "vitest";
import { beatTrack, estimateBar, estimateTempo, trackBeats } from "./tempo.ts";

/**
 * T1229 — the estimator on synthetic envelopes whose answers are known (§V147).
 *
 * The envelope is what the hop analyser's whole-spectrum SuperFlux looks like for a
 * click train: an impulse per click on the hop grid, zero between. At the engine's
 * 48 kHz / 512-sample hop the grid runs at 93.75 hops/s, so a period of 45 hops is
 * 0.48 s — exactly 125 BPM — and every number below follows from that.
 */

const HOP_RATE = 48_000 / 512;
const PERIOD = 45;
const BPM = (60 * HOP_RATE) / PERIOD; // 125

/** An impulse every `period` hops from `phase`, with `accentEvery`-th impulse `accent` tall. */
function clickTrain(hops: number, period: number, phase = 0, accentEvery = 0, accent = 1): Float64Array {
  const envelope = new Float64Array(hops);
  let index = 0;
  for (let hop = phase; hop < hops; hop += period) {
    envelope[hop] = accentEvery > 0 && index % accentEvery === 0 ? accent : 1;
    index += 1;
  }
  return envelope;
}

function clickHops(hops: number, period: number, phase = 0): number[] {
  const out: number[] = [];
  for (let hop = phase; hop < hops; hop += period) out.push(hop);
  return out;
}

describe("estimateTempo — the autocorrelation peak at the train's period (T1229)", () => {
  it("a 125 BPM click train reads 125.000, and the confidence sits high but below 1", () => {
    const tempo = estimateTempo(clickTrain(2000, PERIOD), { hopRate: HOP_RATE });

    // The peak is at lag 45 and its two neighbours are alike by construction (no click
    // aligns at 44 or 46), so the parabola's vertex is the integer: the period is 45 to
    // the edge effect of the last partial period, under 1e-3 hop.
    expect(tempo.periodHops).toBeCloseTo(PERIOD, 3);
    expect(tempo.bpm).toBeCloseTo(BPM, 2);

    // Most candidate lags carry no correlation at all, so the positive mean is a small
    // fraction of the peak. Never 1: 1 is the DECLARED value (`bpmConfidence`).
    expect(tempo.confidence).toBeGreaterThan(0.8);
    expect(tempo.confidence).toBeLessThan(1);
  });

  it("a train at 2× the period is read at ITS period, not the prior's 120", () => {
    // 90 hops = 0.96 s = 62.5 BPM. The prior at one octave width prefers 125 to 62.5,
    // but the autocorrelation at 45 is zero for this train, so the prior cannot invent it.
    const tempo = estimateTempo(clickTrain(4000, 2 * PERIOD), { hopRate: HOP_RATE });
    expect(tempo.periodHops).toBeCloseTo(2 * PERIOD, 3);
    expect(tempo.bpm).toBeCloseTo(BPM / 2, 2);
  });

  it("refines a period between two hops from the neighbours' asymmetry", () => {
    // Clicks at round(i · 45.25): gaps of 45, 45, 45, 46 repeating, so three quarters
    // of the click pairs align at lag 45 and one quarter at 46, none at 44. The parabola
    // through (44, 0), (45, ¾), (46, ¼) has its vertex at 45 + ½(0 − ¼)/(0 − 1½ + ¼) = 45.1
    // — right of the grid, toward the true 45.25, and the edge terms move it by < 0.05.
    const envelope = new Float64Array(4000);
    for (let index = 0; index * 45.25 < 4000; index += 1) envelope[Math.round(index * 45.25)] = 1;
    const tempo = estimateTempo(envelope, { hopRate: HOP_RATE });
    expect(tempo.periodHops).toBeCloseTo(45.1, 1);
  });

  it("silence and a flat envelope make no claim", () => {
    expect(estimateTempo(new Float64Array(2000), { hopRate: HOP_RATE })).toEqual({ periodHops: 0, bpm: 0, confidence: 0 });
    expect(estimateTempo(new Float64Array(2000).fill(0.3), { hopRate: HOP_RATE })).toEqual({
      periodHops: 0,
      bpm: 0,
      confidence: 0,
    });
  });

  it("an envelope shorter than the slowest period makes no claim rather than a guess", () => {
    // 40 BPM is 141 hops; 100 hops cannot hold one period of it.
    expect(estimateTempo(clickTrain(100, PERIOD), { hopRate: HOP_RATE }).periodHops).toBe(0);
  });
});

describe("trackBeats — Ellis's programme lands on the clicks (T1229)", () => {
  it("every beat is a click hop, first to last, with no beat between", () => {
    const envelope = clickTrain(2000, PERIOD, 7);
    const beats = trackBeats(envelope, PERIOD);
    expect(beats).toEqual(clickHops(2000, PERIOD, 7));
  });

  it("holds the period through a missing click", () => {
    // Drop the 10th click. The transition penalty is −100·(log 2)² ≈ −48 for a 2-period
    // gap against a local score of 0 at the silent hop; the programme prefers a beat at
    // the silent hop (two ordinary steps) to one long step, so the grid is kept.
    const envelope = clickTrain(2000, PERIOD);
    envelope[10 * PERIOD] = 0;
    expect(trackBeats(envelope, PERIOD)).toEqual(clickHops(2000, PERIOD));
  });

  it("beatTrack ties the two: the period it finds is the one it tracks with", () => {
    const { tempo, beats } = beatTrack(clickTrain(2000, PERIOD, 3), { hopRate: HOP_RATE });
    expect(tempo.bpm).toBeCloseTo(BPM, 2);
    expect(beats).toEqual(clickHops(2000, PERIOD, 3));
  });

  it("a flat envelope tracks nothing", () => {
    expect(trackBeats(new Float64Array(2000), PERIOD)).toEqual([]);
  });
});

describe("estimateBar — the accented phase is the downbeat (T1229)", () => {
  it("an accent every fourth click is 4 beats per bar with the downbeat on the accent", () => {
    // Accent 2, plain 1: phase means [2, 1, 1, 1], mean 1.25, contrast (2 − 1.25) / 1.25 = 0.6.
    // Against 3 per bar the accents spread over every phase and the contrast is 0.
    const envelope = clickTrain(2000, PERIOD, 0, 4, 2);
    const beats = clickHops(2000, PERIOD);
    const bar = estimateBar(envelope, beats);
    expect(bar.beatsPerBar).toBe(4);
    expect(bar.downbeat).toBe(0);
    expect(bar.confidence).toBeCloseTo(0.6, 6);
  });

  it("an accent every third click, starting on the second, is 3 per bar with downbeat 1", () => {
    const envelope = clickTrain(2000, PERIOD, 0, 3, 2);
    // Shift the accent: rebuild with the pattern starting one beat in.
    const shifted = new Float64Array(2000);
    const beats = clickHops(2000, PERIOD);
    beats.forEach((hop, index) => {
      shifted[hop] = index % 3 === 1 ? 2 : 1;
    });
    expect(estimateBar(envelope, beats).beatsPerBar).toBe(3);
    const bar = estimateBar(shifted, beats);
    expect(bar.beatsPerBar).toBe(3);
    expect(bar.downbeat).toBe(1);
    // Phase means [1, 2, 1], mean 4/3, contrast (2 − 4/3) / (4/3) = 0.5.
    expect(bar.confidence).toBeCloseTo(0.5, 6);
  });

  it("beats that are all alike claim no bar", () => {
    const envelope = clickTrain(2000, PERIOD);
    expect(estimateBar(envelope, clickHops(2000, PERIOD))).toEqual({ beatsPerBar: 0, downbeat: -1, confidence: 0 });
  });

  it("fewer than two bars of beats is too few to say", () => {
    const envelope = clickTrain(2000, PERIOD, 0, 4, 2);
    expect(estimateBar(envelope, clickHops(2000, PERIOD).slice(0, 5)).beatsPerBar).toBe(0);
  });
});

describe("trackBeats — silence at the ends holds no beats (T1229)", () => {
  it("a train that starts one period in does not get a beat at hop 0", () => {
    // The step from the first click back to hop 0 is exactly one period, so the programme
    // would place a beat there at no cost; hop 0 has no local score, so it is trimmed.
    const envelope = clickTrain(2000, PERIOD, PERIOD);
    expect(trackBeats(envelope, PERIOD)).toEqual(clickHops(2000, PERIOD, PERIOD));
  });
});
