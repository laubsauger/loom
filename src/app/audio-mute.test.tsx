// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { captureConfigOf, hasUnboundAudioFile, useAudioInput } from "./use-audio-input.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";

/**
 * T555 — a MUTED or BYPASSED audio node makes NO SOUND.
 *
 * The owner: "audio file in is muted but still audible. that probably needs to not play if
 * the node is not actually cooking / is bypassed / muted." T541 stopped the CHANNELS; this
 * is the other half of the same defect, under the same definitions.
 *
 * ## The gate is the ELEMENT, not the parameter
 *
 * A test asserting `node.ui.muted === true`, or even that `captureConfigOf` returned null,
 * would pass while sound still came out of the speakers — the element was already playing
 * and nobody told it to stop. So the harness below stubs `AudioContext` and `Audio`, runs
 * the REAL hook, and asserts on the element the hook actually created: it was playing, and
 * after the mute it is PAUSED, its source is cleared, and its context is closed. Selection
 * is tested too, but as the mechanism, not as the proof.
 *
 * ## The rule, and the ordering that had to be decided
 *
 * MUTE OVERRIDES `monitor`. `monitor` means "route this to the speakers"; mute means "this
 * node is off"; off wins. It is structural rather than a rule someone has to remember —
 * a silenced node never becomes a capture candidate, so `monitor` is never consulted for
 * it. The `monitor: true` case is asserted below precisely because that is the pairing
 * where a wrong ordering would be audible.
 *
 * BYPASS on an audio source is the same silence, straight from T541: these nodes have no
 * inputs, so a bypassed one has nothing to pass through, and "nothing to pass" is silence.
 *
 * NOT COOKING, the owner's third state, has no separate answer HERE and that is deliberate
 * — see the last case in this file for the argument.
 */

interface FakeElement {
  src: string;
  crossOrigin: string | null;
  loop: boolean;
  currentTime: number;
  playbackRate: number;
  readonly duration: number;
  paused: boolean;
  readonly readyState: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

const elements: FakeElement[] = [];
const contexts: Array<{ closed: boolean; connectedToDestination: boolean }> = [];

function installAudioStubs(): void {
  elements.length = 0;
  contexts.length = 0;

  class FakeAudio implements FakeElement {
    src = "";
    crossOrigin: string | null = null;
    loop = false;
    currentTime = 0;
    playbackRate = 1;
    readonly duration = 30;
    paused = true;
    /** HAVE_METADATA, so `awaitMediaReady` resolves without an event round-trip. */
    readonly readyState = 1;
    play(): Promise<void> {
      this.paused = false;
      return Promise.resolve();
    }
    pause(): void {
      this.paused = true;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    constructor() {
      elements.push(this);
    }
  }

  class FakeContext {
    readonly sampleRate = 48000;
    readonly destination = { kind: "destination" };
    readonly state = "running";
    private readonly record = { closed: false, connectedToDestination: false };
    constructor() {
      contexts.push(this.record);
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        smoothingTimeConstant: 0,
        getByteFrequencyData: () => undefined,
        getByteTimeDomainData: () => undefined,
        connect: () => undefined,
      };
    }
    createMediaElementSource() {
      return { connect: () => undefined };
    }
    createGain() {
      const record = this.record;
      const destination = this.destination;
      return {
        gain: { value: 1 },
        connect: (target: unknown) => {
          if (target === destination) record.connectedToDestination = true;
        },
      };
    }
    close(): Promise<void> {
      this.record.closed = true;
      return Promise.resolve();
    }
    resume(): Promise<void> {
      return Promise.resolve();
    }
  }

  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeContext;
}

function node(id: string, type: string, parameters: Record<string, unknown>, ui?: GraphNode["ui"]): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label: id,
    ...(ui === undefined ? {} : { ui }),
  } as GraphNode;
}

const graphOf = (nodes: GraphNode[]): GraphDocument =>
  ({ revision: 1, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: {}, groups: {} }) as never;

/** Renders the real hook against a graph the test can swap under it. */
function Harness({ getGraph }: { getGraph: () => GraphDocument }): null {
  useAudioInput(getGraph);
  return null;
}

