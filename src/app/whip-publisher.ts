/**
 * §T1809b — one WHIP session: a `MediaStream` published to a WHIP endpoint over WebRTC
 * (design `docs/whip-out-design-2026-11-17.md`). No React, no document, no canvas: the
 * pump (`use-whip-outputs.ts`) owns the stream's tracks and hands them here.
 *
 * What a receiver is promised (the studio's MediaMTX, and MediaMTX in general): H.264
 * only, in the one profile asked for, packetization mode 1, no B-frames (measured for all
 * four profiles: I and P pictures only); a key frame on a clock; Opus only for sound; the
 * size held and the frame rate given way under load. The offer goes in ONE
 * non-trickle POST; the session the server names in `Location` is DELETEd on teardown.
 * A failed POST or a dropped connection is retried every `WHIP_RETRY_MS` until `stop()`.
 *
 * A bearer token is session state: it is sent as a header and appears in no URL, status
 * or error text here.
 */

export const WHIP_RETRY_MS = 2000;
/** How long ICE gathering may take before the offer is posted with what it has. */
const ICE_GATHER_MS = 1500;

export type WhipEndpoint = { readonly url: string } | { readonly refusal: string };

/**
 * `<server>/<path>/whip`, or why not. The Server URL is a saved parameter, so a login or
 * a query string in it (a password, `?jwt=`, `?token=`) is refused by name.
 */
