import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";

/** T1279's idiom: continuous properties read the RANK, drums read the COUNTS. */
const LEVELS = (key: string): string => `op('lvl1').chan.${key}`;
const HITS = (key: string): string => `op('hit1').chan.${key}`;
import { SANCTUM_WGSL } from "../shaders/sanctum.wgsl.ts";

/**
 * E68 — SANCTUM (T1283). The showcase the owner commissioned, and it is a DELIBERATE
 * OUTLIER rather than a budget failure.
 *
 * The brief: *"triple AAA alien technology / temple visuals. with proper pbr materials,
 * reflections, specular, structured textures, lights, and camera moves, details in scene
 * driven by audio."* The feasibility read offered three directions and recommended the
 * rasterised one; the owner chose the RAYMARCHED one with its price in front of them —
 * 25–35 ms @720 against E13's 3.6 ms datum — and then removed the ceiling entirely:
 * "make it look right". Both choices are theirs, made twice, and they are why this file
 * sits beside E67 rather than beside E13.
 *
 *   sky1(solid) ─► temple1(customWgsl: the nave marcher) ─► out1(output)
 *
 * ## The shape of the piece
 *
 * A slow dolly down the nave of a buried temple. Eroded stone, a colonnade that recedes,
 * a doorway at the far end that is the only cold light in the picture, and inlay channels
 * cut into the columns that are still powered.
 *
 * ## What this file does NOT have, stated rather than discovered
 *
 * It is a marcher, so it owns its own shading: **no `materialPbr`**, and none of the
 * GGX/Smith BRDF or the prefiltered environment that §T1284 and §T1289 landed the same
 * night. Those are the scene node family's, and a full-screen `customWgsl` never touches
 * them. It also **cannot MSAA** — that is free on the rasterised path and unavailable
 * here, which is why the anti-aliasing is FXAA (§T1276's component) rather than the 1.69×
 * supersample the owner refused on E67. The renderer's flagship material ships in the
 * SMALLER PBR EXAMPLE that follows this one (§T1290), not in the temple.
 *
 * ## Built in measured stages, and the stages are in the record
 *
 * Each idea was costed before the next went in, at 1280×720, as GPU extent — trimmed
 * means over 240 of 300 frames rather than medians, because Dawn quantizes timestamps to
 * 65 536 ns and a median lands ON the quantum (§B211):
 *
 *   stage 1  the bare march: stone, erosion, one key        2.94 ms
 *   stage 2  + the inlay, its channels and its spill        3.57 ms
 *
 * The resolution is set EXPLICITLY on the document rather than inherited, so the piece and
 * its claims agree about what it was designed for.
 */
