# Laser & Oscilloscope — One Vector Display, Two Dressings, and a Real Output

**Date:** 2026-09-02 · **Row:** §T947 (with §T942 the device bridge, §T715 the degradation rule, §T940 the mechanism-not-decoration precedent)
**Deliverable status:** research + plan. No code was written. SPEC.md was not edited.
**Audience:** orchestrator, then the owner.

**Owner's framing:** *"spec out a laser simulation example as well as an oscilloscope simulation example and if necessary new nodes for those but that may not be. research some of the most common lasers and how they are driven, if they can be network driven, and then maybe we implement one node for the most popular one to prove that we can go from visualization to actual driving production hardware just as touchdesigner would do."*

**Owner's second ask, mid-research:** *"points per second and what not and then some way to get from point operators or geometry to a laserable representation with decimation or what not and fastest path (if the thing we're talking to is not doing that on its own)."*

---

## Evidence discipline

Every claim is labelled.

- **[doc]** — read on a vendor, standards or reference page today, cited, believed, not executed by me.
- **[code]** — read in this repository at the cited path.
- **[verified]** — I performed the check myself and am reporting the result of that check.
- **[arithmetic]** — derived here from numbers that are themselves labelled.
- **[forum]** — a practitioner or vendor-employee claim on a forum. A lead, not a fact.
- **[unverified]** — background belief I could not confirm from a source. Treat as a lead.

Where I could not establish something, this document says so rather than guessing. Section 13 is the list of things I could not settle.

---

## 0. Verdict, up front

**Both of the owner's framings hold, and the second one holds harder than stated — the dwell-time fact is not just the physics of the simulation, it is the entire specification of the output stage.** Section 1 gives the evidence, including TouchDesigner's own parameter names, which are a point-by-point restatement of the framing.

**The owner's guess about TouchDesigner is half right and stale.** TD *did* ship an EtherDream CHOP; it is now marked **"DEPRECATED: use the Laser Device CHOP instead"** **[doc]**. The current surface is a **two-node split** — a **Laser CHOP** that plans a point path, and a **Laser Device CHOP** that talks to hardware (EtherDream, Helios, ShowNET) **[doc]**. That split is the single most useful thing this research found, and Section 7 recommends we copy it exactly.

**Recommendation: implement Ether Dream, over §T942's device bridge.** Not because it is the cheapest or the most modern, but because it is the only candidate that can be **built and gated to exact values with no hardware in the room**: a complete public protocol document plus an MIT/Apache-licensed full DAC emulator **[doc]**. Reasons and skip-list in Section 5.

**A finding that partly falsifies the brief's transport premise, and it is good news.** The brief says "a browser page can reach neither, so this rides §T942's device bridge." True for Ether Dream and IDN. **Not true for the Helios DAC, which is USB, and which somebody has already driven from an unmodified browser page over WebUSB** **[doc]**. So there exists a bridge-free path from a pure browser app to real laser hardware. It is ranked second, for reasons in Section 5.3, but it should not be left out of the record.

**On new nodes, the owner's suspicion is *mostly* right but not entirely.** The simulation dressing needs **zero** new nodes — every piece already ships (Section 9). But the path-planning stage the owner asked for in the second message **is** a new node, and it is the important one. Final count: **two new nodes, `laserPath` and `laserOut`**, and one of them writes to hardware, which forces a decision the codebase has so far never had to make (Section 9.3).

**The load-bearing architectural idea, and it is the coordinator's:** the planner is **shared**, not duplicated. The renderer draws the *planned* stream — the actual samples that would go down the wire — so the preview shows real flicker, real corner dots and real blanking artifacts before anything is plugged in. The planner *inserts* dwell for the galvos and *emits* dwell as a per-point attribute for the renderer. **One stage, two consumers, same physics in both directions.** Section 7.

**Safety is Section 8 and it is not negotiable.** The short version: the failsafe must live on the far side of the thing that can fail, arming must never be document state, and we must never describe ourselves as a safety device.

---

## 1. The two framings, verified

### 1.1 "The laser example and the oscilloscope example are the same thing underneath" — **CONFIRMED, with a sharper version available**

The physical claim is uncontroversial and I found it stated plainly in independent places. An analog scope in X-Y mode replaces the timebase with a second input, and *"the electron beam is not swept left to right and top to bottom, but instead steered to points and traces the lines of the displayed image"* **[doc]**. A laser projector's graphics section is an XY galvanometer pair fed by two bipolar analog signals — the ILDA standard defines X as *"a bipolar analog signal whose voltage range is between +10V and –10V"* with Y identical **[doc]**. Both are: two deflection channels, a blanking/intensity channel, colour, and a persistence mechanism (phosphor or eye).

The strongest corroboration is that the reference implementations of the two are *the same program*. The best-known WebGL oscilloscope renderer, **woscope**, draws each pair of samples as a quad and computes intensity by integrating a Gaussian beam along the segment, with the closed form carrying a **`1/(2l)`** factor where `l` is segment length **[doc]**. That is a laser-beam model applied to a CRT. Meanwhile the best-known open laser toolkit stack (`laser-dac`, MIT, Node/TypeScript) ships a **`@laser-dac/simulator`** package described as web-based laser visualisation that *"mimics hardware limitations"* **[doc]** — a scope-style renderer applied to a laser. The two communities converged on one renderer from opposite ends.

**The sharper version, which I recommend we adopt.** The two are not merely the same with different colours. Their real difference is *which stages of the path planner are active*:

- A **scope** has no planner. The beam follows the signal continuously; corners are bright because the beam physically decelerates. Discretisation into samples is our simulation's artifact, not the instrument's.
- A **laser** has a planner, because galvos are mechanical and cannot track an arbitrary signal. The planner *inserts* extra samples at corners so the beam dwells long enough for the mirrors to turn.

So: **the scope is the laser with the planner turned off.** That is a better unification than "two dressings" because it makes the difference a parameter rather than a fork, and it means the two examples exercise the same code path with different settings — which is exactly the property that makes a shared gate meaningful rather than decorative.

### 1.2 "Brightness is a function of dwell time" — **CONFIRMED, and it is stronger than a look-and-feel claim**

Four independent lines of evidence:

**(a) The instrument literature.** In analog oscilloscopes, brightness varies as an inverse function of the slope of the trace, which is a function of beam velocity: the gun emits a constant electron current, so spreading that constant energy over a longer path in the same time reduces the deposited energy per unit length **[doc]**. There is a patent whose entire subject is compensating for it — *XY display transition intensifier*, US 4,755,726 — and its method is to take **the absolute value of the time derivative of the deflection signals** and use it to modulate the Z axis **[doc]**. An engineer patented the correction, which is decisive evidence that the artifact is real.

**(b) The reference renderer's formula.** woscope's per-segment intensity is
`Cumulative(p) = 1/(2l) · e^(−p_y²/(2σ²)) · [erf(p_x/(√2σ)) − erf((p_x−l)/(√2σ))]`
where `l` is segment length and σ is the beam spread **[doc]**. The `1/(2l)` is the dwell-time fact in closed form: **halve the segment length at a fixed sample rate and you double the brightness.** Nick Tasios' independent GPU implementation reaches the same place from the same premise, integrating a Gaussian along the trajectory with the segment travel time in the denominator **[doc]**.

**(c) The laser practitioners say it about their own medium, unprompted.** On point optimisation: *"If you optimize by sending more points nearer the corners and fewer points for the straight lines, the corners will be much brighter and the lines darker, because the beam spends more time on the corners and less time on the straight lines"* **[doc]**. That is the owner's sentence, written by someone describing a side effect they have to manage.

**(d) TouchDesigner's parameter names.** This is the part I did not expect. TD's **Laser CHOP** exposes **`mincornerhold`** and **`maxcornerhold`**, documented as *"Corner point dwell calculated linearly by angle steepness; at 180° yields minimum, at 0° yields maximum"* **[doc]**. TD ships a parameter called *corner hold*, computed from turn angle, whose unit is dwell. The owner's "one fact" is a shipped feature in the reference product.

**Consequence, and it is the design.** A renderer that draws a constant-brightness polyline is not a stylistic choice, it is a *wrong* renderer — it discards the only quantity that carries the medium's signature. And the quantity is free: the planner already knows every segment's length and the output rate, so it knows the dwell exactly. Section 7 makes that the shared seam.

### 1.3 The scan-rate bound — **CONFIRMED, with concrete numbers**