export function whipEndpoint(server: string, path: string): WhipEndpoint {
  const trimmed = server.trim();
  if (trimmed === "") return { refusal: "Set Server to a WHIP server, for example http://127.0.0.1:8889." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { refusal: `Server is not a URL: write it as http://host:port.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refusal: "Server must start with http:// or https://." };
  if (url.username !== "" || url.password !== "") {
    return { refusal: "Remove the login from Server: the URL is saved with the project. Enter a token in the Stream section instead." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { refusal: "Remove the query string from Server: the URL is saved with the project. Enter a token in the Stream section instead." };
  }
  const name = path.trim().replace(/^\/+|\/+$/g, "");
  if (name === "") return { refusal: "Set Stream path to the stream's name on the server." };
  if (!/^[A-Za-z0-9._~/-]+$/.test(name)) return { refusal: "Stream path may hold letters, digits, and . _ ~ - / only." };
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, "")}/${name}/whip` };
}

/** True when a token sent to this endpoint travels unencrypted beyond this machine. */
export function sendsTokenInClear(endpoint: string): boolean {
  const url = new URL(endpoint);
  return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export type WhipState = "connecting" | "live" | "retrying" | "stopped";

export interface WhipMeasured {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly kbps: number;
  /** The `profile-level-id` actually negotiated, or "" when the report names none. */
  readonly profile: string;
}

export interface WhipPublisherOptions {
  readonly url: string;
  /** The caller owns the tracks. */
  readonly stream: MediaStream;
  /** The video sender's maximum, kbit/s. */
  readonly kbps: number;
  /** The H.264 profile to send: the first four hex digits of its `profile-level-id`. */
  readonly profile: string;
  /** Ask the encoder for a key frame this often while live; 0 leaves it to the server. */
  readonly keyFrameSeconds: number;
  /** Sent as `Authorization: Bearer`; never stored or echoed. */
  readonly token?: string | undefined;
  readonly onChange: () => void;
}

/** The browser pieces, injectable so a test can stand a fake peer and server in. */
export interface WhipPublisherDeps {
  readonly createPeer: () => RTCPeerConnection;
  readonly capabilities: (kind: "video" | "audio") => readonly RTCRtpCodec[];
  readonly fetch: typeof fetch;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

export interface WhipPublisher {
  readonly state: WhipState;
  /** Why it is retrying; empty while connecting or live. */
  readonly error: string;
  /** What the encoder sent over the last sampling interval, or null before two samples. */
  readonly measured: WhipMeasured | null;
  /** Reads the sender's statistics; call about once a second. */
  sample(): Promise<void>;
  /** Ends the session for good (DELETE, keepalive so it survives a page going away). */
  stop(): void;
}

export function browserWhipDeps(): WhipPublisherDeps {
  return {
    createPeer: () => new RTCPeerConnection(),
    capabilities: (kind) => RTCRtpSender.getCapabilities(kind)?.codecs ?? [],
    fetch: (input, init) => fetch(input, init),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => performance.now(),
  };
}

/** The `profile-level-id` of a codec line, lower case, or "" when it names none. */
const profileLevelId = (fmtp: string | undefined): string => /profile-level-id=([0-9a-f]{6})/i.exec(fmtp ?? "")?.[1]?.toLowerCase() ?? "";

/**
 * H.264 with packetization mode 1 in the asked profile ONLY (`profile` is the first four
 * hex digits of its `profile-level-id`, e.g. "42e0" for constrained baseline). No other
 * profile is offered as a fallback: with High first and the rest behind it, MediaMTX
 * answered Baseline (measured, v1.21), so an offer of several is not a choice.
 */
export function preferredH264(codecs: readonly RTCRtpCodec[], profile: string): RTCRtpCodec[] {
  return codecs.filter(
    (codec) =>
      codec.mimeType.toLowerCase() === "video/h264" &&
      /packetization-mode=1/.test(codec.sdpFmtpLine ?? "") &&
      profileLevelId(codec.sdpFmtpLine).startsWith(profile.toLowerCase()),
  );
}

const failureText = (status: number, statusText: string): string => {
  if (status === 401 || status === 403) return `The server refused the login (${String(status)}). Check the token in the Stream section.`;
  if (status === 404) return "The server has no WHIP endpoint at this address (404). Check Server and Stream path.";
  return `The server answered ${String(status)}${statusText === "" ? "" : ` ${statusText}`}.`;
};

export function createWhipPublisher(options: WhipPublisherOptions, deps: WhipPublisherDeps = browserWhipDeps()): WhipPublisher {
  let state: WhipState = "connecting";
  let error = "";
  let peer: RTCPeerConnection | null = null;
  let session: string | null = null;
  let timer: unknown = null;
  let keyTimer: unknown = null;
  let sender: RTCRtpSender | null = null;
  let stopped = false;
  let measured: WhipMeasured | null = null;
  let last: { bytes: number; at: number } | null = null;
  const headers = (extra: Record<string, string> = {}): Record<string, string> =>
    options.token === undefined || options.token === "" ? extra : { ...extra, authorization: `Bearer ${options.token}` };

  const set = (next: WhipState, why: string): void => {
    if (state === next && error === why) return;
    state = next;
    error = why;
    options.onChange();
  };

  const endSession = (url: string): void => {
    // keepalive: also delivered when the page is going away (stop() on pagehide).
    void deps.fetch(url, { method: "DELETE", headers: headers(), keepalive: true }).catch(() => undefined);
  };

  /*
   * A key frame on a clock. A WebRTC encoder sends one only when asked, and MediaMTX asks
   * about every 2 s (measured, v1.21); a receiver that wants a full picture more often
   * than that gets it from here.
   */
  const keyFrames = (pc: RTCPeerConnection): void => {
    if (options.keyFrameSeconds <= 0) return;
    keyTimer = deps.setTimeout(() => {
      keyTimer = null;
      if (pc !== peer || sender === null) return;
      if (state === "live") {
        void sender
          .setParameters(sender.getParameters(), { encodingOptions: [{ keyFrame: true }] } as RTCSetParameterOptions)
          .catch(() => undefined);
      }
      keyFrames(pc);
    }, options.keyFrameSeconds * 1000);
  };

  const close = (): void => {
    const current = peer;
    peer = null;
    sender = null;
    if (keyTimer !== null) deps.clearTimeout(keyTimer);
    keyTimer = null;
    current?.close();
    if (session !== null) endSession(session);
    session = null;
    measured = null;
    last = null;
  };

  const retry = (why: string): void => {
    if (stopped) return;
    close();
    set("retrying", why);
    if (timer !== null) return;
    timer = deps.setTimeout(() => {
      timer = null;
      void connect();
    }, WHIP_RETRY_MS);
  };

  const gathered = (pc: RTCPeerConnection): Promise<void> =>
    new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const wait = deps.setTimeout(resolve, ICE_GATHER_MS);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState !== "complete") return;
        deps.clearTimeout(wait);
        resolve();
      });
    });

  async function connect(): Promise<void> {
    if (stopped) return;
    set("connecting", "");
    const video = options.stream.getVideoTracks()[0];
    if (video === undefined) {
      retry("The stream has no video track.");
      return;
    }
    const h264 = preferredH264(deps.capabilities("video"), options.profile);
    if (h264.length === 0) {
      retry("This browser has no WebRTC encoder for this H.264 profile. Choose another H.264 profile.");
      return;
    }
    const pc = deps.createPeer();
    peer = pc;
    try {
      // "motion", and the frame rate kept: under "detail" with the size kept, the sender paid for every key frame
      // (ten times a frame's budget at 1080p) by dropping the frames after it, a stall of 100 to 700 ms each time
      // (measured 2026-11-17, T1815b).
      video.contentHint = "motion";
      const transceiver = pc.addTransceiver(video, {
        direction: "sendonly",
        streams: [options.stream],
        sendEncodings: [{ maxBitrate: options.kbps * 1000 }],
      });
      const parameters = transceiver.sender.getParameters();
      parameters.degradationPreference = "maintain-framerate";
      await transceiver.sender.setParameters(parameters);
      transceiver.setCodecPreferences(h264);
      sender = transceiver.sender;
      keyFrames(pc);
      for (const audio of options.stream.getAudioTracks()) {
        const sound = pc.addTransceiver(audio, { direction: "sendonly", streams: [options.stream] });
        sound.setCodecPreferences(deps.capabilities("audio").filter((codec) => codec.mimeType.toLowerCase() === "audio/opus"));
      }
      pc.addEventListener("connectionstatechange", () => {
        if (pc !== peer) return;
        if (pc.connectionState === "connected") set("live", "");
        else if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
          retry(`The connection to the server ${pc.connectionState === "failed" ? "failed" : "was lost"}.`);
        }
      });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      let response: Response;
      try {
        response = await deps.fetch(options.url, {
          method: "POST",
          headers: headers({ "content-type": "application/sdp" }),
          body: pc.localDescription?.sdp ?? "",
        });
      } catch {
        // A TypeError with no detail: unreachable, refused by CORS, or mixed content.
        throw new Error(`Could not reach ${new URL(options.url).origin}. Is the server running, and does it allow this page (CORS, https)?`);
      }
      const location = response.headers.get("location");
      const made = location === null ? null : new URL(location, options.url).href;
      if (!response.ok) throw new Error(failureText(response.status, response.statusText));
      const answer = await response.text();
      // Stopped or replaced during the exchange: do not leave the session behind.
      if (pc !== peer) {
        if (made !== null) endSession(made);
        return;
      }
      session = made;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (failure) {
      if (pc === peer) retry(failure instanceof Error ? failure.message : String(failure));
    }
  }

  void connect();

  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    get measured() {
      return measured;
    },
    async sample() {
      const pc = peer;
      if (pc === null || state !== "live") return;
      const report = await pc.getStats();
      if (pc !== peer) return;
      type Sent = { type?: string; kind?: string; codecId?: string; bytesSent?: number; framesPerSecond?: number; frameWidth?: number; frameHeight?: number };
      report.forEach((entry: Sent) => {
        if (entry.type !== "outbound-rtp" || entry.kind !== "video") return;
        const codec = entry.codecId === undefined ? undefined : (report.get(entry.codecId) as { sdpFmtpLine?: string } | undefined);
        const at = deps.now();
        const bytes = entry.bytesSent ?? 0;
        if (last !== null && at > last.at) {
          measured = {
            width: entry.frameWidth ?? 0,
            height: entry.frameHeight ?? 0,
            fps: entry.framesPerSecond ?? 0,
            kbps: Math.round(((bytes - last.bytes) * 8) / (at - last.at)),
            profile: profileLevelId(codec?.sdpFmtpLine),
          };
          options.onChange();
        }
        last = { bytes, at };
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
      close();
      set("stopped", "");
    },
  };
}