export const sanctumDocument = document(
  "sanctum",
  "E68 Sanctum",
  settings({ randomSeed: 68, outputResolution: { width: 1280, height: 720 } }),
  graph(
    [
      /* The marcher writes every pixel, so its input is a formality — but a `customWgsl`
         node takes one, and a black solid is the honest "nothing comes in here". */
      node("sky", "solid", [-600, 0], { color: [0, 0, 0, 1] }, { label: "sky1" }),
      /* §V920/§T1184: every reflected value is STORED rather than inherited from the
         shader's own `// @default` lines. A declared default is a fallback for a node
         somebody just placed; a shipped example that leans on one moves the day the
         shader is retuned, and nothing would say so. */
      node("temple", "customWgsl", [-300, 0], {
        source: SANCTUM_WGSL,
        dollySpeed: 0.55,
        eyeHeight: 1.62,
        pitch: -2,
        lens: 1.7,
        bay: 4.4,
        aisle: 3.6,
        columnRadius: 0.62,
        columnFlare: 0.22,
        ceiling: 7.2,
        /* ─── THE ARCHITECTURAL VOCABULARY (T1304c) ────────────────────────────────────
         * The owner's reading of the version before this one was "the shapes too simple",
         * and it was exact: the hall was a floor, one repeated column, a flat ceiling and
         * a far wall. Four shapes cannot describe a building.
         *
         * Every value here buys a KIND rather than a COUNT, which is the finding the whole
         * rework rests on: the colonnade is domain-repeated, so thirty columns evaluate one
         * distance function — a thirty-first column is free and a CAPITAL is one box. */
        plinthHeight: 0.46,
        capitalDrop: 0.95,
        spanDepth: 0.3,
        ribThickness: 0.17,
        ribWidth: 0.34,
        /* A fifth of the bays have FALLEN, and one hash decides the column, its capital,
           the span above it and the block of it on the floor — a bay whose column is gone
           but whose architrave still floats is a bug, not a ruin. */
        ruin: 0.22,
        /* The mason's courses, cut as real grooves. This is the shape that separates AGE
           from DIRT: weathering opens the bedding joint between two courses first, and a
           noise skin has no idea where those are. */
        /* ⚑ THE VAULT IS BROKEN OPEN IN A THIRD OF THE BAYS, and the daylight standing in
           those holes is the answer to "not dramatic enough". Every other light in this
           hall comes from inside it, at one temperature, along one axis; a shaft falling
           THROUGH the roof gives the frame a light from above, a warm against the cyan,
           and a source that is visible in shot rather than implied. */
        breach: 0.24,
        breachLight: 1.15,
        dayColor: [1, 0.86, 0.62, 1],
        courseHeight: 0.54,
        courseDepth: 0.03,
        courseLay: 0.018,
        courseBlocks: 7,
        /* The floor, which "felt like mud" because it was the plane y = 0 with a
           reflection on it and no material underneath. Slabs, joints, and settlement. */
        slabSize: 1.7,
        slabJoint: 0.055,
        slabDepth: 0.026,
        slabSettle: 0.022,
        erosion: 0.135,
        erosionScale: 2.9,
        erosionBands: 0.62,
        inlayRows: 1.15,
        inlayVeins: 9,
        inlayRings: 0.34,
        inlayDepth: 0.035,
        inlayWidth: 0.16,
        /* ⚑ CONTINUOUS IS NOT UNIFORM (T1304c), and the version before this one was
           uniform: strips of even width and even brightness running the full height of
           every column, which reads as NEON TAPE APPLIED TO A COLUMN rather than as
           something that is part of one. A conduit varies along its run — it swells and
           narrows, it dips, it gutters out and comes back, and it POOLS where it crosses
           a member, because a junction is where a network shows it is a network. */
        inlayRun: 1.7,
        inlayVary: 0.62,
        inlayBreak: 0.42,
        inlayNode: 0.9,
        inlayColor: [0.16, 1, 0.82, 1],
        inlayEmission: 0.85,
        inlaySpill: 4.2,
        inlayDensity: 0.4,
        stoneColor: [0.29, 0.27, 0.25, 1],
        keyColor: [0.52, 0.62, 0.78, 1],
        keyIntensity: 1.35,
        /* The doorway's half-width, and its head is an ARCH — the flat rectangle was "the
           brightest and least interesting thing in frame", and half of that is shape. */
        /* ⚑ TWELVE BAYS, AND IT MUST STAY A MULTIPLE OF `bay` (T1306b). 12 x 4.4 = 52.8.
           The walk is already infinite — `absTime` is the absolute clock and does not wrap
           at a lap — so what ended was the BUILDING: one wall at one fixed z meant the
           camera walked out of the back of the temple after about eighty seconds. The wall
           repeats now, so you leave one hall and enter the next forever. A period that is
           not a whole number of bays would put a doorway in the middle of a colonnade. */
        roomPeriod: 52.8,
        doorWidth: 1.15,
        ambient: 0.26,
        fog: 0.055,
        fogColor: [0.045, 0.05, 0.062, 1],
        warmColor: [1, 0.54, 0.26, 1],
        warmIntensity: 0.28,
        lift: 0.012,
        contrast: 0.82,
        hueTurn: 42,
        /* ⚑ TWO HUES IN OPPOSITION, not one family drifting. The first morph moved the
           conduits along a sixth of the wheel and the reading was that it "reads as one
           state" — correct, because a single hue drifting has nothing to be measured
           against. The counter-light now travels the OTHER WAY on a wider arc, so the two
           lights pull apart and come back together and the frame has a relationship in it
           rather than a setting. */
        hueArc: 0.26,
        warmArc: 0.12,
        keyBreath: 0.34,
        keyPeriod: 15,
        saturation: 1.35,
        pivot: 0.22,
        exposure: 1.35,
        dust: 0.032,
        dustSteps: 30,
        dustFloor: 2.6,
        shaft: 0.55,
        polish: 0.55,
        reflectSteps: 34,
        reflectFade: 12,
        steps: 96,
      }, {
        label: "temple1",
        parameters: {
          /* T1279's shape: the conduits FIRE on the kick. A count is 1 on the frame the
             drum lands and 0 between, so a bare gain on it rests at ZERO — the file with
             no track is exactly the picture it already was (§V914). A rank would rest at
             its middle and leave the hall permanently half-pulsed, which is the opposite
             of a beat. */
          /* ⚑ THE GAIN CAME DOWN FROM 1.5 TO 0.7 (T1304c) AND THE DECAY WENT UP, and the
             two together are the answer to "stuff too blinky blinky". A count is a STEP:
             it is 1 on the frame the drum lands and 0 between, so the only thing that
             decides whether a viewer reads it as a swell or as a strobe is how far it
             travels and how long it takes to come back. 1.5 on top of a rest of 0.85 is a
             light that nearly triples in one frame — which is a strobe however you shape
             it. 0.7 over a 420 ms decay (on the analysis node) is a light that GUTTERS.
             §T1301's open complaint is exactly this failure on E57, and it was not going
             to be fixed by a different curve on a bigger jump. */
          inlayEmission: expressionSlot(`0.85 + 0.7 * ${HITS("kickCount")}`, 0.85),
          /* And the air BREATHES rather than landing: dust on the low band's rank, which
             rests at 0.5 with no audio and so renders the shipped density exactly. */
          dust: expressionSlot(`0.02 + 0.024 * ${LEVELS("low")}`, 0.032),

          /* ⚑ FINER REACTION TO FINER DETAIL (T1304b). One kick lane moving everything is
             the coarsest possible answer to "is this reactive"; what makes a piece perform
             is that SMALL things answer small things. Three more lanes, each on the channel
             whose grain matches what it moves, and every one of them rests at the shipped
             value with no track (§V914):

               hats   → how many RING members are lit. A hat is the finest event in a kit
                        and it ticks the finest structure in the hall.
               snare  → the shaft through the doorway. A backbeat is a bigger gesture than
                        a hat and it moves a bigger thing, but still not the whole frame.
               highMid rank → the warm counter-light. A CONTINUOUS property on a rank, so
                        the frame's second colour swells with the mix's top end rather than
                        firing — the colour balance breathes where the conduits land. */
          inlayRings: expressionSlot(`0.34 + 0.26 * ${HITS("hatCount")}`, 0.34),
          /* The snare moved OFF the shaft and ONTO the junctions (T1304c). A backbeat
             landing on the doorway's beam is the whole frame's brightest object snapping,
             which is the "blinky" reading again; landing on the pools where conduits cross
             members is the same event on the finest structure in the hall. Finer reaction
             to finer detail means the event has to move something SMALL. */
          inlayNode: expressionSlot(`0.9 + 1.1 * ${HITS("snareCount")}`, 0.9),
          /* And the doorway now breathes with a RANK instead of firing on a count: a
             continuous property on a continuous channel, resting at its middle. */
          shaft: expressionSlot(`0.42 + 0.26 * ${LEVELS("high")}`, 0.55),
          /* The hall's primary light swells with the mix's middle rather than only landing
             on the kick — the up-and-down the owner asked for, carried by the light that
             actually illuminates the stone. */
          inlaySpill: expressionSlot(`3.4 + 1.6 * ${LEVELS("lowMid")}`, 4.2),
          warmIntensity: expressionSlot(`0.2 + 0.16 * ${LEVELS("highMid")}`, 0.28),

          /* ⚑ "MORE UP AND DOWN SIDE FELT" — dynamic range IN TIME rather than in space,
             and it is the same complaint as "greyish on average" one axis over: a flat
             histogram and a flat timeline are the same failure. The exposure rides the low
             rank, so a quiet passage sits DOWN and a loud one sits UP, and because a rank
             rests at its middle the no-track picture is the shipped exposure exactly.
             Gentle on purpose: ±10%, because this is the one lane that moves every pixel
             and §T1301's open complaint is a primary light that read as blinking. */
          exposure: expressionSlot(`1.22 + 0.26 * ${LEVELS("low")}`, 1.35),
        },
      }),
      node("out", "output", [0, 0], { toneMap: "filmic" }, { label: "out1" }),

      /* ─── THE AUDIO ────────────────────────────────────────────────────────────────
       *
       * The catalogue's fixed drive shape: a deterministic pattern at index 0 so the file
       * is audio-reactive on open with no track at all (§V363), and a real file at index 1
       * one drop away. Everything downstream reads `source1`, so swapping the source
       * changes nothing else.
       *
       * ONE ANALYSIS INSTANCE, two bags — `lvl1` for the ranked levels, `hit1` for the
       * drum counts — which is the idiom §T1234 and §T1271 arrived at the hard way. The
       * split is the finding: a percentile cannot spread a tie, so a COUNT through a rank
       * rests at its mid and a beat becomes a permanent half-lit nothing.
       *
       * ⚑ NOTHING DRIVES THE CAMERA. §T1279 refused that on E57 for a reason that applies
       * here unchanged: the move IS the piece's pace, and modulating it makes the walk a
       * limp rather than a groove.
       */
      node("music1", "audioPattern", [-1200, 400], { amount: 1, bpm: 112 }, { label: "music1" }),
      node("track1", "audioFileIn", [-1200, 620], {
        cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true,
        playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1,
      }, { label: "track1" }),
      node("source1", "valueSwitch", [-960, 510], { index: 0 }, { label: "source1" }),
      node("analysis1", "component:audioAnalysis@1", [-720, 510], {
        /* hitDecay 420 rather than 250 (T1304c): a count's fall is the ONLY shaping a hit
           lane has, and 250 ms puts the whole gesture inside fifteen frames. "Too blinky
           blinky" is a complaint about that number as much as about the gains above it. */
        envelope: 0.08, window: 16, settle: 0.15, hitDecay: 420,
      }, { label: "analysis1" }),
      /* T1302b: a Select at `*` passes every channel through unchanged — a Limit at 0..1
         would clip the tempo claims the hits bag also carries. */
      node("lvl1", "valueSelect", [-480, 420], { channels: "*" }, { label: "lvl1" }),
      node("hit1", "valueSelect", [-480, 600], { channels: "*" }, { label: "hit1" }),
    ],
    [
      edge("e-sky-temple", ["sky", "out"], ["temple", "input"]),
      edge("e-temple-out", ["temple", "out"], ["out", "input"]),
      edge("e-music-source", ["music1", "out"], ["source1", "in1"]),
      edge("e-track-source", ["track1", "out"], ["source1", "in2"]),
      edge("e-source-analysis", ["source1", "out"], ["analysis1", "audio"]),
      edge("e-analysis-lvl", ["analysis1", "levels"], ["lvl1", "in"]),
      edge("e-analysis-hit", ["analysis1", "hits"], ["hit1", "in"]),
    ],
  ),
);
