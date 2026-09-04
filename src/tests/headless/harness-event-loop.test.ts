import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { solidGraph } from "../fixtures/parity-graphs.ts";
import { FRAME_LOOP_YIELD_MS, renderHeadless } from "./render-harness.ts";

/**
 * ⚑ T1132/B150 — A LONG RENDER MUST STILL LET THE PROCESS ANSWER ITS MESSAGES.
 *
 * `pnpm test` exited non-zero with zero test failures. `quorum-claims.gpu.test.ts` renders
 * E54 twelve times at its shipped 3600-frame horizon, and a render with no Analyze node
 * awaits nothing between `driver.step()` calls — so each one was a single uninterrupted
 * block of the worker's event loop: 35.7 s of a 36.3 s render on an idle machine, longer
 * with the rest of the suite running beside it. Past sixty seconds the worker's
 * `onTaskUpdate` RPC times out on a reply that has already ARRIVED and cannot be read, and
 * Vitest fails the run with nothing failing in it. §B150's shape: the one command that says
 * everything is fine could not say it.
 *
 * ## TWO observers, because a half-yield passes a one-observer gate
 *
 * The claim is not "a yield exists" or "some callback ran". The runner needs two different
 * phases of the loop on every turn — the TIMERS phase, where birpc's deadline and Vitest's
 * own per-test timeout live, and the POLL phase, where the reply is actually read off the
 * channel — and a yield can reach one without the other. Both halves were measured here on
 * this fixture, and each one alone looks like a fix:
 *
 *  - `await Promise.resolve()` reaches neither: it never leaves the microtask queue, and
 *    messages sat unread for the whole 2.2 s render;
 *  - `setImmediate` resumes in CHECK, so the loop passes through POLL on the way and every
 *    message was read on time — while the interval below sat silent for that entire render.
 *    This is the form the fix was first written in, and a socket-only gate would have
 *    called it green.
 *
 * So one observer of each. The poll-phase one is a loopback socket, which is the same shape
 * as the fork channel Vitest's RPC runs over: writes are scheduled before the render starts
 * and each is only seen once the loop has been through poll. The timers-phase one is a plain
 * interval. Both measure the same thing — how long something waited that should not have.
 *
 * The bound is DERIVED from `FRAME_LOOP_YIELD_MS`, so moving the constant moves the gate
 * with it and this file never carries a second copy of the number.
 *
 * ## Why the render has to burn wall time
 *
 * The defect is a WALL GAP, and only wall time produces one. Frames on the mock host cost
 * microseconds — a million of them would still be a fast render and would prove nothing —
 * so the fixture burns its time in `betweenFrames`, the harness's own per-frame hook, which
 * is where a real render's per-frame cost sits. This is the least the claim can cost: just
 * over two yield intervals, so a render that never yields overshoots the bound by more than
 * the bound's entire slack.
 */

/** Held busy on purpose: an `await` would hand the loop back and there would be nothing to gate. */
function burn(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    /* spin — this stands in for a frame's real cost */
  }
}

const BURN_PER_FRAME_MS = 100;
/** Just over two yield intervals: long enough that a loop which never turns is unmistakable. */
const FRAMES = Math.ceil((FRAME_LOOP_YIELD_MS * 2.2) / BURN_PER_FRAME_MS);
/** Messages due often enough that several fall inside the render rather than around it. */
const MESSAGE_EVERY_MS = Math.round(FRAME_LOOP_YIELD_MS / 3);

/**
 * One frame's overshoot (the yield is checked BETWEEN frames, so the frame in flight when
 * the interval expires runs to completion), plus room for a GC pause. A render that never
 * turns the loop blows past this by two whole intervals.
 */
const ALLOWED_LAG_MS = FRAME_LOOP_YIELD_MS + BURN_PER_FRAME_MS + 900;

interface Channel {
  /** Schedules a write due `at` ms from now; resolves the lag between due and seen. */
  send: (at: number) => void;
  /** Lag, in ms, between when each message was due and when the loop got round to reading it. */
  readonly lags: number[];
  close: () => void;
}

