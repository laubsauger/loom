# E53 — Two Cuts

The same subject, cut two ways, side by side: a diptych comparing the two answers this
catalogue has to "separate the person from the background". LEFT, warm: the Matte node.
RIGHT, cool: the Person Mask. One source, one flip, two philosophies.

## The comparison, honestly costed

`matte1(matte)` is a **downloaded model** — MODNet or RVM through onnxruntime, hash-pinned
and reproducible (§V858), producing a **soft alpha** with hair-level detail at ~30 ms
in-page on WebGPU (slower without cross-origin isolation; the node reports its regime).
`seg1(personMask)` is the **operating system's own** Vision segmentation over the local
helper — a **hard class mask**, zero weights, zero download, nothing to verify, 20–35 ms
helper-side, macOS only. Neither is "better": one is reproducible and portable, the other
is instant to adopt and answers with the OS's own idea of a person. Put both on one frame
and the edge quality, the latency and the failure modes stop being prose.

## Both coverages are spent

Each side's haze saturates with **its own** cut's coverage — `matte1:coverage` warms the
left, `seg1:coverage` cools the right — so "found nobody" is a value on both sides, and a
DISAGREEMENT between the two cuts shows as a saturation imbalance across the seam before
anyone squints at edges.

## Shipped look, and the flip

The default source is the deterministic understudy (`src1(switch)` at 0), which contains
no person: both cuts honestly find nobody, both keys go dark, and what ships is the
two-tone animated diptych with the stand-in glowing through at low brightness on both
sides. Flip `src1` to 1 with a webcam to appear twice at once — the left half also wants
the matte model downloaded (the node's notice offers it), the right half wants the local
helper (`pnpm mcp:serve`) on macOS. Each half degrades alone: whichever cut is unavailable
goes dark on its side and says why, while the other keeps cutting.

Nodes: `bed1(noise)` → `src1(switch)` ← `cam1(webcam)`; `src1` → `matte1(matte)` →
`keyM1(multiply)` ← `src1`; `src1` → `seg1(personMask)` → `keyV1(multiply)` ← `src1`;
`src1` → `dim1(level)`; `hazeW1(noise)` → `washW1(hsv)`; `hazeC1(noise)` → `washC1(hsv)`;
`washW1` → `baseL1(add)` ← `dim1`; `washC1` → `baseR1(add)` ← `dim1`; `keyM1` →
`leftC1(over)` ← `baseL1`; `keyV1` → `rightC1(over)` ← `baseR1`; `gateL1(ramp)`,
`gateR1(ramp)` gate the halves through `halfL1(multiply)` / `halfR1(multiply)` into
`sum1(add)` → `out1(output)`.
