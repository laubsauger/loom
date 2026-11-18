# WHIP Out: a live video output over WebRTC (T1809b)

2026-11-17. Design review before the build, per `docs/io-integration-plan.md` §4.5 (stream
out ranks ahead of NDI). Goal: one Loom output published into a WHIP server (MediaMTX) and
shown on a wall, from the page alone: no helper, no desktop app, no new dependency.

## What the others offer

**TouchDesigner, Video Stream Out TOP.** One operator, the input TOP is the picture at the
TOP's own resolution. Parameters: Active, Mode (RTSP server, RTMP sender, SRT, WebRTC),
port / stream name / destination URL, FPS, codec (H.264 / H.265, hardware encoders),
average and peak bitrate, keyframe interval, B-frames, profile, an Audio CHOP for sound.
Its WebRTC mode has no signalling of its own: it is paired with a WebRTC DAT and a
signalling server the user runs (the palette's signalling components). There is no WHIP
client, so publishing into MediaMTX from TD is normally RTSP or RTMP. Status is on the
operator's info (connected clients, dropped frames).

**Notch.** Live output is NDI, Spout and capture-card video out from Builder, or the block
hosted in a media server that owns the output. As far as its documentation shows there is
no RTMP, SRT or WebRTC sender.

**What Loom takes from this.** TD's shape (one sink operator, Active, address, FPS,
bitrate, audio, status on the node) and one thing TD lacks: WHIP, so signalling is one
HTTP POST and needs nothing beside the server. Unlike TD the node has its own Width ×
Height, because the encoded size is a contract with the receiver and must not move when
an upstream resolution does.

## The node

`whipOut`, title **WHIP Out**, category output, kind word `whipout` (as `syphonout`,
`ndiout`). One input, `input` (image). No outputs.

| Parameter | Default | Notes |
| --- | --- | --- |
| `enabled` (Publish) | on | May be driven by an expression; read per frame, acted on per edge. |
| `server` | empty | `http(s)://host[:port][/base]`. Empty sends nothing. |
| `path` (Stream path) | `loom` | The endpoint is `<server>/<path>/whip`. |
| `width` × `height` | 1920 × 1080 | The encoded size, unless the bitrate cannot carry the picture (see below). Must both be even (H.264). |
| `fit` | fit | Fit / Fill / Stretch, as Window Out. |
| `frameRate` | 30 | 1 to 60. The capture rate; the loop may run faster. |
| `bitrate` | 16000 kbit/s | The sender's maximum. |
| `profile` (H.264 profile) | High | The one profile offered: Constrained Baseline, Baseline, Main or High. |
| `keyInterval` (Key frame every) | 0 | 0 leaves key frames to the server; above 0, a full picture at least this often as well. |
| `audio` | off | Opus, Loom's program sound (see Audio). |
| `toneMap` | none | As Window Out: the stream is 8-bit SDR. |

## Where it sits among the sinks

A **display sink** like Window Out (`sink: true`, `sinkRole: "display"`): it owns a
`$target` at Width × Height, drawn by the same fit pass as Window Out, and it is in the
compile's active set only while the app names it, which it does only while the node is
publishing. A node that is off, unconfigured or unwired costs nothing, and a headless
compile, `pnpm render` and the MCP server never render it.

It is also an **emitter** (`sideEffect: "emits"`, like Syphon/NDI/OSC Out): pixels leave
the process. Its pump is `src/app/use-whip-outputs.ts`, registered in `EMISSION_PUMPS`,
and it asks `emissionRefusal` every tick: a take (Render) closes the stream and says why.

The pump presents the `$target` into a canvas of its own (`backend.present(canvas,
{ sizing: "source" })`), never attached to the page: the picture is Width × Height
whatever the viewer, a perform window or the device pixel ratio are. The canvas's capture
track is the video; `RTCPeerConnection` encodes it. Measured before building (headless
Chromium 151, Metal): a detached WebGPU canvas captures and encodes H.264 at the
requested size.

**Capture cadence (found while building).** `canvas.captureStream(30)` is a ceiling the
browser enforces by dropping early frames; on the 120 Hz loop it handed the encoder 28.4
to 29.9 frames a second, unevenly spaced. The pump opens the track at rate 0 and asks for
a frame (`requestFrame()`) from the loop's own frames, one per frame interval with the
remainder carried: 29.96 to 30.2 measured.

