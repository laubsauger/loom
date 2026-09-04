<p align="center">
  <img src="./public/icon.svg" width="180" alt="Loom logo">
</p>

<h1 align="center">Loom</h1>

<p align="center">
  A browser-based WebGPU node compositor.<br>
  <a href="https://laubsauger.github.io/loom/">Open Loom</a>
</p>

<a href="./docs/loom-editor.png">
  <img src="./docs/loom-editor.png" alt="The Loom editor showing a node graph, WGSL shader, inspector, and live output">
</a>

<sub>Click the screenshot for the full-size view.</sub>

## Run

The hosted build has everything that runs in the browser. Anything needing a helper
process on your machine — the stdio MCP bridge today, external devices and services
later — works only from a local clone. Nodes that need one stay visible either way and
say what they are waiting for.

Requires Node.js 22+, pnpm 9.15.4, and a WebGPU browser.

```bash
pnpm install
pnpm dev
```

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## MIDI

A **MIDI In** node reads a controller as channels: learn a control in the inspector's MIDI
section (arm a row, move the knob) and it publishes under the name you give it, so
`midi1:cutoff` drives any parameter — including a shader's own reflected `struct Params`
fields. It reads 7-bit Control Change and 14-bit pitch bend; notes, velocity, MIDI clock,
14-bit CC pairs and SysEx are not read.

Access is asked for on a button press, never on page load. With no Web MIDI (Safari has
none at any version), a refused permission, or nothing plugged in, the node still publishes
every learned channel at its rest value, so the document loads and renders — and the MIDI
section says which of those it is.

### Testing it without a controller

`tools/midi-sender.html` is a dev-only page with knobs, pads and a pitch-bend slider that
sends real MIDI through Web MIDI. It is served by the dev server (`pnpm dev`, then open
`/tools/midi-sender.html`) and is not part of a production build.

It needs a **virtual MIDI port**, because a browser's MIDI output goes to the operating
system rather than back to the same page:

- **macOS** — nothing to install. *Audio MIDI Setup → Window → Show MIDI Studio*,
  double-click **IAC Driver**, tick *Device is online*.
- **Windows** — install **loopMIDI** (free) and add a port.
- **Linux** — `sudo modprobe snd-virmidi` for ALSA virtual ports.

Then send from one tab and learn in the other. The page repeats these instructions itself.

## OSC

An **OSC In** node reads OSC as channels and an **OSC Out** node sends them back out, so a
patch can sit in the middle of a studio chain rather than at the end of one.

Both need a **local helper**, because a browser page cannot receive or send UDP. It is one
process with two doors — the device bridge these nodes use, and the stdio MCP server an
agent uses — so if you are already running it for an agent, it is already running for OSC:

```bash
pnpm helper                  # both doors
pnpm helper --devices-only   # OSC, laser and Person Mask, with no MCP server at all
```

Enter the pairing code it prints in the agent panel's **Connections** section, once. The OSC
nodes use the same attachment — there is no second code and no second panel.

**Everything else is on the node itself.** On *OSC In*, set **Port** and list the channel
names you want in **Controls** (`cutoff pan`); each name grows its own **Address** and
**Rest** parameter. `osc1:cutoff` then drives any parameter, including a shader's own
reflected `struct Params` fields. Values arrive exactly as sent — unlike a 7-bit MIDI CC an
OSC argument has no declared full scale, so nothing is normalised for you. A message with
several arguments addresses by index: `/pad/xy` publishes `/pad/xy/0` and `/pad/xy/1`.

On *OSC Out*, set **Host** and **Port**. **There is no default destination** — an
unconfigured node sends nothing — and broadcast (`x.x.x.255`) and multicast addresses are
refused by name, because a lighting network is a network. One channel called `value` sends
`/address`; several send `/address/name` each.

Two limits, stated rather than discovered:

- **The helper listens on `127.0.0.1` only**, so a sender on another machine (a phone
  running TouchOSC) cannot reach it yet. Widening that is a deliberate decision with its own
  security argument to make.
