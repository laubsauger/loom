import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { MidiReading } from "@domain/midi/midi-mapping.ts";
import { decodeMidiMessage, midiSourceKey } from "@domain/midi/midi-mapping.ts";
import type { MidiAccessState, MidiInputPort } from "@domain/midi/midi-status.ts";

/**
 * T942 tier 1 — the session's ONE Web MIDI access (§V182's one-listener rule, with knobs).
 *
 * ## What it is
 *
 * It opens MIDI once, listens to every input port once, and publishes each control's RAW
 * reading into the channel seam the value graph already threads
 * (`ValueEvaluateContext.channels`, built for `analyze`). `midiIn` projects those readings
 * through its learned mapping; `channelIn` can read one directly by name. No new port
 * type, no compiler change, and nothing here knows what a mapping is.
 *
 * Two names per reading, and the second is what makes a freshly-dropped node work:
 *
 *   midi:<portId>:cc1.74   — this control on THIS device
 *   midi:*:cc1.74          — this control on ANY attached device, last message wins
 *
 * A `midiIn` with no device picked reads the `*` form, so plugging a controller in is the
 * whole setup. Picking a device narrows it, and then a document that names a device you do
 * not have reads nothing — which is the degraded path, and it is the point of having one.
 *
 * ## PERMISSION IS ASKED ON A GESTURE, NEVER ON LOAD (§V476, §V721)
 *
 * Chrome has prompted for ALL Web MIDI access since 124 — not just SysEx. A hook that
 * called `requestMIDIAccess` on mount would put a permission dialog in front of anyone who
 * opened any document, which is the ambush §V476 forbids for an example's first frame, and
 * it would do it for every document rather than one. So `request()` exists and nothing
 * calls it but a button. Until then the state is `idle` and every learned channel reads its
 * rest value — a working, degraded document.
 *
 * SysEx is NOT requested. It is a strictly scarier prompt ("control your instruments") and
 * this row decodes no SysEx, so asking for it would be asking for something we do not use.
 *
 * ## ABSENCE HAS SEVERAL SHAPES AND THEY ARE DIFFERENT SENTENCES (§V359)
 *
 * "Safari has no Web MIDI" and "you said no" and "nothing is plugged in" are three
 * different things to do next, and the §V359 failure is rendering them as the same
 * nothing. So the state is an enumeration, each member carries what to DO (§T948 rule 3 —
 * the copy says what to do, not what is broken), and the MIDI section renders the one that
 * is true. Firefox is a known limit on that honesty and is stated rather than papered
 * over: its model is a site-permission add-on and a page cannot tell a refusal from a
 * missing add-on, so a denial there says both.
 *
 * ## Why the readings are a ref and not React state
 *
 * §V16: a control moving at MIDI's message rate would re-render the app's whole tree.
 * Readings go into a ref the resolver reads at frame time; only the ACCESS STATE and the
 * PORT LIST — which change when hardware is plugged in, not when a knob moves — are React
 * state. A message arrives on the event loop between frames and is read at the next frame
 * boundary, so a reading is at most one frame old by construction: `external-live`, not
 * `async-cached`, and there is deliberately no age display (the plan's §6.4).
 */

/** What a learn row is handed when the user moves a control. */
export interface MidiLearnEvent {
  readonly reading: MidiReading;
  readonly portId: string;
}

export interface MidiInputBinding {
  readonly state: MidiAccessState;
  readonly ports: readonly MidiInputPort[];
  /** Ask for access. MUST be called from a user gesture. Idempotent while granted. */
  readonly request: () => void;
  /**
   * Merged into the value graph's external channels, BEHIND analyze — see `app.tsx`. It
   * answers only `midi:` names, so it can never shadow a node's channel.
   */
  readonly resolver: ChannelResolver;
  /**
   * MIDI-learn: the next supported message calls `listener`, once. Returns a disarm.
   *
   * Session state on purpose — an armed row is not a document fact, and one saved into a
   * file would re-arm every time the file was opened.
   */
  readonly arm: (listener: (event: MidiLearnEvent) => void) => () => void;
}

/**
 * How access is asked for. Injected ONLY by tests (T942's automated half).
 *
 * A gate cannot plug in a controller, and mocking `navigator` globally leaks across files
 * in a shared jsdom environment. So the ONE call to the browser is a parameter, defaulting
 * to the real thing — the same shape `createAnalyzeChannels` gives `readBuffer` and
 * `parameter-editor.ts` gives its scheduler. A fake `MIDIAccess` then drives the whole
 * path: enumeration, hooking, decoding, publishing, learn and teardown, all of the real
 * code, with only the browser's own object replaced.
 *
 * `undefined` — not a rejecting function — is how a test says "this browser has no Web
 * MIDI at all", because that is the shape Safari actually has.
 */
