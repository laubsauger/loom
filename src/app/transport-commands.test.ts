import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import { registerTransportCommands, transportHolderFor } from "./transport-commands.ts";
import type { TransportHandlers } from "./transport-commands.ts";

/**
 * §V29/§V52, T184 — `space` and `.` in the keymap defaults name these two commands.
 * They must actually run something: before this, nothing registered them and the
 * keymap engine reported them `unresolved` forever.
 */

function fakeHandlers(): TransportHandlers & {
  playing: boolean;
  stepped: number[];
  looping: boolean;
} {
  const state = { playing: false, looping: false, stepped: [] as number[] };
  return {
    get playing() {
      return state.playing;
    },
    set playing(value: boolean) {
      state.playing = value;
    },
    stepped: state.stepped,
    isPlaying: () => state.playing,
    togglePlay: () => {
      state.playing = !state.playing;
    },
    seek: (frameIndex: number) => frameIndex,
    stepFrame: (frames: number) => {
      state.stepped.push(frames);
      return frames - 1;
    },
    stepOnce: () => null,
    get looping() {
      return state.looping;
    },
    set looping(value: boolean) {
      state.looping = value;
    },
    isLooping: () => state.looping,
    toggleLoop: () => {
      state.looping = !state.looping;
    },
  };
}

describe("registerTransportCommands", () => {
  it("rejects both commands when no frame loop has claimed the holder", async () => {
    const { bus } = createHarness();
    registerTransportCommands(bus);

    const play = await bus.execute("transport.togglePlay", {}, contextFor(alice));
    expect(play.status).toBe("rejected");
    expect(play.output).toEqual({ playing: false });

    const step = await bus.execute("transport.stepFrame", {}, contextFor(alice));
    expect(step.status).toBe("rejected");
    expect(step.output).toEqual({ frameIndex: -1 });
  });

  it("applies through the holder once a frame loop is mounted, and reports its state", async () => {
    const { bus } = createHarness();
    const holder = registerTransportCommands(bus);
    const handlers = fakeHandlers();
    holder.current = handlers;

    const first = await bus.execute("transport.togglePlay", {}, contextFor(alice));
    expect(first.status).toBe("applied");
    expect(first.output).toEqual({ playing: true });

    const second = await bus.execute("transport.togglePlay", {}, contextFor(alice));
    expect(second.output).toEqual({ playing: false });

    const step = await bus.execute("transport.stepFrame", { frames: 3 }, contextFor(alice));
    expect(step.status).toBe("applied");
    expect(step.output).toEqual({ frameIndex: 2 });
    expect(handlers.stepped).toEqual([3]);
  });

  it("does not mutate on a dry run, and registration is idempotent", async () => {
    const { bus } = createHarness();
    const holder = registerTransportCommands(bus);
    registerTransportCommands(bus); // second call must not double-register
    const handlers = fakeHandlers();
    holder.current = handlers;

    const result = await bus.execute(
      "transport.togglePlay",
      {},
      { ...contextFor(alice), dryRun: true },
    );
    expect(result.status).toBe("applied");
    expect(handlers.playing).toBe(false); // unchanged — dryRun never calls togglePlay

    expect(transportHolderFor(bus)).toBe(holder);
  });
});
