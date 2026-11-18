# Helper and controllers

The local helper connects Loom to OSC, lasers, native Person Mask, terminal panes
and desktop MCP clients. These need a local Loom clone; hosted tabs cannot pair
with the helper.

```bash
pnpm helper
```

Enter the pairing code under **agent → Connections** in the local tab. The same
connection serves devices and agents. Optional flags enable additional access:

| Flag | Access |
| --- | --- |
| `--terminal` | A local shell in each terminal pane |
| `--grant-export` | Rendered pixels and GPU readbacks for agents |
| `--all` | Devices, terminal panes and pixels |
| `--devices-only` | Devices without the MCP server |
| `--phone` | Arm a phone control panel on your local network |
| `--force` | Stop the Loom helper that holds the bridge, then start |

Terminal and pixel access are enabled only at helper startup. `--all` does not
include phone access and cannot be combined with `--devices-only`.

## When another helper holds the bridge

The bridge uses one fixed loopback port, and the first helper to start holds it. Each
agent session starts its own helper, so one you start in a terminal often finds the
port taken. It then prints the PID and command line of the process that holds it.
Without `--devices-only` it also prints that helper's pairing code and forwards agent
tool calls to it, but the access flags you passed do not apply to that helper.

`--force` combines with every other flag. It sends the holding helper SIGTERM, then
SIGKILL if it is still running after three seconds, prints which process it stopped,
and starts normally with its own pairing code. The session that started the stopped
helper loses its Loom tools until it restarts them. `--force` stops only a Loom helper:
if any other program holds the port, or the holder cannot be identified (no `lsof`, as
on Windows), it names what it found, stops nothing and exits. Use it in a terminal, not
in an MCP client configuration, where two servers started together would stop each other.

## Terminal panes

Start the helper with `--terminal` or `--all`. Each pane runs a shell as your user,
in the directory where you started the helper. Closing the pane stops its shell;
restoring a layout opens a fresh one. All shells stop with the helper.

## Phone controls

Start the helper with `--phone`, then open the phone door from the paired editor.
Scan its QR code to use the published controls. The connection uses HTTPS with a
self-signed certificate. Its token expires when the door closes, including when the
editor disconnects.

## MIDI

A MIDI In node publishes named control channels that can drive parameters,
including shader controls. Arm a row in the inspector's MIDI section and move a
knob, or press a key, to learn it. MIDI In reads 7-bit Control Change, 14-bit pitch
bend and a note as a gate (1 while the key is down, whatever the velocity). It does not
read velocity, 14-bit CC pairs or SysEx. The MIDI Notes node reads a keyboard as
voices, and MIDI clock can drive the project tempo.

To tap the tempo from a key or a pedal, add a Tempo node, learn the key or pedal on a
MIDI In row named `tap`, and set the Tempo node's Tap to the expression
`op('midiin1').chan.tap >= 0.5`.

The browser asks for access when you press the permission button. When MIDI is
unavailable, disconnected or denied, learned channels use their rest values and the
inspector explains the connection state.

To test without hardware, run `pnpm dev` and open `/tools/midi-sender.html`. It
sends real MIDI through a virtual port:

- macOS: open Audio MIDI Setup, choose **Window → Show MIDI Studio**, open
  **IAC Driver** and enable **Device is online**.
- Windows: install loopMIDI and add a port.
- Linux: enable ALSA virtual ports with `sudo modprobe snd-virmidi`.

Send from one tab and learn in the other. The sender page is development tooling
and is not included in production builds.

## OSC

OSC In and OSC Out use the helper with no extra flags. Set an input Port and name
its Controls, then set each channel's Address and Rest value. Channels such as
`osc1:cutoff` can drive any parameter. Values retain their original scale. A message
with several arguments publishes indexed addresses, such as `/pad/xy/0`.

On OSC Out, set Host and Port. An unconfigured output sends nothing; broadcast and
multicast destinations are refused. One channel sends `/address`; several send
`/address/name`. OSC uses UDP, so sending does not confirm delivery.

The helper listens on `127.0.0.1`; senders on other machines cannot reach its OSC
input. Without the helper, OSC In publishes each channel's Rest value and reports
the missing connection.

Test locally with:

```bash
node tools/osc-send.mjs 9000 /synth/cutoff 0.7
node tools/osc-send.mjs --sweep 9000 /synth/cutoff
node tools/osc-listen.mjs 9001
```

The test tools also use `127.0.0.1`.

## Live video out (WHIP)

A WHIP Out node publishes its input as live H.264 video over WebRTC to a WHIP server
such as MediaMTX. It needs no helper and no desktop app. Design and measurements:
`docs/whip-out-design-2026-11-17.md`.

Run a MediaMTX on this machine, bound to loopback (`brew install mediamtx`):

```yaml
# mediamtx.yml
rtmp: no
hls: no
srt: no
moq: no
rtspTransports: [tcp]
rtspAddress: 127.0.0.1:8554
webrtcAddress: 127.0.0.1:8889
webrtcLocalUDPAddress: 127.0.0.1:8189
webrtcLocalTCPAddress: ''
webrtcIPsFromInterfaces: no
webrtcAdditionalHosts: [127.0.0.1]
paths:
  all_others:
```

```bash
mediamtx mediamtx.yml
```

In Loom, add **WHIP Out** (Output), wire the picture into it and set:

| Parameter | Value |
| --- | --- |
| Server | `http://127.0.0.1:8889` |
| Stream path | `loom` |
| Width × Height | `1920` × `1080` (both even) |
| Frame rate | `30` |
| Bitrate (kbit/s) | `16000` |
| H.264 profile | High, or Baseline / Constrained Baseline (see below) |
| Publish | on |

The node's **Stream** section shows the state, and once a second what was actually sent
(size, frames per second, kbit/s, profile). To watch it back, open
`http://127.0.0.1:8889/loom` in a browser (MediaMTX's own WebRTC player), or read it over
RTSP:

```bash
ffplay -rtsp_transport tcp rtsp://127.0.0.1:8554/loom
```

Things to know:

- **Keep Loom visible.** A hidden tab renders nothing, so the stream freezes on its last
  picture and the node says "Frozen". Give Loom a window of its own, or keep a perform
  window showing.
- **Logins.** A login or query string in Server is refused, because the URL is saved with
  the project. For a server that asks for one, type a token into the Stream section's
  Token field: it is held for the session and never saved. MediaMTX reads it as its JWT,
  or as `user:pass` for its internal users.
- **Profile.** The profile you choose is the only one offered. On a Mac, Chromium encodes
  Constrained Baseline in software and Baseline and High in hardware: High is the default.
  Choose Constrained Baseline only for a receiver that decodes nothing else.
- **Bitrate.** The frame rate is held; when the picture needs more than Bitrate, the
  stream is sent at a smaller size (the Stream section shows it; measured: noise at 6000
  went out at 640 × 360 to 960 × 540, 31 fps). On a local network keep it high (16000): a key frame is about ten frames of data,
  and at 5000 each one arrives a quarter of a second late, which shows as a stutter.
- **Key frames.** Leave "Key frame every" at 0: the server asks for them. Raise it only
  when receivers take too long to recover from lost data.
- **Audio** adds what Loom itself plays on the speakers (movie sound, a monitored Audio
  In or Audio File In) as Opus. The Harmony synth is not in it yet.
- **A server on another machine.** A Loom opened from `localhost` can publish to a plain
  `http://` server on the LAN. A hosted `https://` Loom cannot unless the server has TLS,
  and the browser will ask for local network access.
- A take (Render) ends the stream while it runs. Syphon Out and NDI Out do the same.
