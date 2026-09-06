/**
 * T1226 — the analysis engine's core: one `fftSize` window in, one hop's features out.
 *
 * This is where the decisions live (§V747): what the analyser bytes are (`stft.ts`),
 * what flux is measured against what (`flux.ts`), what counts as an event (`peaks.ts`
 * and the v1 fixed level). The worklet (`src/app/audio-analysis.worklet.ts`) owns only
 * the ring buffer and the port; a headless test drives THIS on synthetic windows and
 * asserts exact counts, which is the claim the row makes about the engine.
 *
 * Per hop it produces:
 * - `frequency` / `timeDomain`: the analyser-shaped bytes, so `computeAudioFeatures`
 *   keeps producing the v1 bands and level from them, bit-identical to the polled path
 *   (T1225 measured that against a live node).
 * - `flux` / `event`: the v1 onset formula against the PREVIOUS hop, and its rising
 *   crossing of the fixed `eventThreshold`. Summed over a frame interval these are
 *   §V357's `onsetCount` and `onsetMax` at hop fidelity — several hops per interval, a
 *   true max and a real count — with the meaning of both fields untouched.
 * - `bandFlux` / `bandEvents`: SuperFlux (lag `superflux.lag` hops, ±`halfWidth` max
 *   filter) on the whole spectrum (index 0) and on each configured band, with an online
 *   adaptive event per stream. This is the new material; the v2 record (T1227) is written
 *   from what these deliver, not the other way round.
 *
 * Fresh output arrays per hop on purpose: the worklet transfers them across the port,
 * and a transferred buffer is detached on this side.
 */
import { binRange, maxFilter, positiveFlux } from "./flux.ts";
import { createPeakPicker, type PeakPicker, type PeakPickerOptions } from "./peaks.ts";
import { analyserBytes, blackmanWindow } from "./stft.ts";

export interface HopAnalyserOptions {
  readonly fftSize: number;
  readonly sampleRate: number;
  /** `[lowHz, highHz]` per band, in the order `bandFlux[1..]` reports them. */
  readonly bands: ReadonlyArray<readonly [number, number]>;
  /** The v1 event level: a rising crossing of `flux` over this is one `event`. */
  readonly eventThreshold: number;
  readonly superflux: {
    /** Hops between the current window and its reference. */
    readonly lag: number;
    /** Bins either side folded into the reference by max. */
    readonly halfWidth: number;
  };
  readonly picker: PeakPickerOptions;
}

export interface HopFeatures {
  /** `fftSize / 2` bytes, `getByteFrequencyData`-shaped. */
  readonly frequency: Uint8Array;
  /** `fftSize` bytes, `getByteTimeDomainData`-shaped. */
  readonly timeDomain: Uint8Array;
  /** v1 onset at hop rate: mean positive flux against the previous hop, 0..1. */
  readonly flux: number;
  /** A rising crossing of `eventThreshold` by `flux`. */
  readonly event: boolean;
  /** SuperFlux, 0..1: index 0 the whole spectrum, then one per configured band. */
  readonly bandFlux: Float64Array;
  /** Adaptive events, same indexing as `bandFlux`; 1 on the hop an event fires. */
  readonly bandEvents: Uint8Array;
}

export interface HopAnalyser {
  /** Analyse the `fftSize` samples of one window. Windows must arrive in hop order. */
  analyse(samples: ArrayLike<number>): HopFeatures;
}

export function createHopAnalyser(options: HopAnalyserOptions): HopAnalyser {
  const { fftSize, sampleRate, bands, eventThreshold, superflux, picker } = options;
  if (!(fftSize > 0) || (fftSize & (fftSize - 1)) !== 0) {
    throw new Error(`createHopAnalyser: fftSize must be a power of two, got ${fftSize}`);
  }
  if (!(superflux.lag >= 1) || !(superflux.halfWidth >= 0)) {
    throw new Error(`createHopAnalyser: bad superflux options ${JSON.stringify(superflux)}`);
  }
  const binCount = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const window = blackmanWindow(fftSize);
  const scratch = new Float64Array(binCount);
  const streams = bands.length + 1;
  /** Bin ranges per stream: the whole spectrum first, then each band. */
  const ranges: ReadonlyArray<readonly [number, number]> = [
    [0, binCount - 1],
    ...bands.map(([lowHz, highHz]) => binRange(binHz, lowHz, highHz, binCount)),
  ];
  const pickers: PeakPicker[] = Array.from({ length: streams }, () => createPeakPicker(picker));

  /*
   * The last `lag` spectra, circular. Before hop n is written, slot n % lag holds hop
   * n − lag (the SuperFlux reference) and slot (n − 1) % lag holds hop n − 1 (the v1
   * reference); with lag 1 both are the same slot, which is also right.
   */
  const lag = superflux.lag;
  const history: Uint8Array[] = Array.from({ length: lag }, () => new Uint8Array(binCount));
  const filtered = new Uint8Array(binCount);
  let hops = 0;
  let previousFlux = 0;

  return {
    analyse(samples) {
      if (samples.length !== fftSize) {
        throw new Error(`hop analyser: expected ${fftSize} samples, got ${samples.length}`);
      }
      const frequency = new Uint8Array(binCount);
      const timeDomain = new Uint8Array(fftSize);
      analyserBytes(samples, window, frequency, timeDomain, scratch);

      const previous = hops >= 1 ? (history[(hops - 1) % lag] as Uint8Array) : null;
      const flux = positiveFlux(frequency, previous);
      const event = flux > eventThreshold && previousFlux <= eventThreshold;
      previousFlux = flux;

      const bandFlux = new Float64Array(streams);
      const bandEvents = new Uint8Array(streams);
      const lagged = hops >= lag ? maxFilter(history[hops % lag] as Uint8Array, superflux.halfWidth, filtered) : null;
      for (let stream = 0; stream < streams; stream += 1) {
        const [first, last] = ranges[stream] as readonly [number, number];
        const value = positiveFlux(frequency, lagged, first, last);
        bandFlux[stream] = value;
        bandEvents[stream] = (pickers[stream] as PeakPicker).push(value) ? 1 : 0;
      }

      (history[hops % lag] as Uint8Array).set(frequency);
      hops += 1;
      return { frequency, timeDomain, flux, event, bandFlux, bandEvents };
    },
  };
}