async function loopbackChannel(): Promise<Channel> {
  const lags: number[] = [];
  const dueAt = new Map<string, number>();
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback port");

  const [reader, writer] = await Promise.all([
    new Promise<net.Socket>((resolve) => server.once("connection", resolve)),
    new Promise<net.Socket>((resolve) => {
      const socket = net.createConnection({ port: address.port, host: "127.0.0.1" }, () =>
        resolve(socket),
      );
    }),
  ]);
  reader.on("data", (chunk) => {
    const now = Date.now();
    for (const id of chunk.toString().split(",").filter(Boolean)) {
      const due = dueAt.get(id);
      if (due !== undefined) lags.push(now - due);
    }
  });

  let next = 0;
  return {
    send: (at: number) => {
      const id = String((next += 1));
      dueAt.set(id, Date.now() + at);
      setTimeout(() => writer.write(`${id},`), at);
    },
    lags,
    close: () => {
      reader.destroy();
      writer.destroy();
      server.close();
    },
  };
}

let channel: Channel | undefined;
afterEach(() => {
  channel?.close();
  channel = undefined;
});

describe("T1132 — a long render still lets the process answer", () => {
  it("turns the whole event loop while it renders — timers and channel both", async () => {
    channel = await loopbackChannel();
    const expected = Math.floor((FRAMES * BURN_PER_FRAME_MS) / MESSAGE_EVERY_MS);
    for (let index = 1; index <= expected; index += 1) channel.send(index * MESSAGE_EVERY_MS);

    // The TIMERS-phase observer: the gap between its own ticks is how long a deadline that
    // came due mid-render would have waited to be noticed.
    let lastTick = Date.now();
    let worstTickGap = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      worstTickGap = Math.max(worstTickGap, now - lastTick);
      lastTick = now;
    }, 50);

    const startedAt = Date.now();
    lastTick = startedAt;
    try {
      await renderHeadless({
        host: mockGpuHost(),
        graph: solidGraph(),
        frames: FRAMES,
        capture: [],
        betweenFrames: () => burn(BURN_PER_FRAME_MS),
      });
    } finally {
      clearInterval(ticker);
    }
    const wall = Date.now() - startedAt;
    /*
     * One free turn of the loop, so that "read late" and "lost" stay different findings.
     * Anything still unread here never arrived at all; anything read here is read AFTER the
     * render and carries a lag to say so, which is what the bound below judges.
     */
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    /*
     * NON-VACUITY. The render must really have outlived more than one yield interval —
     * otherwise "nothing waited long" is true because nothing was asked of the loop — and
     * more than a couple of messages must have been due inside it, or a single lucky turn
     * would carry the claim.
     */
    expect(wall).toBeGreaterThan(FRAME_LOOP_YIELD_MS * 2);
    expect(expected).toBeGreaterThan(2);

    /*
     * THE CLAIM, HALF ONE — POLL. Every message was seen, and none waited longer than one
     * yield interval to be seen. `lags` is read after the render because a message read late
     * is still read: what is gated is HOW late, which is the number the RPC deadline is
     * compared against.
     */
    expect(channel.lags).toHaveLength(expected);
    const worstMessage = Math.max(...channel.lags);
    expect(
      worstMessage,
      `a message sat unread for ${worstMessage} ms while the harness rendered (wall ${wall} ms, ` +
        `${FRAMES} frames). A worker that cannot read its channel for that long fails the ` +
        `run with no failing test — see the note at the yield in render-harness.ts.`,
    ).toBeLessThan(ALLOWED_LAG_MS);

    /*
     * THE CLAIM, HALF TWO — TIMERS. A deadline coming due mid-render is noticed mid-render.
     * This is the half that keeps a genuinely hung render detectable at all: Vitest's own
     * per-test timeout is a timer, and it cannot fire in a phase the loop never reaches.
     */
    expect(
      worstTickGap,
      `the timers phase went ${worstTickGap} ms without running while the harness rendered ` +
        `(wall ${wall} ms). Nothing that expires — the RPC deadline, this suite's own test ` +
        `timeout — can fire in a phase the loop never reaches.`,
    ).toBeLessThan(ALLOWED_LAG_MS);
  }, 60_000);
});