The publisher is a port of the studio's dependency-free `WhipPublish`: H.264 only,
packetization mode 1; Opus for audio; `maxBitrate` on the sender;
one non-trickle POST of the offer; `DELETE` of
the session on teardown. Four things differ from the reference, each from a measurement:

- **One profile is offered, not a preference list.** With High first and the others
  behind it, MediaMTX answered Baseline. So the node's H.264 profile is the only one in
  the offer, the node reports the profile actually negotiated, and a browser or server
  without it is a refusal on the node, not a quiet substitute.
- **The frame rate is kept, not the size.** The reference sets `degradationPreference:
  "maintain-resolution"` and `contentHint: "detail"`. Under those the sender paid for every
  key frame (190 to 220 KB against 13 to 20 KB for a P frame at 1080p) by dropping the
  frames after it, a stall of 100 to 700 ms each time. The node sets `"maintain-framerate"`
  and `"motion"`. The cost: Width × Height is the size asked for, no longer a promise. A
  picture the bitrate cannot carry goes out smaller (noise at 6000 kbit/s: 640 × 360 to
  960 × 540 at 31 fps, where it was 1920 × 1080 at 6.4 to 8.8 fps), and the node reports
  the size sent.
- **The default is High, not the reference's Constrained Baseline, which is the slow one
  on this Mac.** Playwright's Chromium 151 encodes Constrained Baseline in software
  (15 to 20 ms a frame at 1080p alone, 70 ms beside a 1080p decoder) and Baseline and High
  in hardware (9 ms). Measured through Loom at 1080p30: Baseline 29.7 to 29.9 fps received
  and 62 to 71 ms from an edit to the changed frame on the subscriber; Constrained
  Baseline 24.5 to 29.7 fps and 171 to 220 ms. No profile sends B-frames (ffprobe over
  RTSP: I and P pictures only, for all of them). In the desktop app beside a heavy render
  Constrained Baseline fell to 8 fps; High held 30.0 through the studio's MediaMTX to its
  projector players (2026-11-17), so High is the default.
- **A key frame on a clock is optional, and off by default.** A WebRTC encoder sends one
  only when asked, and MediaMTX asks about every 2 s. Above 0, `keyInterval` makes the pump
  ask the sender as well (`setParameters` with `encodingOptions: [{ keyFrame: true }]`).
  It shipped at 1 s and that was a mistake at a low bitrate: WebRTC paces a key frame out
  over the bitrate, so at 5 Mbit/s each one arrived 190 to 250 ms late, a stutter once a
  second. At 16 Mbit/s with `keyInterval` 0 the lateness at the publishing Mac was 21 ms at
  the 95th percentile, one late frame in 11 s. Hence the defaults 0 and 16000.

## Credentials

- A login in the Server URL (`user:pass@`) or a query string on it (`?jwt=`, `?token=`) is
  **refused by name** and nothing is sent: the URL is a document parameter and is saved.
- A server on loopback or an open relay needs nothing.
- A bearer token is **session state**: typed into the node's Stream section, held in
  memory by the pump per node, sent only as `Authorization: Bearer …` on the WHIP POST and
  DELETE. It is not a parameter, so it is not in the `.loom.json`, the autosave, undo, the
  audit log or any tool result; the section shows only whether one is set; no status or
  diagnostic carries a header. A reload or a new document forgets it. MediaMTX reads a
  bearer token as its JWT, or as `user:pass` for its internal users.
- A token sent to a plain `http://` host that is not loopback travels in clear on that
  network. The section says so; it is the user's network and their call.

## Hidden tab

The realtime loop runs on `requestAnimationFrame`, and a browser stops calling it for a
hidden tab. So:

- **Editor visible** (its own window on any screen, however small): the stream runs.
- **Editor hidden, a perform window visible**: the perform window's frames drive the loop
  (T303/T1409b), and the stream runs.
- **Editor hidden, nothing else visible**: nothing renders. The connection is kept, the
  canvas stops changing, and a viewer holds the last picture. The node says so: "Frozen:
  this tab is hidden and nothing is rendering". It is not hidden behind "live". Advice in
  the recipe: keep Loom in its own window, not a background tab.

A hidden-tab frame source (a worker timer driving the loop while a stream is live) is the
real fix and is filed as T1810b, not built here: it changes who owns the loop's clock.
Not verified: what a receiver shows during a long freeze (headless Chromium never hides a
page, so the gate cannot reach this state).

