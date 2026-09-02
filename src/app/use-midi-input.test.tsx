// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { MidiLearnEvent } from "./use-midi-input.ts";
import { useMidiInput } from "./use-midi-input.ts";

/**
 * T942 tier 1 — THE AUTOMATED HALF, so nobody needs a controller in the room.
 *
 * The owner's question was how this gets tested at all. The answer is two things, and both
 * exist: a sender page for a human (`tools/midi-sender.html` — real Web MIDI on both ends,
 * through a virtual port), and this file for CI. What this file fakes is exactly ONE
 * object — the browser's `MIDIAccess` — and every line of our own code runs for real:
 * enumeration, hooking, decoding, publishing, learn, teardown.
 *
 * That boundary is chosen deliberately. Faking `decodeMidiMessage` would test nothing;
 * faking the whole hook would test nothing. The seam is the browser's, so the fake is the
 * browser's.
 *
 * ## The assertion this file exists for, above all others
 *
 * MIDI IS NEVER REQUESTED ON MOUNT. Chrome has prompted for all Web MIDI since 124, so a
 * hook that asked on render would put a permission dialog in front of every document
 * anyone opened — §V476's ambush, generalised from one example to the whole app. It is the
 * first test below and it fails the moment someone "helpfully" adds an effect.
 */

/**
 * A port that supports BOTH ways a listener can be attached.
 *
 * `addEventListener` is here precisely so the "does a re-sync stack listeners" assertion
 * can fail. With only an assignable `onmidimessage` that assertion is a tautology — one
 * slot cannot hold two handlers — and a tautological guard is §V500's unfalsifiable one.
 * `deliveries` counts every invocation across both routes, so a second handler is visible
 * as a doubled count rather than inferred.
 */
class FakePort {
  onmidimessage: ((event: { data: Uint8Array | null }) => void) | null = null;
  readonly listeners: Array<(event: { data: Uint8Array | null }) => void> = [];
  deliveries = 0;
  readonly id: string;
  readonly name: string;
  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
  addEventListener(_type: string, listener: (event: { data: Uint8Array | null }) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: (event: { data: Uint8Array | null }) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  send(bytes: readonly number[]): void {
    const event = { data: new Uint8Array(bytes) };
    if (this.onmidimessage !== null) {
      this.deliveries += 1;
      this.onmidimessage(event);
    }
    for (const listener of [...this.listeners]) {
      this.deliveries += 1;
      listener(event);
    }
  }
}

class FakeAccess {
  onstatechange: (() => void) | null = null;
  ports: FakePort[];
  constructor(ports: FakePort[]) {
    this.ports = ports;
  }
  readonly inputs = {
    forEach: (callback: (port: FakePort) => void): void => {
      for (const port of this.ports) callback(port);
    },
  };
}

const asAccess = (fake: FakeAccess): MIDIAccess => fake as unknown as MIDIAccess;

/** The resolver takes a driver context it never reads; nothing here has one to give. */
const read = (resolver: (name: string, context: never) => unknown, name: string): unknown =>
  resolver(name, undefined as never);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("§V476 — the permission is asked on a GESTURE, never on load", () => {
  it("requests nothing on mount, and reports idle rather than a failure", async () => {
    const requestAccess = vi.fn(() => Promise.resolve(asAccess(new FakeAccess([]))));
    const { result } = renderHook(() => useMidiInput({ requestAccess }));
    // A microtask turn, so an effect that asked would have been caught.
    await act(async () => {});
    expect(requestAccess).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "idle" });
    // And idle is not an error state: nothing has gone wrong, nothing has been asked.
    expect(result.current.ports).toEqual([]);
  });

  it("asks once when the button is pressed, and a second press is a no-op", async () => {
    const requestAccess = vi.fn(() => Promise.resolve(asAccess(new FakeAccess([]))));
    const { result } = renderHook(() => useMidiInput({ requestAccess }));
    await act(async () => {
      result.current.request();
    });
    expect(result.current.state).toEqual({ kind: "granted" });
    await act(async () => {
      result.current.request();
    });
    expect(requestAccess).toHaveBeenCalledTimes(1);
  });

