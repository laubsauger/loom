# E52 — Presence

A presence mirror: whoever stands at the camera is lifted off their background by the
operating system's own person segmentation — Apple Vision, reached through the local
helper (`pnpm mcp:serve`) over the device bridge — and composited over a slow synthetic
haze that wakes into colour when someone is in frame.

## The trade this node demonstrates

`mask1(personMask)` is the Matte node's sibling with the opposite trade: no model
download, no weights, nothing to hash-verify — an OS API has no bytes to check — but it
needs the helper on macOS, and the OS supplies the model, so two machines may cut
differently. The Matte node stays the hash-pinned, reproducible spelling; this one is
the zero-setup spelling. Both publish white-where-person on every channel, which is
what makes `key1(multiply)` the entire compositor: the source times its own mask.

## The room knows — coverage as a value

`wash1(hsv)`'s saturation is an expression over `mask1:coverage` — the fraction of the
frame the mask confidently claims, published by the node itself. An empty room sits
near-grey; a person filling a tenth of the frame pulls the haze toward full colour.
"Ran and found nobody" is a number driving a knob here, not an absence — the
distinction that keeps a working mask from ever reading as a broken one.

## Degrade, stated because every gate sees it

The shipped default is the deterministic understudy (`src1(switch)` at 0 — a webcam
cannot gate headlessly), which contains no person. Without the helper the node's
diagnostic says what pairing would change, the mask stays neutral, and the room shows
the haze alone — the correct picture of an empty room, not a failure. Flip `src1` to 1
with the helper attached and the mirror is live.

Nodes: `bed1(noise)` → `src1(switch)` ← `cam1(webcam)`; `src1` → `mask1(personMask)` →
`key1(multiply)` ← `src1`; `haze1(noise)` → `wash1(hsv)` → `room1(over)` ←
`key1`; `room1` → `out1(output)`.
