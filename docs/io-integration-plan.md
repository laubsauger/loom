# I/O Integration Plan — MIDI, OSC, a Device Bridge, External Processes, and the Shell Question

**Date:** 2026-09-02 · **Rows:** §T942 (I/O integration), §T943 (native shell)
**Audience:** orchestrator, then the owner. **Purpose:** decide what to build, in what order, and what to refuse.
**Deliverable status:** research + plan. No code was written. SPEC.md was not edited; §11 carries proposed rows for the orchestrator to adopt or reject.

**Owner's framing:** *"right now in and output is very limited in terms of integrating into systems for vjs or studio or whatever where these kind of apps are only part of the equation and feed into others or pull from others or both."*

**Evidence discipline.** Every claim below is labelled. **[measured]** = I ran it on this machine today. **[code]** = read in this repo at the cited path. **[doc]** = read on a vendor/standards page, cited, and believed but not executed. **[unverified]** = background knowledge I could not confirm from a source; treat as a lead, not a fact.

---

## 0. Verdict, up front

**Build one thing, and it is not a protocol — it is a seam.** Everything ranked below is cheap *if* external values enter the graph the way `analyze` already does, and expensive if each protocol invents its own path. The seam exists and is unused by anything external: `ValueEvaluateContext.channels?: (name) => number | undefined` (`src/domain/types/node-definition.ts:238`) **[code]**.

**The ranked recommendation** (full reasoning in §4, skip list in §4.6):

| # | Capability | Direction | Where it runs | Why it is this high |
|---|---|---|---|---|
| 1 | **Web MIDI in + MIDI learn** | in | page, no helper | Table stakes for VJ use, zero new infrastructure, native to the browser. |
| 2 | **Device channel seam + `channelIn` addressing** | in | page | The prerequisite for 1, 3 and 5. One mechanism, every protocol after it is a driver. |
| 3 | **Device bridge = generalised `bridge-host`, OSC in/out first** | both | helper | OSC is the studio lingua franca and a page cannot speak UDP. Generalising the existing host is a fraction of a new one. |
| 4 | **MIDI out** | out | page | Same API, same session, closes the loop to lighting desks and DAWs. |
| 5 | **Recorded device tracks (record/replay)** | — | page | Not a feature, a gate. Without it every MIDI/OSC example is ungateable and §V329 is violated on purpose. |
| 6 | **WebSocket out (JSON channel push)** | out | page | One `WebSocket` and a serialiser; makes Loom a *source* for anything scriptable. |
| 7 | **Art-Net / sACN out** | out | helper | Falls out of 3 nearly free once the bridge exists; opens the lighting market. |
| 8 | **Gamepad in** | in | page | Two dozen lines against a shipped API; real VJ ergonomics. |

**Deferred with reasons, not forgotten:** NDI, Syphon/Spout, Ableton Link, WebSerial/WebHID/WebUSB, MQTT, timecode, Touch In/Out equivalents, shared memory. §4.6 gives each a reason.

**Five findings that changed the plan while I was writing it:**

1. **Chrome has gated loopback WebSockets behind a permission prompt since version 147 (7 April 2026)** — but I read the spec rule directly and **loopback→loopback is exempt**, so a page served from `localhost` is unaffected and a page served from a public HTTPS origin is not (§3.2 Finding A). That is a deployment decision we should make on purpose.
2. **TouchDesigner has no MIDI-learn** — *"there is no auto-learn currently"*, in its own docs (§3.1(i)). MIDI-learn is table stakes because everything that is not TD has it, and shipping it makes us better than the reference product at the ergonomic VJs touch most.
3. **TouchDesigner has no uniform missing-device contract, and several of its I/O operators fail open with plausible zeros** (§3.1(iv)). That is the §V147 failure this repo already has rules against, and it makes §5.4 an area where we can be straightforwardly better rather than merely equal.
4. **Safari has no Web MIDI at any version, and blocks HTTPS→loopback as mixed content** (§3.2 Finding B). Safari runs Loom (WebGPU 26+) but can reach neither MIDI nor a helper, so honest-absence UI ships *with* the feature, not after it.
5. **The loopback transport's ceiling is its text codec, not loopback** — 77 ms vs 4.9 ms for the same 8.3 MB (§10). That reframes every "can a browser app move pixels to a local process" argument in this document.

**Four framings I was asked to verify: three hold, one holds in substance with the wrong citation, and two details are wrong in ways that matter.** §1 has the corrections; §11.3 lists them as SPEC amendments.

**The SAB verdict (§8):** the owner is right about their own case and wrong about the general rule, and the distinction decides the shell question. SharedArrayBuffer is *not* gated on Electron — it works in a browser today under COOP/COEP **[doc]**. But SAB is shared within one **agent cluster**: a page and its workers. **There is no SAB path from a page to a separate OS process, headers or not** — so for a `uv` venv Python, no amount of header configuration helps. **[doc]** For control-rate data a loopback WebSocket is not merely sufficient, it is over-provisioned by four orders of magnitude: **0.061 ms mean round trip, ~16,500 round trips/s** through this repo's own bridge server **[measured, §10]**. For per-frame framebuffers the current transport is not viable (**118 ms per 1080p RGBA round trip**) — but the cause is the *text codec*, not loopback (**raw loopback TCP does the same bytes in 4.9 ms, 3.4 GB/s**) **[measured, §10]**.

**The shell question (§9):** presented as options, not a recommendation, per §T943. The decisive axis is WebGPU, not binary size — **and it decides more sharply than expected. WebKitGTK does not compile WebGPU in at all** (read from `Source/WebGPU/CMakeLists.txt`: the backend is inside `if (APPLE)`), so **Tauri, Wails and Neutralino do not run a degraded Loom on Linux — they do not run Loom on Linux.** Embedded WKWebView does get WebGPU, but only on **macOS 26+**, with no flag or entitlement below that. Tauri's own maintainers closed both WebGPU requests as *not planned* and recommend Electron for cross-platform WebGPU. **So the real question is not "Electron or lightweight" but "is Linux in scope, and is macOS 26 an acceptable floor".** Two facts remain untested on hardware and are named in §9.6.

---

## 1. The four framings, verified

The brief asked me to verify four things rather than rediscover them. Three hold. One holds in substance with its citation wrong, and two details in the others are off in ways that matter to the design.

### 1.1 Pure browser app — **CONFIRMED**

No Electron, no Tauri, no native shell anywhere in the tree **[code]**: `package.json` dependencies are React, vgpu, onnxruntime-web, CodeMirror, Radix, zustand, zod. The only Node-side surface in the repo is `src/mcp/**`, which is an MCP server the user's agent client spawns — not an app shell. §T715 states the same for the ML program and its constraint ("an unavailable accelerator degrades the RATE, never the CONTRACT") is the one I carry into §5.4.

The partition the brief draws is correct, with one refinement in §2.

### 1.2 The bridge already exists — **CONFIRMED, and it is better than the brief implies**

`src/mcp/bridge-host.ts` (836 lines), `bridge-protocol.ts` (309), `bridge-proxy.ts` (334), `bridge-handoff.ts` (157), `loopback-ws.ts` (270), and a 943-line test **[code]**. It carries, verbatim:

- `BRIDGE_HOST = "127.0.0.1"`, and the docblock says why it is not configurable: *"an option here is an option somebody sets to `0.0.0.0` to 'make it work from my phone'"* (`bridge-protocol.ts:63`) **[code]**.
- `isPermittedOrigin` — a loopback-origin allowlist, with the reasoning that a page cannot forge `Origin` and an absent `Origin` means the peer is not a page (`bridge-protocol.ts:101`) **[code]**.
- A CSPRNG pairing code minted per process, never in a URL, typed by a human (`mintPairingCode`, `bridge-protocol.ts:123`) **[code]**.
- Roles (`page` / `proxy`), one page at a time, a separate 192-bit proxy token that exists only in a `0600` file, EADDRINUSE→proxy, and retry-on-free (§T921) **[code]**.
- §T458's finding is cited *in the code*, at `bridge-protocol.ts:27`: *"T458 MEASURED the third-party relay binding `*:4797` and called it a local relay; we do not repeat it."* **[code]**

**The one thing the brief does not know, and it is the single most consequential fact in this document for the output half:** the loopback server **refuses binary frames by design** and speaks JSON text only, with a 64 MB message cap (`loopback-ws.ts:22`, `MAX_MESSAGE_BYTES`) **[code]**. Every pixel that crosses it today is base64 inside JSON. §7.3 says what that costs and what to do about it.

### 1.3 The feed seam exists — **CONFIRMED, with two corrections**

Confirmed and stronger than described:

- `FrameDriverOptions.audio?: () => AudioFeatures | null` (`src/runtime/execution/frame-driver.ts:29`) **[code]**.
- `HeadlessRenderOptions` carries frame-indexed twins **and their recorders**: `audio?: (frameIndex) => AudioFeatures | null` with `recordAudio: FeatureTrackRecorder`, and `pointer?: (frameIndex) => Partial<PointerState> | null` with `recordPointer` (`src/tests/headless/render-harness.ts:83,106,132`) **[code]**.
- `ValueEvaluateContext` (`src/domain/types/node-definition.ts:210`) is where a value node reads the world: `inputs`, `values`, `frame`, `pointer?`, `audio?`, `state`, and **`channels?: (name: string) => number | undefined`** **[code]**.

**Correction 1 — `pointer` is not optional on the driver.** `FrameDriverOptions.pointer: PointerSource` is **required** (`frame-driver.ts:24`); only `useFrameLoop`'s option is optional (`use-frame-loop.ts:139`), and when omitted the loop constructs its own. This matters: it means the driver's contract is "there is always a pointer, possibly a zeroed one", which is exactly the always-publishes-something shape §5.4 wants for devices, and is a better precedent than "optional closure".

**Correction 2 — there is no `inference?` on the frame driver.** `inference` exists only on the headless harness and its test (`render-harness.ts:132`, `inference-feed.gpu.test.ts:85`) **[code]**. Live inference runs through a different structure entirely — `useModelInference` with a worker, an inference-source id per node, and staleness published as a channel (`src/app/use-model-inference.ts`) **[code]**. So the pattern is not "three optional closures on the driver"; it is **two per-frame closures (audio, pointer) plus one async-cached publisher (inference/analyze) that reaches the graph through `channels`**. Devices split across *both* patterns and §5 uses each where it fits.

**The best-fitting precedent for MIDI/OSC is not `audio` — it is `analyze` → `channels` → `channelIn`.** `channelIn` (`src/nodes/definitions/value-graph-nodes.ts:578`) already reads an arbitrary **string name** out of an external publisher with a **Fallback** when the name is absent **[code]**. An OSC address is a string name. A MIDI CC is a string name. The node that maps them into the graph already exists and shipped for `analyze`.

### 1.4 Reproducibility shapes the design — **CONFIRMED in substance, WRONG in citation**

The brief cites §V346/§V421 as the `audioIn`/`mouse` precedent. **Both are about something else.** §V346 is about regression signatures being separable. §V421 is *"a SPEC ROW's STATUS is a CLAIM and it ROTS — verify a status before building on it"* **[code: SPEC.md:1270,1328]**, which is itself an instruction not to do what the citation did.

The real machinery is better than the brief hoped, and it is **executable, not prose**:

- **`src/domain/render/reproducibility.ts`** defines `Reproducibility = "pure" | "external-live" | "async-cached"` and an exhaustive `NODE_REPRODUCIBILITY` record **derived against the registry**, with `reproducibility.test.ts` failing when a newly registered node is missing from it **[code]**.
- `webcam`, `audioIn` and `mouse` are already `external-live`; `analyze` and `channelIn` are `async-cached`; `audioFileIn` and `movieFileIn` are `pure` (a bound file under the timeline lock is `f(frame)`) **[code: reproducibility.test.ts:77-94]**.
- `nonReproducibleRenderWarning(graph, registry)` is called from the export path (`src/app/use-render-range.ts:183`) and its exact text is pinned by test **[code]**.

**Consequence for this plan, and it is not optional: a `midiIn` or `oscIn` node cannot land without an entry in `NODE_REPRODUCIBILITY` — the gate fails the build until its author decides.** They are `external-live`. Every example using one warns on export, and every gate that renders one needs a recorded track (§6).

The correct citations for the exemption precedent are **§V476** (do not ship an example whose first frame asks for a permission), **§V411** (the understudy pattern: a `switch` whose default branch is synthetic and whose second branch is the real device), **§V353** (deterministic silence is all-zeros, never an absent bag), **§V363** (a demo must demonstrate itself), and **§V329** (an async result must expose its staleness) **[code: SPEC.md]**. §5.4 and §6 are built on those four.

### 1.5 A fifth thing the brief did not claim, which I should state