  it("does not ask for SysEx — a scarier prompt for a capability this row does not use", () => {
    const requestAccess = vi.fn(() => Promise.resolve(asAccess(new FakeAccess([]))));
    const { result } = renderHook(() => useMidiInput({ requestAccess }));
    act(() => {
      result.current.request();
    });
    expect(requestAccess).toHaveBeenCalledWith({ sysex: false });
  });
});

describe("the three absences, each reaching a DIFFERENT state (§V359)", () => {
  it("no requestMIDIAccess at all is `unsupported` — Safari, at every version", async () => {
    // jsdom's navigator has none, and no injection is given: exactly Safari's shape.
    const { result } = renderHook(() => useMidiInput());
    await act(async () => {
      result.current.request();
    });
    expect(result.current.state).toEqual({ kind: "unsupported" });
  });

  it("a refusal is `denied`, and it is not fatal", async () => {
    const error = new Error("refused");
    error.name = "SecurityError";
    const { result } = renderHook(() => useMidiInput({ requestAccess: () => Promise.reject(error) }));
    await act(async () => {
      result.current.request();
    });
    expect(result.current.state).toEqual({ kind: "denied" });
    // The seam keeps answering; it simply has nothing to answer with. A throwing resolver
    // would take every driven parameter down with it.
    expect(read(result.current.resolver, "midi:*:cc1.74")).toBeUndefined();
  });

  it("any other fault is `failed` and carries the browser's own words", async () => {
    const { result } = renderHook(() =>
      useMidiInput({ requestAccess: () => Promise.reject(new Error("the port went away")) }),
    );
    await act(async () => {
      result.current.request();
    });
    expect(result.current.state).toEqual({ kind: "failed", message: "the port went away" });
  });

  it("granted with NO ports is a distinct state from granted with ports", async () => {
    const { result } = renderHook(() =>
      useMidiInput({ requestAccess: () => Promise.resolve(asAccess(new FakeAccess([]))) }),
    );
    await act(async () => {
      result.current.request();
    });
    expect(result.current.state).toEqual({ kind: "granted" });
    expect(result.current.ports).toEqual([]);
  });
});

describe("readings reach the channel seam, under both names", () => {
  const grantOne = async () => {
    const port = new FakePort("port-7", "Launch Control");
    const access = new FakeAccess([port]);
    const hook = renderHook(() => useMidiInput({ requestAccess: () => Promise.resolve(asAccess(access)) }));
    await act(async () => {
      hook.result.current.request();
    });
    return { hook, port, access };
  };

  it("enumerates the ports it was given", async () => {
    const { hook } = await grantOne();
    expect(hook.result.current.ports).toEqual([{ id: "port-7", name: "Launch Control" }]);
  });

  it("publishes a CC under the device name AND the any-device name", async () => {
    const { hook, port } = await grantOne();
    act(() => {
      port.send([0xb0, 74, 100]);
    });
    // Device-scoped, for a node that picked this controller.
    expect(read(hook.result.current.resolver, "midi:port-7:cc1.74")).toBe(100);
    // Any-device, which is what a freshly-dropped node with no device picked reads.
    expect(read(hook.result.current.resolver, "midi:*:cc1.74")).toBe(100);
  });

  it("answers ONLY the midi namespace, so it can never shadow a node's channel", async () => {
    const { hook, port } = await grantOne();
    act(() => {
      port.send([0xb0, 74, 100]);
    });
    expect(read(hook.result.current.resolver, "cc1.74")).toBeUndefined();
    expect(read(hook.result.current.resolver, "meter1")).toBeUndefined();
  });

  it("publishes NOTHING for a message this row does not support", async () => {
    const { hook, port } = await grantOne();
    act(() => {
      port.send([0x90, 60, 100]); // note on
      port.send([0xf8]); // clock
    });
    // Both directions (§V461): the supported message DID publish above, so an empty map
    // here is the decoder dropping these rather than nothing working at all.
    expect(read(hook.result.current.resolver, "midi:*:cc1.60")).toBeUndefined();
    expect(read(hook.result.current.resolver, "midi:port-7:bend1")).toBeUndefined();
  });

  it("does not re-render the tree per message — readings are a ref, not state (§V16)", async () => {
    const port = new FakePort("port-7", "Launch Control");
    const access = new FakeAccess([port]);
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useMidiInput({ requestAccess: () => Promise.resolve(asAccess(access)) });
    });
    await act(async () => {
      hook.result.current.request();
    });
    const settled = renders;
    act(() => {
      for (let value = 0; value < 40; value += 1) port.send([0xb0, 74, value]);
    });
    expect(renders).toBe(settled);
    expect(read(hook.result.current.resolver, "midi:*:cc1.74")).toBe(39);
  });

  it("re-hooks a port on statechange WITHOUT stacking a second listener", async () => {
    const { port, access } = await grantOne();
    act(() => {
      port.send([0xb0, 74, 1]);
    });
    expect(port.deliveries).toBe(1);
    // A replug fires statechange, and the hook re-walks every input. Assigning
    // `onmidimessage` rather than adding a listener is what keeps that idempotent; the
    // `addEventListener` version of this hook doubles the count here and every reading
    // after it would be decoded twice.
    act(() => {
      access.onstatechange?.();
      port.send([0xb0, 74, 2]);
    });
    expect(port.deliveries).toBe(2);
  });

  it("unhooks every port on unmount", async () => {
    const { hook, port, access } = await grantOne();
    hook.unmount();
    expect(port.onmidimessage).toBeNull();
    expect(access.onstatechange).toBeNull();
  });
});

