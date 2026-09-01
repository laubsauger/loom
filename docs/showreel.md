# Shaderloom showreel — 45s cut

Target: Twitter/X, autoplay, **silent-first** (captions carry it), 1080×1080 or 1920×1080.
Music: one track, hard downbeat at 0:00. Every cut lands on a beat.
Rule: **no UI chrome until 0:06.** Lead with the picture, not the tool.

---

## Shot list

| # | Time | Source | On screen | Note |
|---|---|---|---|---|
| 1 | 0:00–0:03 | **E31 Corona** | — | Cold open. Full-bleed. Loudest frame we own. No text. |
| 2 | 0:03–0:06 | **E31 Corona** | `THIS IS RUNNING IN A BROWSER TAB` | Hold the same shot. Text in, text out. |
| 3 | 0:06–0:10 | E31 → pull back to graph | `NODE GRAPH · WEBGPU · NO INSTALL` | The reveal. Zoom out from the output tile into the full patch, nodes live and previewing. |
| 4 | 0:10–0:14 | **E35 Nova-Torus** | `AUDIO DRIVES GEOMETRY` | Cut on beat. Show the tube thickness pumping. Waveform visible in a value node. |
| 5 | 0:14–0:18 | **E34 Lidar** | `RAYS. RETURNS. SHADOWS.` | Beams sweeping, impacts lighting the terrain. |
| 6 | 0:18–0:22 | **E33 Obol** | `1728 CUBES → ONE SURFACE` | The fuse. Time it so the morph completes on a beat. |
| 7 | 0:22–0:25 | **E36 Facade** | `PROJECTION MAPPING PREVIZ` | Two projectors, the overlap zone, shadow fingers off the cornice. |
| 8 | 0:25–0:29 | **E27 Relief / E39 Rosette** | `YOUR WEBCAM IS A SOURCE` | Live face → scanlines → polar rosette. Personal, immediate. |
| 9 | 0:29–0:33 | **E43 Splice** | `VIDEO, SLICED ON THE BEAT` | The glitch rack: bands hold, then SLAM on the tick. Cut so a re-deal lands on a beat — the effect is the edit. |
| 10 | 0:33–0:37 | Split screen: graph ↔ output | `EVERY PARAMETER IS DRIVABLE` | Drag a slider, watch three previews move. **Show a value node's plot.** |
| 11 | 0:37–0:41 | Fast montage, 4×1s | — | E9 Ember · E16 Murmuration · E13 Prism (the traced interior beam) · E41 Cinder (a moving subject sheds particles). One beat each. |
| 12 | 0:41–0:45 | Black → wordmark | `SHADERLOOM` + URL | Hold 2s. |

---

## Captions — full list, verbatim

Keep them **≤ 5 words**, sans, bottom-third, hard cut in/out. No fades.

```
THIS IS RUNNING IN A BROWSER TAB
NODE GRAPH · WEBGPU · NO INSTALL
AUDIO DRIVES GEOMETRY
RAYS. RETURNS. SHADOWS.
1728 CUBES → ONE SURFACE
PROJECTION MAPPING PREVIZ
YOUR WEBCAM IS A SOURCE
VIDEO, SLICED ON THE BEAT
EVERY PARAMETER IS DRIVABLE
SHADERLOOM
```

---

## Why these shots

- **Corona opens** because it is the calibration bar (§V471) — it is the best-looking thing we own, and a reel that opens weak is not watched.
- **The graph reveal is at 0:06, not 0:00.** Node-graph screenshots read as "developer tool" and lose the scroll. Earn it with the picture first.
- **Obol is the single most *legible* idea** — a viewer with no context understands "cubes become a blob" instantly. It is the shot most likely to be quoted.
- **Facade is the differentiator.** Nobody expects previz in a browser tab. It is the shot that makes a lighting designer stop.
- **Webcam is the call to action** — it is the only shot where the viewer sees *themselves* in the product. E39's rosette is full-bleed loud; it carries the back half of the shot.
- **Splice follows the webcam** because both are "your video, transformed" — and a beat-synced glitch is the one effect whose *timing* reads in a silent autoplay: the frame visibly holds, then slams. Pasture was cut here: its idea (a sim that feeds itself) does not survive four seconds at feed-scroll size — dark, intricate, illegible at speed. The md keeps the idea; the reel keeps only what reads.
- **The montage is deliberately fast.** Breadth without dwelling; four looks in four seconds says "there is more here" better than any caption. Cinder replaced Fluid: "motion becomes particles" is a sentence at one second, and fluid dye is the look every tool already shows.

## Cutting notes

- **Every cut on a beat.** The reel is silent-first but it will be watched with sound by the people who matter.
- **No slow zooms, no crossfades.** Hard cuts only. The material is high-contrast and motion-heavy; dissolves muddy it.
- **Never show a loading state, a blank viewer, or an empty graph.** Start every clip mid-motion.
- **Capture at the project's full resolution** and downscale — §V627: additive point density is resolution-dependent, so a half-res capture blows out.
- **Capture display-encoded** — §V618: a linear dump is ~1.5 stops dark and will look muddy on Twitter.

## Open dependencies

- A screen recorder at 60fps that does not drop frames during a drag — verify before shooting shot 10. (T735's plot jitter and E39 both landed; every shot above exists today.)
