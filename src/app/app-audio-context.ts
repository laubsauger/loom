import type { MovieAudioOutput, MovieAudioRoute } from "./movie-audio-playback.ts";

/**
 * §T1548b — THE APP'S ONE `AudioContext`.
 *
 * Movie sound goes through Web Audio (the owner's ruling, 2026-10-04), and so does Audio
 * File In / Audio In capture (`use-audio-input.ts`). They share this context: two would be
 * two output streams on two clocks. It is made on first ask and never closed — a
 * `MediaElementAudioSourceNode` belongs to its context for the element's life, so a context
 * that closed under a routed movie would leave that movie silent with no way back. A
 * capture that ends disconnects its nodes instead.
 *
 * A context made before the page has had a user gesture starts SUSPENDED (Chrome's
 * autoplay policy). So this listens, in the capture phase, for the first pointer, key or
 * touch and resumes it there, on the gesture's own stack; the listeners go once it runs.
 * Until then a routed movie is kept muted (`createMovieAudioPlayback`), because an UNMUTED
 * routed element nearly stops its clock while its context is suspended (measured in
 * Chrome: 0.002 s of media in 1 s of wall; muted, 0.978 s).
 *
 * Null where there is no Web Audio (jsdom, an old engine): movies then play through their
 * own element output, as they did before T1548b.
 */
let shared: AudioContext | null = null;

export function appAudioContext(): AudioContext | null {
  const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (typeof Context !== "function") return null;
  // `instanceof` the CURRENT constructor: a context from a constructor that has since been
  // replaced (a test's stub) is not this realm's any more.
  if (shared !== null && shared.state !== "closed" && shared instanceof Context) return shared;
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return null;
  }
  shared = context;
  resumeOnGesture(context);
  return context;
}

const GESTURES = ["pointerdown", "keydown", "touchend"] as const;

function resumeOnGesture(context: AudioContext): void {
  if (typeof window === "undefined" || context.state === "running") return;
  const stop = () => {
    for (const type of GESTURES) window.removeEventListener(type, onGesture, true);
  };
  function onGesture(): void {
    if (context.state === "running" || context.state === "closed") {
      stop();
      return;
    }
    // On the gesture's stack: an awaited resume loses the activation.
    void context.resume().then(() => {
      if (context.state === "running") stop();
    }, () => undefined);
  }
  for (const type of GESTURES) window.addEventListener(type, onGesture, true);
}

/**
 * §T1809b — THE PROGRAM BUS: what Loom itself sends to the speakers, as one node.
 *
 * A unity gain into `destination`, one per context. Movie sound and the Audio In / Audio
 * File In monitor connect here and not to `destination`, so a stream (WHIP Out's Audio)
 * can tap exactly what is heard: `appProgramStream`. The Harmony synth still connects to
 * `destination` itself and is not on the bus (§T1811b).
 */
const programs = new WeakMap<AudioContext, { readonly bus: GainNode; tap: MediaStreamAudioDestinationNode | null }>();

function programOf(context: AudioContext): { readonly bus: GainNode; tap: MediaStreamAudioDestinationNode | null } {
  let program = programs.get(context);
  if (program === undefined) {
    const bus = context.createGain();
    bus.connect(context.destination);
    program = { bus, tap: null };
    programs.set(context, program);
  }
  return program;
}

/** Where a source that should be HEARD connects, in place of `context.destination`. */
export function appProgramOutput(context: AudioContext): AudioNode {
  return programOf(context).bus;
}

/**
 * The program bus as a `MediaStream` (one audio track), made on first ask and kept: the
 * caller clones the track and stops its clone. Null where there is no Web Audio, or no
 * stream destination.
 */
export function appProgramStream(): MediaStream | null {
  const context = appAudioContext();
  if (context === null || typeof context.createMediaStreamDestination !== "function") return null;
  const program = programOf(context);
  if (program.tap === null) {
    program.tap = context.createMediaStreamDestination();
    program.bus.connect(program.tap);
  }
  return program.tap.stream;
}

/** Per element, for its life: `createMediaElementSource` may be called once per element, ever. */
const routes = new WeakMap<HTMLMediaElement, { readonly context: AudioContext; readonly gain: GainNode }>();

/**
 * §T1548b — movie elements into the app context: element → its own `GainNode` →
 * the program bus → destination. The gain is the element's volume and mute (Chrome ignores `element.volume`
 * on a routed element). Routing the same element again reconnects the route it already
 * has; an element routed into another context, or not a real media element, is refused
 * (null) and plays through its own output.
 */
export function appMovieAudioOutput(): MovieAudioOutput | null {
  const context = appAudioContext();
  if (context === null) return null;
  return {
    route(element): MovieAudioRoute | null {
      if (typeof HTMLMediaElement === "undefined" || !(element instanceof HTMLMediaElement)) return null;
      let route = routes.get(element);
      if (route !== undefined && route.context !== context) return null;
      if (route === undefined) {
        try {
          const source = context.createMediaElementSource(element);
          const gain = context.createGain();
          gain.gain.value = 0;
          source.connect(gain);
          route = { context, gain };
          routes.set(element, route);
        } catch {
          return null;
        }
      }
      const { gain } = route;
      gain.connect(appProgramOutput(context));
      return {
        gain: gain.gain,
        release: () => {
          gain.gain.value = 0;
          gain.disconnect();
        },
      };
    },
    running: () => context.state === "running",
  };
}
