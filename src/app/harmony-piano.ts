import manifest from "../assets/piano/instrument.json";

const urls = import.meta.glob<string>("../assets/piano/*.flac", { eager: true, query: "?url", import: "default" });

export interface PianoSample {
  readonly root: number;
  readonly layer: 3 | 6;
  readonly fundamental: number;
  readonly buffer: AudioBuffer;
}

export interface PianoBank {
  readonly samples: readonly PianoSample[];
}

export interface PianoLayer {
  readonly buffer: AudioBuffer;
  readonly playbackRate: number;
  readonly gain: number;
}

// One bounded bank (including an in-flight or rejected request) per context. Context
// lifetime controls retention; a failure is explicit and never substitutes a synth.
const banks = new WeakMap<AudioContext, Promise<PianoBank>>();

function validateSamples(samples: readonly Pick<PianoSample, "root" | "layer" | "fundamental">[]): void {
  if (samples.length === 0) throw new Error("Harmony piano bank has no samples.");
  const roots = new Map<number, Set<number>>();
  for (const sample of samples) {
    if (!Number.isInteger(sample.root) || sample.root < 0 || sample.root > 127 ||
      (sample.layer !== 3 && sample.layer !== 6) || !Number.isFinite(sample.fundamental) || sample.fundamental <= 0) {
      throw new Error("Harmony piano sample requires a MIDI root, layer 3 or 6, and a positive measured fundamental.");
    }
    let layers = roots.get(sample.root);
    if (layers === undefined) { layers = new Set(); roots.set(sample.root, layers); }
    if (layers.has(sample.layer)) throw new Error(`Harmony piano root ${sample.root} has duplicate layer ${sample.layer}.`);
    layers.add(sample.layer);
  }
  for (const [root, layers] of roots) {
    if (!layers.has(3) || !layers.has(6)) throw new Error(`Harmony piano root ${root} requires both layers 3 and 6.`);
  }
}

async function load(context: AudioContext): Promise<PianoBank> {
  const entries = Object.entries(manifest.samples).map(([name, sample]) => {
    const url = urls[`../assets/piano/${name.replaceAll("#", "sharp")}.flac`];
    if (url === undefined) throw new Error(`Harmony piano recording is missing: ${name}.flac.`);
    return { url, root: sample.midi, layer: sample.layer as 3 | 6, fundamental: sample.fundamental };
  });
  validateSamples(entries);
  const samples: PianoSample[] = new Array(entries.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && next < entries.length) {
      const index = next++;
      const entry = entries[index]!;
      try {
        const response = await fetch(entry.url);
        if (!response.ok) throw new Error(`Harmony piano recording fetch failed (${response.status}): ${entry.url}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        samples[index] = { root: entry.root, layer: entry.layer, fundamental: entry.fundamental, buffer };
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
  return { samples };
}

export function loadHarmonyPiano(context: AudioContext): Promise<PianoBank> {
  if (context.state === "closed") return Promise.reject(new Error("Harmony piano requires an open AudioContext."));
  let bank = banks.get(context);
  if (bank === undefined) { bank = load(context); banks.set(context, bank); }
  return bank;
}

/** Nearest MIDI root, lower on ties; measured fundamentals correct each layer's tuning. */
export function pianoLayers(bank: PianoBank, pitch: number, velocity: number): readonly [PianoLayer, PianoLayer] {
  if (!Number.isFinite(pitch) || pitch < 0 || pitch > 127 || !Number.isFinite(velocity) || velocity < 0 || velocity > 1) {
    throw new RangeError("Harmony piano requires MIDI pitch 0..127 and velocity 0..1.");
  }
  validateSamples(bank.samples);
  let root = bank.samples[0]!.root;
  for (const sample of bank.samples) {
    const distance = Math.abs(sample.root - pitch);
    const nearest = Math.abs(root - pitch);
    if (distance < nearest || (distance === nearest && sample.root < root)) root = sample.root;
  }
  const soft = bank.samples.find(sample => sample.root === root && sample.layer === 3)!;
  const hard = bank.samples.find(sample => sample.root === root && sample.layer === 6)!;
  const frequency = 440 * 2 ** ((pitch - 69) / 12);
  const blend = Math.max(0, Math.min(1, (velocity - 0.35) / 0.35));
  const gain = 0.7 + velocity * 0.6;
  return [
    { buffer: soft.buffer, playbackRate: frequency / soft.fundamental, gain: gain * (1 - blend) },
    { buffer: hard.buffer, playbackRate: frequency / hard.fundamental, gain: gain * blend },
  ];
}
