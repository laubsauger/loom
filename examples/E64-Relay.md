# E64 — Relay

A number leaves this document as an OSC message, travels out of the browser through a real UDP socket, comes back in, and drives the picture it was measured from. Both ends are in the one file: the sender transmits to 127.0.0.1, the receiver listens on 127.0.0.1, and the local device helper's own two sockets close the circuit. The strip chart along the bottom draws what was sent in amber and what came back in cyan, so the delay between them is a distance you read off the frame rather than a number somebody tells you.

## Why this file exists

`oscIn` and `oscOut` shipped with a README section each and appeared in **zero** examples. That is T728's failure mode in its purest form — a node type nobody can find because nothing demonstrates it — and it applied to the whole device surface, which had no catalogue presence at all. The owner's ask was direct: *"we need to set up an example for OSC in / OSC out, ideally both in one so that we can demonstrate our capabilities… and maybe the pass through if that's something we're interested in showing."*

## The design decision that makes it runnable by anybody

An OSC example that needs a phone running TouchOSC, or a lighting desk, or a second machine, is an example nobody runs. So both ends are the same machine and the same process: `send1` transmits to `127.0.0.1:9107` and `hear1` listens on `127.0.0.1:9107`. One helper owns both sockets — the ingress socket binds loopback and takes no host at all, the egress socket is the one the OS gives an ephemeral port — so the datagram genuinely leaves this machine's UDP stack and genuinely comes back into it. Nothing is faked and nothing is short-circuited in software.

## A bare round trip proves nothing, so this one transforms

If the graph sent a number and read the same number back, the picture would be a tautology: the value that returns is the value you sent, and a wire that did nothing would look identical. So the number is not arbitrary — it is a **measurement of the picture itself** — and what returns **drives that picture**.

```
wash1(ramp) ------------------------------+
bed1(noise) -> bedclip1(limit) -----------+
gate1(rectangle) -------------------------+-> field1(add) -> dim1(level) -+-> win1(crop) -> meter1(analyze)
sweep1(lfo) -> beam1(circle) -------------+                              |
                                                                         +-> plate1(over) -> out1(output)
meter1 ~~> probe1(channelIn) -> wire1(valueMath) -> send1(oscOut)   [127.0.0.1:9107 /loom/relay]
                                                        |
                                              ~~~ a UDP datagram, out of the page ~~~
                                                        |
hear1(oscIn) [listening on 9107] -+-> ctl1(valueMath) ~~> dim1.brightness
                                  +-> penB1(valueMath) ~~> penb1(circle)
wire1 -> penA1(valueMath) ~~> pena1(circle)
pena1 -> ink1(over) <- penb1 ;  ink1 -> tape1(over) <- roll1(transform) <- hist1(feedback)
tape1 -> plate1 ; panel1(rectangle) -> plate1
```

`meter1` reduces the marked window to the **brightest** luminance inside it; the beam sweeping through the window is what makes that number rise and fall. `wire1` normalises it onto 0…1. `send1` puts it on the wire. `hear1` reads it back. `ctl1` turns it into `dim1`'s brightness, with its output bounds **inverted** — brighter window, higher reading, lower brightness — so the loop is negative feedback and settles instead of running away.

E14 Self-Regulating Bloom closes exactly this loop inside the process, with `channelIn` feeding a proportional controller. **This is that same loop with the wire replaced by a UDP socket**, and the extra latency is the whole demonstration.

## The chart is the latency, drawn

`pena1` (amber, thin) plots what was sent this frame. `penb1` (cyan, thick) plots what has come back. Both draw at x = 0.94 and the whole strip scrolls left, so **x is time** and a feature that appears in cyan some frames after it appeared in amber sits **further to the right by exactly the round trip**.

Two details that are not decoration:

- `roll1` translates by exactly **eight texels** of a 1280-wide frame. A fractional shift resampled a few hundred times turns a trace into fog; an exact texel shift is a bilinear identity, so the history stays a line.
- The strip's x axis is **frames, not seconds** — it is the feedback loop's own step. At 60 fps the trace reads as a smooth curve; drop the frame rate and the same signal draws steeper, because the beam has moved further between two pens that are still eight pixels apart.

