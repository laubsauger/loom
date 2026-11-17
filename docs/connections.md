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