Points per second divided by points per frame *is* the refresh rate; there is no other knob. The industry states it as arithmetic: *"If a graphic contains 600 points: 30,000 ÷ 600 ≈ 50 complete frames per second. Now double the graphic complexity to 1,200 points: 30,000 ÷ 1,200 ≈ 25 complete frames per second"* **[doc]**. The calibration anchor: the **ILDA 30K Test Pattern contains 1,192 points, so at 30,000 pps it displays about 25.2 times per second** **[doc]**.

Exceeding the scanner's budget produces a documented, specific list of artifacts: *"flicker, less stable lines, visible drawing motion, poorer corner definition, reduced apparent brightness"* and, from mechanical lag, *"rounded corners, shrinking graphics, sluggish motion"* plus *"overshoot, ringing, spikes around corners"* **[doc]**. TD's own EtherDream page says the same in one sentence: *"attempting to quickly scan a square over a large area too quickly… may result in very curved corners as the physical components lag behind their target positions"* **[doc]**.

**One caveat worth carrying into any UI copy.** A kpps rating is meaningless without the scan angle it was measured at: *"30 kpps @ 8° ILDA cannot be directly compared to 40 kpps @ 4°"* **[doc]**. If we ever print a pps figure next to a claim about a real projector, it must carry the angle or say nothing.

---

## 2. The landscape

| Device | Transport | Protocol status | Buy? | TD support | Test without hardware |
|---|---|---|---|---|---|
| **Ether Dream 4** | TCP 7765 + UDP 7654 broadcast **[doc]** | **Fully public**, versioned spec page **[doc]** | Yes — X-Laser sells it, PCB or enclosed **[doc]** | **Yes**, Laser Device CHOP **[doc]** | **Yes** — MIT/Apache Rust DAC emulator **[doc]** |
| **Helios / HeliosPRO** | USB bulk (Helios); Ethernet/IDN (HeliosPRO, OpenIDN adapter) **[doc]** | **Open source hw + sw**; protocol readable from SDK source, no standalone spec doc found **[verified — I looked]** | Yes, cheapest of the set **[doc]** | **Yes**, Laser Device CHOP **[doc]** | **No emulator found** |
| **LaserCube / LaserDock** | USB (early), UDP 45456/45457/45458 (WiFi models) **[doc]** | Reverse-engineered / community-documented; vendor GitHub exists, no formal spec found **[verified — I looked]** | Yes | **Not** in the Laser Device CHOP list; vendor ships a separate TD component repo **[doc]** | No |
| **Pangolin FB4 / Beyond** | Via **Beyond** software over a proprietary SDK **[doc]** | Closed SDK, Windows host required | Yes (expensive) | Yes — a separate **Pangolin CHOP** that talks to Beyond, not to hardware **[doc]** | No |
| **ShowNET (Laserworld)** | Ethernet; also Art-Net and DMX512; "ILDA Streaming" over LAN **[doc]** | Vendor ecosystem; no public protocol spec found **[verified — I looked]** | Yes | **Yes**, Laser Device CHOP **[doc]** | No |
| **LaserAnimation Sollinger AVB** | AVB over a low-latency pro audio interface (MOTU, RME, USB2AVB) **[doc]** | Audio-transport based; 24-bit XY and colour claimed **[doc]** | Professional tier | Yes, via audio device **[doc]** | Not meaningfully |
| **Moncha / Showcontroller** | — | **Could not establish.** Searches returned marketing and manuals, no protocol document | — | Not in TD's list | — |
| **IDN (as a target)** | UDP 7255 (IDN-Hello) **[doc]** | **Open standard.** IDN-Stream rev 002, July 2025 — official. IDN-Hello still a **draft dated 2022-03-27** **[doc]** | Via HeliosPRO / OpenIDN adapter / StageMate **[doc]** | Reached *through* the Helios SDK **[doc]** | No |

**Reading of the landscape.** Two devices have genuinely open, documented, buyable, TD-supported protocols: **Ether Dream** and **Helios**. Everything else is either closed (Pangolin), vendor-ecosystem with no public wire spec (ShowNET, Moncha), community-reverse-engineered (LaserCube), or a standard whose discovery half is still a draft (IDN).

**Prior art worth reading before writing any code:** `Volst/laser-dac` (MIT, ~129 stars, Node/TypeScript, explicitly **legacy/unmaintained**, development moved to Rust `laser-dac-rs` and C++ `libera-laser`) **[doc]**. It supports Ether Dream, Helios, Laserdock, LaserCube WiFi, Beyond and EasyLase, **plus a simulator package**, and it is MIT — so unlike the AGPL browser-Helios repo below, we can read it freely.

---

## 3. What TouchDesigner actually ships — the verified answer

The owner's guess: *"I believe TD has an Etherdream CHOP but I am not certain."* **Half right, and stale.**

**What exists today [doc]:**

1. **EtherDream CHOP** — exists, and its documentation page opens with **"DEPRECATED: use the Laser Device CHOP instead."** No deprecation date is given on the page. It took up to five channels: X, Y, R, G, B; parameters Network Address, Network Port (default **7765**), Active, Queue Time/Units, and per-channel scales.
2. **Laser Device CHOP** — the current output node. Supported devices, verbatim: **"EtherDream, Helios, and ShowNET"**. Takes `x`, `y` (−1..1), `r`, `g`, `b`, `i` (0..1), plus optional `user1`–`user4`. Page last modified **3 November 2025**.
3. **Laser CHOP** — **the path planner, and a separate node from the output.** Accepts SOP, POP or CHOP, and emits samples at a configurable rate, *"typically 10,000–96,000 samples per second."* Its parameters are Section 6's specification, pre-written.
4. **Pangolin CHOP** — sends frames to **Beyond**, Pangolin's show software, over the Beyond SDK. It does not talk to an FB4.
5. **Helios DAC CHOP** — a device-specific page still exists alongside the generic one.

TD's Lasers overview page names five pathways: EtherDream, Helios (*"also supports IDN devices over Ethernet"*), ShowNET, LaserAnimation Sollinger AVB, and Pangolin Beyond, and states the workflow as: *"a CHOP, POP or SOP defining the shapes is sent to the Laser CHOP which processes the data into streams of samples"* **[doc]**.

**The one line to take away.** TD separates **planning** from **transport**, and the planner is the bigger node. Section 7 says we should do the same, for reasons that are ours and not merely imitative.

**Practical operating advice from the TD community, worth recording because it is a safety-adjacent ergonomic:** set the sample rate to about 80% of the safe scan rate determined for the scanner, and *"if you hear a loud whining noise coming from your galvos you need to reduce the sample rate"* **[doc, community]**. Galvos complain audibly before they fail. That is not something we can detect, but it belongs in our documentation.

---

## 4. The standards

### 4.1 ILDA Standard Projector (the DB25 analog interface) — **Revision 002, July 1999, public download** [doc]

The physical layer everything else eventually becomes. Relevant facts:

- **X± on pins 1 and 14, Y± on pins 2 and 15**, differential, *"because they are more immune to noise"*, bipolar **+10 V to −10 V**.
- **Shutter**: *"A voltage level of 0 volts closes the shutter so that no light is emitted… and a voltage level of +5 volts fully opens the shutter."*
- **Interlock**: pins 4 and 17. *"The purpose of the two interlock lines is so that a projector can tell when it is properly connected to an ILDA-compatible signal source. The projector will put a current or signal into pin 4, and the same current or signal should be present back at the projector when reading pin 17."*

**Why the interlock matters to us, precisely.** It is a **cable-continuity loop**, not a software feature. It means an *unplugged or broken cable* is detected by the projector in hardware. It does **not** mean a crashed sender is detected — the cable is still plugged in when our page dies. Anyone reasoning "there's an interlock, we're fine" has misread which failure it covers. This distinction drives Section 8.2.

### 4.2 ILDA Image Data Transfer Format (IDTF / `.ild`) — **Revision 011, 16 Nov 2014, public** [doc]

The interchange file format for frames, *"for exchanging laser show frames between systems."* Not on our critical path, but worth noting as a cheap future win: an `.ild` **exporter** would let a Loom document be opened in every laser program in existence, with no device, no bridge, and no safety surface at all. It is the lowest-risk possible "we reach the laser world" feature. Not recommended for this row; recommended as a follow-up row.

### 4.3 IDN — the ILDA Digital Network