describe("MIDI-learn — the next message binds, once", () => {
  const grantOne = async () => {
    const port = new FakePort("port-7", "Launch Control");
    const access = new FakeAccess([port]);
    const hook = renderHook(() => useMidiInput({ requestAccess: () => Promise.resolve(asAccess(access)) }));
    await act(async () => {
      hook.result.current.request();
    });
    return { hook, port };
  };

  it("hands the armed listener the control that moved, with its port", async () => {
    const { hook, port } = await grantOne();
    const seen: MidiLearnEvent[] = [];
    act(() => {
      hook.result.current.arm((event) => seen.push(event));
      port.send([0xb0, 19, 64]);
    });
    expect(seen).toEqual([{ reading: { source: { kind: "cc", channel: 1, number: 19 }, raw: 64 }, portId: "port-7" }]);
  });

  it("binds ONE control — a knob still moving must not re-bind on every message", async () => {
    const { hook, port } = await grantOne();
    const seen: MidiLearnEvent[] = [];
    act(() => {
      hook.result.current.arm((event) => seen.push(event));
      port.send([0xb0, 19, 64]);
      port.send([0xb0, 19, 65]);
      port.send([0xb0, 22, 10]);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reading.source).toEqual({ kind: "cc", channel: 1, number: 19 });
  });

  it("ignores an unsupported message rather than binding a control nobody can use", async () => {
    const { hook, port } = await grantOne();
    const seen: MidiLearnEvent[] = [];
    act(() => {
      hook.result.current.arm((event) => seen.push(event));
      port.send([0x90, 60, 100]);
      port.send([0xb0, 19, 64]);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reading.source).toEqual({ kind: "cc", channel: 1, number: 19 });
  });

  it("can be disarmed, so an armed row the user gave up on is not a trap", async () => {
    const { hook, port } = await grantOne();
    const seen: MidiLearnEvent[] = [];
    act(() => {
      const disarm = hook.result.current.arm((event) => seen.push(event));
      disarm();
      port.send([0xb0, 19, 64]);
    });
    expect(seen).toEqual([]);
    // And the reading still published — disarming a learn does not stop the feed.
    expect(read(hook.result.current.resolver, "midi:*:cc1.19")).toBe(64);
  });

  it("learns pitch bend at full resolution, so a bend binding is not born truncated", async () => {
    const { hook, port } = await grantOne();
    const seen: MidiLearnEvent[] = [];
    act(() => {
      hook.result.current.arm((event) => seen.push(event));
      port.send([0xe0, 0x00, 0x40]);
    });
    expect(seen[0]?.reading).toEqual({ source: { kind: "pitchBend", channel: 1 }, raw: 8192 });
  });
});
