import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../assets/piano/instrument.json";
import { loadHarmonyPiano, pianoLayers, type PianoBank, type PianoSample } from "./harmony-piano.ts";

const buffer = (id: string) => ({ id } as unknown as AudioBuffer);
function sample(root: number, layer: 3 | 6, fundamental: number): PianoSample {
  return { root, layer, fundamental, buffer: buffer(`${root}/${layer}`) };
}
function context(decode = vi.fn(async () => buffer("decoded"))) {
  return { state: "running", decodeAudioData: decode } as unknown as AudioContext;
}
function successfulFetch() {
  return vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as Response));
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../assets/piano/instrument.json");
});

describe("recorded Harmony piano", () => {
  it("corrects measured tuning per velocity layer and chooses the lower nearest root on ties", () => {
    const low3 = sample(69, 3, 438);
    const low6 = sample(69, 6, 442);
    const bank: PianoBank = { samples: [sample(72, 6, 523), low6, sample(72, 3, 522), low3] };
    const layers = pianoLayers(bank, 70.5, 0.525);
    const frequency = 440 * 2 ** (1.5 / 12);
    expect(layers.map(layer => layer.buffer)).toEqual([low3.buffer, low6.buffer]);
    expect(layers[0].playbackRate * low3.fundamental).toBeCloseTo(frequency, 10);
    expect(layers[1].playbackRate * low6.fundamental).toBeCloseTo(frequency, 10);
    expect(layers[0].gain).toBeCloseTo((0.7 + 0.525 * 0.6) * 0.5);
    expect(layers[1].gain).toBeCloseTo(layers[0].gain);
    expect(pianoLayers(bank, 71, 0.5)[0].buffer).toBe(bank.samples[2]!.buffer);
  });

  it.each([0, 0.35, 0.525, 0.7, 1])("blends layers and preserves total gain at velocity %s", velocity => {
    const bank = { samples: [sample(69, 3, 440), sample(69, 6, 440)] };
    const [soft, hard] = pianoLayers(bank, 69, velocity);
    const total = 0.7 + velocity * 0.6;
    expect(soft.gain + hard.gain).toBeCloseTo(total);
    expect(hard.gain / total).toBeCloseTo(Math.max(0, Math.min(1, (velocity - 0.35) / 0.35)));
    expect(soft.playbackRate).toBe(1);
    expect(hard.playbackRate).toBe(1);
  });

  it("rejects empty, incomplete, duplicate and invalid layers rather than substituting samples", () => {
    expect(() => pianoLayers({ samples: [] }, 60, 0.5)).toThrow("no samples");
    expect(() => pianoLayers({ samples: [sample(60, 3, 261)] }, 60, 0.5)).toThrow("both layers");
    const pair = [sample(60, 3, 261), sample(60, 6, 262)];
    expect(() => pianoLayers({ samples: [...pair, pair[0]!] }, 60, 0.5)).toThrow("duplicate layer");
    expect(() => pianoLayers({ samples: [{ ...pair[0]!, layer: 4 } as unknown as PianoSample, pair[1]!] }, 60, 0.5)).toThrow("layer 3 or 6");
    expect(() => pianoLayers({ samples: [{ ...pair[0]!, fundamental: 0 }, pair[1]!] }, 60, 0.5)).toThrow("positive measured fundamental");
    expect(() => pianoLayers({ samples: pair }, NaN, 0.5)).toThrow(RangeError);
    expect(() => pianoLayers({ samples: pair }, 60, 1.1)).toThrow(RangeError);
  });

  it("shares the in-flight and completed bank per context and loads the manifest's 36 recordings", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const firstContext = context();
    const request = loadHarmonyPiano(firstContext);
    expect(loadHarmonyPiano(firstContext)).toBe(request);
    const bank = await request;
    expect(bank.samples).toHaveLength(36);
    expect(bank.samples.map(({ root, layer, fundamental }) => [root, layer, fundamental])).toEqual(
      Object.values(manifest.samples).map(entry => [entry.midi, entry.layer, entry.fundamental]));
    expect(await loadHarmonyPiano(firstContext)).toBe(bank);
    expect(fetch).toHaveBeenCalledTimes(36);
    const fetched = fetch.mock.calls as unknown as Array<[string]>;
    expect(fetched.some(([url]) => url.includes("Dsharp2v3.flac"))).toBe(true);
    expect(fetched.some(([url]) => url.includes("Fsharp2v3.flac"))).toBe(true);
    expect(fetched.every(([url]) => !url.includes("#"))).toBe(true);
    const second = await loadHarmonyPiano(context());
    expect(second).not.toBe(bank);
    expect(fetch).toHaveBeenCalledTimes(72);
  });

  it("limits complete fetch/decode jobs to four while keeping manifest order", async () => {
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    let active = 0;
    let maximum = 0;
    let issued = 0;
    const pending: Array<() => void> = [];
    const decode = vi.fn(() => new Promise<AudioBuffer>(resolve => {
      active++;
      const id = String(++issued);
      maximum = Math.max(maximum, active);
      pending.push(() => { active--; resolve(buffer(id)); });
    }));
    const request = loadHarmonyPiano(context(decode));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(active).toBe(4);
    for (let batch = 0; batch < 9; batch++) {
      pending.splice(0).reverse().forEach(resolve => resolve());
      await flush();
    }
    const bank = await request;
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(36);
    expect(bank.samples.map(sample => sample.root)).toEqual(Object.values(manifest.samples).map(entry => entry.midi));
  });

  it("rejects HTTP failure explicitly and caches that failure without issuing replacement fetches", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404 } as Response));
    vi.stubGlobal("fetch", fetch);
    const audio = context();
    const request = loadHarmonyPiano(audio);
    await expect(request).rejects.toThrow("fetch failed (404)");
    expect(loadHarmonyPiano(audio)).toBe(request);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(audio.decodeAudioData).not.toHaveBeenCalled();
  });

  it("propagates decode failure and rejects closed contexts", async () => {
    vi.stubGlobal("fetch", successfulFetch());
    const failure = new Error("FLAC decoder rejected recording");
    const audio = context(vi.fn(async () => { throw failure; }));
    await expect(loadHarmonyPiano(audio)).rejects.toBe(failure);
    await expect(loadHarmonyPiano({ ...audio, state: "closed" } as AudioContext)).rejects.toThrow("open AudioContext");
  });

  it("rejects a manifest recording absent from the bundled assets", async () => {
    vi.resetModules();
    vi.doMock("../assets/piano/instrument.json", () => ({ default: {
      samples: { missing: { midi: 60, layer: 3, fundamental: 261 } },
    } }));
    const fetch = successfulFetch();
    vi.stubGlobal("fetch", fetch);
    const { loadHarmonyPiano: loadMissing } = await import("./harmony-piano.ts");
    await expect(loadMissing(context())).rejects.toThrow("recording is missing: missing.flac");
    expect(fetch).not.toHaveBeenCalled();
  });
});