- **IDN-Stream: Revision 002, July 2025 — an official adopted standard, public download** **[doc]**. UDP; chunked data with config messages and timestamps; carries X, Y, R, G, B and intensity with variable bit depths.
- **IDN-Hello (discovery): still a DRAFT, dated 2022-03-27** **[doc]**. Servers listen on **UDP 7255**; clients discover by broadcast scan **[doc]**.

**Is IDN adopted, or a spec nobody ships?** The honest answer is **"real but thin, and improving."**

*For:* it is a genuinely official, recently revised (July 2025) ILDA standard. The Helios **C++ SDK has been updated with IDN support**, which transitively enables *"any other network DAC using the IDN protocol"* **[doc]**. The **Helios OpenIDN adapter won first place in the 2024 ILDA Fenning Award for Technical Achievement, IDN Standards category** **[doc]**. Modulaser lists IDN as a first-class output **[doc]**.

*Against:* a survey of the field states *"IDN has seen limited adoption in the wild… on the hardware side there are very few options"* **[doc]**. Modulaser's IDN page names exactly **one** recommended device, the HeliosPRO **[doc]**. The Helios **C# library is explicitly not yet updated with IDN support and is "not recommended for general use"** **[doc]** — the reference implementation is itself incomplete. The discovery half is a four-year-old draft.

**And one thing I verified myself rather than read:** **`ilda-digital.com`, the IDN project's own site, currently fails to load with an expired TLS certificate** **[verified — fetch on 2026-09-02 returned `certificate has expired`]**. That is not a technical argument against the protocol, but it is a maintenance signal, and it is exactly the kind of stale-confidence trap this brief asked me to avoid inheriting in the other direction.

**Verdict on IDN: not first. Second or third, and cheap when it comes.** The reason it is cheap is structural: IDN and Ether Dream differ in wire format and transport but consume the *same planned point stream*. Once Section 7's planner exists, an IDN driver is an encoder plus a socket, and the ~90% of the work that is planning and safety is already done.

---

## 5. The recommendation

### 5.1 Implement: **Ether Dream, over §T942's device bridge**

**Reasons, in order of weight:**

1. **It is the only candidate we can build and gate to exact values with no hardware in the room.** `nannou-org/ether-dream` contains an **`ether-dream-dac-emulator`** crate, MIT/Apache-2.0 dual licensed, whose README states it emulates *"all networking (UDP broadcasting, TCP listening, TCP streaming) and the full set of state machines within the DAC"* **[doc]**. There is also a Wireshark dissector **[doc]**. For a codebase whose entire culture is exact-value Dawn gates and mutation-tested assertions, a bit-accurate device simulator is not a convenience, it is the difference between a testable feature and an untestable one. **No other candidate offers this.**
2. **The protocol is fully public, complete and precise.** Ports, the broadcast struct, both state machines, every opcode, the 18-byte point struct, every status field, every NAK code (Section 5.5 has the extract). I was able to specify the wire format in this document from the vendor's own page in a single fetch.
3. **It has the best-documented safety semantics of the set** — an explicit Emergency Stop command, a Clear E-Stop command that can *refuse*, a defined Idle state (*"all analog outputs are at 0v"*), an underflow flag, and — the important one — a documented **"Emergency stop occurred due to loss of Ethernet link"** condition **[doc]**. Section 8 leans on all of these.
4. **It exercises §T942's bridge and proves it for a second protocol family**, which is the strategic point of doing this at all. It is a concrete, shipped driver for a plan that currently has none.
5. **It is buyable now.** Ether Dream 4 is current, sold by X-Laser through multiple AV distributors, board-only or enclosed, and *"fully software-compatible with previous Ether Dream models"* **[doc]**.
6. **TD's original laser CHOP was Ether Dream, and it remains in the current supported list** **[doc]** — so we are not choosing an oddity.

**The honest cost:** it needs the bridge, and the bridge is unbuilt work in §T942. Section 12 argues that the laser path is nonetheless the *cheapest possible* first bridge driver, because of an arithmetic result about bandwidth.

### 5.2 Second, and buy it too: **Helios over WebUSB**

**This is the finding that partially falsifies the brief's transport premise and it deserves its own paragraph.** Helios is USB, not network. `dinther/helios_dac-for-browser` is a **WebUSB implementation that drives a Helios DAC from an unmodified browser page**, with a live demo, multi-device frame-synced output, and no native helper beyond a Windows driver step **[doc]**. So **a pure browser app can drive real production laser hardware with no bridge at all** — which, for §T715's "we are a browser app and that fact partitions everything", is a genuinely notable exception in our favour.

Known constraints **[doc]**: Chromium only (WebUSB is *"not Baseline… does not work in some of the most widely-used browsers"* — no Firefox, no Safari), secure context required, a permission prompt per device, and on Windows the user must install a **WinUSB driver via Zadig**. Available in workers.

The device: VID `0x1209`, PID `0xE500`, bulk endpoints `0x02` out / `0x81` in; `HELIOS_MAX_POINTS 0xFFF` (4095 per frame), `HELIOS_MAX_PPS 0xFFFF`, `HELIOS_MIN_PPS 7`; point struct is 12-bit XY, 8-bit R/G/B/I **[doc, from the SDK header]**.

**Two cautions.** The reference browser implementation is **AGPL-3.0** — we must not copy from it; we may cite its existence as proof and work from the MIT `laser-dac` and the open SDK header instead. And it has 3 stars, so it is an existence proof, not a dependency.

**Why second rather than first:** no emulator, so the encoder would be gated only against hand-written byte vectors and never against a state machine; Chromium-only cuts our audience; and the Windows driver step is a support burden. **But it is the cheapest hardware of the set and needs no helper process, so if the owner is buying one device to see light this month, buy a Helios *and* an Ether Dream — they are cheap relative to a projector, and Section 7's architecture makes the second driver a small fraction of the first.**

### 5.3 Skipped, with reasons

