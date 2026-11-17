/**
 * T1785b — TAP TEMPO: a rate from the taps themselves, with no clock of its own.
 *
 * Every tap arrives with its time in seconds, from whoever heard it (the command reads the
 * app's wall clock, a test passes numbers). The rate is 60 over the MEDIAN of the intervals
 * between the last taps: one late tap moves a mean and leaves a median where it was. Two
 * taps are the least that make an interval and eight the most that are kept, so a tempo
 * that drifts is followed within two bars. A gap longer than `TAP_RESET_SECONDS` starts a
 * new count: the tap after a pause is a first tap, never an interval of three seconds.
 */
export const TAP_MAX_TAPS = 8;
export const TAP_RESET_SECONDS = 2;
/** The range a project tempo may take (the settings schema holds the same two numbers). */
export const BPM_MIN = 20;
export const BPM_MAX = 999;

export interface TapResult {
  /** The tapped tempo, or null while there is one tap and no interval yet. */
  readonly bpm: number | null;
  /** Taps in the current count, this one included. */
  readonly taps: number;
}

export interface TapTempo {
  tap(atSeconds: number): TapResult;
}

/** A tempo as the document stores it: inside the range, to a tenth of a beat a minute. */
export function roundBpm(bpm: number): number {
  return Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)) * 10) / 10;
}

export function createTapTempo(): TapTempo {
  let times: number[] = [];
  return {
    tap(atSeconds) {
      const last = times[times.length - 1];
      if (last !== undefined && (atSeconds - last > TAP_RESET_SECONDS || atSeconds <= last)) times = [];
      times.push(atSeconds);
      if (times.length > TAP_MAX_TAPS) times = times.slice(-TAP_MAX_TAPS);
      if (times.length < 2) return { bpm: null, taps: times.length };
      const intervals = times.slice(1).map((time, index) => time - (times[index] as number)).sort((a, b) => a - b);
      const middle = intervals.length >> 1;
      const median = intervals.length % 2 === 1 ? (intervals[middle] as number) : ((intervals[middle - 1] as number) + (intervals[middle] as number)) / 2;
      return { bpm: roundBpm(60 / median), taps: times.length };
    },
  };
}
