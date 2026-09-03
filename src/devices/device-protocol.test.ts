import { describe, expect, it } from "vitest";

import {
  deviceStreamId,
  vetOscDestination,
  vetOscListenPort,
  type DeviceClientMessage,
  type DeviceHostMessage,
  type OscSendOutcome,
} from "./device-protocol.ts";
import { describeSendOutcome } from "../domain/osc/osc-status.ts";

/**
 * THE DEVICE ROLE'S CONTRACT (T942 tier 3, §T950 gaps 1, 3 and 4).
 *
 * These are not transport tests — `device-bridge.test.ts` drives the bytes. These pin the
 * three properties that a future author could quietly undo with a one-line change and no
 * other test noticing: the streaming shape's disambiguation rule, the send vocabulary, and
 * the refusal to default a destination.
 */

describe("§T950 gap 1 — an `id` means one reply, a `stream` means zero or more pushes", () => {
  /*
   * The rule the whole streaming design rests on, asserted STRUCTURALLY rather than left as
   * a sentence in a docblock: on a HOST message, the PRESENCE OF `id` decides. Present, it
   * is the one reply owed to a request; absent, it is an unsolicited push routed by
   * `stream`. Decidable from one field, which is what a reader needs at runtime.
   *
   * `deviceSubscribed` carries both on purpose — it is the reply that HANDS BACK the stream
   * name, so the pushes that follow can be routed by something the page now knows. A
   * `stream` beside an `id` is a value being returned; a `stream` without one is a tag.
   *
   * Written as exhaustive samples of each union, so a member added without thinking about
   * this fails to compile here before it fails anywhere else.
   */
  const requests: readonly DeviceClientMessage[] = [
    { type: "deviceAttach", code: "AAA", client: "x" },
    { type: "deviceSubscribe", id: 1, source: { kind: "osc", port: 9000 } },
    { type: "deviceUnsubscribe", id: 2, stream: "osc:9000" },
    { type: "deviceSend", id: 3, to: { host: "127.0.0.1", port: 9000 }, packets: [] },
    { type: "deviceAck", stream: "osc:9000", seq: 7 },
  ];
  const replies: readonly DeviceHostMessage[] = [
    { type: "deviceAttached", sources: [] },
    { type: "refused", reason: "x" },
    { type: "deviceSubscribed", id: 1, stream: "osc:9000", flow: "coalesce", detail: "x" },
    { type: "deviceRefused", id: 1, reason: "x" },
    { type: "deviceSendResult", id: 3, outcome: { delivery: "refused", reason: "x" } },
    { type: "deviceEvents", stream: "osc:9000", at: 1, seq: 1, dropped: 0, values: {} },
    { type: "deviceStreamState", stream: "osc:9000", state: "open", detail: "x" },
  ];

  it("every HOST message after the handshake is classifiable from `id` alone", () => {
    const pushTypes = new Set(["deviceEvents", "deviceStreamState"]);
    // The handshake sits either side of the rule: one attach is ever in flight per socket,
    // so there is nothing for an id to disambiguate — the page role's `attached`/`refused`
    // are shaped the same way and for the same reason.
    const handshake = new Set(["deviceAttached", "refused"]);
    for (const message of replies.filter((entry) => !handshake.has(entry.type))) {
      const record = message as unknown as Record<string, unknown>;
      const isPush = pushTypes.has(message.type);
      // A push must never carry an `id`, or a reader would resolve a promise nobody made.
      expect("id" in record, `${message.type}`).toBe(!isPush);
      // And a push must carry a `stream`, or it could not be routed at all.
      if (isPush) expect("stream" in record, `${message.type}`).toBe(true);
    }
  });

  it("every page REQUEST carries an id, except the one that is told rather than asked", () => {
    for (const message of requests) {
      const record = message as unknown as Record<string, unknown>;
      const owed = message.type !== "deviceAttach" && message.type !== "deviceAck";
      expect("id" in record, `${message.type}`).toBe(owed);
    }
  });

  it("every PUSH carries a stream, so nothing is left waiting for a reply that never comes", () => {
    const pushes = replies.filter(
      (message) => message.type === "deviceEvents" || message.type === "deviceStreamState",
    );
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect("id" in (push as unknown as Record<string, unknown>)).toBe(false);
      expect("stream" in (push as unknown as Record<string, unknown>)).toBe(true);
    }
  });

  it("a stream id is stable, so a resubscribe addresses the same socket", () => {
    expect(deviceStreamId({ kind: "osc", port: 9000 })).toBe(deviceStreamId({ kind: "osc", port: 9000 }));
    expect(deviceStreamId({ kind: "osc", port: 9000 })).not.toBe(deviceStreamId({ kind: "osc", port: 9001 }));
  });
});