export interface MidiInputOptions {
  readonly requestAccess?: ((options: MIDIOptions) => Promise<MIDIAccess>) | undefined;
}

const MIDI_PREFIX = "midi:";

/** Nothing to read is not the same as zero; an unlearned control must fall to its rest. */
type Readings = Map<string, number>;

export function useMidiInput(options: MidiInputOptions = {}): MidiInputBinding {
  const [state, setState] = useState<MidiAccessState>({ kind: "idle" });
  const [ports, setPorts] = useState<readonly MidiInputPort[]>([]);

  const readings = useRef<Readings>(new Map());
  const armed = useRef<((event: MidiLearnEvent) => void) | null>(null);
  /** The granted access, so a re-request is a no-op and teardown can unhook every port. */
  const access = useRef<MIDIAccess | null>(null);
  const disposed = useRef(false);

  const handle = useCallback((portId: string, data: Uint8Array | null): void => {
    const reading = decodeMidiMessage(data);
    // An unsupported message (a note, a clock tick, SysEx) does NOTHING — it cannot be
    // learned and it cannot publish. See `midi-mapping.ts` for what that list is and why.
    if (reading === null) return;
    const key = midiSourceKey(reading.source);
    readings.current.set(`${MIDI_PREFIX}${portId}:${key}`, reading.raw);
    readings.current.set(`${MIDI_PREFIX}*:${key}`, reading.raw);
    const listener = armed.current;
    if (listener !== null) {
      // Disarm BEFORE calling: a learn binds ONE control, and a knob that is still moving
      // sends a stream. Re-entrant re-arming from inside the listener still works.
      armed.current = null;
      listener({ reading, portId });
    }
  }, []);

  /** Re-reads the port list and (re)hooks every input. Cheap; runs on every statechange. */
  const sync = useCallback(
    (granted: MIDIAccess): void => {
      if (disposed.current) return;
      const found: MidiInputPort[] = [];
      granted.inputs.forEach((input) => {
        found.push({ id: input.id, name: input.name ?? "" });
        // Assigning `onmidimessage` rather than adding a listener is what makes this
        // idempotent: a port re-hooked on every statechange keeps exactly one handler,
        // where `addEventListener` would stack one per replug.
        input.onmidimessage = (event) => handle(input.id, event.data);
      });
      found.sort((a, b) => a.id.localeCompare(b.id));
      // Identity churn is a re-render of everything below; only replace when the SET moved.
      setPorts((previous) =>
        previous.length === found.length && previous.every((port, index) => port.id === found[index]?.id && port.name === found[index]?.name)
          ? previous
          : found,
      );
    },
    [handle],
  );

  /* Read through a ref so a caller passing an inline arrow does not re-key `request`. */
  const injected = useRef(options.requestAccess);
  injected.current = options.requestAccess;

  const request = useCallback((): void => {
    if (access.current !== null) return;
    const ask =
      injected.current ??
      (typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function"
        ? (given: MIDIOptions) => navigator.requestMIDIAccess(given)
        : null);
    if (ask === null) {
      // Safari, at every version. There is nothing to retry and nothing to grant, so the
      // copy for this state must not offer a button that would do neither.
      setState({ kind: "unsupported" });
      return;
    }
    setState({ kind: "requesting" });
    // SysEx is NOT requested: it is a strictly scarier prompt and this row decodes none.
    ask({ sysex: false })
      .then((granted) => {
        if (disposed.current) return;
        access.current = granted;
        setState({ kind: "granted" });
        granted.onstatechange = () => sync(granted);
        sync(granted);
      })
      .catch((error: unknown) => {
        if (disposed.current) return;
        // A refusal is a `SecurityError`; anything else is a fault worth quoting. Both are
        // NON-FATAL — the document keeps rendering, degraded, either way.
        const name = error instanceof Error ? error.name : "";
        setState(
          name === "SecurityError" || name === "NotAllowedError"
            ? { kind: "denied" }
            : { kind: "failed", message: error instanceof Error ? error.message : String(error) },
        );
      });
  }, [sync]);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      const granted = access.current;
      if (granted === null) return;
      granted.onstatechange = null;
      granted.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
    };
  }, []);

  const resolver = useCallback<ChannelResolver>((channel) => {
    // Namespaced, so this resolver can never answer for a node's own channel name and the
    // merge order with analyze cannot matter (§V665's lesson about a claimed prefix, from
    // the safe side: the prefix is checked, not assumed).
    if (!channel.startsWith(MIDI_PREFIX)) return undefined;
    return readings.current.get(channel);
  }, []);

  const arm = useCallback((listener: (event: MidiLearnEvent) => void): (() => void) => {
    armed.current = listener;
    return () => {
      if (armed.current === listener) armed.current = null;
    };
  }, []);

  return useMemo(
    () => ({ state, ports, request, resolver, arm }),
    [state, ports, request, resolver, arm],
  );
}