- **Pangolin FB4 / Beyond — skip, and it is not close.** The TD integration talks to **Beyond**, a paid Windows show-control application, over a proprietary SDK **[doc]**; it does not talk to an FB4. To match it we would need to ship a Windows-only dependency on commercial software we cannot test against and whose protocol we cannot read. It is also the one system that already does its own planning and safety masking, so it would consume our planner rather than use it. **Skip permanently for direct output; revisit only if someone wants Loom to *feed* Beyond, which is a different, easier feature.**
- **LaserCube — skip for now, but it is the natural third.** The protocol is well enough understood in public to implement (UDP: **45456** alive/discovery, **45457** command, **45458** data; commands including `0x80` set-output and `0xa9` sample-data; points as five little-endian `uint16` in `0x000–0xFFF`, ~140 points per datagram to stay under MTU) **[doc]**. But this is a community gist, not a vendor specification; it is not in TD's Laser Device CHOP list; and it is UDP, so it needs the bridge anyway. Once the bridge and planner exist it is a small encoder. Popular with creative coders, so worth doing eventually.
- **ShowNET / Moncha / Showcontroller — skip.** TD supports ShowNET, so it is legitimate, but I **could not find a public wire protocol specification for either** despite looking; the ecosystem is vendor software plus Art-Net/DMX. Art-Net control of a laser is a *lighting-desk* interface (intensity, base colour, size, offset over DMX512 **[doc]**) — it is not vector output, and conflating the two would be a mistake. If we later want Art-Net, §T942 already ranks it (#7) as a lighting feature, and it should stay there.
- **LaserAnimation AVB — skip.** Requires professional AVB audio hardware and a wholly different transport family (samples as audio channels). High ceiling, wrong first rung.
- **IDN — not first, cheap later.** Section 4.3.
- **The ILDA DB25 analog interface — not applicable and worth saying why.** We are software; we cannot emit ±10 V. Every path we take reaches DB25 *through* a DAC. The standard matters to us only as the thing that defines what a DAC must produce, and for the interlock/shutter facts in Section 4.1.

### 5.4 What we would ship, concretely

Two examples and two nodes:

- **`E-Scope` — an X-Y oscilloscope.** Two waveforms into the deflection channels, phosphor green, persistence decay, bloom. Planner in "resample only" mode. Zero device surface. Fully deterministic, gateable like any other example.
- **`E-Laser` — a laser projector simulation with a real output path.** Same planner at full strength, laser dressing (beam divergence, per-vertex hot dots, blanking transitions visible as faint travel), plus a disarmed `laserOut`. Renders identically with or without hardware.

### 5.5 The Ether Dream wire, as researched (so implementation does not re-derive it) [all doc]

- **Discovery:** UDP broadcast to the LAN broadcast address, **once per second**, on **port 7654**. Struct `j4cDAC_broadcast { uint8 mac[6]; uint16 hw_revision; uint16 sw_revision; uint16 buffer_capacity; uint32 max_point_rate; dac_status status; }`. **`buffer_capacity` and `max_point_rate` are device-reported — do not hardcode either.**
- **Control:** TCP **7765**. **One host at a time**; a second connection is rejected.
- **Commands:** Prepare `p` (0x70), Begin `b` (0x62), Queue Rate Change `q` (0x74), Write Data `d` (0x64), Stop `s` (0x73), **Emergency Stop `0x00` or `0xFF`**, **Clear E-Stop `c` (0x63)**, Ping `?` (0x3F). All commands are answered.
- **Responses:** ACK `a` (0x61); NAK-Full `F` (0x46); NAK-Invalid `I` (0x49); **NAK-Stop-Condition `!` (0x21)** — "the emergency condition persists".
- **Point:** `dac_point { uint16 control; int16 x; int16 y; uint16 r,g,b,i,u1,u2; }` = **18 bytes**, little-endian, packed, no padding, full scale = 65535. `control` bit 15 pops a queued rate change.
- **Status:** `dac_status { uint8 protocol, light_engine_state, playback_state, source; uint16 light_engine_flags, playback_flags, source_flags, buffer_fullness; uint32 point_rate, point_count; }`.
- **States:** light engine 0 Ready / 1 Warmup / 2 Cooldown / **3 E-Stop**; playback 0 Idle / 1 Prepared / 2 Playing.
- **Idle means dark:** *"No output is generated; all analog outputs are at 0v, and the shutter is controlled by the data source."*
- **Playback flags:** bit 0 shutter (0 closed / 1 open); bit 1 *"Underflow. 1 if the last stream ended with underflow, rather than a Stop command"*; bit 2 e-stop occurred during stream.
- **E-stop triggers:** *"either by an E-stop input on the DAC, an E-stop command over the network, or a fault such as over-temperature"*, and there are flags for *"Emergency stop occurred due to loss of Ethernet link"* and *"Emergency stop input to projector is currently active."*

---

## 6. The path-planning stage — points per second, decimation, and the fastest path

### 6.0 Who does this today — **verified, and the answer is: the software, always**

The owner's parenthetical — *"if the thing we're talking to is not doing that on its own"* — is the right question, and the answer is unambiguous for every device we would ship.

- **Ether Dream does no planning.** Its entire protocol surface is "here is a buffer of `dac_point`s, play them at `point_rate`" **[doc]**. There is no interpolation, no dwell, no reorder, no decimation anywhere in the specification. It is a clocked FIFO into a DAC.
- **Helios does no planning.** `WriteFrame(points, count, pps, flags)` with flags limited to start-immediately / single-mode / don't-block **[doc]**.
- **LaserCube does no planning.** `CMD_SAMPLE_DATA` carries raw XY/RGB samples **[doc]**.
- **Pangolin's Beyond does do the planning**, because it is a full show program rather than a DAC — and TD reflects this exactly, by routing geometry to the **Pangolin CHOP directly instead of through the Laser CHOP** **[doc]**. That contrast is the proof.
- **The community says the same, and says it is the hard part:** *"the biggest problem in developing support for laser DACs has been in developing the secret sauce point optimization algorithms that most pro laser show software companies keep close to their heart"* **[forum]**.

**So the owner's parenthetical resolves to: it is not doing that on its own, and this stage is the substance of the row.** It is also the part with the most residual value — the planner is reusable for `.ild` export, for IDN, for LaserCube, and for the simulation, forever.

### 6.1 The frame budget, and why it must be on screen

`points per frame = points per second ÷ frames per second`. Exceeding it does not error; the frame simply takes longer, and the refresh rate falls until it flickers. At **30 kpps and 60 fps the budget is 500 points**; at 30 kpps and 30 fps it is 1,000; the ILDA 30K test pattern's 1,192 points refresh at **25.2 Hz** **[doc]**.

**Design rule: never clamp, always report.** Truncating a frame to fit a budget produces a partially-drawn image, which is a worse failure than flicker and is invisible to the author. Instead the planner publishes, as channels the graph can read and the UI can show:

- `pointsPerFrame` — what the plan actually costs
- `budget` — pps ÷ current fps
- `effectiveRefreshHz` — pps ÷ pointsPerFrame, **the honest refresh rate**
- `blankFraction` — share of samples spent dark (the travel tax; the target of Stage 2)

and raises a visible diagnostic when `effectiveRefreshHz` falls below a flicker threshold. This is the same shape as the readback budget already in the codebase (`src/runtime/telemetry/readback.ts`, §V185) **[code]**: a resource the user spends, priced and shown, not silently rationed.

**And because the simulation renders the planned stream (Section 7), a budget overrun is visible as flicker in the preview, not only as a number.** The number explains what the eye already noticed.

### 6.2 The pipeline

Stages, in order. The order is load-bearing and two of the orderings are traps.

**Stage 1 — Path extraction.** Ordered polylines out of the input. The codebase already carries the needed structure: `PointTopology = "points" | "lines" | "triangles"` (`src/domain/types/ports.ts:32`) **[code]**, and a `pointTopology` node that produces it. Disjoint runs become separate paths. A path is *closed* if its last point coincides with its first, which matters for Stage 5.

**Stage 2 — Path ordering (minimise blanked travel).** Blanked travel is pure cost: samples spent moving with the beam off, contributing nothing but consuming budget. Reordering the paths and choosing each path's direction reduces it.

**Recommendation: greedy nearest-neighbour over path endpoints, followed by a bounded 2-opt pass with a fixed iteration cap.** Reasons for stopping there:
- The instance is small. Tens of paths, not thousands. NN + limited 2-opt gets most of the available win.
- **It must terminate in a fixed budget.** This runs every frame. An anytime heuristic with a hard cap is correct; an exact solver is not.
- **It must be deterministic.** This is a repo-specific constraint the general laser literature does not face: our examples are gated by exact-value comparison, so the planner must be seed-free with ties broken by input index. A randomised-restart heuristic would make every downstream gate non-reproducible. *This constraint should be written into the node's docblock, because it is the kind of thing a later optimisation pass would innocently break.*
- Full TSP is not warranted and, for the closed-path variant with direction choice, is not even the right formulation.

Notably, **ofxIlda — the best-known open ILDA library — explicitly does not do this stage**: *"it doesn't do any re-ordering of the points or Polys"* **[doc]**. So implementing it is a genuine (small) differentiator, not table stakes.

**Stage 3 — Decimation, with corners protected.** Remove points that carry no information — collinear runs, dense sampling on straight sections.

**Recommendation: angle-gated Douglas–Peucker.** Plain Douglas–Peucker is close to correct already, since it keeps the point of maximum perpendicular deviation and so tends to keep corners. But "tends to" is not a guarantee at low epsilon-to-scale ratios. So: first mark every vertex whose turn angle exceeds a threshold as an **unremovable anchor**, then run DP independently on each run *between* anchors. Epsilon is expressed in projector units (a fraction of full deflection), not pixels, because that is the unit the hardware works in.

**Trap 1, and it is the important one: decimate BEFORE interpolation, never after.** Stage 4 inserts points to control beam velocity. Running DP afterwards deletes exactly those points — they are collinear by construction — and silently undoes the work. The pipeline order is not a style preference.

**Stage 4 — Interpolation / max-step resampling.** Insert intermediate points so no consecutive pair is further apart than a maximum step. This is what bounds galvo velocity, and it is why a long line needs *more* points, not fewer.

TD names both halves of it **[doc]**:
- **`stepsize`** — *"The distance each x,y can change while outputting color"*
- **`bstepsize`** — *"The distance each x,y can change while not outputting color (blanking)"*

Two thresholds because nobody sees the blanked move, so it may be traversed faster — but not infinitely faster, since the mirrors still have to physically arrive, and arriving with residual velocity is what produces the overshoot spike at the start of the next lit stroke.

**The owner's stated symptom is exactly right and worth recording as the acceptance criterion for this stage:** without added intermediate points, a long line reads *bright at the ends and dim in the middle*, because the endpoints are where samples exist and the middle is traversed ballistically. If our simulation shows that when interpolation is off and doesn't when it is on, the stage is working.

ofxIlda does this stage by default — *"it uniformly resamples your shapes so you don't have to"* **[doc]**.

**Stage 5 — Corner dwell and anchor points.** Repeat the vertex at corners so the mirrors settle before the beam turns.

**Recommendation: copy TD's formulation, because it is simple, published, and matches the physics.** Hold count is a linear function of turn angle between a minimum and a maximum: TD's `mincornerhold`/`maxcornerhold`, *"calculated linearly by angle steepness; at 180° yields minimum, at 0° yields maximum"* **[doc]** — i.e. a straight-through vertex gets the minimum and a full reversal gets the maximum. TD additionally allows a **custom curve** (`cornerholdchop`) and per-point overrides; we should ship the linear version and leave the curve as a later parameter.

Also from TD **[doc]**: `starthold`, *"the time in ms the Laser should wait at the first point"*.

**Trap 2: this stage is where the two halves of §T947 meet.** The dwell we insert here is the dwell the renderer reads out in Section 7. Insert it in a place the renderer cannot see and the preview stops being honest.

**Stage 6 — Blanking transitions.** A blanked move needs points at both ends, not just in between: the beam must be *off* before the galvos start moving (or you draw a tail), and the galvos must have *arrived and settled* before the beam comes on (or you draw a leading spike). TD parameterises all four independently, in milliseconds — `postblankoff`, `bstepsize`-governed travel, `preblankon`, and their mirror pair **[doc]**. At a fixed output rate, milliseconds are a point count.

ofxIlda inserts blanking automatically between polygons and duplicates endpoints, with a default of *"around 30x"* repeats **[doc]** — a concrete starting number, and one that shows how expensive this stage is against a 500-point budget. **Two blanked moves at 30 repeats each is 12% of a 500-point frame spent on nothing visible.** That is precisely why Stage 2 (ordering) pays for itself.

**Stage 7 — Colour delay.** Real projectors have a fixed latency between the XY signal reaching the galvos and modulation reaching the diodes. TD exposes `colordelay` in ms and `interpcolors` for interpolation between points **[doc]**. Implementation is a shift of the colour channels by *n* samples relative to XY. Default 0, author-settable, per-projector.

**Stage 8 — Budget accounting.** Section 6.1. Report, never clamp.

**Stage 9 — Range and safety clamp.** Section 8. **Duplicated on the native side**, because a clamp that lives only in the page is a clamp that a page crash removes.

### 6.3 What "fastest path" means, and a caution

The owner's phrase invites a TSP reading. Two things to hold apart:

1. **Fewest wasted samples** — Stage 2, ordering. Real, worth doing, bounded heuristic.
2. **Fastest traversal in physical time** — this is *not* purely a path-length problem, because the cost of a move depends on the galvo's state entering it, and the corner-dwell cost depends on the turn angle at the junction. A tour optimised for Euclidean length can be *slower* in samples than a slightly longer tour that makes gentler turns.

I am **not** recommending we model that. It is a research problem, the pro packages treat their answers as trade secrets **[forum]**, and the honest engineering position is: optimise blanked distance (cheap, understood, most of the win), measure the sample cost of the result, and show the author the number. **If we ever claim "optimal", we will be wrong.** Say "shorter", show `blankFraction`, and let the author judge.

---

## 7. One planner, two consumers — the architecture

This is the coordinator's framing and I think it is the strongest argument in the row for building any of it.

```
  pointset (+ topology, colour)
            │
            ▼
   ┌──────────────────┐   status channels ──► pointsPerFrame, budget,
   │    laserPath     │                       effectiveRefreshHz, blankFraction
   │  (Section 6)     │
   └────────┬─────────┘
            │  the PLANNED sample stream — the exact samples
            │  that would go down the wire, carrying per-point:
            │    position, colour, blanked, and DWELL
            │
      ┌─────┴──────────────────────┐
      ▼                            ▼
  RENDER (existing nodes)     laserOut  ──► bridge ──► Ether Dream
  geometry mode:"beam"        (disarmed by default)
  brightness ∝ dwell
  additive → feedback decay
  → threshold/blur/add bloom
      │
      ▼
   what you see
```

**The claim this buys us.** The preview is not an artist's impression of a laser; it is a rendering of the same array of samples the DAC receives. So:

- **Flicker is real.** Overrun the budget and the preview flickers, because the frame genuinely takes longer.
- **Corner dots are real.** They are bright because Stage 5 put five samples there and the renderer divides brightness by segment length, so five coincident samples deposit five times the energy in one place. **Nobody drew a dot.**
- **Blanking artifacts are real.** The faint travel line between shapes appears if and only if the blanking transitions are mistimed, which is the actual failure mode on real hardware.
- **Turning off interpolation really does make long lines dim in the middle.**

**And the inversion the coordinator identified is exact.** The simulator derives brightness *from* dwell; the output stage *inserts* dwell so that galvos can track. One quantity, computed once, read in two directions. That is why the planner emits dwell as a per-point attribute rather than keeping it internal: it is the shared physical fact, and it is the thing that makes this one feature instead of two.

**Where the planner runs, and an honest two-tier answer.**

- **Tier 1, ship first — CPU, analytic input.** The XY signal comes from value-graph expressions or a small parametric evaluator; the planner runs on the CPU; the result is uploaded as a pointset for the renderer and handed to `laserOut`. No readback, no added latency, fully deterministic, gateable to exact values. **Both proposed examples fit in Tier 1.**
- **Tier 2, later — GPU geometry input.** Planning an arbitrary GPU-resident pointset requires reading it back. The mechanism exists (`LoomBackend.readBuffer`, `src/runtime/backend/backend-types.ts:208`, documented as reading the last *completed* frame) **[code]**, it is already metered (`src/runtime/telemetry/readback.ts`, §V185) **[code]**, and it already has a precedent for being one frame late by contract (`analyze`, §V144) **[code]**. So Tier 2 is a known shape at a known price, not an unknown. It should be priced into the readback budget and inherit the one-frame lag rather than stalling.

Being explicit about the tiers matters because it is tempting to design for Tier 2 and then discover the examples never needed it.

---

## 8. Safety

**Preamble, and it must appear in our documentation as well as here.** A laser projector can cause permanent eye injury. Compliance with IEC 60825-1 is a property of the *projector and the operator*, never of the software driving it. **Shaderloom is not a safety device and must never describe itself as one.** What follows is about ensuring that *our bugs* do not create a hazard, and about failing in the safe direction. It does not make an unsafe projector safe.

### 8.1 The physical fact everything follows from

*"If the scanning galvanometers stop moving while the beam is on, all optical power collapses into a single stationary point that is far more dangerous than a moving beam"* **[doc]**. And because *"a deflection system can emit a stationary laser beam in case of a fault, all lasers must be switched off automatically or blanked to avoid increasing the laser class"* **[doc]**.

The real protection is **hardware**: a scan-fail monitor reads the galvo driver feedback and, on detecting stationary axes, *"all modulation lines are switched off within approximately 20 ms"* **[doc]**. ILDA is stricter, asking for shutoff *"within at least 10 milliseconds and preferably within 1 msec"* **[doc]**. That is a hardware loop we are not in and cannot join. Note also that scan-fail monitors have a known weakness — *"they typically only monitor the rate of change of position and do not track the actual position of the beam"* **[doc]** — so they can be fooled. This is another reason not to lean on them rhetorically.

**Our obligation is therefore narrower and completely clear: never be the cause.** A crash, a dropped frame, a NaN, a stalled tab or a closed laptop lid must not leave a beam parked.

### 8.2 The load-bearing rule: **the failsafe must live on the far side of the thing that can fail**

The page is the component that can crash, hang, get throttled by a background tab, or be closed. **A watchdog implemented in the page cannot protect against the page.** Therefore the dead-man timer lives in the **bridge helper**, which is a separate OS process. This is the single most important architectural requirement in this document and it is a *new* requirement on §T942.

Note carefully what the existing protections do **not** cover:

- The **ILDA interlock** (pins 4/17) detects a *disconnected cable* **[doc]**. Our page dying leaves the cable connected. Not covered.
- The **Ether Dream e-stop on Ethernet link loss** **[doc]** covers the DAC losing its *network link*. Our page dying with the helper still connected does not drop the link. Not covered.
- The **Helios firmware watchdog** exists in firmware v3 but is reported *"set to the default 16 seconds"* **[forum, attributed to the creator]** — I could not verify this and it may have changed. Sixteen seconds of parked beam is not a failsafe. **Treat every DAC's own watchdog as absent until measured.**

Every documented device-side failsafe covers a *different* failure than the one we are most likely to cause. That is the finding.

### 8.3 What the output path must guarantee

**G1 — Arming is session state and never document state.** A `.loom.json` cannot arm a laser. Opening an example, or a file from the internet, must never emit light. Arming requires a deliberate human action in the current session and does not survive a reload. This mirrors the bridge's existing posture: the human types a pairing code, and it is *"never in a URL"* (`bridge-protocol.ts`) **[code]**.

**G2 — A native-side dead-man timer.** If the helper does not receive a fresh point block within a short timeout, it independently sends blanking, then Stop, then (Ether Dream) Emergency Stop, without being asked. Timeout should be a small multiple of the frame interval and must be far below any device-side watchdog. **The helper's failsafe fires when the page goes quiet for any reason, including reasons the page cannot report.**

**G3 — Every block ends blanked.** The last samples of every transmitted block carry zero colour and zero intensity at the last position. **Never let the buffer running dry define the output**, because the Ether Dream specification records underflow only as a *flag* and does not state what the output does during it — I looked specifically for this and it is not there **[verified: the protocol page documents the underflow flag and the Idle state, but not the transition]**. Blanked tails make the behaviour ours instead of undefined.

**G4 — Non-finite and out-of-range coordinates blank; they do not clamp.** This is a subtle one and getting it backwards is dangerous. A NaN clamped to zero parks the beam **at the centre of the field at whatever brightness the colour channels hold** — the exact hazard geometry. So: any non-finite or out-of-range X or Y blanks the beam and holds the last *valid* position. Colour is zeroed, not clamped.

**G5 — Software scan-fail: stationary output blanks.** If XY does not change by more than a threshold across a rolling window while colour is non-zero, blank. This is a software echo of the hardware scan-fail monitor and it catches the most likely graph bug (an expression that stops moving). **It must be documented as *not* a substitute for a hardware scan-fail system**, and the UI must not imply that it is.

**G6 — A master intensity ceiling enforced on the native side.** Applied after everything the page sends, in the helper, as the last operation before the wire. A ceiling that lives in the page is removed by any bug in the page. This is the same reasoning as G2, applied to power instead of time.

**G7 — An always-available E-stop while armed.** Reachable by keyboard, visible whenever output is armed, and **it must not depend on the render loop** — a hung graph is precisely when it is needed. It must map to the protocol's real e-stop (Ether Dream `0x00`/`0xFF`) and not merely to "stop sending". Note the protocol allows Clear E-Stop to be refused with NAK `!` while the condition persists **[doc]**; our UI must surface a refused clear rather than silently retrying.

**G8 — Offline, headless and export renders never emit.** This is a real hazard, not a hypothetical: the export path and the GPU gates both *run the graph*, and `examples.gpu.test.ts` renders every shipped example **[code]**. A `laserOut` node reached by a headless render must be inert by construction, not by configuration. Section 9.3 explains why this forces a change to a shared registry record.

**G9 — Rate changes are bounded and monotonic in the safe direction.** A pps change is a change to how fast the mirrors are being asked to move. Raising it beyond a projector's rating is how you break scanners; the community's own advice is to run at *"80% of the safe scan rate"* and to treat audible galvo whine as a stop signal **[doc, community]**. Our rate parameter must be clamped to the device-reported `max_point_rate` from the broadcast **[doc]** and should carry an author-set projector ceiling below that.

**G10 — No audience-scanning affordances, presets, or language.** No "safe" preset, no beam-attenuation-map feature, no copy that implies our output is suitable for pointing at people. ILDA's own guidance places responsibility with *"a trained laser show operator who can use an E-stop"* **[doc]**. We ship a tool for driving a projector, and our documentation says exactly that.

### 8.4 What we refuse to ship without

**G1, G2, G3, G4, G7, G8 and G10 are release blockers.** Without G1 a downloaded document fires a laser. Without G2 a crashed tab parks a beam. Without G3 the output during underflow is undefined behaviour we chose not to define. Without G4 a NaN aims the worst case at the centre of the field. Without G7 there is no way to stop it. Without G8 our own test suite fires the laser. Without G10 we are making a claim we cannot support.

G5, G6 and G9 are strongly recommended and should be in the first release; they are defence in depth rather than the floor.

---

## 9. Nodes

### 9.1 The simulation needs none — verified against the registry

Everything the dressing requires already ships **[code]**:

| Need | Existing mechanism |
|---|---|
| Draw a segment between two samples | `geometry` node, `mode: "beam"` (§T680) — one quad per point spanning `position` → an `endpoint` vec3f attribute, with `taper` and `softness`. Refuses by name if `endpoint` is missing or not vec3f. |
| Brightness ∝ dwell | `{ kind: "map", attribute }` parameter binding — a per-point f32 attribute multiplies the parameter. The planner emits `dwell`; the renderer maps it. |
| Additive light accumulation | `blend: "additive"` on `geometry` and `renderPoints`; *"pairs with Blend: Additive for beams that read as light"* is in the node's own docstring. |
| Phosphor persistence | Three options already exist: `feedback` (ping-pong with `persistence` and `blacklevel`), `cache` (N-frame ring with per-frame taps — the honest choice if we want *true* per-frame layers rather than an exponential approximation), and `renderPoints`' own `accumulate` flag. |
| Bloom | The shipped `threshold` → `blur` → `add` chain (E4, E34). |
| Blanked samples not drawn | The `group` WGSL predicate on `geometry`/`renderPoints`; E34 already argues at length that *dropping* beats *recolouring* for a class that is an absence — which is exactly what blanking is. |
| Flat 2D view | `camera` node, `ortho: true` with `orthoHeight` (`scene.ts:86`) — **[verified: I read the parameter definitions]**. |
| Drive the deflection channels | `lfo`, `valueMath`, `valueFilter`, `constant`, `timer`, `channelIn`, plus expression parameter bindings. |

**So the owner's suspicion holds for the half they were asking about.** The E1-Feedback-Echo and E34-Lidar examples between them already demonstrate every mechanism the scope needs.

### 9.2 The planner is a new node — `laserPath`

It cannot be an existing one, and the reason is structural rather than a matter of effort:

- A `pointKernel` is a per-point map. **The planner changes cardinality** (Stages 3, 4, 5, 6 all insert or delete) and its output length is data-dependent. `pointKernelAdvanced` does have deterministic spawn/kill with scan compaction, so cardinality alone is not fatal — but:
- **Stage 2 is a global reorder** over paths with a direction choice per path. That is not expressible as a per-point kernel at all.
- The value graph cannot carry it either: `ValueChannels = Readonly<Record<string, number>>` (`src/domain/types/node-definition.ts:208`) **[code]**. **A value node can output named scalars and nothing else** — no arrays, no vectors, no buffers. An XY *stream* is categorically not a value-graph object.

`laserPath`: pointset (+ topology, colour) → planned pointset (position, `endpoint`, colour, `blanked`, `dwell`) + status channels (`pointsPerFrame`, `budget`, `effectiveRefreshHz`, `blankFraction`). Parameters follow Section 6.2, named after TD's where TD has a name, because a laser person reading our parameter list should recognise it.

Reproducibility: **`pure`**. It reads a pointset and a clock and returns a deterministic function of them — provided Stage 2's tie-breaking is index-based, per Section 6.2.

### 9.3 The output is a new node — `laserOut` — and it forces a decision the codebase has not had to make

`laserOut`: planned pointset in, nothing out. A sink.

**The decision.** `src/domain/render/reproducibility.ts` defines `Reproducibility = "pure" | "external-live" | "async-cached"` with an exhaustive `NODE_REPRODUCIBILITY` record, gated by a test that fails when a registered node is missing from it **[code]**. Every one of those three values describes **how a node's output depends on the world**. `laserOut` has no output. On that axis it is `pure` — and marking it `pure` would be *correct* and *dangerous*, because it would let a headless export run it (G8).

**The axis the record does not have is "does this node have a side effect outside the render?"** Nothing in the codebase has needed it, because until now every node has been a function of its inputs. This is the first node that *does something to the world*.

**Recommendation: do not overload `Reproducibility`.** Add a separate, explicit declaration — a `sideEffect` / `emitsToDevice` flag on the node definition, with its own exhaustive record and its own gate, and a hard rule in the offline/headless path that such a node is inert. Two orthogonal properties deserve two records; conflating them would make the reproducibility gate mean two things and would let a future author satisfy it accidentally.

This is a small change but it is a **spec-level** one and belongs to the orchestrator, not to an implementer. It is the one place where §T947 pushes on shared architecture.

### 9.4 Possible third node, and an argument for not building it yet

An `xyGenerator` producing a sample stream from two parametric expressions would make the scope example trivial to author. **I recommend not adding it initially**: `pointLine` plus a `pointKernel` computing position from `ctx.index` already does it, that is the pattern E34 uses for its aim geometry **[code]**, and a node whose entire body is "evaluate two expressions over an index" is the kind of single-use abstraction the project's own rules discourage. Ship the examples with the existing mechanism; add the convenience node only if authoring proves genuinely awkward.

---

## 10. How the XY path is authored in a graph

**`E-Scope`:**

```
pointLine (N samples)
  → pointKernel        position.x = fx(ctx.index/N, ctx.absTime)
                       position.y = fy(ctx.index/N, ctx.absTime)
                       endpoint   = same functions at index+1
  → laserPath          mode: resample-only (no decimation, no corner hold, no blanking)
  → geometry mode:"beam", blend additive, softness high, brightness ← map(dwell)
  → camera ortho
  → feedback           persistence high, blacklevel near-black   [phosphor]
  → threshold → blur → add                                       [bloom]
  → level              green tint
  → output
```

Deflection is driven by `lfo` / `valueMath` chains into the kernel's uniforms via `pointKernelValueParameters` **[code]** — so the author changes the picture by changing frequencies and phases, which is what an X-Y scope *is*. Fully `pure`; gateable like any other example.

**`E-Laser`:** the same spine, with `laserPath` at full strength, a laser dressing (tighter beam, coloured, divergence via `taper`/`softness`), and a `laserOut` at the end of a branch. The `output` still comes from the render chain, not from the device — **the device branch does not participate in the picture at all**, which is what makes Section 11 easy.

**The authoring insight worth stating.** The graph reads left to right as *signal → plan → beam → phosphor → eye*, which is the physical chain in the same order. That is the property that makes this a good teaching example rather than a demo: the graph is a diagram of the instrument.

---

## 11. A document referencing absent hardware — §T715's rule

§T715: *"an unavailable accelerator must degrade the RATE, never the CONTRACT — the node always exists, always publishes its output type, and a document using it must LOAD and RENDER on a machine without it… and the degradation must be VISIBLE."*

**For a laser this is unusually easy, and the reason is worth stating because it is a design win rather than an accident: the picture was never the device's job.** `laserOut` is a sink with no output. The rendered image comes from the simulation branch. So:

- **With no bridge, no helper and no hardware, `E-Laser` renders exactly the same image it renders with a projector attached.** The device is not in the picture's dependency chain. This is the strongest possible form of the rule — not a degraded contract, an *unchanged* one.
- **`laserOut` always exists and always accepts its input.** It never refuses to load, never errors on a missing device, never turns red in a way that suggests the document is broken.
- **The degradation is visible without being alarming**: a status row reading *"No device — simulation only"*, and status channels (`connected`, `armed`, `pps`, `bufferFullness`, `blocksDropped`) that publish honest values. Following §V329's rule that an async result exposes its staleness, and the ML path's rule that a node with no result reports **no** age rather than zero **[code]**, `bufferFullness` with no device must report *absent*, not `0` — `0` is a legitimate and alarming reading from a real device.
- **A shipped example must not ask for a device on load** (the §V476 family). `laserOut` ships disarmed, and per G1 it cannot ship any other way, because armed is not a saveable state.

**The understudy pattern is not needed here, and that is worth noting explicitly.** For `webcam` and `audioIn`, examples use a `switch` whose branch 0 is a synthetic performer and branch 1 the real device (`relief.ts:203`, and §V687's rule that the understudy must *move*) **[code]**. That pattern exists because those nodes are *sources* — absent hardware means an absent picture. `laserOut` is a *sink*. There is nothing to stand in for. Using a `switch` here would be cargo-culting the pattern past the problem it solves.

---

## 12. What §T942's bridge plan does not cover

**Read state, stated honestly.** `docs/io-integration-plan.md` was **actively being written while I worked** — I read it twice and it changed between reads. At my last read it ended at **§2**, with §§3–11 referenced from the verdict but not yet present. **This gap list is therefore against its §0 verdict table and §§1–2, plus §T942's SPEC text.** Several items may already be handled in the unwritten sections; each is flagged as a question to check rather than a certain omission.

**First, the good news, and it is a real result.** The plan's headline concern for output is that the loopback server *"refuses binary frames by design"* and speaks JSON text only, with base64 inside JSON, costing a measured **118 ms per 1080p RGBA round trip** **[plan, code]**. **The laser path does not care.** Arithmetic **[arithmetic, from the plan's measured figures and the Ether Dream struct]**:

- 30,000 pps ÷ 60 fps = **500 points per frame**
- 500 × 18 bytes = **9,000 bytes per frame**, 540 KB/s
- base64 → **~12,000 bytes per frame**, ~720 KB/s
- 1080p RGBA is 8,294,400 bytes — **922× larger**. Scaling the plan's own 118 ms measurement gives **~0.13 ms per frame**, about **0.8% of a 16.7 ms frame budget**.

**So the laser output path fits the existing text bridge with roughly three orders of magnitude of headroom, and must not be used to justify the binary-transport work.** It is the *cheapest possible* first bridge driver: a real, useful, hardware-touching output that lands entirely inside the transport that already exists. That is a genuinely strong argument for doing this row before the harder parts of §T942.

**Now the gaps.**

1. **No streaming message shape.** `BridgeHostMessage` / `BridgePageMessage` are request/response with a numeric id — `listTools`, `callTool`, `ping` and their results **[code]**. There is **no server-push, no subscription, and no unsolicited device→page event**. A laser needs page→helper at 60 Hz and helper→page status continuously. This is a new message family, not a new tool.
2. **No backpressure or flow control.** Ether Dream is a credit system: every status carries `buffer_fullness`, and a write that does not fit is refused with **NAK-Full `F`** **[doc]**. The frame loop must know how full the device is. Nothing in the plan's model — control-rate scalars in, values out — has a shape for a device pushing back on the sender.
3. **No dead-man / watchdog concept.** Section 8.2. This is the biggest addition and it is safety-critical. Today a page disconnect means "the socket closed"; for a laser it must mean "blank, stop, e-stop, now."
4. **No lifecycle for a stateful, armed, exclusive resource.** The bridge's model is stateless tool calls. A laser is open → arm → stream → disarm → close, with an owner, a timeout, and a defined behaviour on every abnormal exit. Related: **Ether Dream itself permits only one host at a time and rejects the second** **[doc]**, which composes awkwardly with the bridge's own "one page at a time" rule — two independent exclusivity claims that need one story.
5. **No side-effect story for offline and headless.** Section 9.3, G8. The plan is about data entering and leaving a *live* session; it does not address what a node that touches hardware does under `examples.gpu.test.ts` or an export.
6. **No datagram semantics.** For IDN and LaserCube the helper can report only that a datagram was *sent*, never that it *arrived*. The plan's request/response framing implies a reliability UDP does not have. When those drivers land, the protocol needs to distinguish "sent" from "acknowledged" or it will lie.
7. **WebUSB is not in the ranked list as an output path.** §T942 lists WebSerial/WebHID/WebUSB in the deferred bucket. Helios shows WebUSB is a **first-class, helper-free device-output path** — the only one in this document that needs no process at all. It deserves either promotion or an explicit reason for staying down.
8. **The channel seam does not fit this consumer.** The plan's central seam is `channels?: (name) => number | undefined` — scalars **[code]**. `laserOut` consumes a *pointset*. **The laser is the first I/O consumer that does not fit the channel seam**, and the seam it does fit — the readback budget in `src/runtime/telemetry/readback.ts` (§V185) — is not mentioned in the plan at all. Worth reconciling, because "one seam for all I/O" is otherwise a claim the first hardware output falsifies.

Items 3, 4 and 5 are the ones that cannot be deferred, because they are safety.

---

## 13. What I could not settle

Listed rather than guessed, per the brief.

1. **What an Ether Dream actually outputs during buffer underflow.** The specification documents the underflow *flag* and the Idle state, but not the transition. **[verified: I read the protocol page specifically for this and it is not there.]** Mitigated by G3 (always send blanked tails) rather than resolved. Would need measurement on hardware.
2. **The Helios firmware watchdog timeout.** A *"default 16 seconds"* figure appears on a forum, apparently from the creator **[forum]**. Unverified, possibly stale. Treat as absent (Section 8.2).
3. **A typical Ether Dream `buffer_capacity`.** Device-reported in the broadcast **[doc]**; commonly quoted as 1800 points, which I could not confirm. **Do not hardcode it.** If it is 1800, that is 60 ms of buffer at 30 kpps, which sets the jitter tolerance — worth measuring first.
4. **The Helios USB wire packing.** The SDK's `HeliosPoint` struct is 8 bytes with 12-bit XY **[doc]**, but the on-wire bit packing is in the SDK's `.cpp`, which I did not read.
5. **Moncha / Showcontroller protocol.** No public specification found. It may exist behind a login or in a vendor SDK.
6. **When TD deprecated the EtherDream CHOP.** The page carries the notice but no date **[doc]**.
7. **Whether TD's Laser Device CHOP is in stable or experimental builds.** Both a stable and an `Experimental:` documentation page exist for the Pangolin CHOP; I did not establish the release channel for the Laser Device CHOP.
8. **`docs/io-integration-plan.md` §§3–11.** Not yet written at my last read (Section 12).
9. **Nothing here was tested against hardware.** No laser, no DAC, no bridge driver was built or run. Every device claim is documentation.

---

## 14. Summary of what I would propose to build

| # | Item | Why |
|---|---|---|
| 1 | **`laserPath`** — the planner (Section 6) | The engineering core; reusable for every output target and for `.ild` export |
| 2 | **`E-Scope`** — planner in resample-only mode, existing nodes for the dressing | Proves the physics and the shared pipeline with zero device surface |
| 3 | **A `sideEffect` declaration + gate** (Section 9.3) | Safety prerequisite G8; a spec-level change, orchestrator's call |
| 4 | **Bridge additions**: streaming messages, backpressure, dead-man timer, armed-resource lifecycle (Section 12, items 1–4) | Safety prerequisites G2, G6; also generic bridge improvements |
| 5 | **`laserOut` + the Ether Dream driver**, gated against the Rust DAC emulator | The hardware proof |
| 6 | **`E-Laser`** — full planner, laser dressing, disarmed output | The demonstration |
| 7 | *Later:* Helios over WebUSB; IDN; LaserCube; `.ild` export | Each is an encoder against a planner that already exists |

Items 1 and 2 are worth building **even if the hardware work is never approved** — they are a complete, self-contained, fully deterministic example that teaches a real instrument. Item 3 is worth settling early because it is small and everything after it depends on it.

---

## Sources

TouchDesigner: [Laser Device CHOP](https://docs.derivative.ca/Laser_Device_CHOP) · [Laser CHOP](https://docs.derivative.ca/Laser_CHOP) · [EtherDream CHOP (deprecated)](https://docs.derivative.ca/EtherDream_CHOP) · [Lasers overview](https://derivative.ca/UserGuide/Lasers) · [Pangolin CHOP](https://docs.derivative.ca/Pangolin_CHOP) · [Helios DAC CHOP](https://docs.derivative.ca/Helios_DAC_CHOP) · [etherdream-touch-designer (community)](https://github.com/tgreiser/etherdream-touch-designer)

Ether Dream: [Protocol](https://ether-dream.com/protocol.html) · [Developer manual](https://ether-dream.com/manual.html) · [nannou-org/ether-dream + DAC emulator (Rust, MIT/Apache)](https://github.com/nannou-org/ether-dream) · [tgreiser/etherdream (Go)](https://github.com/tgreiser/etherdream) · [Wireshark dissector](https://github.com/alphajbravo/EtherDream-Dissector) · [Ether Dream 4 at B&H](https://www.bhphotovideo.com/c/product/1973534-REG/x_laser_ether_dream_4_laser.html)

Helios: [Grix/helios_dac SDK](https://github.com/Grix/helios_dac) · [SDK header (constants, point struct)](https://raw.githubusercontent.com/Grix/helios_dac/master/sdk/cpp/HeliosDac.h) · [dinther/helios_dac-for-browser (WebUSB, AGPL-3.0)](https://github.com/dinther/helios_dac-for-browser) · [Helios at Bitlasers](https://bitlasers.com/helios-laser-dac/) · [HeliosPRO](https://bitlasers.com/heliospro-laser-dac/) · [OpenIDN adapter](https://bitlasers.com/openidn-network-adapter-for-the-helios-dac/) · [Grix/helios_openidn](https://github.com/Grix/helios_openidn)

LaserCube: [Network protocol gist (s4y)](https://gist.github.com/s4y/0675595c2ff5734e927d68caf652e3af) · [LaserCubeSharp](https://github.com/berkut0/LaserCubeSharp) · [Wickedlasers/Laser_OS_TouchDesigner](https://github.com/Wickedlasers/Laser_OS_TouchDesigner) · [EtherDream vs IDN (vendor blog)](https://www.laseros.com/blog/etherdream-vs-idn-network-laser/)

ILDA & IDN: [ILDA Technical Standards index](https://www.ilda.com/technical.htm) · [ILDA Standard Projector rev 002 (DB25)](https://www.ilda.com/resources/StandardsDocs/ILDA_ISP99_rev002.pdf) · [IDN-Stream rev 002, July 2025](https://www.ilda.com/resources/StandardsDocs/ILDA-IDN-Stream-rev002.pdf) · [IDN-Hello draft 2022-03-27](https://www.ilda.com/resources/StandardsDocs/IDN-Hello-2022-03-27-draft.pdf) · [Understanding IDN (Wireshark traces)](https://ilda.com/resources/Tech/IDN/Understanding-IDN_Wireshark-Traces_v2021-05-26.pdf) · [About IDN](https://www.ilda.com/idn.htm) · [ILDA pinout (Pangolin)](https://pangolin.com/blogs/education/ilda-laser-pinout)

Safety: [ILDA — How to do safe audience scanning](https://www.ilda.com/audiencescanningsafety.htm) · [SafeGuard Pro scan-fail board (EN 60825-1)](https://www.lasershop.de/en/scan-fail-safety-board-safeguard-pro-according-to-60825-1.html) · [Laser show safety guide, IEC 60825-1 classes](https://www.starshinelights.com/blogs/news/laser-show-safety-laser-classes) · [Stage laser safety & audience scanning](https://www.supercanlight.com/stage-laser-safety-dmx-control-guide/)

Path planning & point optimisation: [KPPS guide (points-per-frame arithmetic, ILDA 30K test pattern)](https://www.starshinelights.com/blogs/news/laser-projector-kpps-guide) · [ofxIlda wiki](https://github.com/memoakten/ofxIlda/wiki) · [Laser show blanking guide](https://www.starshinelights.com/blogs/news/laser-show-blanking) · [Preparing ILDA graphics](https://www.starshinelights.com/blogs/news/laser-show-projector-graphics-guide)

Vector-display rendering: [woscope — how to draw oscilloscope lines with math and WebGL](https://m1el.github.io/woscope-how/) · [Nick Tasios — Simulating an XY oscilloscope on the GPU](http://nicktasios.nl/posts/simulating-an-xy-oscilloscope-on-the-gpu.html) · [US 4,755,726 — XY display transition intensifier](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/4755726) · [Keysight — the electron beam in oscilloscopes](https://www.keysight.com/used/us/en/knowledge/glossary/oscilloscopes/what-is-an-electron-beam)

Software landscape: [Volst/laser-dac (MIT, Node/TS, legacy)](https://github.com/Volst/laser-dac/) · [ModulaserApp/laser-dac-rs](https://github.com/ModulaserApp/laser-dac-rs) · [Modulaser IDN output docs](https://modulaser.app/docs/outputs/idn) · [Modulaser Ether Dream output docs](https://modulaser.app/docs/outputs/ether-dream) · [Laserworld ShowNET](https://www.laserworld.com/en/technical-explanations-overview/shownet-as-laser-mainboard.html)

Browser APIs: [MDN — WebUSB API](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API)