The reading's working span is set at 0.075…0.42 against measured extremes of **0.041 and 0.447** across fifteen seconds, so the trace has flat rails top and bottom. That is deliberate: a square-ish edge is the easiest feature there is to line up between two traces.

## What it looks like with no helper, which is the ordinary case

**This is the first example in the catalogue that cannot fully render standalone.** A browser page cannot open a UDP socket — that is the entire reason a local helper exists — so the round trip needs that helper running and paired. The document is built for that state rather than apologising for it:

- **`oscIn` always publishes.** An unheard address falls to its declared Rest, so `hear1` reads **0.420**, `ctl1` reads **1.080**, and `dim1` sits at a fixed, well-exposed brightness. The picture is a picture.
- **The cyan trace goes dead flat** while the amber one keeps moving. One live trace and one straight line is a legible statement that nothing is coming back. It is not a dead frame and it is not a lie that looks like it is working.
- **The reason reaches a surface, and this document draws no text to do it.** With no helper attached, the problems pane carries three rows against these two nodes — one for the send that went nowhere, two for the listeners — each naming the helper and the exact command to start it. That command is spelled in exactly one place in the source (`src/devices/helper.ts`), which is why this page does not repeat it: a second copy is a second thing to go stale, and the app is the surface that should be answering "what do I run?" anyway.

