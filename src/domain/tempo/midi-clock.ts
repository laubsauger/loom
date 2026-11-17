/**
 * T1786b — MIDI CLOCK IN: tempo and position from MIDI realtime, with no clock of its own.
 *
 * A clock master sends 0xF8 twenty-four times a quarter note, and 0xFA / 0xFB / 0xFC for
 * start, continue and stop. Each message arrives here with its time in seconds (the Web
 * MIDI event's own timestamp), so the follower is a pure function of what it was sent.
 *
 *  - TEMPO is 60 over twenty-four mean pulse intervals, the mean taken across the window's
 *    whole span: up to `MIDI_CLOCK_WINDOW` intervals (two beats), which is what holds the
 *    number still against a millisecond of USB jitter. It locks after
 *    `MIDI_CLOCK_LOCK_INTERVALS` (a quarter of a beat). When the newest few intervals leave
 *    the window's mean by more than `MIDI_CLOCK_JUMP` the window is cut down to them (and
 *    held there until all of them are new), so a tempo change on the master is followed in
 *    a third of a beat and not averaged in over two.
 *  - POSITION counts pulses. Start puts the next pulse on beat zero (the MIDI rule), stop
 *    holds the count, continue carries on from it. Pulses seen with no start count from
 *    the first one, because a follower that joins a running master has nothing else.
 *  - LOCK is lost when no pulse has arrived for `MIDI_CLOCK_TIMEOUT_SECONDS`: the reading
 *    then says so and reports no tempo, and whoever reads it holds the last one. Pulses
 *    that come back with no Start do not say where the master is, so the reading is marked
 *    `rejoined` and the reader, which ran the beat on meanwhile, hands its position back
 *    (`hold`): the count carries on from there and not from where it stood before the gap.
 */
export const MIDI_CLOCK_PULSES_PER_BEAT = 24;
export const MIDI_CLOCK_WINDOW = 48;
export const MIDI_CLOCK_LOCK_INTERVALS = 6;
export const MIDI_CLOCK_JUMP = 0.05;
export const MIDI_CLOCK_TIMEOUT_SECONDS = 0.5;

export const MIDI_CLOCK = 0xf8;
export const MIDI_START = 0xfa;
export const MIDI_CONTINUE = 0xfb;
export const MIDI_STOP = 0xfc;

/** True for the four realtime status bytes the follower reads. */
export function isMidiClockStatus(status: number): boolean {
  return status === MIDI_CLOCK || status === MIDI_START || status === MIDI_CONTINUE || status === MIDI_STOP;
}

export interface MidiClockReading {
  /** Pulses are arriving and a tempo has been measured from them. */
  readonly locked: boolean;
  /** The measured tempo, or null when not locked. */
  readonly bpm: number | null;
  /** The master is running (started or continued, or never said). */
  readonly running: boolean;
  /** Position in beats since start, between pulses carried on at the measured tempo. */
  readonly beats: number;
  /** The pulses stopped and came back with no Start since: `beats` is stale until `hold` is called. */
  readonly rejoined: boolean;
}

export interface MidiClockFollower {
  message(status: number, atSeconds: number): void;
  reading(nowSeconds: number): MidiClockReading;
  /** Puts beat zero at `nowSeconds` (the transport's resync), keeping the tempo. */
  rezero(nowSeconds: number): void;
  /** Puts `nowSeconds` at `beats`, keeping the tempo: the position a reader held through a gap. */
  hold(beats: number, nowSeconds: number): void;
}

export function createMidiClockFollower(): MidiClockFollower {
  let times: number[] = [];
  let count = 0;
  let running = true;
  let awaitingFirst = true;
  let settling = 0;
  let rejoined = false;

  const spanBpm = (from: number): number | null => {
    const first = times[from];
    const last = times[times.length - 1];
    const intervals = times.length - 1 - from;
    if (first === undefined || last === undefined || intervals < 1 || last <= first) return null;
    return (60 * intervals) / (MIDI_CLOCK_PULSES_PER_BEAT * (last - first));
  };
  const tempo = (): number | null => (times.length - 1 >= MIDI_CLOCK_LOCK_INTERVALS ? spanBpm(0) : null);
  const hold = (beats: number, nowSeconds: number): void => {
    const last = times[times.length - 1];
    const bpm = tempo();
    // The pulse count that puts `nowSeconds` on `beats`: minus what has passed since the last pulse.
    count = beats * MIDI_CLOCK_PULSES_PER_BEAT - (last === undefined || bpm === null ? 0 : Math.min(1, Math.max(0, ((nowSeconds - last) * bpm * MIDI_CLOCK_PULSES_PER_BEAT) / 60)));
    awaitingFirst = false;
    rejoined = false;
  };

  return {
    message(status, atSeconds) {
      if (status === MIDI_START) {
        running = true;
        awaitingFirst = true;
        count = 0;
        rejoined = false;
        return;
      }
      if (status === MIDI_CONTINUE) {
        running = true;
        return;
      }
      if (status === MIDI_STOP) {
        running = false;
        return;
      }
      if (status !== MIDI_CLOCK) return;
      const last = times[times.length - 1];
      if (last !== undefined && (atSeconds - last > MIDI_CLOCK_TIMEOUT_SECONDS || atSeconds < last)) {
        times = [];
        // A Start since the last pulse says where this one is; otherwise nothing does.
        if (!awaitingFirst) rejoined = true;
      }
      times.push(atSeconds);
      if (times.length > MIDI_CLOCK_WINDOW + 1) times = times.slice(-(MIDI_CLOCK_WINDOW + 1));
      if (times.length - 1 > MIDI_CLOCK_LOCK_INTERVALS) {
        const whole = spanBpm(0);
        const recent = spanBpm(times.length - 1 - MIDI_CLOCK_LOCK_INTERVALS);
        // A jump: keep only the newest intervals, and keep doing so until every one of
        // them was measured at the new tempo.
        if (whole !== null && recent !== null && Math.abs(recent - whole) > whole * MIDI_CLOCK_JUMP) settling = MIDI_CLOCK_LOCK_INTERVALS;
        if (settling > 0) {
          times = times.slice(-(MIDI_CLOCK_LOCK_INTERVALS + 1));
          settling -= 1;
        }
      }
      if (!running) return;
      if (awaitingFirst) awaitingFirst = false;
      else count += 1;
    },
    reading(nowSeconds) {
      const last = times[times.length - 1];
      const bpm = last !== undefined && nowSeconds - last <= MIDI_CLOCK_TIMEOUT_SECONDS ? tempo() : null;
      const base = count / MIDI_CLOCK_PULSES_PER_BEAT;
      if (bpm === null || last === undefined) return { locked: false, bpm: null, running, beats: base, rejoined };
      const carried = running && !awaitingFirst ? Math.min(Math.max(0, ((nowSeconds - last) * bpm) / 60), 1 / MIDI_CLOCK_PULSES_PER_BEAT) : 0;
      return { locked: true, bpm, running, beats: base + carried, rejoined };
    },
    rezero: (nowSeconds) => hold(0, nowSeconds),
    hold,
  };
}