**§T504/§T508 are not the audio record/replay rows.** They are E24's swappable audio source and `valueSwitch` **[code: SPEC-ARCHIVE.md:281,283]**. The record/replay row is **§T431** (feature-track recorder + offline replay, landed `92c77e8`/`aa3b65c`) and its pointer sibling **§T661** **[code: SPEC-ARCHIVE.md:254,401]**. The artefact is `src/domain/audio/feature-track.ts` — versioned, flat-array encoded, with the version defined as *the semantics of the fields, not the file layout* **[code]**. That file is the template §6 copies.

---

## 2. The partition: page-native vs helper-required

The brief's partition is right. Two refinements, both from the browser-status survey (§3.2), both load-bearing.

**Native to a page** — WebMIDI, WebSocket *client*, WebRTC, `getUserMedia`, Gamepad, WebHID, WebSerial, WebUSB, `getDisplayMedia`, Web Audio, WebCodecs.

**Requires a helper process** — OSC (UDP), Art-Net/sACN (UDP), NDI (its own discovery + transport), Syphon/Spout (native GPU texture sharing), raw TCP, Ableton Link (UDP multicast), MIDI *network* sessions, anything that must **listen** on a port.

**Refinement A — "WebSocket client" is doing a lot of work in that list, and it is what makes the bridge possible at all.** A page can *dial out* to a socket; it can never *accept* one. Everything the helper does for us reduces to: be the thing that can listen, and be the thing that can speak datagrams.

**Refinement B — a page cannot speak UDP, but it *can* speak WebRTC data channels, which are SCTP over DTLS over UDP.** That is not a route to OSC (the peer must speak WebRTC too), but it is a second, *unmediated* route to a local process that already speaks WebRTC — and it matters for §8 only if the Python side is willing to run `aiortc`. **For a local process a loopback WebSocket is strictly simpler, for a structural reason rather than a performance one: WebRTC still needs a signalling channel to exchange SDP, and if you already have a way to reach the local process to signal, that channel *is* the transport** (§3.2).

---

## 3. Surveys

### 3.1 TouchDesigner's actual I/O surface, crawled

~85 pages fetched from docs.derivative.ca today. Everything in this section is **[doc]** — read on the wiki, not run in TouchDesigner. Five findings changed my plan and four commonly-repeated claims turned out to be wrong.

#### The families

**MIDI.** `MIDI In CHOP` (notes, controllers, program change, SysEx, timing; channels created per event, Automatic or Manual mode) · `MIDI In Map CHOP` (reads `s1..sN` sliders / `b1..bN` buttons declared in the **MIDI Device Mapper dialog**, selected with range syntax `s[1-16] s20`) · `MIDI Out CHOP` (sends when input channels change) · `MIDI In DAT` (log table: `message, type, channel, index, value` + 5 timestamp columns) · `MIDI Event DAT` (logs messages **in and out**, filterable by direction). **There is no MIDI Out DAT — the URL 404s and it is in no category listing.** MIDI transmission is CHOP-only.

**OSC.** `OSC In/Out CHOP`, `OSC In/Out DAT`. Transports: UDP, Multicast UDP, and "Reliable Messaging (UDT Library)".

**DMX / lighting.** `DMX In CHOP` and `DMX Out CHOP` — interfaces `Enttec Generic Serial`, `Enttec USB Pro`, `Enttec USB Pro Mk2`, **`Art-Net`, `sACN`, `KiNET`** · `Art-Net DAT` (network device discovery) · `DMX Out POP` + `DMX Fixture POP`. Net 0–127, subnet 0–15, universe 0–15 (sACN starts at 1). *"The first channel you send into the DMX Out will correspond to the first DMX address."* Max 44 Hz, stated on both operators.

**Network transports (all DAT-side).** `TCP/IP DAT` (client **or server**) · `UDP In/Out DAT` · `WebSocket DAT` (client, TLS supported) · `Web Client DAT` (HTTP verbs, OAuth1/2) · **`Web Server DAT` (HTTP + HTTPS + WebSocket server, binary supported)** · `MQTT Client DAT` (tcp/ssl/ws/wss) · `SocketIO DAT` · `WebRTC DAT` (signalling only) · `TUIO In DAT` · `Multi Touch In DAT` (**not supported on macOS**) · `Serial DAT` (RS-232) · `Serial CHOP` · `Pipe In/Out CHOP` (**TCP/IP despite the name**). Deprecated: `UDT In/Out DAT` (removed from 2021+ builds), `Web DAT`.

**Video / texture I/O.** `NDI In/Out TOP` + `NDI DAT` (source discovery) + `Audio NDI CHOP` · `Syphon Spout In/Out TOP` · `Video Device In/Out TOP` · `Screen Grab TOP` · `Video Stream In TOP` (RTSP/HLS/SRT/WebRTC) · **`Video Stream Out TOP` (RTSP server, RTMP to Twitch/YouTube, SRT, WebRTC; H.264/H.265/AV1)** · `Touch In/Out TOP` (TD↔TD over TCP, Hap Q) · `Shared Mem In/Out TOP` · `DirectX In/Out TOP` · `Photoshop In TOP` · `Direct Display Out TOP` · `ST2110 In/Out TOP` · `RenderStream In/Out TOP`.

**Audio.** `Audio Device In/Out CHOP` (DirectSound / CoreAudio / **ASIO** / Blackmagic / AJA; In *"can capture control voltages if the ADC passes DC"*) · `Audio Stream In/Out CHOP` (**RTSP and WebRTC**) · `Audio Devices DAT`.

**Sync / timing.** `Sync In/Out CHOP` (multicast `224.0.0.1`) · `Ableton Link CHOP` · `Timecode CHOP` · `LTC In/Out CHOP`.

**Input devices.** `Joystick CHOP` (6 axes, 32 buttons, 2 sliders, 4 POV hats, all 0–1) · `Keyboard In CHOP` / `Keyboard In DAT` · `Mouse In CHOP` / `Mouse Out CHOP` · `Tablet CHOP` · Kinect / Kinect Azure / RealSense / ZED / Orbbec / OAK / Leap Motion / OpenVR / Oculus Rift · camera trackers (BlackTrax, MoSys, Ncam, Stype, RenderStream, FreeD, OptiTrack, PosiStageNet) · LIDAR (Hokuyo, Ouster, SICK, Leuze) · lasers (`Laser Device CHOP` for EtherDream/Helios/ShowNET, `Pangolin CHOP`).

**Device enumeration is its own family** and worth noticing as a pattern: `Audio Devices DAT`, `Video Devices DAT`, `Serial Devices DAT`, `Monitors DAT`, `NDI DAT`, `Art-Net DAT`, `EtherDream DAT` — each a table with a **change callback**. TD treats "what is plugged in" as data in the graph, not as a dialog.

#### Five findings that changed this plan

**(i) TouchDesigner has no MIDI-learn.** The MIDI Device Mapper page says it outright: ***"There is no auto-learn currently."*** Custom maps are built by editing component tables for sliders and buttons. **So MIDI-learn is not table stakes *because TD has it* — it is table stakes because every VJ tool that is not TD has it, and shipping it would make us better than the reference product at the single most-used piece of controller ergonomics.** That raises its value and it stays at #1.

**(ii) TD's own network video-out is Windows + Nvidia only.** `Video Stream Out TOP` — the RTSP/RTMP/SRT/WebRTC path — ***"requires an Nvidia GPU and Windows to operate"***, and GeForce cards are capped at 8 encoder sessions. **A browser app with WebCodecs and WebRTC is cross-platform where TouchDesigner is not.** That is a genuine competitive position and it reorders our output thinking: streaming out (WebRTC/RTMP-ish) may be a *better* first video-out than NDI, not a worse one.

**(iii) The CHOP/DAT split is exactly our value-graph/no-DAT split, and TD pays the same price we would.** An OSC **CHOP** produces floats only; the **DAT** is what carries strings, blobs, MIDI type tags, whole bundles, and bundle time-tags, with a callback per packet. Our value graph is `Record<string, number>` and has no DAT analogue — **so the deferral in §4.6 is the same line TD draws, and the thing we give up is precisely what TD gives up on the CHOP side.** Worth knowing exactly what it is rather than discovering it.

**(iv) TouchDesigner does not have a uniform missing-device contract, and its failures are the ones §V-io-2 is designed to prevent.** There is no wiki policy page (`/Errors` 404s). Four inconsistent mechanisms coexist: `Audio Device In/Out CHOP` has an opt-in **`Error if Missing`** parameter (implying the default elsewhere is *not* to error); `Video Devices DAT` fuzzy-matches by unique ID, then label, then index, so **a renamed capture card can silently bind to a different card**; `Oculus Rift CHOP` runs with no hardware attached, *"outputting default values"*; `Joystick CHOP` gives *"a value of 0 … if the axis doesn't exist"*, **indistinguishable from a centred stick**. **This is the strongest argument in the document for §V-io-2/§V-io-3: the reference product's absent-device behaviour is a known-bad we can simply not copy, and our existing rules (§V353, §V359, §V469) already say how.**

**(v) LTC timecode arrives as *audio*, which we can already receive.** `Timecode CHOP` is a **generator**, not a device input. Wire timecode comes in through `LTC In CHOP`, which *decodes SMPTE out of an audio signal fed from the Audio Device In CHOP*. **We already have an audio input path and a feature-extraction stage** (`src/app/audio-features.ts`, `audioIn`) **[code]** — so LTC-in is reachable page-natively, with no bridge, if anyone ever wants it. It moves out of "needs a helper" and into "needs a decoder".

#### Four claims that are commonly repeated and are wrong

- **"NDI is license-gated in TD."** It is not. The Licensing table gives *"NDI OPs for streaming video over LAN"* to **all tiers including Non-Commercial**. What *is* gated: Shared Memory OPs and DirectX texture sharing (Educational and up), `Sync In/Out CHOP` and hardware frame-lock (**Pro only**), ST2110 and the camera-tracking family (**Pro only**), and Non-Commercial is capped at **1280×1280 resolution**.
- **"Syphon is macOS and Spout is Windows, so they are two different operators."** One operator, `Syphon Spout In/Out TOP`, covers both. Real differences worth noting: ***"Syphon is limited to 8-bit RGBA"*** while Spout goes to 32-bit float; Spout needs Nvidia or AMD (*"Intel does not work"*) and defaults to a limit of 10 active senders.
- **"There is a UDP In CHOP."** There is not — the URL 404s. CHOP-side network ingress is `OSC In CHOP`, `Touch In CHOP` and `Pipe In CHOP`.
- **"Timecode CHOP reads timecode from a device."** It generates; see (v).

**The wiki's OSC address→channel-name rule is undocumented**, which is worth stating because §5.2 proposes our own and it is nice to know we are not diverging from a published standard. All that exists is a `Strip Prefix Segments` parameter (*"an address of /a/b/c/d/e with 3 segments removed would show d/e (or d_e as a final channel name)"*) plus the general channel-naming rule that **`/` is a legal channel-name character** and anything illegal is coerced to `_`. On the way out, `OSC Out CHOP`'s `Transpose By Name` groups channels sharing a root: `A/Red B/Red A/Blue B/Blue` becomes two messages, `/A Red Blue` and `/B Red Blue`. **That is a good design and §4.5 copies its spirit.**
### 3.2 Browser API status, checked today (2026-09-02)

Everything here was fetched today from MDN browser-compat-data, the W3C/WICG specs, Chrome release notes and blink-dev intents. **Three of these findings change the plan, and one of them changes it a lot.**

| API | Chrome/Edge | Firefox | Safari | Gate |
|---|---|---|---|---|
| **Web MIDI** | 43+ | **108+ desktop only**, site-permission add-on | **none, any version** | secure context; **permission prompt for ALL access since Chrome 124**, not just sysex |
| **WebSocket → `ws://127.0.0.1`** | yes, **but see LNA below** | yes | **blocked as mixed content from HTTPS** (WebKit bug 171934, open since 2017) | — |
| **SharedArrayBuffer** | 68+ | 79+ | 15.2+ | cross-origin isolated (COOP+COEP) |
| **COEP: credentialless** | 96+ | **119+** | **none** | — |
| **Web Serial** | 89+ | **151+ desktop** (new, May 2026) | none | user gesture, per-site+per-port |
| **WebHID** | 89+ | none (Mozilla: negative) | none | user gesture |
| **WebUSB** | 61+ | none (Mozilla: negative) | none (WebKit: oppose) | user gesture |
| **WebTransport** | 97+ | 114+ | **26.4+ (Mar 2026)** | secure context |
| ↳ `serverCertificateHashes` | 100+ | 125+ | **26.4+** | cert validity **< 2 weeks**, SHA-256, ECDSA P-256 only, no RSA |
| **WebCodecs `VideoEncoder`** | 94+ | 130+ | 16.4+ | secure context |
| **`MediaStreamTrackProcessor`** | 94+ (partial) | **none** | 18+ | — |
| **getDisplayMedia** | 72+ | 66+ | 13+ | transient activation; **permission can never be persisted** |
| **Gamepad** | yes | yes | yes | **gamepad must be physically actuated** before it appears |
| **WebGPU** | 113+ (MDN counts full at 144) | **141+ Windows, 145+ macOS Apple Silicon**; Linux pending | 26+ | — |