/** One poll of the hook's config watcher (it polls once a second by design). */
async function tick(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const FILE = { file: "blob:track.mp3", monitor: true };

beforeEach(() => {
  installAudioStubs();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("T555 — muting an audio node stops the SOUND, not just the channels", () => {
  it("the element the hook created is PLAYING while the node is live — the baseline", async () => {
    const graph = { current: graphOf([node("music", "audioFileIn", FILE)]) };
    render(<Harness getGraph={() => graph.current} />);
    await tick();

    expect(elements.length, "the hook never opened an element, so nothing below proves anything").toBe(1);
    expect(elements[0]?.paused).toBe(false);
    expect(elements[0]?.src).toBe("blob:track.mp3");
    // `monitor: true` means it is routed to the speakers — the case a wrong mute/monitor
    // ordering would leave audible.
    expect(contexts[0]?.connectedToDestination).toBe(true);
    expect(contexts[0]?.closed).toBe(false);
  });

  for (const flag of ["muted", "bypassed"] as const) {
    it(`${flag} while playing: the element is PAUSED, its source cleared, its context closed`, async () => {
      const graph = { current: graphOf([node("music", "audioFileIn", FILE)]) };
      render(<Harness getGraph={() => graph.current} />);
      await tick();
      const element = elements[0];
      expect(element?.paused).toBe(false);

      graph.current = graphOf([node("music", "audioFileIn", FILE, { [flag]: true })]);
      await tick();

      // The assertion that matters: the ELEMENT stopped. Not "the parameter says muted".
      expect(element?.paused, `${flag} left the element playing`).toBe(true);
      expect(element?.src).toBe("");
      expect(contexts[0]?.closed).toBe(true);
      // And nothing was opened in its place.
      expect(elements.length).toBe(1);
    });

    it(`${flag} from the start: no element is ever opened, and monitor never gets a vote`, async () => {
      const graph = {
        current: graphOf([node("music", "audioFileIn", FILE, { [flag]: true })]),
      };
      render(<Harness getGraph={() => graph.current} />);
      await tick();
      expect(elements.length).toBe(0);
      expect(contexts.length).toBe(0);
    });
  }

  it("un-muting opens it again, so this is an OFF switch and not a one-way door", async () => {
    const graph = { current: graphOf([node("music", "audioFileIn", FILE, { muted: true })]) };
    render(<Harness getGraph={() => graph.current} />);
    await tick();
    expect(elements.length).toBe(0);

    graph.current = graphOf([node("music", "audioFileIn", FILE)]);
    await tick();
    expect(elements.length).toBe(1);
    expect(elements[0]?.paused).toBe(false);
  });
});

describe("T555 — which node the session captures, once a node can be off", () => {
  it("mute overrides monitor: `monitor: true` on a muted node is still no capture", () => {
    expect(captureConfigOf(graphOf([node("music", "audioFileIn", FILE, { muted: true })]))).toBeNull();
  });

  it("a silenced node PROMOTES the next candidate rather than taking the session down with it", () => {
    const config = captureConfigOf(
      graphOf([
        node("a", "audioFileIn", { file: "blob:first.mp3", monitor: true }, { muted: true }),
        node("b", "audioFileIn", { file: "blob:second.mp3", monitor: true }),
      ]),
    );
    expect(config?.url).toBe("blob:second.mp3");
    expect(config?.nodeId).toBe("b");
  });

  it("a muted microphone does not open the DEVICE — a permission prompt from an off node is an ambush", () => {
    expect(captureConfigOf(graphOf([node("mic", "audioIn", {}, { muted: true })]))).toBeNull();
    // And the next mic still works, so this silences one node rather than the feature.
    const config = captureConfigOf(
      graphOf([node("a", "audioIn", { device: "one" }, { muted: true }), node("b", "audioIn", { device: "two" })]),
    );
    expect(config?.source).toBe("mic");
    expect(config?.device).toBe("two");
  });

  it("a muted UNBOUND file node is not 'waiting for a file' — it is off (B74's status stays honest)", () => {
    expect(hasUnboundAudioFile(graphOf([node("music", "audioFileIn", {})]))).toBe(true);
    expect(hasUnboundAudioFile(graphOf([node("music", "audioFileIn", {}, { muted: true })]))).toBe(false);
  });

  it("a live node is unaffected — the flags are the only thing that changed", () => {
    expect(captureConfigOf(graphOf([node("music", "audioFileIn", FILE)]))).toEqual({
      source: "file",
      url: "blob:track.mp3",
      device: "",
      monitor: true,
      nodeId: "music",
    });
  });
});

/**
 * The assumption `isSilencedSource` makes, gated rather than commented (§V437).
 *
 * It answers "is this node off" from the flags alone, which is only sound for a node with
 * NO INPUTS — that is where bypass unambiguously means silence, because there is nothing
 * to pass through. Every audio capture candidate is such a node today. If one grows an
 * input tomorrow, this reddens and whoever added it has to decide what bypass means there
 * before the audio path can keep using the cheap answer.
 */
describe("T555 — the capture candidates really are inputless sources", () => {
  it("audioFileIn and audioIn declare no inputs, which is what makes bypass mean silence", () => {
    for (const type of ["audioFileIn", "audioIn"]) {
      const definition = allNodeDefinitions.find((entry) => entry.type === type);
      expect(definition, `${type} is gone from the registry`).toBeDefined();
      expect(definition?.inputs, `${type} grew an input; bypass no longer trivially means silence`).toEqual([]);
    }
  });
});

/**
 * THE THIRD STATE, and why it is not implemented as a third state.
 *
 * The owner named "not actually cooking" beside bypassed and muted, and TD agrees a
 * non-cooking CHOP makes no sound. But in this project a value node is evaluated EVERY
 * FRAME whether or not anything reads it — §V155, deliberately: a stateful stage that is
 * skipped does not go stale, it DIVERGES, so `useValueGraph` never evaluates lazily. So
 * "not cooking" is not a state an unconsumed node can be in; after T541 the only nodes
 * that do not cook are the muted and the bypassed ones, which is exactly the set this file
 * silences. The third state and the first two are the same set.
 *
 * The alternative — "unconsumed means silent" — was rejected on three counts, and the
 * rejection is recorded because the question will come back: it would contradict §V155's
 * unconditional evaluation; it would make whether you can HEAR a file depend on graph
 * topology, with nothing on screen saying so; and it would break auditioning a track
 * before wiring it, which is how anyone actually starts. `monitor: true` is an explicit
 * request to hear something, and nothing here overrules it except the node being off.
 */
describe("T555 — an unconsumed but monitored node still plays, deliberately", () => {
  it("a file node wired to nothing is still the session's capture", async () => {
    const graph = { current: graphOf([node("music", "audioFileIn", FILE)]) };
    render(<Harness getGraph={() => graph.current} />);
    await tick();
    expect(elements[0]?.paused).toBe(false);
  });
});
