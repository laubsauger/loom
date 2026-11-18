import { describe, expect, it } from "vitest";
import { createWhipPublisher, preferredH264, sendsTokenInClear, whipEndpoint, WHIP_RETRY_MS } from "./whip-publisher.ts";
import type { WhipPublisherDeps } from "./whip-publisher.ts";

/**
 * §T1809b — the WHIP session's rules that do not need a browser: what the server is sent
 * (the address, the login), and what it is sent when things go wrong or stop. A fake
 * server (`fetch`) records every request; assertions are on those requests, which is what
 * a real server reads. That frames arrive and decode is `src/tests/e2e/whip-out.spec.ts`.
 */

describe("the endpoint is Server/Stream path/whip, and a secret in the URL is refused", () => {
  it("joins server and path, with or without slashes and a base path", () => {
    expect(whipEndpoint("http://127.0.0.1:8889", "loom")).toEqual({ url: "http://127.0.0.1:8889/loom/whip" });
    expect(whipEndpoint(" https://relay.example/live/ ", "/wall/left/")).toEqual({ url: "https://relay.example/live/wall/left/whip" });
  });

  it("refuses a login or a query string, because the URL is saved with the project", () => {
    for (const server of ["http://user:pass@host:8889", "http://user@host:8889", "https://host/?jwt=abc", "https://host/#frag"]) {
      const endpoint = whipEndpoint(server, "loom");
      expect("refusal" in endpoint, server).toBe(true);
      // And the refusal does not repeat the secret back into a status line or a log.
      expect(JSON.stringify(endpoint)).not.toMatch(/pass|abc/);
    }
  });

  it("refuses what is not an http(s) server or a usable path, by name", () => {
    expect(whipEndpoint("", "loom")).toEqual({ refusal: expect.stringContaining("Set Server") });
    expect(whipEndpoint("rtsp://host", "loom")).toEqual({ refusal: expect.stringContaining("http://") });
    expect(whipEndpoint("http://host", " ")).toEqual({ refusal: expect.stringContaining("Stream path") });
    expect(whipEndpoint("http://host", "a b?c")).toEqual({ refusal: expect.stringContaining("Stream path") });
  });

  it("knows when a token would cross a network unencrypted", () => {
    expect(sendsTokenInClear("http://192.168.1.20:8889/loom/whip")).toBe(true);
    expect(sendsTokenInClear("http://127.0.0.1:8889/loom/whip")).toBe(false);
    expect(sendsTokenInClear("http://localhost:8889/loom/whip")).toBe(false);
    expect(sendsTokenInClear("https://relay.example/loom/whip")).toBe(false);
  });
});

const codec = (fmtp: string, mimeType = "video/H264"): RTCRtpCodec => ({ mimeType, clockRate: 90000, sdpFmtpLine: fmtp });
const OFFERED = [
  codec("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"),
  codec("level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f"),
  codec("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"),
  codec("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034"),
  codec("", "video/VP8"),
];

describe("the offer names one H.264 profile", () => {
  it("offers the asked profile in packetization mode 1 and nothing else", () => {
    expect(preferredH264(OFFERED, "42e0").map((entry) => entry.sdpFmtpLine)).toEqual([OFFERED[2]!.sdpFmtpLine]);
    expect(preferredH264(OFFERED, "6400").map((entry) => entry.sdpFmtpLine)).toEqual([OFFERED[3]!.sdpFmtpLine]);
    // Main is not in this browser's list: nothing is offered, so nothing else is sent in its place.
    expect(preferredH264(OFFERED, "4d00")).toEqual([]);
  });
});

interface Request { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly keepalive: boolean }

/** A peer that negotiates instantly and a server whose answers the test scripts. */
function world(answers: Array<() => Response | Promise<Response>>) {
  const requests: Request[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const peers: Array<{ closed: boolean; preferences: RTCRtpCodec[]; connect(state: string): void }> = [];
  const deps: WhipPublisherDeps = {
    createPeer: () => {
      const listeners = new Map<string, Array<() => void>>();
      const record = { closed: false, preferences: [] as RTCRtpCodec[], connect: (state: string) => {
        peer.connectionState = state;
        for (const listener of listeners.get("connectionstatechange") ?? []) listener();
      } };
      peers.push(record);
      const peer = {
        connectionState: "new",
        iceGatheringState: "complete",
        localDescription: { sdp: "v=0 offer" },
        addTransceiver: () => ({
          sender: { getParameters: () => ({}), setParameters: () => Promise.resolve() },
          setCodecPreferences: (codecs: RTCRtpCodec[]) => { record.preferences = codecs; },
        }),
        addEventListener: (type: string, listener: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
        createOffer: () => Promise.resolve({ type: "offer", sdp: "v=0 offer" }),
        setLocalDescription: () => Promise.resolve(),
        setRemoteDescription: () => Promise.resolve(),
        close: () => { record.closed = true; },
      };
      return peer as unknown as RTCPeerConnection;
    },
    capabilities: () => OFFERED,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, keepalive: init?.keepalive === true });
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));
      const next = answers.shift();
      if (next === undefined) throw new Error("the fake server has no answer left");
      return Promise.resolve().then(next);
    }) as typeof fetch,
    setTimeout: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
    now: () => 0,
  };
  const stream = { getVideoTracks: () => [{ contentHint: "" }], getAudioTracks: () => [] } as unknown as MediaStream;
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  /** Fires the pending timers of exactly this delay (the retry, not the key frame clock). */
  const elapse = (ms: number): void => { for (const timer of timers.splice(0)) if (!timer.cancelled && timer.ms === ms) timer.run(); else if (!timer.cancelled) timers.push(timer); };
  return { requests, peers, deps, stream, settle, elapse };
}