`pagehide` (reload, close, navigation) ends every session with a keepalive `DELETE`.

## Audio

Off by default. On, the stream carries **Loom's program sound** as Opus: what Loom itself
sends to the speakers. The app's one `AudioContext` gets a program bus (a unity gain into
`destination`); movie sound and the Audio In / Audio File In monitor connect to the bus,
and a `MediaStreamAudioDestinationNode` taps it. Consequences, stated: a source that is
not monitored is not in the stream; the monitor volume is the stream's level; before the
first click the context is suspended and the track is silence. The Harmony synth connects
to `destination` directly and is **not** in the stream yet (T1811b; its files were out of
bounds for this pass).

## Failure, reconnect, status

States: off, not configured (with the reason), waiting for a frame, connecting, live,
retrying (with the server's answer or the connection state), paused during a render.
A failed POST or a dropped connection retries every 2 s, for ever, until the node is
disabled. Changing the server, path, size, rate, bitrate, audio or token ends the session
and starts a new one. Disable, delete, bypass, a new document, a lost device and
`pagehide` all end it with `DELETE`.

The user sees it in two places: the node's **Stream** section in the inspector (state,
endpoint, and once a second the measured outgoing size, frames per second and kbit/s from
`getStats`), and a warning on the node, in the one diagnostics list, for anything that
is not off or live.

CORS: the page is cross-origin isolated (COEP `require-corp`), which constrains what the
page embeds, not a CORS `fetch`. MediaMTX answers the preflight with
`Access-Control-Allow-Origin` echoing the origin and allows `Authorization` and
`Content-Type` (checked on v1.21), and exposes `Location`. A hosted `https://` Loom cannot
POST to a plain `http://` server unless it is loopback (mixed content); the status reports
the failed request and the recipe says to run Loom locally or put TLS on the server.

Local network access: Chromium asks the user for permission before a page fetches a
loopback or LAN address when it places the page itself in a wider address space (seen in
the gate: a page whose document was not really served from loopback was refused "access
to the loopback address space"). Loom served from `localhost` to a server on `127.0.0.1`
needs no prompt (measured). A hosted Loom publishing to a LAN server will be asked; not
verified here.

## Deferred, each a SPEC row

- T1810b: a frame source for a hidden editor, so a stream does not freeze.
- T1811b: audio: the Harmony synth on the program bus, and choosing a source per node.
- T1812b: the stream's state as published channels (`live`, `fps`, `kbps`).
- T1813b: reach beyond the LAN (ICE servers / TURN), other codecs, trickle ICE.
- T1814b: a shipped example, and a WHEP In to match.
- T1815b: 60 fps arrives as 46 to 59 with the machine's load; the defaults moved to High, 16000 kbit/s and key frames on request after the studio run.

## Measured (2026-11-17, this Mac, Playwright Chromium 151 headless on Metal, MediaMTX 1.21 on loopback, a WHEP subscriber page on the same machine, load average 4 to 10)

| Case | Received by the subscriber |
| --- | --- |
| 1920 × 1080, 30 fps, Baseline, static checker | 1920 × 1080 decoded, 29.7 to 29.9 fps, picture and orientation right |
| the same, an edit in the graph | 62 to 71 ms from the committing key to the first changed frame presented |
| 1920 × 1080, 30 fps, Constrained Baseline (the default then) | 24.5 to 29.7 fps, 171 to 220 ms |
| 1920 × 1080, 60 fps, High, hue turning | 45.6 to 59.3 fps (59.3 at the lowest load), 207 to 239 different colours in 6 s, 9 key frames in 6 s |
| 1920 × 1080, 30 fps, Constrained Baseline, noise, 6000 kbit/s cap, size kept (as first built) | size held, 6.4 to 8.8 fps, 4430 to 6091 kbit/s |
| the same on High with the frame rate kept (2026-11-18) | 640 × 360 to 960 × 540, 31.0 fps, 4348 kbit/s |
| Publish off | the server's path is gone within a second |
| a server that asks for a login | 401 named on the node; with the token, live; the saved file does not contain it |

The gate is `src/tests/e2e/whip-out.spec.ts` (`chromium-gpu`). Not measured: a hidden tab,
the owner's Chrome, the studio's server and receivers, a second machine, the sound's
content (only that an Opus track is published).