**Finding A — Chrome now gates loopback WebSockets behind a permission prompt, and it shipped four months ago.**
**Chrome 147 (released 7 April 2026) extended Local Network Access restrictions to WebSockets:** *"WebSocket connections to local addresses now trigger permission prompts"* (Chrome 147 release notes; blink-dev Intent to Ship, LGTMs 13 and 18 March 2026) **[doc]**. LNA restrictions can also be turned off wholesale by enterprise policy (`LocalNetworkAccessBlockedForUrls`).

**But it does not affect us as we currently ship, and I verified the rule myself rather than taking it second-hand.** I fetched the WICG spec (Draft Community Group Report, 7 August 2026) and the gating rule is: *"A request is a local network request if request's current url's host maps to an IP address whose IP address space is **less public than** request's policy container's IP address space"*, plus an explicit note that *"requests originating from the loopback address should not be considered local network requests."* **[doc — fetched and quoted]**

So:

- **Page served from `http://localhost:5173` → `ws://127.0.0.1:43919`: loopback → loopback, NOT gated.** Today's dev and today's bridge are unaffected.
- **Page served from a public HTTPS origin → `ws://127.0.0.1`: gated, prompt required.**

**This is a deployment decision, and it should be made deliberately rather than discovered.** If Loom is ever hosted at a public origin and expects to reach a local helper, every user meets a Chrome permission prompt whose current wording is *"Access other apps and services on this device"* — and enterprise Chrome can refuse it outright. **Serving the app from loopback avoids the whole mechanism.** Given the app already runs from a local dev server, "the bridge requires the locally-served build" is a defensible and cheap position, and it is one more argument for §7's one-process design. Note also the spec defines two permission names (`local-network`, `loopback-network`) while Chrome implements one descriptor (`local-network-access`) — spec/implementation drift worth re-checking before anyone writes a feature-detect.

**Finding B — Safari has no Web MIDI, at any version, and blocks HTTPS→loopback as mixed content.**
Web MIDI: *not supported 3.1–27+* (caniuse; MDN marks the API "Limited availability — not Baseline" for this reason) **[doc]**. Loopback: WebKit bug 171934 *"Don't treat loopback addresses as mixed content"* has been open since 2017-05-10 with its last substantive comment in 2023 **[doc]**. **So on Safari, MIDI is unreachable and a helper is unreachable from an HTTPS origin.** Safari *does* have WebGPU (26+), so Loom itself runs there — which makes this exactly the §V359 situation: the I/O panel on Safari must say *"this browser has no Web MIDI"* with its reason, not present a dead picker. I would treat the loopback/mixed-content claim as the staler of the two and re-check it against a current Safari before writing user-facing copy.

**Finding C — Chrome prompts for ALL Web MIDI since Chrome 124 (April 2024), not just sysex.**
*"The entire Web MIDI API is now gated behind a permission prompt"* — previously only sysex prompted **[doc: developer.chrome.com/blog/web-midi-permission-prompt]**. Denial surfaces as `SecurityError`. **This makes §V476 binding for MIDI examples: a shipped example containing a live `midiIn` asks for a permission on first frame, exactly as a mic branch does, and §V411's understudy pattern becomes the only way to ship one.** Firefox's model differs again (a site-permission add-on) and Bugzilla 1742635 records that a site **cannot distinguish user-denial from add-on-missing** there — so the "why is there no MIDI" message cannot be fully accurate on Firefox and should say so rather than guess.

**Corrections to the brief's assumptions, all in the same direction — the page can do slightly more than assumed and Safari slightly less:**

- **WebSerial is no longer Chromium-only**: Firefox 151 desktop shipped it in May 2026, with a per-site-and-per-port permission and an enterprise policy (`DefaultSerialGuardSetting`) that disables it by default in Firefox Enterprise **[doc]**. WebHID and WebUSB remain Chromium-only, and Mozilla's formal positions on both are **negative**.
- **COEP `credentialless` is not Chromium-only** — Firefox 119 shipped it. Safari has neither, so Safari needs the stricter `require-corp`. Relevant to §8.
- **WebTransport with `serverCertificateHashes` is now cross-engine** (Safari 26.4, March 2026) but is **not** a practical local-helper transport: the pinned certificate must have a validity window under two weeks, must be ECDSA P-256, and the helper would have to implement HTTP/3 and hand the page a fresh hash. A loopback WebSocket is strictly simpler. Chrome's LNA gating for WebTransport was targeted at 147 but I could not confirm it shipped there — sources disagree **[doc, contested]**.
- **WebRTC to a local process is worse than a WebSocket, for a structural reason**: no STUN/TURN is needed (host candidates suffice), but you still need a signalling channel to exchange SDP — and if you already have a way to reach the local process to signal, that channel *is* the transport. Chrome's LNA for WebRTC is at Intent-to-Prototype only, so it is not a durable way around the prompt either **[doc, weakest-sourced item in this table]**.
- **`getDisplayMedia`'s permission can never be persisted** — *"the user must be prompted for permission every time"* **[doc: MDN]**. That is disqualifying for an unattended VJ rig and it is why Screen Grab is not in the ranked list.
- **Gamepads require physical actuation before they appear** (anti-fingerprinting), so a gamepad node's absent state is normal-on-load and must not read as an error **[doc: MDN]**.
- **`webkit.org/status` is retired** — it now redirects readers to MDN/caniuse. Any SPEC row citing it should be updated.
- **caniuse's Firefox WebGPU row is stale** (it claims disabled-through-157 while Firefox shipped Windows in 141). Cite MDN BCD and the Mozilla Gfx blog instead. Relevant to §9's matrix.
## 4. The ranked subset

### 4.1 How the ranking was made

Four criteria, applied in this order:

1. **Does it need infrastructure we do not have?** Page-native beats bridge-required, because a bridge item carries a helper process the user must run.
2. **Does it unblock other items?** The seam (#2) is ranked above things that are more visible than it, because everything after it is a driver.
3. **Is the reach real?** OSC and MIDI reach existing software people already own. MQTT reaches a broker nobody has described.
4. **Does the value graph already have somewhere to put it?** A numeric channel lands in a `Record<string, number>` that exists. A string does not.

TouchDesigner's surface (§3.1) is roughly forty boundary-crossing operators. **We are proposing eight items, three of which are one mechanism seen from different sides.** §4.6 refuses the rest by name.

### 4.2 Tier 1 — the foundation (build these together)

**1. Web MIDI in, with learn and mapping.** Page-native, no helper, and §3.1(i) found that **TouchDesigner has no auto-learn at all** — so this is not catching up, it is a place we can be better than the reference product at the ergonomic VJs use most. Chrome/Edge since 43, Firefox 108+ desktop; **Safari has none, at any version** (§3.2), so the honest-absence UI (§V-io-3) ships with it rather than after it. Chrome has prompted for *all* MIDI access since 124, which makes §V476 binding and the understudy pattern mandatory for any shipped example.

**2. The device channel seam.** Publish device values into the `channels` extras the value graph already threads (`use-value-graph.ts:160`), and add the frame-indexed harness twin beside `audio` and `pointer` **[code]**. **`channelIn` then works against MIDI and, later, OSC with no new node and no compiler change.** This is the cheapest item in the document and the most load-bearing: items 3, 4, 5, 7 and 8 are all drivers behind it.

**Why together:** shipping MIDI without the seam means MIDI invents a channel, and then OSC invents a second one. §V437's lesson, three times over `absTime`: *a requirement delivered site-by-site is not delivered* **[code: SPEC.md]**.

### 4.3 Tier 2 — the bridge and the loop back out

**3. Device bridge (generalise `bridge-host`), OSC in and out first.** A page cannot speak UDP and OSC is the studio lingua franca — every DAW, every lighting desk, Resolume, Ableton via plugins, Max, Pd, TouchDesigner itself. Generalising the existing host (§7) reuses the loopback bind, the origin allowlist, the pairing code, the role protocol and §T921's proxy/retry, so **the security posture is inherited rather than re-argued**, which is most of the work on a thing like this. Ranked below the seam because it needs the seam; ranked above MIDI out because it opens more of the world.

**4. MIDI out.** Page-native, same permission grant, **and it shares the mapping table with item 1** — which is the whole reason it is this high. Motorised faders and LED rings turn a controller from a sensor into an instrument, and building the mapping once for both directions is much cheaper than twice.

**5. Recorded device tracks.** Not a feature; the gate (§6). `NODE_REPRODUCIBILITY` will refuse to let `midiIn` land unclassified, and once classified `external-live`, every example warns on export and every headless gate needs a recorded feed. Ranked fifth rather than first only because there is nothing to record until 1 and 3 exist — **it must ship in the same wave, not "later"**, or we accumulate ungateable examples.

### 4.4 Tier 3 — cheap reach

**6. WebSocket out.** One `WebSocket`, the published bag as JSON, at a chosen rate. No helper, no permission, no bridge. **[measured]** 0.061 ms per message round trip, so the cost at 60 Hz is nil. Makes Loom a source for anything scriptable.

**7. Art-Net / sACN out.** Nearly free once the bridge speaks UDP: DMX is a channel array and the value graph is a channel bag, so the impedance match is almost exact. TD's own constraints are the spec to copy — 512 channels per universe, **44 Hz max**, first channel → first DMX address (§3.1). Opens installations, architectural lighting and theatre, which is a different audience than VJ. Needs §V-io-5 more than anything else here: Art-Net's default is a broadcast address, and broadcasting by default is §T458's mistake in a different protocol.

**8. Gamepad in.** A bag-shaped node over a shipped API, two dozen lines. Caveat for its absent-state copy: **a gamepad does not appear until it is physically actuated** (anti-fingerprinting), so "not detected" is the normal state on load and must not read as an error (§3.2).
### 4.5 Output — the half the owner named first

*"…these kind of apps are only part of the equation and feed into others or pull from others or both."* **A tool that cannot send is a dead end in a studio chain**, and today Loom can send exactly two things: a rendered file, and pixels to an agent over the MCP bridge **[code: `src/runtime/export/**`, `render_preview`]**. Neither is a live feed.

The good news is that egress is *cheaper* than ingress for everything control-rate, because the values already exist. `use-value-graph.ts` keeps `latestBags.current` — every value node's bag, per frame, keyed by node id — and `value-history.ts` already rings them for plotting **[code]**. **Publishing is a serialiser over a map we already build.** There is no new evaluation, no new seam, no new port type.

**OSC out.** The value-graph bag *is* an OSC namespace with no translation: node name → address prefix, channel name → leaf. `lfo1` publishing `{ value: 0.3 }` sends `/lfo1 0.3`; `midi1` publishing four channels sends `/midi1/cutoff`, `/midi1/fader3`, and so on. **The mapping is symmetric with §5.2's ingress mapping, which is the property that makes the pair worth building together.** TouchDesigner's `OSC Out CHOP` reached the same design from the other end — its `Transpose By Name` mode groups channels sharing a root, so `A/Red B/Red A/Blue B/Blue` sends `/A Red Blue` and `/B Red Blue` **[doc]** — which is worth copying as an option, because one message per node is far kinder to a receiver than one per channel. Needs the bridge (UDP). Rate-limited and explicitly addressed per §V-io-5 — no broadcast by default.

**MIDI out.** Page-native, same `requestMIDIAccess` grant as ingress, and it shares the mapping table (§5.3) — which is why it ranks 4 rather than 8. This is what drives motorised faders and LED rings back from the patch, and it is what makes a controller feel *connected* rather than *read*. A value → CC is a quantisation and a channel/number, i.e. the ingress mapping run backwards.

**WebSocket out.** The cheapest of all: one `WebSocket` client, the published bag as JSON, at a chosen rate. No helper, no permission, no bridge. It makes Loom a *source* for anything scriptable — a Node script, a Python listener, a web page, a Max patch with a websocket object. **[measured]** the transport cost is 0.061 ms per message round trip; one-way at 60 Hz is free. I rank it 6 only because OSC reaches more existing software; on effort alone it would be first.

**Art-Net / sACN out.** Once the bridge speaks UDP, DMX is a packet format: 512 channels per universe, a fixed header, 44 Hz. **The value graph is already a channel bag and DMX is already a channel array — the impedance match is almost exact**, which is why this falls out nearly free and why it ranks 7 despite opening a genuinely different market (architectural lighting, installations, theatre). The care needed is §V-io-5's: a lighting network is a network, and broadcasting to `2.255.255.255` because that is the Art-Net default is precisely the §T458 mistake in a different protocol.

**Video out — NDI and Syphon/Spout, honestly.**

- **Syphon (macOS) and Spout (Windows) share GPU textures between processes on one machine, by handle.** The whole point is that the pixels never leave the GPU. **A browser page has no mechanism to export a GPU texture handle to another process — not through WebGPU, not through WebGL, not through any shipping or proposed API.** So the only page-side route is: read back to CPU, cross the socket, re-upload on the far side, and have a helper publish it. **That discards the entire reason Syphon exists.** The cost of the pure-browser architecture, stated plainly: **Syphon/Spout are unreachable from a page, and no amount of bridge engineering recovers them — only a native shell does (§9).** That is the single strongest item in C's column and it should be weighed as such rather than glossed.
- **NDI is network video and therefore *is* reachable through a helper**, since it is frames over a socket rather than a shared handle. The pipeline is readback → encode → helper → NDI. **[measured]** the socket can carry it if binary frames are added (4.9 ms per 1080p round trip as raw bytes, §10), and WebCodecs `VideoEncoder` — already used by the export path (`src/app/use-render-range.ts:14`) **[code]** — can compress it first. **The unmeasured term is the GPU readback**, and I flag rather than hide that it is likely the binding constraint. NDI also carries licensing considerations for redistribution that I did not research.
- **Streaming out (WebRTC / RTMP / SRT) may be the better first video-out, and the survey is what changed my mind.** TouchDesigner's own `Video Stream Out TOP` — its RTSP/RTMP/SRT/WebRTC path — ***"requires an Nvidia GPU and Windows to operate"***, with GeForce cards capped at 8 encoder sessions **[doc]**. We have WebCodecs `VideoEncoder` on Chrome, Firefox and Safari desktop and WebRTC everywhere (§3.2). **So this is a capability where a browser app is cross-platform and the reference product is not** — the inverse of every other row in this section. It still pays the readback cost, and it is still deferred, but it should be evaluated *before* NDI rather than after.
- **The honest summary: we can plausibly do NDI or stream-out at a cost, and we cannot do Syphon/Spout at any cost while we are a page.** Both are deferred in §4.6, but for different reasons — NDI and streaming for effort and sequencing, Syphon/Spout for impossibility.

**One output that needs no protocol at all and is worth naming:** a second browser window showing the render (the perform window, already a concept here — §V202 discusses which window hosts the scheduler **[code: SPEC.md]**) captured by OBS or any window-capture tool. **That is how most browser-based VJ tools reach a mixer today, it works right now, and it costs nothing.** It should be documented as the supported path while NDI is deferred, rather than left for users to discover. §V359 again: an unavailable route rendered *with its reason and its workaround* beats a silent gap.
### 4.6 What we skip, and why — the half that makes this a plan

*A plan that proposes everything is not a plan.* Each of these is a deliberate refusal with a stated reason and a stated condition for revisiting.

| Skipped | Reason | Revisit when |
|---|---|---|
| **Syphon / Spout** | **Impossible from a page**, not merely hard: they share a GPU texture *handle* between processes and no web API exports one. Readback→socket→re-upload discards the entire reason they exist. (TD covers both with one operator, `Syphon Spout In/Out TOP`; worth knowing that **Syphon itself is limited to 8-bit RGBA** and Spout needs Nvidia or AMD — *"Intel does not work"* — so the thing we cannot have is also narrower than its reputation.) | A native shell is chosen (§9). Then it is a library binding, not a project. |
| **NDI** | Reachable but expensive: needs binary frames on the transport (§7.3), a GPU readback per frame whose cost I did not measure (§10), an encoder, and a helper-side SDK. **A window captured by OBS already solves the common case for free** (§4.5), and §3.1(ii) suggests **WebRTC/WebCodecs streaming is the better first video-out anyway** — it is the path where we would be cross-platform and TouchDesigner is Windows+Nvidia only. Note NDI is *not* license-gated in TD, contrary to the common claim — that was never the reason to skip it. | Someone names a chain that OBS window-capture cannot serve. Then evaluate **stream-out before NDI**. |
| **Ableton Link** | Real value for VJ work — shared tempo and phase across machines, and TD's `Ableton Link CHOP` publishes exactly the channels we would want (tempo/BPM, beat, bar, phase, per-bar ramps and pulses, peer count) **[doc]**. But it is UDP multicast with a specific SDK, and **we do not yet have the thing it would synchronise**: §T825 records that `audioFileIn`/`audioIn` publish no `beat`/`bar`/`barPhase` at all, so only `audioPattern` carries musical structure **[code]**. Link would deliver a tempo into a graph with no tempo-consuming surface. | §T825 is resolved — a declared or estimated tempo exists on the file/live nodes. Link is then the natural *source* of it and jumps sharply up the ranking; its channel set is a ready-made spec. |
| **WebSerial / WebHID / WebUSB** | Genuinely native to a page now (and WebSerial reached Firefox 151 in May 2026), but each is a *device-specific protocol* on top of a byte pipe — a DMX dongle, an Arduino, a custom controller. There is no generic node; there is one node per device family. **HID is the exception worth watching**, because many DJ controllers are HID rather than MIDI. | A specific controller the owner actually uses needs it. This is a good candidate for the custom-node escape hatch rather than a shipped node. |
| **MQTT** | A broker protocol for installations and IoT. It is WebSocket-transportable so a page could speak it directly — but it needs a broker to exist, which is a deployment the owner has not described, and it carries a client library. | An installation project needs it. Cheap to add later; nothing else depends on it. |
| **TCP / raw UDP as user-facing nodes** | These are *transports*, not features. Exposing "send bytes to a port" as a node moves the protocol problem to the user and produces documents nobody else can read. The bridge speaks TCP/UDP internally in service of OSC, Art-Net and NDI; it should not offer it raw. | Never, as a shipped node. A custom bridge driver is the right escape hatch. |
| **Timecode (LTC / MTC)** | Only meaningful when a Loom document is *slaved* to an external timeline, which is a broadcast/theatre workflow. The timeline machinery it would drive exists (§T454/§T455 ranges, transport, seek **[code]**), so this is sequencing rather than architecture. **And it needs no bridge:** §3.1(v) — TD's `LTC In CHOP` decodes SMPTE **out of an audio signal**, and we already have an audio input path, so this is a decoder over a seam we own. | A show-control use case appears. Then it is a decoder plus a transport source, and the transport-source seam already exists (`TransportSource`, `frame-driver.ts`). |
| **Shared memory (TD's Shared Mem In/Out)** | **Structurally unavailable**: §8.1 — no SAB, and no shared memory of any kind, between a page and another OS process. | A native shell is chosen. Then it becomes the fastest local IPC available. |
| **Screen Grab / `getDisplayMedia` as an input node** | **The permission cannot be persisted — MDN: *"the user must be prompted for permission every time"*** **[doc]**. A VJ rig that demands a picker dialog on every launch is not a rig. Also desktop-only, and `MediaStreamTrackProcessor` (the efficient frame path) does not exist in Firefox. | The permission model changes, or a shell makes it a native capture. |
| **"Touch In / Touch Out" equivalents (Loom↔Loom)** | TD's own machine-to-machine link. We have exactly one instance of the problem it solves and a much better answer available: two Loom tabs can already share through the document, and the bridge could carry it later. Building peer transport before anyone runs two Looms is speculative (§C: nothing speculative). | Two instances is a real workflow someone is actually blocked on. |
| **A DAT equivalent (strings, tables, arbitrary types)** | The value graph is `Record<string, number>` by contract **[code]**. Widening it to carry strings touches every value node and every downstream operator, and TD's DAT family is a large product in itself. **§3.1(iii) says exactly what we forgo, because TD's CHOP side forgoes the same things**: string and blob arguments, MIDI type tags, whole OSC bundles, bundle time-tags, and a callback per packet. OSC strings and MIDI SysEx both want it; both can wait. | A concrete need appears that numbers cannot express. Then it is its own port kind and its own plan, not a widening of this one. |
| **Cross-origin isolation / SharedArrayBuffer** | Priced in §8.2: app-wide deployment constraint, breaks embedding and un-CORP'd CDN assets, for a benefit nothing currently asks for. | A worker-side pixel pipeline needs zero-copy. Not before. |
## 5. What an external value looks like *in the graph*

This is the question that decides whether the rest is cheap. The brief asks three sub-questions; the repo answers two of them already.

### 5.1 A channel bag, not a node per device

**How the value graph actually works** (`src/domain/channels/value-graph.ts:24`, `src/domain/types/node-definition.ts:207`) **[code]**: every value node publishes a **bag** — `Readonly<Record<string, number>>` — and is addressed downstream as `name` (the bag's `value` channel, or its only channel) or **`name:channel`** for a named one (`value-graph.ts:311-319`). `mouse` publishes `{ x, y, buttons }` from one node **[code]**. Per-channel operations are the convention: `mapChannels` applies a Lag to `x` and `y` independently with nothing configured **[code]**.

**So the answer to "a node per device, or one node with a channel picker?" is: neither, and the third option is already the house style.** One `midiIn` node per *device*, publishing a **bag of every channel the user has learned on it**:

```
midi1  →  { modwheel: 0.42, cutoff: 0.71, fader3: 0.0, note60: 1 }
```

Wire `midi1` into a Lag and every learned control smooths at once. Address one with `midi1:cutoff` in a driven parameter. This is `mouse`'s shape scaled up, it needs zero new machinery in the value graph, and it makes a MIDI controller behave like the multi-channel source it physically is.

A device picker parameter (`device`, a string) already has precedent on `audioIn` (`src/nodes/definitions/audio.ts:44`) **[code]** — including its wart, filed as §T811: no presentation flag on `ParameterDefinition`, so a device param renders both as its picker and as a raw string field. Fixing §T811 becomes worth doing when the third device node lands, not before.

### 5.2 How an OSC address maps to a value channel

**The address is the channel name. That is the whole mapping, and the node that reads it already ships.**

`channelIn` (`src/nodes/definitions/value-graph-nodes.ts:578`) takes a `channel` string and a `fallback` number, reads `ValueEvaluateContext.channels?.(name)`, and publishes the fallback when the name is unpublished **[code]**. Its own docblock says it *"reads EXTERNAL channels only"* and that *"stale-or-fallback beats stalled (§V144)"* **[code]**.

So:

| OSC message | Published channel name | Read by |
|---|---|---|
| `/synth/cutoff 0.7` | `/synth/cutoff` | `channelIn` with `channel = "/synth/cutoff"` |
| `/pad/xy 0.2 0.8` | `/pad/xy/0`, `/pad/xy/1` | two `channelIn`s, or one `oscIn` node publishing the bag |
| `/clip/3/fire` (bang) | `/clip/3/fire` as 1 for one frame | `channelIn` → `valueTrigger` |

**We are not diverging from a published standard by choosing this, because there is no published standard to diverge from:** §3.1 found that TouchDesigner's own address→channel-name rule is **undocumented on the wiki**. What TD does publish is worth copying — a `Strip Prefix Segments` parameter (*"an address of /a/b/c/d/e with 3 segments removed would show d/e"*), an `OSC Address Scope` include/exclude pattern filter, and the fact that **`/` is a legal channel-name character** in TD so addresses survive largely intact **[doc]**. A prefix-strip parameter on `oscIn` is a small thing that makes long namespaces usable, and the scope filter is what keeps §V-io-7's channel cap from being hit by an iPhone spraying accelerometer data.

**Multi-argument messages take a slash-index suffix** (`/pad/xy/0`), because a positional argument has no name to take — and deliberately **not** a colon, which is already the `name:channel` addressing separator (§7.4). Non-numeric arguments (strings, blobs) **do not enter the value graph at all** — the value graph is `Record<string, number>` by contract and widening it to carry strings is a change to every value node. Strings belong on a future DAT-equivalent (§4.6), not here.

**Two node shapes, and I recommend shipping both because they cost almost nothing together:**

1. **`oscIn` (a device node)** — parameterised by a namespace prefix (`/synth/*`), publishes a bag of everything under it. Good when a controller sends a known family.
2. **`channelIn` unchanged** — reads one address by exact string, with a Fallback. Good when the user knows the one address they want, and it works *today* if the OSC feed publishes into the `channels` extras.

The second is free. Literally: publishing OSC values into the same `channels` extras that `use-value-graph.ts:160` already threads (`src/app/use-value-graph.ts:140-180`) **[code]** makes `channelIn` an OSC reader with no new node, no new port type, and no compiler change. **That is the cheapest real feature in this document and it should be the first thing built after the transport exists.**

### 5.3 Learn / mapping

MIDI-learn is table stakes and it is a **session** concern, not a document one — but the *mapping* is a document concern, because a project that forgets its mapping on reload is not a project.

**TouchDesigner does not have it.** The MIDI Device Mapper page says ***"There is no auto-learn currently"*** — custom maps are made by editing component tables **[doc, §3.1(i)]**. What TD does have is worth stealing anyway: a **Device ID** that associates an In and an Out device with one map (which is exactly what makes MIDI feedback work), the `MIDI In Map CHOP`'s indirection so the *operator* asks for `s1..sN` while the *dialog* owns the binding, and a drag-the-mapping-row-into-the-network gesture that creates an operator with all mapped channels ready. **The indirection is the good idea: the node names channels, the mapping names hardware, and the document survives a different controller.** The rest — that it has to be typed into tables — is what we should not copy.

**The shape that fits this codebase:**

- **The mapping lives in the `midiIn` node's parameters**, as an array of `{ channel: string, source: { kind: "cc" | "note" | "pitchbend", channel: number, number: number }, range: [lo, hi], mode: "absolute" | "relative" | "toggle" }`. It is document state, saved in `*.loom.json`, diffed and undone by the ordinary command path (`src/domain/commands`, §I) — a learn is just a parameter edit, so undo, autosave, and the agent tool surface all work on it for free.
- **Learn is a UI mode on the node's inspector**: arm a row, move a control, the next incoming message binds. The arming state is session state and must not enter the document.
- **The channel name is the user's**, defaulted from the source (`cc74` → rename to `cutoff`). Names are identifiers in this codebase (§V129, `nodeByName`) and the same discipline should apply to learned channels: `midi1:cutoff` is a readable driven-parameter reference and `midi1:cc74` is not.
- **`range` and `mode` belong in the mapping, not downstream.** The alternative is every user rebuilding a gain+bias chain per control — which is exactly the failure §T738 measured for audio ("every example's HAND-BUILT gain+bias chain BREAKS UNDER REAL MUSIC") and §T821 exists to fix. Do not repeat it for MIDI. A 7-bit CC normalises to 0..1 at the source; `range` maps that to the useful band once.
- **Relative/endless encoders need `mode`** because they send +1/−1 deltas (in one of three competing encodings) and an absolute reading of them is garbage. This is the one place a mapping needs to hold state across frames; `ValueEvaluateContext.state` exists for exactly that (§V181, reset with the transport) **[code]**.

**MIDI feedback (motorised faders, LED rings) is MIDI *out* addressed by the same mapping** — which is why MIDI out ranks 4 rather than 8: the mapping table is the shared artefact and building it once for both directions is much cheaper than twice.

### 5.4 A document that references an absent device

**The constraint is §T715's, verbatim, and it applies identically: the node ALWAYS exists, ALWAYS publishes its output type, and a document using it MUST LOAD AND RENDER — degraded, and the degradation must be VISIBLE. Never silent, never fatal.**

**And here the reference product is a warning rather than a model.** §3.1(iv): TouchDesigner has **no uniform missing-device contract**. `Audio Device In CHOP` has an opt-in `Error if Missing` parameter — implying the default elsewhere is not to error. `Joystick CHOP` gives *"a value of 0 … if the axis doesn't exist"*, which is indistinguishable from a centred stick. `Oculus Rift CHOP` runs with no headset, *"outputting default values"*. `Video Devices DAT` fuzzy-matches a device by unique ID, then label, then index — so **a renamed capture card can silently bind to a different card** **[doc]**. Every one of those is a plausible, wrong picture with nothing said, which is the §V147 family this repo has a rule against. **We should not copy any of it, and we already know what to do instead.**

This repo has already solved this three times and the solutions are consistent:

1. **`channelIn`'s Fallback** — an unpublished name yields the stated fallback, not a stall, not an error **[code]**.
2. **§V353 deterministic silence** — `audioIn` with no track publishes **all-zeros**, never an absent bag, *because a missing feature set would dangle every driven parameter while zeros keep the whole graph evaluating* **[code: SPEC.md:1325]**.
3. **The inference identity fallback** — an absent model still publishes bytes (mid-grey depth composes to a `displace` no-op) so the picture is a no-op rather than a hole (§T715) **[code]**.

**So: a `midiIn` naming a device that is not plugged in publishes its learned channels at their declared rest values** (from the mapping's `range[0]` or an explicit `rest`, not blindly 0 — a control whose rest is centre must rest at centre), **and raises one diagnostic naming the device.**

Three things this must get right, each of which the repo has a rule for:

- **The diagnostic must reach a surface.** §V365: *a registered command that refuses in silence is the same broken app as an unregistered one*; §V338/§V469: a detected-and-branched-on integration that reports nothing is indistinguishable from a broken one **[code: SPEC.md]**. The problems pane, not a console line, and not only a `.md` (§V363).
- **Absent and unimplemented must be distinguishable.** §V359: *an ABSENT row and a FORGOTTEN row are THE SAME PIXELS; an unavailable transport is rendered WITH ITS REASON rather than hidden* **[code: SPEC.md]**. "No MIDI device named *Launch Control XL*" and "this browser has no Web MIDI" are different sentences and the user needs to know which they are in — particularly because the second is *the permanent state on Safari* if the survey in §3.2 holds.
- **The example must still play.** §V411's understudy pattern and §V363: ship a `valueSwitch` whose default branch is a synthetic driver (an LFO at a plausible rate) and whose second branch is the device. The file plays on open for someone with no controller, and the `midiIn` node is still in the graph and still compiled by the gate — *the exact gate B39 escaped for months* **[code: SPEC.md:863]**.

**And the permission rule bites here.** §V476: *do not ship an example whose first frame asks for a permission* **[code: SPEC.md:1245]**. If Web MIDI prompts on `requestMIDIAccess` (see §3.2), then a gallery example containing a live `midiIn` is an ambush in exactly the way a mic branch is, and the understudy pattern is not a nicety — it is the only way such an example can ship at all.
## 6. Reproducibility: recorded device tracks

**This is not a feature and it is not optional. It is the thing that makes MIDI/OSC gateable, and without it we ship examples that cannot be tested and a §V329 violation on purpose.**

### 6.1 What the gate forces

`reproducibility.test.ts` asks the registry for every node it can instantiate and **fails when one is missing from `NODE_REPRODUCIBILITY`**, with a message telling the author to decide **[code]**. So the moment `midiIn` is registered, someone must classify it. The answer is `external-live` — the same class as `webcam`, `audioIn` and `mouse`, whose docblock states the rule: *"there is no parameter that makes a live camera replay… the only route to reproducibility is recording the device to a file first and playing that back"* **[code: reproducibility.ts]**.

Consequences, all automatic once the classification lands:

- `nonReproducibleRenderWarning` names the node on every export from `use-render-range.ts:183` **[code]**.
- Any shipped example containing one declares its exemption in its own `.md`, which the example gate enforces **[code: SPEC.md:1613]**.
- Every GPU/headless gate involving one must **feed a recorded track**, or it asserts against whatever the machine happened to be doing — which is the "plausible pixels, silently inert input" family that earned five separate rows (§T630, §T633, §T650, §T655, §T661) **[code: SPEC.md]**.

### 6.2 The track format: copy `feature-track.ts`, do not invent

`src/domain/audio/feature-track.ts` is the template and its design decisions transfer exactly **[code]**:

- **Record what the engine READ, not what an upstream stage computed.** The harness records at the seam (`recordAudio`, `recordPointer`), and the docblock is explicit: *"what must replay identically is what the engine READ"* **[code: render-harness.ts]**. For MIDI that means recording the **resolved channel bag per frame**, not the raw MIDI bytes. A byte log would have to be re-interpreted through the mapping at replay time, and a mapping edit would then silently change the replay — which is the same failure `feature-track.ts` avoids by recording features rather than PCM (*"matching the browser AnalyserNode's windowing and FFT bit-for-bit across engines is a §V47 parity promise nobody can keep"*).
- **Flat arrays, not objects.** *"A ten-minute performance at 60fps is 36 000 frames: as objects that is a multi-megabyte JSON of repeated key names"* **[code]**. A device track needs a channel-name header plus a flat `frames` array of `channels.length` numbers per frame.
- **The version is the SEMANTICS.** `FEATURE_TRACK_VERSION` bumps when the *meaning* of a field changes, never for a performance change **[code]**. For a device track the semantics include **the mapping** — a track recorded through a mapping that has since been re-learned is a different track. Either embed the mapping in the track or version it alongside.
- **Past the end is silence.** `SILENCE` is the all-zeros record; a render past a track's end gets it, deterministically **[code]**. For devices, "past the end" should be the **rest values**, not zeros, for the same reason §5.4 gives.

### 6.3 Where the feed enters

Two seams, and devices need both because they have both natures:

- **Per-frame closure on the harness**, `deviceChannels?: (frameIndex: number) => Readonly<Record<string, number>> | null`, mirroring `audio` and `pointer` (`render-harness.ts:83,106`) **[code]**. This is what a gate feeds.
- **The live `channels` extras** in `use-value-graph.ts:160` **[code]**, which is where the running session's MIDI/OSC values arrive — the same route `analyze` takes.

Both resolve to the same `ValueEvaluateContext.channels` inside the value graph, so **a node cannot tell whether it is live or replayed**, which is the property that makes replay honest. That is precisely the shape `audio` has and the reason the brief's framing 3 is right about determinism coming free — it just comes free through `channels`, not through a fourth driver closure.

### 6.4 The staleness question

`analyze` and `channelIn` are `async-cached` because their values arrive on a readback's schedule and §V329 demands the age be visible **[code]**. **MIDI and OSC are different and the difference should be stated rather than assumed:** a MIDI message arrives on the browser's event loop between frames and is read at the next frame boundary, so it is *live*, not *stale* — the value is at most one frame old by construction, exactly like the pointer. Classify device nodes `external-live`, not `async-cached`, and do not build an age display for them.

**Except one case:** a value arriving over the *bridge* from a helper process crosses a socket, and a helper that stalls (or a page that backgrounds — §V202: Chrome clamps rAF to ~1 Hz in a non-foreground tab **[code: SPEC.md]**) will hold its last value indefinitely. **A bridge-fed channel needs a last-arrival age and a visible stale state**; a page-native MIDI channel does not. That is one more argument for §7's typed protocol carrying a timestamp per event rather than bare numbers.
## 7. The device bridge: generalising `bridge-host`, not building a second one

### 7.1 What carries over unchanged

Every security primitive, and none of it needs re-arguing — which is the entire value of the proposal:

| Property | Where it lives | Carries over |
|---|---|---|
| Loopback only, not configurable | `BRIDGE_HOST = "127.0.0.1"`, `bridge-protocol.ts:65` | **unchanged** — this is §T458's finding as code |
| Origin allowlist as second fence | `isPermittedOrigin`, `bridge-protocol.ts:103` | **unchanged** |
| Pairing code, CSPRNG, per process, never in a URL | `mintPairingCode`, `bridge-protocol.ts:123` | **unchanged** |
| Remote-address check independent of the bind host | `isLoopbackAddress`, `loopback-ws.ts:101` | **unchanged** |
| Roles declared in the first message | `page` / `proxy`, §T921 | **extended by exactly one** (§7.2) |
| EADDRINUSE → proxy the incumbent, retry-on-free | `bridge-proxy.ts`, `bridge-handoff.ts` | **unchanged, and it is why one process works** |
| A message is never an instruction | `bridge-protocol.ts:52` | **unchanged, and it matters more** (§7.4) |

**§T458's three findings map onto the device bridge one for one, and all three are already answered:** (a) it bound the wildcard — we bind loopback and refuse to make it an option; (b) it did not isolate channels, so any connected client could invoke another's tools — we accept one `page` at a time and the role gate is structural, *"a page can reach the `proxyAttach` branch and never past it, because a page cannot read a file"* (§T921) **[code]**; (c) no rate limiting on registration — the pairing code plus one-page-at-a-time plus close-on-first-wrong-code removes the guessing loop (`bridge-protocol.ts:118`) **[code]**.

**One new exposure the device bridge creates that the MCP bridge does not have, and it must be named:** the MCP bridge lets an agent *drive* Loom. A device bridge lets Loom *reach the network* — Art-Net to a lighting rig, OSC to whatever is listening. A malicious page that got past the pairing code could previously edit a document; now it could transmit on the LAN. **Mitigation: egress targets are document state, and the bridge refuses to send anywhere the document did not name.** Not a wildcard destination, not a broadcast address by default. This is worth an invariant of its own (§11).

### 7.2 The protocol shape, and why the existing one does not fit as-is

The MCP protocol is **request/response, host-initiated**: `listTools` / `callTool` from the host, results from the page (`bridge-protocol.ts:162-176`) **[code]**. Devices invert this. A MIDI CC is **unsolicited, page-bound, and high-rate**. So the device role needs the other direction, and it should be a *third role on the same socket family* rather than a second server:

```ts
// page → host
| { type: "deviceAttach"; code: string; client: string }
| { type: "subscribe"; id: number; sources: readonly DeviceSourceSpec[] }
| { type: "send"; source: string; events: readonly DeviceEvent[] }   // egress, batched per frame
// host → page
| { type: "deviceAttached"; sources: readonly DeviceSourceDescriptor[] }
| { type: "deviceEvents"; source: string; at: number; events: readonly DeviceEvent[] }
| { type: "deviceState"; source: string; state: "open" | "absent" | "error"; reason?: string }
```

Four properties that are not negotiable, each earned by a row already in SPEC:

1. **Batched per frame, not per message.** OSC from a fader bank arrives at hundreds of messages per second. Delivering each as its own socket message and its own React state update is how a UI dies. The page reads a *coalesced* bag at the frame boundary — which is also what makes it replayable (§6).
2. **Every event carries `at`.** §6.4: a bridge-fed channel can go stale invisibly and must be able to say so.
3. **`deviceState` is a first-class message, not an error.** §V359: an absent device is rendered *with its reason*. The host must say "no such MIDI port" distinctly from "the helper is not running".
4. **The catalogue is discovered, not configured.** `deviceAttached` enumerates what the helper can see, which is what makes a device picker possible at all. **TouchDesigner treats this as a whole operator family and it is a good idea**: `Audio Devices DAT`, `Video Devices DAT`, `Serial Devices DAT`, `Monitors DAT`, `NDI DAT`, `Art-Net DAT`, `EtherDream DAT` — each a table **with a change callback**, so "what is plugged in" is data in the graph rather than state in a dialog **[doc, §3.1]**. We should not build seven nodes, but the *shape* — enumeration as data, with a change event — is what `deviceState` and `deviceAttached` are for, and it is what lets a device picker refresh without a reload. Note TD's own caveat that *"some devices may not be listed if they are connected while TouchDesigner is already open"*: hot-plug is the case everyone gets wrong, and a change callback is how you do not.

### 7.3 The transport must grow binary frames — and this is the one real engineering cost

`loopback-ws.ts` refuses binary frames deliberately (*"everything on this wire is JSON text, and a binary frame is a sender we do not understand"*) **[code]**. For control data that is correct and should stay: **[measured]** a 133-byte MIDI event as JSON round-trips in **0.061 ms mean** through the real server, ~16,500/s. At 60 fps with a hundred events per frame that is under 1% of a frame budget. **Do not change the transport for control data. There is no problem there.**

For pixels it does not work, and the numbers say precisely why **[measured, §10]**:

| Payload | Path | Round trip | Effective |
|---|---|---|---|
| 133 B JSON control event | this repo's WS server | **0.061 ms** | ~16,500/s |
| 1920×1080 RGBA, base64 in JSON | this repo's WS server | **119 ms** | ~8/s |
| 1920×1080 RGBA, raw text frame | this repo's WS server | **77 ms** | ~13/s |
| 1920×1080 RGBA, raw bytes | plain loopback TCP | **4.9 ms** | ~206/s, 3.4 GB/s |

**The bottleneck is the text codec, not loopback.** A 16× gap between the same bytes as text through this server and as `Buffer`s over TCP. So: *if* a pixel path is ever wanted over the bridge, the fix is binary frames plus zero-copy buffers in `loopback-ws.ts`, and the headroom is there — 4.9 ms round trip is inside a 16.6 ms frame. **But §4.6 argues we should not want that path at all**, because the GPU readback in front of it is the real cost and because NDI/Syphon are better solved elsewhere. **Recommendation: add binary frames only when a ranked item needs them. Nothing in tiers 1–8 does.**

### 7.4 Untrusted data, restated for a new threat model

`bridge-protocol.ts:50` already says *"a message off this socket is never an instruction"* and `callTool` arguments stay `unknown` until validated by a zod schema **[code]**. Devices make this sharper in one specific way: **an OSC address is attacker-controllable text that we are proposing to use as a channel name.** Channel names are looked up in a `Map` (`value-graph.ts:314`) so there is no injection surface in the evaluator, but there are three places to be careful: the name must not be interpreted as a path or a node reference; a `:` in an OSC address collides with the `name:channel` addressing syntax and must be escaped or rejected; and an unbounded stream of novel addresses is an unbounded map. **Cap the published channel set and say so when the cap is hit** (§V469: a swallowed refusal is worse than a slow one).

### 7.5 Lifetime: one process, two spawners

The MCP host's lifetime belongs to Claude Desktop, which spawns it — and **spawns it twice from one config entry**, measured, which is the whole of §T921 **[code]**. A device bridge must run whether or not an agent client is running, so the user starts it (`pnpm loom:bridge`). **These are not in conflict, because §T921 already solved exactly this collision:** the second instance to start loses the bind, becomes a client of the incumbent, and forwards. One process ends up owning the devices; both sets of callers reach it. **Generalising means adding device sources to `serve.ts` and a `device` role to the protocol — it does not mean a second listener, a second port, or a second security argument.** That is the strongest argument for the brief's framing 2 and it survives contact with the code.

**One caveat to state honestly:** the proxy path today forwards `tools/list` and `tools/call` (`bridge-proxy.ts`) **[code]**. Forwarding a *subscription* — a long-lived, high-rate, push stream — through the proxy is more work than forwarding a request/response pair, and I have not designed it. If that turns out to be awkward, the fallback is that only the incumbent serves devices and a proxying instance reports "devices are served by PID N" — loud, actionable, and §V288-shaped.
## 8. External processes (python / uv), and the SharedArrayBuffer verdict

### 8.1 The precision that decides this

**SharedArrayBuffer is not gated on a native shell.** It is Baseline since December 2021 — Chrome 68+, Firefox 79+, Safari 15.2+ — and needs cross-origin isolation: `COOP: same-origin` plus `COEP: require-corp` or `credentialless`, with `self.crossOriginIsolated` as the runtime check **[doc: MDN, last modified 2026-08-21]**. A browser app can have SAB today, with no Electron.

**But SAB is shared within one agent cluster — a page and its workers.** There is no mechanism by which a page hands a `SharedArrayBuffer` to a separate OS process. Not with headers, not with permissions, not at all. **[doc]**

**So both halves of the owner's sentence need saying, because each one is right about a different thing:**

- *"For actual SharedArrayBuffer we need something like Electron"* — **true for their case.** Sharing memory with a `uv` venv Python is impossible from a page. If shared memory with an external process is the requirement, a native shell is the only option that delivers it.
- *"…we need Electron for SharedArrayBuffer"* — **false as a general statement.** For page↔worker sharing, which is what SAB is actually for, headers are sufficient and we could turn it on tomorrow.

**Whether we want to turn it on is a separate question with a real price**, and it should be priced before it is chosen.

### 8.2 What cross-origin isolation costs

**Two of the four costs usually quoted are smaller than the folklore says, and the other two are worse.** This was checked today rather than recited **[doc, with live header checks]**.

**Smaller than claimed — the CDN subresource problem is mostly solved already.** Under `COEP: require-corp` a cross-origin `no-cors` subresource is blocked unless it sends `Cross-Origin-Resource-Policy: cross-origin` or is fetched in CORS mode. Live header checks on 2026-09-02 found CORP **already present** on Google Fonts (both hosts), Google Tag Manager, Google Analytics, Google Maps JS, jsDelivr, cdnjs, unpkg and code.jquery.com. The counterexample in that sample was `js.stripe.com/v3/`, which sends no CORP and needs a `crossorigin` attribute. **So "isolation breaks your CDN assets" is largely obsolete advice**, and there is a dry-run header (`Cross-Origin-Embedder-Policy-Report-Only`) to check ours specifically before committing.

**Worse than claimed — popups and third-party iframes.**

- **`COOP: same-origin` severs `window.opener` for cross-origin popups**, and *"will break integrations that require cross-origin window interactions such as OAuth and payments"*. **The trap is that the obvious mitigation does not work: `same-origin-allow-popups` preserves OAuth popups but does *not* grant cross-origin isolation**, which requires the internal `same-origin-plus-COEP` state. **SharedArrayBuffer and popup-based OAuth are mutually exclusive.** `COOP: restrict-properties`, the proposed fix, exists in **no browser** — it has no key in MDN's compat data at all.
- **Third-party iframes must send their own compatible COEP**, recursively down the frame tree. Checked live: **YouTube embeds break** (they send CORP but only `COEP-Report-Only`, which does not satisfy the check). Google Publisher Tag is explicitly unsupported on COEP pages. The `credentialless` *iframe attribute* is an escape but loads the frame with no cookies or storage — killing any logged-in embed — and is **Chrome 110+ only**.
- **Being embedded elsewhere**: we can still be iframed (COOP governs top-level contexts; framing is `X-Frame-Options`/`frame-ancestors`), but we are **not isolated in there** unless the whole chain is isolated and the embedder adds `allow="cross-origin-isolated"`. The Document-Isolation-Policy explainer names this exact case as the unsolved one that forces widget authors to *"maintain two versions of their widgets, with and without SABs."*

**`COEP: credentialless`** relaxes only the subresource rule (and sends those requests without credentials); it does **not** relax the iframe inheritance requirement. Chrome/Edge 96+, **Firefox 119+**, **not Safari** — so a Safari-supporting app still needs a `require-corp`-clean asset story **[doc: MDN BCD]**.

**There is now a partial escape, and it is Chrome-only.** `Document-Isolation-Policy` (`isolate-and-require-corp` / `isolate-and-credentialless`) shipped in **Chrome 137 desktop** and gives per-document isolation backed by process isolation: no requirements on subframes, **cross-origin popups still work**, and a DIP document embedded cross-origin gains the isolated APIs regardless of its embedder. Mozilla's standards position went **positive on 2026-08-10**; WebKit's is open with portability concerns; neither has implemented it. **Per-worker isolation is not a thing** — a worker inherits its document's state. The old `UnrestrictedSharedArrayBuffer` reverse origin trial for desktop expired at Chrome 149 (stable 2026-06-02; current stable ~152); the enterprise policy `SharedArrayBufferUnrestrictedAccessAllowed` survives but is a managed-fleet lever, desktop only.

**One thing this settles cleanly: WebGPU does not require cross-origin isolation.** MDN's WebGPU page requires a secure context and says nothing about COOP/COEP/SAB. The coupling runs the other way — **wasm threads and SAB require isolation; WebGPU does not** — so nothing about our renderer pushes us toward it.

**Verdict on isolation for Loom specifically: do not turn it on now, and do not turn it on for a reason we do not have yet.** The asset cost is small, but the popup and embed costs are structural, the Chrome-only escape does not help Firefox or Safari users, and the benefit — SAB between page and workers — is something nothing in the current architecture asks for. The inference worker moves `Uint8Array`s by transfer, not by sharing (`src/runtime/models/inference-protocol.ts:15` documents the choice: *"Both buffers are transferable and both are transferred"*) **[code]**. **Revisit if and when a worker-side pixel pipeline actually needs zero-copy — and note that Pyodide, the most likely reason to want it, does not (§8.3(B)).**

### 8.3 The three options for talking to Python

Per §T943, these are presented for the owner to choose from, not decided here.

#### (A) Browser + bridge — WebSocket to an external Python

The Python process opens a loopback WebSocket to the device bridge (or the bridge speaks to it), and values cross as JSON.

- **No shared memory.** Every value is copied and serialised.
- **Latency is a non-issue for control-rate data, measured rather than assumed: 0.061 ms mean round trip, ~16,500/s** through this repo's own server **[measured, §10]**. A frame is 16.6 ms. For MIDI, OSC, parameter streams, analysis results, pose keypoints, classifier outputs, and anything else expressed as numbers, **A is not a compromise — it is over-provisioned by four orders of magnitude**.
- **It is a compromise for per-frame framebuffers.** 119 ms per 1080p RGBA round trip on today's text-only transport; 4.9 ms as raw bytes over plain TCP **[measured, §10]**. So the ceiling is the codec, not the architecture — and in front of both sits the GPU readback, which I did not measure and which is probably the real cost (§10).
- **Which do we actually need?** Naming this honestly is what decides whether A suffices. Reviewing the catalogue: `analyze` publishes numbers; `depth`/`pose` publish a texture and keypoints; the value graph is `Record<string, number>` by contract; every MIDI/OSC/DMX use case is control-rate **[code]**. **The only thing that wants per-frame pixels across a process boundary is video output (NDI/Syphon) — which §4.6 defers for reasons that have nothing to do with latency.** So: **A is sufficient for everything currently ranked.**
- Keeps the pure-browser property, the existing security argument, and zero new distribution surface.

#### (B) Browser + Pyodide/WASM Python in a worker

Python compiled to WebAssembly, running in a Web Worker inside our own page. **Real SAB, no external process, no shell, no bridge, no pairing.**

This option deserves better than the dismissal it usually gets, and the research changed my view of it twice — once in each direction.

**Current state, checked today [doc]:** Pyodide **314.0.6**, released **2026-08-25**, bundling **CPython 3.14.2**. *(The version scheme changed: anything written against "Pyodide 0.2x" is stale. `0.29.4` → `314.0.0` in June 2026, and the major now tracks the Python version, annually.)* ~285 packages in the distribution.

**In its favour, more than expected:**

- **It removes an entire failure class.** No process to start, no port to bind, no pairing code, no LNA prompt (§3.2), no "is the helper running" state, no §T921-style two-instance collision. The Python lives in the page's lifetime.
- **It does not need cross-origin isolation.** This surprised me and it materially improves the option: **Pyodide has no pthreads and forbids `-pthread`**, so it does not drag in the SAB requirement at all. Isolation is needed only for two side features — Ctrl-C interrupts and streaming downloads. **So §8.2's costs are not the price of B.**
- **Python → JS is genuinely zero-copy** via `PyBuffer.getBuffer()`: *"Get a view of the buffer data which is usable from JavaScript. No copy is ever performed."* A numpy array becomes a typed array over the WASM heap, with shape/strides, and mutations are visible on both sides.
- **The numeric stack is real**: numpy 2.4.6, scipy 1.18.0, scikit-learn 1.8.0, pandas 3.0.2, opencv-python 4.11, Pillow, sympy, scikit-image, pyarrow, polars, duckdb, xgboost, lightgbm. Under **PEP 783**, PyPI now hosts binary Emscripten wheels (`pyemscripten_2026_0`), so the "pure-Python only" limit is no longer accurate either.

**Against it, and these are hard limits:**

- **No ML runtime. `torch`, `onnxruntime` and `numba` are absent from the distribution and have zero `pyemscripten` wheels on PyPI** — so there is no runtime-install escape hatch. You can load weights and tokenize; you cannot run a model. *(We already run ONNX in JS via `onnxruntime-web`* **[code: package.json]** *— so this is less of a loss than it sounds, but it means B is not where inference goes.)*
- **No threads, no `multiprocessing`, no `subprocess`.** `threading.Thread.start()` raises. No sockets in the browser (experimental Node-only since 314.0.0), and `ssl` is a stub that raises `NotImplementedError` on real TLS.
- **Filesystem is in-memory and lost on reload** unless explicitly synced to IndexedDB.
- **JS → Python always copies** — the zero-copy street is one-way — and the Python↔JS boundary is *inside one worker*, so getting arrays out to the main thread and onward to WebGPU is still a copy or a transfer.
- **Workers must be module-type** (`{ type: "module" }`); classic `importScripts` workers broke in 314.0.0.
- **The commonly-quoted "3–5× slower than native Python" figure is stale and should not be repeated as current** — git blame puts that line on the roadmap page in **April 2021**, unedited since, predating CPython 3.9→3.14 and several Emscripten majors. There is no published benchmark page. Note also that it describes *interpreter* speed; numpy/scipy inner loops are compiled C.

**The decisive question is which Python the owner means, and A and B are answers to two different questions rather than competitors:**

- *"Run my existing `uv` venv, with my libraries and my models and my files"* → **B does not serve it at all.** A does, today.
- *"Let me write some Python as part of the patch"* → **B is strictly better than A**: no process, no protocol, no security surface, real zero-copy on the Python→JS side, and a numeric stack that covers most of what a patch-language Python would want.

#### (C) Native shell

SAB with subprocesses via native IPC, plus UDP/OSC with no helper at all, NDI/Syphon reachable, real filesystem access, and no pairing dance.

**What evaporates under C, counted honestly, because this is C's real argument and it is usually undersold:** the device bridge's entire existence (§7) — the loopback server, the pairing code, the origin allowlist, the role protocol, the proxy/handoff/retry machinery, the "is the helper running" UI state, the LNA prompt, Safari's mixed-content block, and the *second distribution artefact* the helper otherwise is. That is most of `src/mcp/**`'s hard-won complexity, and §T921 is the record of how much that complexity actually cost to get right. **C is not "the same app in a wrapper" — it deletes a subsystem.**

**What it costs**, and §9 is where the decisive constraint lives: a distribution artefact per platform, code signing and notarisation, an update mechanism, and above all **a webview that does WebGPU**.

### 8.4 Recommendation, with the trade named

**For the I/O programme in §4: option A, and it is not close.** Every ranked item is control-rate, and control-rate over loopback is measured at four orders of magnitude of headroom. Choosing a shell to get shared memory we would use for nothing would be paying a distribution cost for an unused capability.

**For "run my Python": ask which Python.** If it is *the user's own venv*, A is the answer today and C is the answer if shared memory ever genuinely binds. If it is *Python as a patch language*, **B is the better answer and it does not cost cross-origin isolation** — which is the single most useful thing the research turned up, because it removes the reason B is usually dismissed.

**The trade, stated plainly: A keeps us a browser app and costs us a helper process the user must run; C deletes the helper and costs us a shell we must ship, sign and update — and stakes the whole app on the shell's WebGPU support.** That last clause is §9.

---

## 9. §T943 — the native shell question

**Research only. The owner decides. Nothing below is a recommendation.**

### 9.1 The frame

Three options, restated from §8.3 with the shell axis made explicit:

- **(A) Browser + bridge.** Today's architecture plus a helper process. No shared memory with an external process, ever. Loopback carries control data with four orders of magnitude of headroom **[measured]**.
- **(B) Browser + Pyodide in a worker.** Real SharedArrayBuffer, no external process, no shell, no bridge. Bounded by the Pyodide wheel set.
- **(C) Native shell.** Shared memory with subprocesses via native IPC, UDP/OSC with no helper, NDI and **Syphon/Spout reachable at all** (§4.5 — the one capability that is otherwise impossible), filesystem access, no pairing dance.

**What C deletes is the honest measure of its value, and it is more than it looks.** The whole of §7 — the loopback listener, the pairing code, the origin allowlist, the role protocol, the proxy/handoff/retry machinery from §T921, the "is the helper running" UI state, Chrome's new LNA prompt for hosted origins (§3.2 Finding A), Safari's mixed-content block (Finding B), and a **second distribution artefact** the helper otherwise is. §T921's history is the record of what that complexity cost to get right the first time.

**What C costs is a build and signing pipeline per platform, an update mechanism, and — decisively — a webview that does WebGPU.**

### 9.2 The axis that actually decides it

**Not binary size.** Comparisons of Electron against Tauri/Wails/Neutralino almost always turn into a megabytes argument, and for us that is the wrong number entirely. **Loom is a WebGPU application. A shell whose webview has no `navigator.gpu` does not run a smaller version of Loom; it runs no version of Loom.**

Electron bundles Chromium, so WebGPU is whatever that Chromium has. The "lightweight" family — Tauri, Wails, Neutralino, Electrobun — uses the **system webview**, which means the engine differs per platform: WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux. **So the question is not "is Tauri lighter" but "does WKWebView 26 expose WebGPU to an embedded app, and does WebKitGTK expose it at all" — and the answer per platform is the whole decision.**

### 9.3 The matrix: shell × platform × WebGPU

All **[doc]**, fetched 2026-09-02, primary sources named. **Nothing here was run on hardware**, and §9.5 lists the two things that would change the answer if tested.

**First, the engines themselves, independent of any shell:**

| Engine | WebGPU |
|---|---|
| **Chromium / Dawn** | Default since **113** on macOS, Windows x64, ChromeOS. **Linux**: Intel Gen12+ since **144**, NVIDIA (driver 535.183.01+) on **Wayland** since **147**; everything else still needs `--enable-unsafe-webgpu`. Windows ARM64 still flagged. |
| **WebKit, Apple ports** | Default in **Safari 26.0** — but gated on **OS version, not browser version**: macOS Tahoe 26, iOS/iPadOS/visionOS 26. |
| **WebKit, GTK / WPE ports** | **Not built. Not compiled in at all.** |
| **Gecko** | Windows 141, macOS Apple Silicon 145/147; Linux not shipped. Irrelevant — no shell embeds Gecko. |

**Then the shells:**

| Shell (current version) | macOS | Windows | Linux |
|---|---|---|---|
| **Electron 44.1.1** (Chromium 152, 2026-09-01) | ✅ default | ✅ default (x64) | ⚠️ **expected but unverified**, and narrow: Intel Gen12+ or NVIDIA-on-Wayland only |
| **Tauri 2.11.5** | ✅ **macOS 26+ only** | ✅ default (WebView2) | ❌ **absent** |
| **Wails v2.14 / v3 beta** | ✅ macOS 26+ only | ✅ default | ❌ **absent** |
| **Neutralino 6.9.0** | ✅ macOS 26+ only | ✅ default | ❌ absent (unless its `chrome` mode is used — see below) |
| **Electrobun 2.0.2-beta.13** | ✅ (WKWebView 26+, or CEF) | ✅ | ❌ WebKitGTK / ✅ **with bundled CEF** |

### 9.4 The three facts that decide it

**(1) WebKitGTK has no WebGPU, and it is not a flag — the code is not compiled.** This is the strongest-sourced claim in the section because it is read from the build system rather than from documentation. `Source/cmake/WebKitFeatures.cmake` on `main` carries `WEBKIT_OPTION_DEFINE(ENABLE_WEBGPU "Toggle WebGPU support" PRIVATE OFF)`; `OptionsGTK.cmake` contains no override; and `Source/WebGPU/CMakeLists.txt` is, in full:

```cmake
add_subdirectory(WGSL)

if (APPLE)
    add_subdirectory(WebGPU)
endif ()
```

On the `webkitglib/2.52` stable branch — what WebKitGTK 2.52.x ships from — that file is one line: `add_subdirectory(WGSL)`. **The WGSL compiler builds everywhere; the WebGPU backend is Apple-only.** Corroborated by silence: webkitgtk.org's release history (current stable 2.52.6, 2026-08-19) has zero WebGPU mentions, and neither do Igalia's 2026 WebKit periodicals.

**So the owner's framing — "WebKitGTK on Linux lags" — is too gentle. It does not lag; it is absent.** `navigator.gpu === undefined`. **Tauri, Wails and Neutralino do not run a degraded Loom on Linux. They do not run Loom on Linux.**

**(2) The macOS floor for every system-webview shell is macOS 26, with no escape hatch below it.** Embedded WKWebView **does** get WebGPU on macOS 26 / iOS 26 — no entitlement, no preference key — confirmed three ways: an Apple engineer on the developer forums (*"these feature flags only impact Safari and not WebKit generally. For WKWebView, the feature will work when it's enabled by default"*), a Tauri maintainer reporting it tested on production builds (*"It should work out of the box on macos/ios 26+"*), and MDN's compat data mirroring `webview_ios` to `safari_ios` 26. WebKit bug 299237 states the gating explicitly: *"navigator.gpu requires macOS Tahoe, iOS 26, visionOS 26 or later."*

**And below that there is nothing to try**: Safari's feature flags do not reach embedded webviews. **So choosing Tauri/Wails/Neutralino means requiring macOS 26 (autumn 2025) as a hard minimum**, which is a much more specific commitment than "recent macOS".

**(3) Tauri's own maintainers recommend Electron for this.** Both WebGPU requests are **closed as not planned** (tauri#6381, tauri#12846), and the maintainer's position across the thread is that they have no control while they use OS webviews — culminating on **2025-02-28 in recommending Electron for cross-platform WebGPU**. There is no WebGPU documentation on v2.tauri.app at all. **When a project tells you its own tool is the wrong choice for your requirement, that is worth more than a feature table.**

### 9.5 Secondary observations

- **Electron on Linux is the one soft spot in the recommendation-shaped conclusion.** Chromium 152 is past both Linux milestones, so it *should* work under Chromium's constraints — but Electron's own tracker has a history here (electron#41763, "Cannot get WebGPU adapter in Linux", closed 2024 without a repro, re-complained on 2025-08-01: *"Web gpu still broken on electron on linux and there is no way to enable it like you can in chrome"*), and **no post-Chromium-144 confirmation exists either way**. And Chromium's Linux coverage is narrow regardless: Intel Gen12+, or NVIDIA on Wayland. **AMD, and NVIDIA on X11, still need a flag.** If Linux matters, this is the thing to test first.
- **Electrobun is beta and its headline WebGPU feature is not the one you want.** Every release is a prerelease (2.0.2-beta.13, 2026-08-30). Its `bundleWGPU` option ships prebuilt **Dawn** libraries and exposes WebGPU to the **main process** with a native surface composited into the webview — *"available in the Cottontail and Bun runtimes only"*. **For an existing `navigator.gpu` app that is a rewrite of the rendering host, not a port.** Its actual `navigator.gpu` answer is `bundleCEF: true`, i.e. bundling Chromium — which is Electron's trade with a less-supported toolchain.
- **Neutralino has an odd escape hatch worth knowing about**: a `chrome` mode that runs the app inside an installed Chrome/Chromium/Edge in app mode, erroring if none is found. That gets WebGPU on Linux at the cost of requiring the user to have a Chromium browser — and of not really being a native shell.
- **Bundling Chromium into Tauri is requested (tauri#14963) and not available.** `tauri-runtime-verso` (Servo) is an official experiment, explicitly *"not as feature rich and powerful as the current backends"*, and **Servo's own WebGPU is behind a flag and work-in-progress**. Not a path. **Sciter and Ultralight: unknown** — no primary source was reachable, and neither is a Chromium, so neither is a plausible host for this app. I am reporting them as unknown rather than guessing.

### 9.6 What this means for the decision, without making it

**If Linux is in scope, the system-webview shells are eliminated — not deprioritised, eliminated.** That reduces the "lightweight vs Electron" question to a much smaller one: *is Linux in scope, and is macOS 26 an acceptable floor?*

- **Linux in scope** → Electron (or a CEF-based shell, which is Electron's trade under a different name), with its Linux GPU coverage tested on target hardware first.
- **macOS + Windows only, and macOS 26+ acceptable** → Tauri/Wails/Neutralino become genuinely viable, and the usual arguments for them apply.
- **Staying a browser app** → costs us Syphon/Spout permanently (§4.5), keeps the helper process and its LNA/Safari caveats (§3.2), and keeps everything else in this document intact.

**Two things to test on hardware before committing to anything, because they are the only unresolved facts and both are cheap to settle:**

1. **Does Electron on Linux actually get an adapter** on the target GPU and display server? Unconfirmed since Chromium 144.
2. **Is Safari 26 / WKWebView WebGPU Apple-Silicon-only, or does it work on Intel Macs on Tahoe?** Several secondary blogs claim Apple Silicon only; **no primary source confirms it**, and WebKit's own Bugzilla carries WebGPU test bugs tagged `[macOS x86_64]`, which suggests otherwise. It may be a conflation with Firefox's genuinely documented Intel-Mac gap. **Unresolved — do not assert it either way; test on an Intel Mac if any user has one.**

---

## 10. Measurements

Run on this machine (darwin 25.3.0, Node v24.11.1), 2026-09-02. **These are the only numbers in this document I produced myself; everything else labelled `[doc]` is read, not run.**

**What was measured:** this repo's own `createLoopbackWebSocketServer` (`src/mcp/loopback-ws.ts`) — the exact server a device bridge would generalise — echoing messages to Node's built-in `WebSocket` client over `127.0.0.1`. Round trip means send→echo→receive, so it carries the payload **twice** and includes the JS-side string encode/decode on both ends. Warm-up iterations discarded. Scripts are in this session's scratchpad, not in the repo.

```
CONTROL (one MIDI CC as JSON, echoed)
  payload 133 B   n=2000
  mean 0.061 ms   p50 0.053 ms   p95 0.105 ms   max 0.807 ms
  => ~16,500 round trips/s

FRAME (1920x1080 RGBA, base64 inside JSON, echoed)
  payload 11,059,226 B   n=30
  mean 118.693 ms   p50 117.594 ms   p95 136.767 ms   max 142.873 ms
  => ~8 round trips/s

FRAME (same pixels as raw text, no base64, echoed)
  payload 8,294,400 B   n=30
  mean 77.385 ms   p50 77.373 ms   p95 90.919 ms   max 98.568 ms
  => ~13 round trips/s

RAW TCP loopback, same 8,294,400 B echoed, node Buffers, no framing
  mean 4.863 ms
  => ~206 round trips/s, 3.4 GB/s both directions
```

**What these numbers license:**

- **Control-rate data over loopback is a solved problem with four orders of magnitude of headroom.** A frame at 60 fps is 16.6 ms; one MIDI event costs 0.061 ms round trip and a device feed is one-way, so the real per-event cost is lower still. Any argument that a helper process is "too slow" for MIDI/OSC/DMX is wrong, and this is the measurement that closes it.
- **Per-frame framebuffers over the *current* transport are not viable** — 119 ms is 7 frames at 60 fps.
- **…but the reason is the text codec, not the loopback.** Raw bytes over plain TCP do the same work in 4.9 ms. **So "a browser app cannot move pixels to a local process fast enough" is FALSE as a general claim**; what is true is that *this server, as written, cannot*, by an explicit design choice that was correct for its original job.

**What these numbers do NOT license, and I want this stated because it is the easy overclaim:** none of this measures **getting the pixels off the GPU**. A `readback` of 8.3 MB per frame is a separate and probably larger cost, it stalls the pipeline, and this repo counts readbacks as an invariant precisely because they are expensive (§V7, and `HeadlessRenderResult.readbacks` exists to assert playback adds none) **[code]**. **Any future NDI/Syphon-out design is bounded by GPU readback first and the socket second.** I did not measure readback and no claim here rests on it.

---

## 11. Proposed SPEC material

**SPEC.md was not edited — it is the orchestrator's.** These are proposals with numbers left blank; adopt, renumber or reject.

### 11.1 Proposed invariants

- **§V-io-1 — an external value enters through `channels`, never through a new driver closure.** MIDI, OSC, DMX and anything else numeric publish into `ValueEvaluateContext.channels`, the seam `analyze` already uses. A node cannot tell live from replayed, which is what makes replay honest — and a fourth per-frame closure on the frame driver would have to be recorded, replayed and gated separately for every protocol. One seam, N drivers. (§T654, §T431, §T661)

- **§V-io-2 — a device node publishes at its declared REST values when the device is absent, never zeros and never nothing.** §V353 established all-zeros for silence *because a missing feature set would dangle every driven parameter*. A control whose rest is centre must rest at centre, or "unplugged" reads as "hard left". Absence is a *value* plus a *diagnostic naming the device*, never a stall and never a load failure. (§T715, §V353, §V359)

- **§V-io-3 — "no device" and "no API" are different sentences and the UI must say which.** §V359's rule applied to devices: an absent MIDI port and a browser with no Web MIDI produce the same empty picker and require different actions from the user. On Firefox a site cannot distinguish user-denial from missing-add-on at all, so the message there must say *that*, not guess. (§V359, §V469)

- **§V-io-4 — every device node is `external-live` and no example ships one without an understudy.** The `NODE_REPRODUCIBILITY` gate forces the classification; §V476 forbids an example whose first frame asks a permission, and Chrome has prompted for *all* Web MIDI since 124. So a gallery example with a live device is a `valueSwitch` whose default branch is synthetic and whose second is the device — §V411's understudy, which also keeps the device node in the compiled plan and therefore in the gate. (§V329, §V411, §V476, §V363)

- **§V-io-5 — the bridge never transmits to a destination the document did not name.** The MCP bridge let an agent drive Loom; a device bridge lets Loom reach the network. Egress targets are document state; no wildcard destination, no broadcast by default. This is the one genuinely new exposure the generalisation creates and it should be closed by construction, not by care. (§T458, §T921)

- **§V-io-6 — a bridge-fed channel carries an arrival time and can say it is stale; a page-native one does not need to.** A MIDI message read at the next frame boundary is at most one frame old by construction. A value that crossed a socket from a process that may have stopped is not, and §V202 (rAF clamped to ~1 Hz in a background tab) makes the stall case ordinary rather than exotic. Do not build an age display for the first; do not omit it for the second. (§V329, §V202)

- **§V-io-7 — an OSC address is untrusted text used as a channel name.** Cap the published channel set, reject or escape the `:` that collides with `name:channel` addressing, and never resolve a device-supplied name as a node reference or a path. Say so loudly when the cap is hit rather than dropping addresses silently. (§V469, `bridge-protocol.ts:52`)

### 11.2 Proposed tasks, in build order

1. **Device channel seam.** Publish external device values into the live `channels` extras (`use-value-graph.ts:160`) and add the harness twin `deviceChannels?: (frameIndex) => Record<string, number> | null` beside `audio` and `pointer`. **Ships with `channelIn` working against it and no new node.** This is the whole foundation and it is small.
2. **`midiIn` + mapping + learn.** Web MIDI, a bag per device, the mapping table in node parameters, learn as an inspector mode. `NODE_REPRODUCIBILITY: external-live`. The absent-device path (§V-io-2/3) is part of this task, not a follow-up.
3. **Device track record/replay.** `feature-track.ts` cloned for device channels, recorder at the seam, harness feed, and the byte-identical replay gate that §T431 established for audio.
4. **Bridge generalisation, OSC in.** A `device` role on the existing protocol, batched-per-frame events, `deviceState` messages, discovery. Reuses every security primitive unchanged (§7.1).
5. **OSC out + MIDI out.** Egress under §V-io-5, sharing the mapping table with the in direction.
6. **WebSocket out.** The whole published channel set as JSON, at a chosen rate.
7. **Art-Net / sACN out.** A driver behind the bridge that already exists by then.
8. **Gamepad in.** A `gamepad` node, bag-shaped, with the actuation caveat in its absent-state copy.

**Sequencing note against §9: items 1, 2, 4, 5, 6 and 8 are page-native and survive any shell decision unchanged.** Only item 3 (the bridge) and item 7 (which sits behind it) are work a shell choice could partly obviate. **So the shell decision does not block this programme and this programme should not wait for it.**

**No §T943 row is proposed** — the shell choice is the owner's and §9 deliberately stops short of recommending. What *is* worth a row is the pair of hardware checks in §9.6 (does Electron on Linux get an adapter; is WKWebView WebGPU Apple-Silicon-only), because both are cheap, both are currently unresolved in public sources, and a decision made without them rests on a blog post.

### 11.3 SPEC corrections found while verifying

- **§T942's citation of §V346/§V421 for the `audioIn`/`mouse` exemption precedent is wrong.** §V346 is about separable regression signatures; §V421 is about spec-row statuses rotting. The exemption precedent is **§V476 + §V411 + §V353 + §V363**, and the enforcement mechanism is `src/domain/render/reproducibility.ts` with `NODE_REPRODUCIBILITY` and `nonReproducibleRenderWarning`.
- **§T942 cites §T504/§T508 as "audio record/replay".** They are E24's swappable audio source and `valueSwitch`. The record/replay rows are **§T431** (audio) and **§T661** (pointer).
- **§T942's framing (3) describes `pointer?: PointerSource` as an optional closure on the frame driver.** It is **required** on `FrameDriverOptions` (`frame-driver.ts:24`); only `useFrameLoop`'s is optional. And **`inference?` is not on the frame driver at all** — it exists only on the headless harness; live inference runs through `useModelInference` and reaches the graph as a published channel.
- **Any row citing `webkit.org/status` should be updated** — that page is retired and now points readers at MDN/caniuse.

---

## 12. What I did not verify, and what would change my mind

Listed because the brief asked for it and because three stale-confident claims this week is the reason it asked.

1. **I did not run any of this against a real device.** No MIDI controller was plugged in, no OSC was sent, no browser was opened. Everything about Web MIDI's behaviour here is documentation.
2. **I did not measure GPU readback**, which is the term that probably dominates any pixel-output path (§10). Every latency claim in this document is about the socket and says so.
3. **The Safari HTTPS→loopback mixed-content block rests on a WebKit bug whose last substantive comment is from 2023** **[doc]**. It is the staler of the two Safari findings. Re-check before writing user-facing copy that depends on it.
4. **Chrome's LNA/WebTransport milestone is contested** between the Chrome 147 release notes (which mention only WebSockets) and a secondary source claiming both. It does not affect the recommendation, since WebTransport is not recommended.
5. **The WICG LNA spec defines two permission names (`local-network`, `loopback-network`) while Chrome implements one (`local-network-access`)**. Anyone writing a feature detect must check the implementation, not the spec.
6. **Firefox's Web MIDI add-on mechanism** — that the add-on has been auto-created since Firefox 107 came from search snippets rather than a fetched page. Medium confidence.
7. **I did not design the proxy path for subscriptions** (§7.5). Forwarding a long-lived push stream through `bridge-proxy.ts` is more than forwarding request/response, and the fallback if it is awkward is stated rather than solved.
8. **Nothing in §9 was run on hardware.** Two facts there are explicitly unresolved and both are cheap to settle: whether **Electron on Linux** actually returns a WebGPU adapter (no confirmation since Chromium 144, and the last tracker reports are negative), and whether **Safari 26 / WKWebView WebGPU is Apple-Silicon-only** (claimed by secondary blogs, contradicted by WebKit's own `[macOS x86_64]` test bugs, confirmed by no primary source). **Do not assert either in a SPEC row on my word.**
9. **Whether a `SharedArrayBuffer` can back a numpy array with no copy is undocumented**, and the "no" in §8.3(B) is a chain of inference from four separately-verified statements, not a documented fact. A twenty-line experiment settles it if it ever matters.
10. **Sciter and Ultralight are reported as unknown**, not as unsuitable. No primary source was reachable for either.

**What would change the ranking:**

- **If the owner's real need is video out rather than control I/O**, the whole ranking inverts and §4.6's NDI/Syphon deferral becomes the main question instead of a footnote. The ranking assumes "feed into others" mostly means *values*, because that is what a VJ chain and a studio chain move between tools most often — but the owner said *"feed into others or pull from others or both"* without saying what flows, and I did not ask.
- **If a native shell is chosen (§9)**, items 3, 4, 7 change character completely: OSC, Art-Net and NDI stop needing a bridge and become library calls, and the ranking should be redrawn on the other side of that decision rather than executed and then rewritten. **The ordering advice that follows from this: items 1, 2, 4, 5, 6 and 8 are page-native and survive any shell decision unchanged — build those first regardless.** Only item 3 (the bridge) and item 7 (which sits behind it) are work that a shell decision could partly obviate.
- **If Safari support matters commercially**, MIDI drops out of tier 1 for that platform permanently and the honest-absence UI (§V-io-3) becomes more important than any single protocol.