const created = (): Response => new Response("v=0 answer", { status: 201, headers: { location: "/loom/whip/session-1" } });
const options = (stream: MediaStream, extra: { token?: string } = {}) =>
  ({ url: "http://127.0.0.1:8889/loom/whip", stream, kbps: 6000, profile: "42e0", keyFrameSeconds: 1, onChange: () => {}, ...extra });

describe("a WHIP session, as the server sees it", () => {
  it("posts the offer once, goes live when the peer connects, and deletes ITS session on stop", async () => {
    const { requests, peers, deps, stream, settle } = world([created]);
    const publisher = createWhipPublisher(options(stream), deps);
    await settle();
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST http://127.0.0.1:8889/loom/whip"]);
    expect(requests[0]?.headers["content-type"]).toBe("application/sdp");
    expect(publisher.state).toBe("connecting");
    peers[0]?.connect("connected");
    expect(publisher.state).toBe("live");

    publisher.stop();
    // The session the server named in Location, resolved against the endpoint; keepalive
    // so it is still delivered while the page goes away.
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: "http://127.0.0.1:8889/loom/whip/session-1", keepalive: true });
    expect(peers[0]?.closed).toBe(true);
    expect(publisher.state).toBe("stopped");
  });

  it("sends a token as a bearer header on the POST and the DELETE, and never in a URL or a message", async () => {
    const { requests, deps, stream, settle } = world([() => new Response("", { status: 401, statusText: "Unauthorized" })]);
    const publisher = createWhipPublisher(options(stream, { token: "s3cret-token" }), deps);
    await settle();
    expect(requests[0]?.headers["authorization"]).toBe("Bearer s3cret-token");
    expect(publisher.state).toBe("retrying");
    // What the user is shown names the refusal and not the secret.
    expect(publisher.error).toContain("401");
    expect(publisher.error).not.toContain("s3cret-token");
    expect(requests.every((request) => !request.url.includes("s3cret-token"))).toBe(true);
    publisher.stop();
  });

  it("sends no authorization header at all without a token", async () => {
    const { requests, deps, stream, settle } = world([created]);
    const publisher = createWhipPublisher(options(stream), deps);
    await settle();
    expect("authorization" in (requests[0]?.headers ?? {})).toBe(false);
    publisher.stop();
  });

  it("tries again every 2 s after a server that is down, and after a connection that drops", async () => {
    const { requests, peers, deps, stream, settle, elapse } = world([
      () => { throw new TypeError("Failed to fetch"); },
      created,
      created,
    ]);
    const publisher = createWhipPublisher(options(stream), deps);
    await settle();
    expect(publisher.state).toBe("retrying");
    expect(publisher.error).toContain("Could not reach http://127.0.0.1:8889");
    const posts = (): number => requests.filter((request) => request.method === "POST").length;
    expect(posts()).toBe(1);

    elapse(WHIP_RETRY_MS);
    await settle();
    expect(posts()).toBe(2);
    peers[1]?.connect("connected");
    expect(publisher.state).toBe("live");

    // The connection is lost: the old session is deleted, and a new one is asked for.
    peers[1]?.connect("failed");
    expect(publisher.state).toBe("retrying");
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: "http://127.0.0.1:8889/loom/whip/session-1" });
    elapse(WHIP_RETRY_MS);
    await settle();
    expect(posts()).toBe(3);
    publisher.stop();
  });

  it("stopped while the server is still answering: the session that arrives late is deleted, not left running", async () => {
    let answer: (response: Response) => void = () => {};
    const { requests, deps, stream, settle } = world([() => new Promise<Response>((resolve) => { answer = resolve; })]);
    const publisher = createWhipPublisher(options(stream), deps);
    await settle();
    publisher.stop();
    answer(created());
    await settle();
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: "http://127.0.0.1:8889/loom/whip/session-1" });
  });

  it("stop ends the retries: nothing is posted after it", async () => {
    const { requests, deps, stream, settle, elapse } = world([() => new Response("", { status: 503 })]);
    const publisher = createWhipPublisher(options(stream), deps);
    await settle();
    publisher.stop();
    elapse(WHIP_RETRY_MS);
    await settle();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });
});