To run the circuit: start the local device helper (the app's problems pane on this document prints the command, and there is a variant that starts the device door alone, with no agent server and no GPU), then paste the pairing code it prints into the Connections section of the agent panel. The helper binds 127.0.0.1 only, so any other OSC sender you point at port 9107 has to be on this machine too.

## There is no default destination, and that is the point

`oscOut` ships with an empty Host and a zero Port. A fresh one transmits **nothing**, and that is a decision rather than an omission: Art-Net's default is a broadcast address, and a build that defaults a destination is a build that puts datagrams on somebody's studio network because a file was opened. Broadcast and multicast addresses are refused by name, on the page's side before a byte leaves and again in the helper, which is the side that owns the socket.

So a document that wants to transmit has to **say where**. This one says `127.0.0.1`, which is the only destination a shipped example is entitled to name: it is this machine, it is the machine the helper is already bound to, and opening the file cannot reach anything else.

## Units, and why the normalise is on the sending side

`wire1` normalises before the send and `ctl1` denormalises after the receive. That is not symmetry for its own sake. What goes on the wire should be in the units the far end expects, because **the far end might not be you**: point `send1` at a lighting desk and 0…1 is what a fader wants, and point any other sender at port 9107 and 0…1 is what this document promises to accept. Both remaps clamp, so a value arriving from anywhere cannot drive the picture past its rails.

Two things the transport does to the number, worth knowing before you go looking for them:

- **OSC 1.0 carries a 32-bit float.** What returns is the f32 rounding of what left, not the same double. Send 0.42 and 0.41999998688697815 comes back.
- **A reading is held, not an event.** The last value received under an address stands until the next one arrives; stop the sender and the picture holds where it was rather than falling back to Rest.

## What is gated, and what is not — precisely

This is the part it would be easy to lie about, so it is written out in full.

**Gated, headlessly, on every run:**

| claim | where |
| --- | --- |
| the two halves name the same port and the same address — the circuit is a circuit | `src/examples/relay-circuit.test.ts` |
| a number the graph derived goes out over a **real UDP datagram** and comes back as itself (f32 rounding asserted, not hidden in a tolerance), and is **not** the Rest value | `src/examples/relay-circuit.test.ts` |
| the returned number reaches `dim1.brightness` through the real expression reader, at the value `ctl1`'s arithmetic says, and differs from the no-helper brightness | `src/examples/relay-circuit.test.ts` |
| `hear1` publishes exactly its declared Rest with no resolver at all — the no-helper picture | `src/examples/relay-circuit.test.ts` |
| every driven channel in the document actually moves when its sources move, `oscIn`'s included | `src/examples/driven-channel-motion.test.ts` |
| UDP bytes → `oscIn` → a driven parameter, across the loopback bridge, from the helper's side | `src/devices/device-bridge.test.ts` |
| `oscOut` sends only what the document configured, honours its Rate, and refuses with no destination | `src/app/use-osc-bridge.test.tsx` |
| the picture: loads, compiles with no diagnostics, replays identically, builds on the mock device and on Dawn, and still looks like its baseline | the ordinary example gates |

**Not gated, and it is not pretended otherwise:**

- **The browser's own leg.** `relay-circuit.test.ts` drives the real value graph and the real UDP sockets, but not the loopback WebSocket between a tab and the helper, and not React. `device-bridge.test.ts` covers that hop from the other side, with the UDP layer stubbed. Nothing runs both at once, and a GPU claim cannot reach either.
- **The latency.** The round trip measured **two frames of a 60 Hz loop** through real sockets and the helper's 16 ms coalescing flush, on a quiet machine. That is a property of the machine, not of the document, so no test asserts it — a gate on that number would be a clock test wearing a correctness test's name.

**The documented manual check**, run against this file on macOS with the device-only helper:

1. Opened with **no helper**: `hear1` published 0.420, `ctl1` 1.080, the cyan trace was flat, and the problems pane carried the three rows described above, naming the helper and the command.
2. **Paired** with the device-only helper: the helper logged the device attachment and bound `UDP 127.0.0.1:9107` — the port this document names — and the two listener warnings cleared.
3. An external OSC sender pushed `/loom/relay` at port 9107: `hear1` moved to **0.583**, `ctl1` to **1.019**, `penB1` to **0.828**, and the picture's exposure and the cyan pen followed. **The ingress half is verified live, in the browser, end to end.**
4. The egress half's last leg — the tab's own `oscOut` datagram completing the circuit inside the app — was **not** observed in that session: the tab was background-throttled to a fraction of a frame per second and its transport had been rewound by an edit, and the pump's rate limiter is keyed on transport time, so a clock that jumps backwards pins it until the clock catches up. Worth knowing if you try this and see the send warning persist: let the transport run past where it was, or reload.

## Motion is not on the loop

`sweep1` is a free-running LFO and `bed1` is a moving 4D noise, so the picture animates whether or not a helper is anywhere near it. That is a requirement rather than a nicety: every headless gate renders this file with no device attached, so an example whose only motion came from the round trip would read as a still to all of them — and, worse, would look broken to anybody who opened it before starting the helper.

Measured through the look instrument's own arithmetic: mean |Δ| linear luma between frame 60 and frame 180 is **0.03841**, the 0.1st-to-99.9th percentile luma span is **0.4071**, and the gallery card's brightest pixel is **0.3945** against a 0.0018 floor. All four are the file's committed look baseline.

## The window is painted because a sensor you cannot see is a sensor nobody believes

`gate1` and `win1` are the same four numbers — the marker is derived from the crop rather than typed twice — and the marker is composited **before** `dim1`, so the controller scales it along with everything else it measures. A marker outside the loop would be a constant the loop could not see, and the reader would have to be told that instead of watching it.

Two conventions meet at that derivation and both were learned by rendering the crop on its own and looking at where it landed: `crop` measures v from the **bottom** while the generators measure their centre from the **top**, and `rectangle`'s size is a **half-extent**, not a width.

## Reproducibility

Every clock in the file is authored: one LFO, the noise's own speed, and the feedback strip's per-frame scroll. The OSC loop is explicitly **not** reproducible and is not supposed to be — `oscIn` is `external-live`, a render over it does not reproduce, and `oscOut` transmits from the live session only. An offline export, a headless render and every Dawn gate install no pump at all, so none of them put a datagram on the wire; a take is blocked by a check against the node's own `emits` declaration rather than by nobody having built the pump. What all of them render is the Rest picture, which is why the Rest had to be a good one.