- **OSC rides UDP, so a send can only ever be reported as *sent*, never as *arrived*.**
  Nothing in the app will tell you a message was delivered, because nothing can know.

With no helper running — which includes the hosted build — every OSC In control still
publishes its Rest value, so the document loads and renders, and the problems pane says
which node needs what.

### Testing it without hardware

```bash
node tools/osc-send.mjs 9000 /synth/cutoff 0.7     # one message
node tools/osc-send.mjs --sweep 9000 /synth/cutoff # 0 → 1 → 0 at 60 Hz
node tools/osc-listen.mjs 9001                     # watch what OSC Out sends
```

Both talk to `127.0.0.1` only, and neither takes a host argument.

## MCP

Loom exposes its tools over stdio for desktop clients and through WebMCP in supported browsers.

### Claude

Use this as `.mcp.json` with Claude Code, or merge the `mcpServers` block into your Claude Desktop config:

```json
{
  "mcpServers": {
    "loom": {
      "type": "stdio",
      "command": "/ABSOLUTE/PATH/TO/pnpm",
      "args": [
        "--dir",
        "/ABSOLUTE/PATH/TO/loom",
        "helper"
      ]
    }
  }
}
```

Replace both paths. `which pnpm` prints the first one. Restart Claude, then ask it to call `bridge_status` and show the current pairing code.

The script was called `mcp:serve` until it was renamed to `helper`; the old name still works
as an alias, so an existing config keeps running. The **agent → Agents** help tab generates a
config that spawns `node` directly, which avoids pnpm's startup banner landing in the
JSON-RPC stream.

To drive the visible editor:

1. Run `pnpm dev` and open the local Loom URL.
2. Open the **agent** pane and find **Connections**.
3. Enter the pairing code from `bridge_status`.

Until the tab is attached, the MCP server works on its own headless document. The bridge accepts local Loom tabs only, not the GitHub Pages site. For headless pixel and readback tools, append `--grant-export` to the config's `args`.

[Claude MCP docs](https://code.claude.com/docs/en/mcp)

### WebMCP

1. Enable `chrome://flags/#enable-webmcp-testing` and relaunch Chrome.
2. Open Loom with a WebMCP-capable browser agent or extension.
3. Check **agent → Connections**. Loom registers its tools automatically; there is no pairing code.

[Chrome WebMCP setup](https://developer.chrome.com/docs/ai/webmcp)

## Deploy

Deployment is manual. Once the changes are on `main`:

```bash
pnpm deploy
```

## What is in it

- Write WGSL in the node editor. Fields in `struct Params` become typed controls automatically, including colour pickers. Those controls can be driven by the graph or published from a component.
- Build feedback loops, frame caches and slit scans. Pause, step or scrub them on the same frame clock used for MP4 rendering.
- Feed microphone or audio files into level, four frequency bands and onset. LFOs, expressions, envelopes and beat patterns plug into the same parameter system.
- Run custom point kernels on the GPU with named attributes, spawn and kill, compaction, fields, rays and indirect drawing. Render the result as points, instances or meshes.
- Build 3D scenes with cameras, lights, projectors, shadows, ambient occlusion, environment maps and unlit, Phong, PBR or glass materials.
- Bring in stills, video and webcams. Run depth and pose inference in the browser, then use the results in texture and point graphs.
- Turn a selection into a versioned component, then publish the controls its instances should expose.
- Preview any branch, pop panes into their own windows, save layouts, export stills or render a frame range to MP4.
- Drive the open document from the UI, MCP or WebMCP through the same command surface. Changes remain visible and undoable.
- Save versioned `.loom.json` projects, with autosave recovery if the tab disappears.

Loom's core GPU runtime is built on [vGPU](https://vgpu.sh/) by Vercel Labs.

[Spec](./SPEC.md) · [Examples](./examples/README.md)