describe("§T950 gap 3 — the send vocabulary has no word for `arrived`", () => {
  it("names exactly three outcomes, and `delivered` is not one of them", () => {
    /*
     * §V461 read backwards: the assertion is about what CANNOT be said. UDP tells the
     * sender whether the local write succeeded and nothing more, so a union with a
     * success member would be a lie the type system invited. Pinned by name so that
     * adding one is a red test rather than a plausible convenience.
     */
    const outcomes: readonly OscSendOutcome[] = [
      { delivery: "refused", reason: "x" },
      { delivery: "failed", reason: "x" },
      { delivery: "unconfirmed", transport: "udp", handed: 1, to: { host: "127.0.0.1", port: 1 }, at: 0 },
    ];
    expect(outcomes.map((outcome) => outcome.delivery).sort()).toEqual([
      "failed",
      "refused",
      "unconfirmed",
    ]);
  });

  it("the sentence a human reads says arrival is unconfirmed, and never claims delivery", () => {
    const sentence = describeSendOutcome({
      delivery: "unconfirmed",
      handed: 2,
      to: { host: "10.0.0.4", port: 9000 },
    });
    expect(sentence).toContain("arrival unconfirmed");
    expect(sentence).toContain("UDP");
    // The words a UI must never be able to reach for out of this function.
    for (const forbidden of ["delivered", "received", "arrived", "✓"]) {
      expect(sentence.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it("a local failure and a refusal read as different things, because they need different fixes", () => {
    expect(describeSendOutcome({ delivery: "failed", reason: "EACCES" })).toContain("failed here");
    expect(describeSendOutcome({ delivery: "refused", reason: "no destination" })).toContain("Not sent");
    expect(describeSendOutcome(null)).toBe("Nothing sent yet.");
  });
});

describe("§T950 gap 4 / §T458 — there is no default destination and no broadcast", () => {
  it("refuses an empty host and says what to set, rather than doing nothing quietly", () => {
    const vetted = vetOscDestination("", 9000);
    expect(vetted.ok).toBe(false);
    if (vetted.ok) throw new Error("unreachable");
    expect(vetted.reason).toContain("no default");
  });

  it("refuses a zero or out-of-range port", () => {
    expect(vetOscDestination("127.0.0.1", 0).ok).toBe(false);
    expect(vetOscDestination("127.0.0.1", 70_000).ok).toBe(false);
    expect(vetOscDestination("127.0.0.1", 1.5).ok).toBe(false);
  });

  it("refuses the limited and directed broadcast addresses BY NAME", () => {
    // Art-Net's own default is `2.255.255.255`. Copying that habit into OSC is §T458's
    // measured mistake in a different protocol, so it is refused rather than warned about.
    for (const host of ["255.255.255.255", "2.255.255.255", "192.168.0.255", "10.1.2.255"]) {
      const vetted = vetOscDestination(host, 6454);
      expect(vetted.ok, host).toBe(false);
      if (vetted.ok) throw new Error("unreachable");
      expect(vetted.reason).toContain("broadcast");
    }
  });

  it("refuses multicast, which is a broadcast with better manners", () => {
    for (const host of ["224.0.0.1", "239.255.0.1"]) {
      const vetted = vetOscDestination(host, 6454);
      expect(vetted.ok, host).toBe(false);
      if (vetted.ok) throw new Error("unreachable");
      expect(vetted.reason).toContain("multicast");
    }
  });

  it("refuses a name that would need DNS, and says so rather than failing later", () => {
    // A hostname turns "where does this go" into a question answered by a server rather
    // than by the document. Named as a limit; the alternative is a silent resolution.
    const vetted = vetOscDestination("studio-mac.local", 9000);
    expect(vetted.ok).toBe(false);
    if (vetted.ok) throw new Error("unreachable");
    expect(vetted.reason).toContain("DNS");
  });

  it("accepts a literal address and localhost, because those are what a studio types", () => {
    expect(vetOscDestination("192.168.1.50", 9000)).toEqual({
      ok: true,
      value: { host: "192.168.1.50", port: 9000 },
    });
    // `localhost` is normalised to the literal, so the helper never resolves anything.
    expect(vetOscDestination("localhost", 9000)).toEqual({
      ok: true,
      value: { host: "127.0.0.1", port: 9000 },
    });
  });
});

describe("§T458(a) — the listen vet takes no host at all", () => {
  it("accepts an ordinary OSC port", () => {
    expect(vetOscListenPort(9000)).toEqual({ ok: true, value: 9000 });
    expect(vetOscListenPort(8000)).toEqual({ ok: true, value: 8000 });
  });

  it("refuses a privileged port, because a helper should not need root to hear a fader", () => {
    expect(vetOscListenPort(80).ok).toBe(false);
    expect(vetOscListenPort(1023).ok).toBe(false);
    expect(vetOscListenPort(0).ok).toBe(false);
    expect(vetOscListenPort("9000").ok).toBe(false);
  });

  it("has no parameter that could carry a bind address — the finding, in the signature", () => {
    // §T458(a) measured a "local relay" bound to `*:4797`. The structural answer is that
    // there is nowhere to put a host: this function takes one argument, and its callers
    // bind `BRIDGE_HOST` because it is the only address they know.
    expect(vetOscListenPort.length).toBe(1);
  });
});
