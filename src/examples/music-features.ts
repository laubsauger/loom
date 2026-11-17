import type { GraphEdge, GraphNode } from "../domain/types/graph.ts";
import type { PublishedParameter } from "../domain/types/components.ts";
import type { NodeId } from "../domain/types/ids.ts";
import type { StoredParameter } from "../domain/types/parameters.ts";
import { edge, expressionSlot, named } from "./documents/builders.ts";
import {
  MIDI_LANE_CHANNELS,
  MIDI_LANES,
  MUSIC_FEATURE_GROUPS,
  MUSIC_REGION_BANDS,
  MUSIC_VOICES,
  channelNames,
  type FeatureChannel,
  type MusicFeatureGroup,
} from "./music-features-contract.ts";

/**
 * T1805b: the two MUSIC FEATURE components, as the graphs they are authored from.
 *
 *   MusicFeatures   audio (and optionally tonal) in ─► levels, beats, tempo, notes, harmony, form
 *   MidiFeatures    a MIDI keyboard inside        ─► the same six, plus lanes
 *
 * Both publish the contract in `music-features-contract.ts`: the same channel names from
 * sound and from keys, so one network takes either. They were built inside a project
 * (silk-medusa, split from its scene in §T1793b's session) and are promoted here; the
 * member names are the project's, kept so it can take the shipped components back and
 * compare node by node. Where the shipped graphs differ from the project's on purpose is
 * marked `SHIPPED DIFFERS` at the line.
 *
 * WHAT IS HERE: the member tables (one row a node, in sections), the expression text that
 * repeats per voice, per pitch class and per key voice as TEMPLATES, and the two hosts'
 * outside nodes. `starter-components.ts` saves the members as a component through the real
 * authoring commands; this module builds nothing but the graph to select from.
 *
 * The value graph is all there is to write these in today, and several rows below stand in
 * for a node that does not exist yet. Each says which, at the row:
 *
 *   §T1794b  Merge and Rename      every `groupOut`, every `x = y` line that only renames
 *   §T1795b  sample-and-hold       every `hold`
 *   §T1796b  Count's output name   `startFrom`, and the Selects in front of each Count
 *   §T1797b  an unbounded Speed    `BEATS_BOUND`
 *   §T1800b  parameters in statements   every `constant` at the head of a table
 *
 * and two that no row can show:
 *
 *   §T1798b  nothing is pruned: a network that reads only `beats` pays for the notes, the
 *            harmony and the tempo estimator too (0.55 ms a frame for MusicFeatures, 0.4 ms
 *            for MidiFeatures, measured headless on the hosts). Six outputs are six places
 *            to prune from once unread value nodes are.
 *   §T1799b  MusicFeatures' own Chroma, Chord and Notes read the session's ONE capture, not
 *            the wire into `audio`. With one audio source that is the same sound. With two,
 *            which one the capture follows is decided by node id, and `tonal` is the way to
 *            say it by wire.
 */

// ── Graph assembly ───────────────────────────────────────────────────────────────────────

/** Where a wire lands: a member name alone lands on `in`; a pair names the port. */
type Wire = string | readonly [port: string, source: string];
interface Member {
  readonly node: GraphNode;
  readonly from: readonly Wire[];
}
/** A host node OUTSIDE the component, placed by its offset from where the instance will sit. */
interface Outside extends Member {
  readonly at: readonly [x: number, y: number];
}
const outside = (at: readonly [number, number], entry: Member): Outside => ({ ...entry, at });

const member = (role: string, type: string, parameters: Record<string, StoredParameter>, from: readonly Wire[] = []): Member => ({
  node: named(role, type, [0, 0], {}, { parameters }),
  from,
});

const select = (role: string, from: string, channels: string): Member => member(role, "valueSelect", { channels }, [from]);
const lag = (role: string, from: string, seconds: StoredParameter, releaseRatio = 1): Member =>
  member(role, "valueLag", { lag: seconds, releaseRatio }, [from]);
const constant = (role: string, value: number): Member => member(role, "constant", { value });

/**
 * HOLD: the input as it was on the last frame `gate` read 1. A Lag whose time is 2 ms while
 * the gate is up and `frozen` seconds otherwise, which is the workaround §T1795b names: it
 * creeps by the lag's residue between gates. A sample-and-hold node replaces every caller.
 */
const hold = (role: string, from: string, gate: string, frozen = 1_000_000_000): Member =>
  lag(role, from, expressionSlot(`0.002 + ${String(frozen)} * (1 - ${gate})`, 0.002));

const statements = (...lines: readonly (string | readonly string[])[]): string => lines.flat().join(";\n");
const assignments = (values: Readonly<Record<string, number>>): string =>
  statements(Object.entries(values).map(([name, value]) => `${name} = ${String(value)}`));

/** An Expression node: bags from `from` merge, `lines` run in order, `defaults` stand in for a name no wire carries. */
const expression = (role: string, from: readonly string[], lines: readonly (string | readonly string[])[], defaults: Readonly<Record<string, number>> = {}): Member =>
  member(role, "valueExpression", { expressions: statements(...lines), defaults: assignments(defaults) }, from);

/**
 * One output group, assembled under the contract's names: `sources` says which inner
 * channel or expression each contract channel is. Refuses a group that does not match the
 * contract exactly, so the generator cannot publish a name the tests do not hold.
 *
 * These are the `x = x` rows §T1794b counts: a Merge and a Rename node replace each one.
 */
const groupOut = (role: string, group: MusicFeatureGroup, from: readonly string[], sources: Readonly<Record<string, string>>): Member => {
  const wanted = channelNames(MUSIC_FEATURE_GROUPS[group]);
  const given = Object.keys(sources);
  if (wanted.length !== given.length || wanted.some((name) => !(name in sources))) {
    throw new Error(`music-features: group "${group}" assembles [${given.join(" ")}], the contract lists [${wanted.join(" ")}]`);
  }
  return expression(role, from, wanted.map((name) => `${name} = ${sources[name]!}`));
};
const zeros = (names: readonly string[]): Record<string, string> => Object.fromEntries(names.map((name) => [name, "0"]));

const COLUMN = 340;
const ROW = 190;

/**
 * Members → nodes on a grid and their edges, with the host's outside nodes around them.
 * A column is a member's depth (its longest chain of wires back to a source), a row its
 * place in the table among that column, so no two members share a cell. Saving the
 * selection leaves the instance at the members' centre, and the outside nodes are placed
 * from there.
 *
 * Edge ids sort by target, then by the wire's place in `from`: the value graph merges a
 * port's bags in edge-id order (later wins on a name clash), so the table's order is the
 * merge order.
 */
function assemble(members: readonly Member[], around: readonly Outside[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const inside = new Map(members.map((entry) => [entry.node.id, entry]));
  const outsideNames = new Set(around.map((entry) => entry.node.id));
  const sourceOf = (wire: Wire): string => (typeof wire === "string" ? wire : wire[1]);
  const depths = new Map<string, number>();
  const depthOf = (name: string, trail: readonly string[] = []): number => {
    if (outsideNames.has(name)) return -1;
    const known = depths.get(name);
    if (known !== undefined) return known;
    const entry = inside.get(name);
    if (entry === undefined) throw new Error(`music-features: "${trail.at(-1) ?? "?"}" is wired from "${name}", which is not in the table`);
    if (trail.includes(name)) throw new Error(`music-features: wires loop through ${[...trail, name].join(" → ")}`);
    const depth = entry.from.length === 0 ? 0 : 1 + Math.max(...entry.from.map((wire) => depthOf(sourceOf(wire), [...trail, name])));
    depths.set(name, depth);
    return depth;
  };
  const rows = new Map<number, number>();
  const placed = members.map((entry) => {
    const column = depthOf(entry.node.id);
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...entry.node, position: { x: column * COLUMN, y: row * ROW } };
  });
  const centre = {
    x: Math.round(placed.reduce((total, node) => total + node.position.x, 0) / placed.length),
    y: Math.round(placed.reduce((total, node) => total + node.position.y, 0) / placed.length),
  };
  const nodes = [...around.map((entry) => ({ ...entry.node, position: { x: centre.x + entry.at[0], y: centre.y + entry.at[1] } })), ...placed];
  const edges = [...around, ...members].flatMap((entry) =>
    entry.from.map((wire, index) => {
      const [port, source] = typeof wire === "string" ? ["in", wire] : wire;
      return edge(`e-${entry.node.id}-${String(index).padStart(2, "0")}-${source}`, [source, "out"], [entry.node.id, port]);
    }),
  );
  return { nodes, edges };
}

// ── Expression templates ─────────────────────────────────────────────────────────────────

const upTo = (count: number): number[] => Array.from({ length: count }, (_, index) => index);
const sum = (terms: readonly string[]): string => terms.join(" + ");
/** `max(max(a, b), c)`: the grammar's min and max take two arguments. An indexed maximum (§T1794b's family) replaces these. */
const nest = (fn: "min" | "max", terms: readonly string[]): string => terms.reduce((soFar, term) => `${fn}(${soFar}, ${term})`);

const PITCH_CLASSES = upTo(12);

/** The strongest of twelve, lower index first on a tie: each value gives up a millionth per index. */
const tieBroken = (value: string, index: number): string => `(${value} - ${String(index)} * 0.000001)`;
const indexOfStrongest = (candidates: readonly string[], strongest: string): string =>
  sum(candidates.map((candidate, index) => `${String(index)} * (${candidate} == ${strongest})`));

/** Σ chroma[k]·chroma[k+d]: how much of the sound sits `d` semitones apart. The tritone pairs each class once. */
const intervalEnergy = (semitones: number): string =>
  sum(upTo(semitones === 6 ? 6 : 12).map((k) => `chroma${String(k)} * chroma${String((k + semitones) % 12)}`));
/**
 * Dissonance, 0..1: interval energy weighted by roughness (semitone 1, tone 0.6, minor
 * third 0.15, major third 0.1, fourth 0, tritone 0.8) over all of it.
 */
const dissonance = (interval: (semitones: number) => string): string =>
  `(1.0 * ${interval(1)} + 0.6 * ${interval(2)} + 0.15 * ${interval(3)} + 0.1 * ${interval(4)} + 0.8 * ${interval(6)}) / (${sum([1, 2, 3, 4, 5, 6].map(interval))} + 0.001)`;

/** The six form and harmony scores every source ends in: a 6 s lag, then these curves. */
const SCORE_CURVES = {
  energy: "smoothstep(0.2, 0.85, sE)",
  brightness: "smoothstep(0.2, 0.85, sL)",
  density: "smoothstep(0.2, 0.9, sD)",
  tension: "smoothstep(0.1, 0.7, sT)",
} as const;

/** `voiceNStart` from a Count's `<name>` and `<name>Since` (§T1796b: the count wears its input's name): seconds on abstime, -1 before the first. */
const startFrom = (count: string): string => `(${count} > 0.5) * (abstime - ${count}Since) - (${count} < 0.5)`;

/** The tempo in effect: the declared one above 1, else `otherwise`, inside what a clock can run at. */
const tempoInEffect = (otherwise: string): string => `clamp((value > 1) * value + (value <= 1) * ${otherwise}, 20, 300)`;

// ── MusicFeatures ────────────────────────────────────────────────────────────────────────

const VOICES = upTo(MUSIC_VOICES);
/** The Notes node inside tracks this many notes; a `tonal` source may carry fewer (Tone Pattern has four). */
const TRACKED_NOTES = upTo(5);

/** A tracked note the range may use: confident, and still sounding. */
const tracked = (note: number): string => `(voice${String(note)}Confidence > 0.6) * (voice${String(note)}Envelope > 0.05)`;
const trackedOr = (note: number, field: string, otherwise: string): string =>
  `(${tracked(note)} * voice${String(note)}${field} + (1 - ${tracked(note)}) * ${otherwise})`;
/** Strikes this frame, capped at 1, among the tracked notes sitting on `pitch`. */
const strikesOn = (pitch: string): string =>
  `min(${sum(TRACKED_NOTES.map((note) => `(${tracked(note)} * (voice${String(note)}Pitch == ${pitch})) * voice${String(note)}OnsetCount`))}, 1)`;

const bands = (centres: readonly number[]): string => centres.map((centre) => `band${String(centre)}`).join(" + ");
const bandMean = (...centres: number[]): string => `(${bands(centres)}) / ${String(centres.length)}`;
/** A region's level: the fourth-power mean of its spectrum rows, so one loud row carries it. */
const regionLevel = (centres: readonly number[]): string =>
  `((${centres.map((centre) => `band${String(centre)} ^ 4`).join(" + ")}) / ${String(centres.length)}) ^ 0.25`;

/** A region's working range above the noise floor: narrower at low Sensitivity, never above 0.45. */
const regionSpan = (region: number): string => `clamp(p${String(region)} - nl, (0.15 - 0.05 * sense), 0.45)`;

/** The tap-tempo estimator looks back over these many seconds of kicks (frames, at the running rate). */
const TEMPO_LOOKBACKS = ["1.5", "2.5", "3.7", "5.0"] as const;

/** Chroma at a voice's held pitch class: what that voice sounds like while drums cover the bands. */
const chromaAt = (pitch: string): string => sum(PITCH_CLASSES.map((k) => `chroma${String(k)} * (mod(round(${pitch}), 12) == ${String(k)})`));

const MUSIC_TONAL_DEFAULTS: Readonly<Record<string, number>> = Object.fromEntries(PITCH_CLASSES.map((k) => [`chroma${String(k)}`, 0]));
/**
 * SHIPPED DIFFERS: a `tonal` source with fewer than five voices (Tone Pattern has four)
 * left `voice4…` unknown, and an unknown name fails every statement that reads it, so the
 * note range, the strikes and `noteDensity` published nothing. The missing voice now reads
 * as silent. A wired channel wins over a default, so a five-voice source is unchanged.
 */
const MISSING_VOICE: Readonly<Record<string, number>> = Object.fromEntries(
  TRACKED_NOTES.flatMap((note) => ["Pitch", "Confidence", "Envelope", "OnsetCount"].map((field) => [`voice${String(note)}${field}`, 0])),
);

/** `beats` is a Speed between ±this; see the row. */
const BEATS_BOUND = 1_000_000_000;
/** The notes group is everything per voice and the pedals: picked by pattern from the features Expression. */
const NOTES_OUT = "voice* note* sustain* soft*";

/** The MusicFeatures host's two sources, outside the component: any audio source and any tonal source take these seats. */
const MUSIC_AUDIO_SOURCE = "pattern_beat";
const MUSIC_TONAL_SOURCE = "tones_song";

const musicMembers: readonly Member[] = [
  // The page's knobs, as channels. A statement cannot read a parameter (§T1800b), so each
  // published parameter writes a Constant and the Constant is wired in.
  constant("audiosense", 1),
  constant("audiosmooth", 0.5),
  constant("audiodense", 0.65),
  constant("audiodeclared", 0),
  constant("audiofallback", 0),
  expression("audiosensein", ["constant_audiosense"], ["sense = value"]),

  // Tonal sources. The inner Chroma, Chord and Notes read the session's one capture; a wire
  // into `tonal` (input 1 of each Switch) replaces all three with channels of the same names.
  member("music", "audioChord", { minConfidence: 0.2 }),
  member("music", "audioChroma", { attack: 0.2, gate: true, release: 0.5 }),
  member("music", "audioNotes", { attack: 0.01, glide: 0.03, hold: true, release: 0.3, voices: TRACKED_NOTES.length }),
  member("tonalchroma", "valueSwitch", { crossfade: false, index: 0 }, [["in1", MUSIC_TONAL_SOURCE], ["in2", "chroma_music"]]),
  member("tonalchord", "valueSwitch", { crossfade: false, index: 0 }, [["in1", MUSIC_TONAL_SOURCE], ["in2", "chord_music"]]),
  member("tonalnotes", "valueSwitch", { crossfade: false, index: 0 }, [["in1", MUSIC_TONAL_SOURCE], ["in2", "notes_music"]]),
  select("audiochord", "switch_tonalchord", "root chordQuality chordConfidence chordChangeCount"),
  select("audiochromain", "switch_tonalchroma", "chroma[0-9] chroma1[01]"),
  select("audioconf", "switch_tonalchroma", "chromaConfidence"),
  select("audionotes", "switch_tonalnotes", "voice[0-4]Pitch voice[0-4]Confidence voice[0-4]Envelope voice[0-4]OnsetCount voice[0-4]Id"),
  select("audiokey", "switch_tonalchord", "chordQuality chordConfidence tonalCenter keyMode keyConfidence"),

  // Bands: the spectrum under a 50 ms follower, and the five regions made from it. `q0`…`q4`
  // guess a pitch class from the spectral tilt; they are read only with Pitch Fallback on.
  select("audio", MUSIC_AUDIO_SOURCE, "band* centroid level kick kickCount"),
  lag("audiobands", "select_audio", 0.05, 2),
  expression(
    "audioregion",
    ["lag_audiobands"],
    [
      MUSIC_REGION_BANDS.map((centres, region) => `e${String(region)} = ${regionLevel(centres)}`),
      `el = (${sum(VOICES.map((region) => `e${String(region)}`))}) / ${String(MUSIC_VOICES)}`,
      VOICES.map((region) => `m${String(region)} = e${String(region)}`),
      `q0 = 0 + 3 * smoothstep(-0.15, 0.15, ${bandMean(149, 204)} - ${bandMean(80, 109)})`,
      `q1 = 2 + 4 * smoothstep(-0.15, 0.15, ${bandMean(278, 380, 519)} - ${bandMean(149, 204)})`,
      `q2 = 5 + 4 * smoothstep(-0.15, 0.15, ${bandMean(709, 968, 1300)} - ${bandMean(380, 519)})`,
      `q3 = 8 + 4 * smoothstep(-0.15, 0.15, ${bandMean(1800, 2500, 3400)} - ${bandMean(968, 1300)})`,
      `q4 = 10 + 7 * smoothstep(-0.15, 0.15, ${bandMean(6300, 8600, 11700, 16000)} - ${bandMean(1800, 2500, 3400, 4600)})`,
      "cb = centroid",
      VOICES.map((region) => `p${String(region)} = e${String(region)}`),
      "pl = el",
      "nl = el",
      `bs = ${bandMean(1800, 2500, 3400)}`,
      `bh = ${bandMean(8600, 11700, 16000)}`,
      // One signal under several names, because each follower below publishes under its
      // input's name and they meet again in one Expression (§T1794b: a Rename).
      ["zs = bs", "ys = bs", "ws = bs", "zh = bh", "yh = bh", "wh = bh", "ql = el"],
    ],
    { centroid: 0 },
  ),

  // Adaptive range and gate: a 60 s floor, a 1.2 s mean and a fast peak per region, then
  // each region's envelope (`env`), its strike signal (`d`) and the gate (`G`).
  select("audion", "expression_audioregion", "nl"),
  select("audiom", "expression_audioregion", "m[0-4]"),
  select("audiop", "expression_audioregion", "p[0-4] pl"),
  select("audioql", "expression_audioregion", "ql"),
  select("audioe", "expression_audioregion", "e[0-4] el"),
  select("audioq", "expression_audioregion", "q[0-4] cb"),
  lag("audiofloor", "select_audion", 60, 0.02),
  lag("audiomean", "select_audiom", 1.2),
  lag("audiopeak", "select_audiop", 0.3, 130),
  lag("audiotrough", "select_audioql", 2.5, 0.02),
  lag("audiopitch", "select_audioq", 1),
  select("audiocb", "lag_audiopitch", "cb"),
  select("audiopq", "lag_audiopitch", "q[0-4]"),
  expression(
    "audiovoice",
    ["lag_audiofloor", "lag_audiomean", "lag_audiopeak", "lag_audiotrough", "select_audioe", "expression_audiosensein", "select_audiocb"],
    [
      "G = max(smoothstep(nl + 0.075 - 0.025 * sense, nl + 0.105 - 0.025 * sense, pl), smoothstep(0.35, 0.45, pl)) * (pl > 0.01)",
      "rl = clamp(pl - nl, (0.15 - 0.05 * sense), 0.45)",
      "L = clamp((el - pl + rl) / rl, 0, 1) * G",
      VOICES.flatMap((i) => {
        const [e, m, p, x, g] = ["e", "m", "p", "x", "g"].map((name) => `${name}${String(i)}`) as [string, string, string, string, string];
        return [
          `${x} = clamp((${e} - ${p} + ${regionSpan(i)}) / ${regionSpan(i)}, 0, 1)`,
          `${g} = smoothstep(pl - 0.42, pl - 0.22, ${p}) * G`,
          `env${String(i)} = clamp(0.2 + 0.4 * ${x} + (1.2 + 0.5 * sense) * (${e} - ${m}) / ${regionSpan(i)}, 0, 1) * ${g}`,
          `d${String(i)} = ((${e} - ${m}) / ${regionSpan(i)} - 0.24 + 0.07 * sense) * ${g} - (1 - ${g})`,
        ];
      }),
      `full = (${sum(VOICES.map((i) => `env${String(i)}`))}) / ${String(MUSIC_VOICES)}`,
      "bn = clamp((cb ^ 0.5 - 0.1) / 0.35, 0, 1)",
      "sw = L",
      "wq = 1 - smoothstep(0.09, 0.17, pl - ql)",
    ],
    { sense: 1, ql: 0 },
  ),
  select("audiod", "expression_audiovoice", "d[0-4]"),
  select("audioenv", "expression_audiovoice", "env[0-4] sw"),
  select("audiog", "expression_audiovoice", "G"),
  select("audiovel", "expression_audiovoice", "G"),
  select("audiometerin", "expression_audiovoice", "L G"),
  select("audiometerel", "expression_audioregion", "el"),
  select("audiosect", "expression_audiovoice", "L full bn G wq"),
  select("audiohudsect", "expression_audiovoice", "L full"),
  lag("audioenv", "select_audioenv", expressionSlot("0.12 + 0.4 * op('constant_audiosmooth').chan.value", 0.32), 9),
  member("audiovoice", "valueNormalize", { window: 16 }, ["lag_audiomean"]),

  // Beats, the pump: the level against its own 0.3 s mean, for a kick that moves the whole mix.
  select("audiolevel", "select_audio", "level kick kickCount"),
  expression("audiolvb", ["select_audiolevel"], ["lvb = level"], { level: 0 }),
  lag("audiolvb", "expression_audiolvb", 0.3),
  expression("audiopump", ["select_audiolevel", "lag_audiolvb"], ["kn = max(level / max(lvb, 0.0005) - 1, 0)", "knp = kn"], { level: 0, lvb: 0.001 }),
  select("audiopumpn", "expression_audiopump", "kn"),
  select("audiopumpp", "expression_audiopump", "knp"),
  lag("audiopumppeak", "select_audiopumpp", 0.03, 133),
  expression(
    "audiopumpk",
    ["lag_audiopumppeak", "select_audiopumpn"],
    ["kR = smoothstep(0.45, 0.7, kn / max(knp, 0.05)) * smoothstep(0.05, 0.12, kn)", "ks = smoothstep(0.2, 0.45, kn / max(knp, 0.05))"],
    { kn: 0, knp: 0 },
  ),

  // Beats, the kick: the two rows a kick lives in against their 0.3 s base and their peak.
  select("audiokickb", "select_audio", "band109 band149"),
  expression("audiokickc", ["select_audiokickb"], ["zk1 = band109", "zk2 = band149", "yk1 = band109", "yk2 = band149"], { band109: 0, band149: 0 }),
  select("audiokicky", "expression_audiokickc", "yk1 yk2"),
  select("audiokickz", "expression_audiokickc", "zk1 zk2"),
  lag("audiokicky", "select_audiokicky", 0.03, 500),
  lag("audiokickz", "select_audiokickz", 0.3),
  select("audiokicknl", "lag_audiofloor", "nl"),
  expression(
    "audiokick",
    ["select_audiokickb", "select_audiokicknl", "lag_audiokicky", "lag_audiokickz"],
    ["jk = max(max(band109 - zk1, 0) / max(yk1 - nl, 0.08), max(band149 - zk2, 0) / max(yk2 - nl, 0.08))", "kp = jk"],
    { band109: 0, band149: 0, zk1: 0, zk2: 0, yk1: 0, yk2: 0, nl: 0 },
  ),
  select("audiokickj", "expression_audiokick", "jk"),
  select("audiokickp", "expression_audiokick", "kp"),
  lag("audiokickpeak", "select_audiokickp", 0.03, 133),

  // Beats, snare, hat and drum presence: a drum is a row that FALLS fast after it rises, so
  // presence (`P`) is the fall rate of the snare and hat rows against their peak.
  select("audiobeatb", "expression_audioregion", "b[sh]"),
  select("audiobeatw", "expression_audioregion", "w[sh]"),
  select("audiobeaty", "expression_audioregion", "y[sh]"),
  select("audiobeatz", "expression_audioregion", "z[sh]"),
  member("audiobeat", "valueSlope", {}, ["select_audiobeatw"]),
  expression("audiobeatfall", ["slope_audiobeat"], ["qs = max(0, -ws)", "qh = max(0, -wh)"], { ws: 0, wh: 0 }),
  lag("audiobeatfall", "expression_audiobeatfall", 2.5),
  lag("audiobeatpeak", "select_audiobeaty", 0.03, 500),
  lag("audiobeatbase", "select_audiobeatz", 0.3),
  expression(
    "audiodrums",
    ["lag_audiofloor", "lag_audiobeatpeak", "lag_audiobeatfall"],
    ["gs = smoothstep(1.2, 2.6, qs / max(ys - nl, 0.08))", "gh = smoothstep(1.2, 2.6, qh / max(yh - nl, 0.08))", "P = max(gs, gh)", "gk = P"],
    { nl: 0 },
  ),
  select("audiodp", "expression_audiodrums", "P"),
  select("audiodrums", "expression_audiodrums", "g[ksh] P"),
  select("audiohuddrums", "expression_audiodrums", "P"),
  expression(
    "audiobeat",
    [
      "select_audiog",
      "lag_audiofloor",
      "lag_audiolvb",
      "lag_audiobeatpeak",
      "expression_audiopumpk",
      "select_audiokickj",
      "select_audiodrums",
      "select_audiolevel",
      "lag_audiokickpeak",
      "lag_audiobeatbase",
      "select_audiobeatb",
    ],
    [
      "beatSnare = smoothstep(0.12, 0.45, (bs - zs) / max(ys - nl, 0.08)) * gs * G",
      "beatHat = smoothstep(0.12, 0.45, (bh - zh) / max(yh - nl, 0.08)) * gh * G",
      "beatKick = max(max(max(smoothstep(0.25, 0.7, level / max(lvb, 0.0005) - 1), kR) * (1 - 0.6 * smoothstep(0.8, 1.2, (bs - zs) / max(ys - nl, 0.08))), (kickCount > 0.5) * smoothstep(0.02, 0.15, kick)), smoothstep(0.3, 0.7, jk / max(kp, 0.05)) * ks) * gk * G",
    ],
    { G: 0, nl: 0, level: 0, lvb: 0.001, kick: 0, kickCount: 0, jk: 0, kp: 0, kR: 0, ks: 1 },
  ),
  member("audiobeat", "valueTail", { decay: "exponential", tail: 0.4 }, ["expression_audiobeat"]),
  lag("audiobeat", "tail_audiobeat", 0.07),

  // Beats, the fast set: the same three with no tail, on a quicker presence (0.7 s rise, 3 s hold).
  expression("audiofallf", ["expression_audiobeatfall"], ["fs = qs", "fh = qh"], { qs: 0, qh: 0 }),
  lag("audiofallfast", "expression_audiofallf", 0.7, 4),
  expression(
    "audiopresf",
    ["lag_audiobeatpeak", "lag_audiofloor", "select_audiohuddrums", "lag_audiofallfast"],
    ["Pf = max(P, max(smoothstep(1.2, 2.6, fs / max(ys - nl, 0.08)), smoothstep(1.2, 2.6, fh / max(yh - nl, 0.08))))"],
    { nl: 0, P: 0, fs: 0, fh: 0, ys: 0, yh: 0 },
  ),
  member("audiopresf", "valueTail", { decay: "exponential", tail: 3 }, ["expression_audiopresf"]),
  expression(
    "audiofast",
    [
      "lag_audiofloor",
      "select_audiokickb",
      "lag_audiokickz",
      "tail_audiopresf",
      "lag_audiotempoconf",
      "lag_audiobeatpeak",
      "lag_audiotempoquick",
      "select_audiokickj",
      "expression_audiopumpk",
      "select_audiobeatb",
      "select_audiog",
      "lag_audiobeatbase",
    ],
    [
      "sF = smoothstep(0.12, 0.45, (bs - zs) / max(ys - nl, 0.08)) * Pf * G",
      "hF = smoothstep(0.12, 0.45, (bh - zh) / max(yh - nl, 0.08)) * Pf * G",
      "kF = max(smoothstep(0.35, 0.7, jk) * smoothstep(0.2, 0.45, max(band109 - zk1, band149 - zk2)) * Pf, kR * max(smoothstep(0.15, 0.4, cr), cy * Pf)) * G",
    ],
    { G: 0, nl: 0, Pf: 0, jk: 0, bs: 0, bh: 0, zs: 0, zh: 0, ys: 0, yh: 0, band109: 0, band149: 0, zk1: 0, zk2: 0, kR: 0, cr: 0, cy: 0 },
  ),
  select("audiofast", "expression_audiofast", "kF sF hF"),

  /*
   * Tempo estimate: a tap tempo over the kicks, here because the engine has no live
   * estimator (§T1802b). A Count numbers the kicks; the count and its time are read now and
   * as they were 1.5, 2.5, 3.7 and 5 s ago (four Delays), which gives the mean period over
   * each look-back. The longest is the estimate, the others vote on whether it is steady
   * (`cx`, confidence) and whether a tempo exists at all yet (`cy`, quick). The estimate is
   * folded into 60..180 and held while confidence is up.
   */
  expression("audiotempoko", ["select_audiopumpn", "select_audiog", "expression_audiopumpk", "select_audiodp"], ["ko = kR * G * max(P, smoothstep(0.3, 0.6, kn))"], {
    kR: 0,
    G: 0,
    P: 0,
    kn: 0,
  }),
  select("audiotempoko", "expression_audiotempoko", "ko"),
  member("audiotempo", "valueCount", { holdoff: 0.2, threshold: 0.5 }, ["select_audiotempoko"]),
  expression("audiotempotap", ["count_audiotempo"], upTo(TEMPO_LOOKBACKS.length + 1).flatMap((tap) => [`tc${String(tap)} = ko`, `tt${String(tap)} = abstime - koSince`]), {
    ko: 0,
    koSince: 0,
  }),
  ...upTo(TEMPO_LOOKBACKS.length + 1).map((tap) => select(`audiotempo${String(tap)}`, "expression_audiotempotap", `tc${String(tap)} tt${String(tap)}`)),
  ...TEMPO_LOOKBACKS.map((seconds, index) =>
    member(
      `audiotempo${String(index + 1)}`,
      "valueDelay",
      { frames: expressionSlot(`clamp(round(${seconds} / max(delta, 0.004)), 1, 600)`, Math.round(Number(seconds) * 30)) },
      [`select_audiotempo${String(index + 1)}`],
    ),
  ),
  expression(
    "audiotempoest",
    ["delay_audiotempo3", "select_audiotempo0", "delay_audiotempo1", "delay_audiotempo4", "delay_audiotempo2"],
    [
      "p1 = (tt0 - tt1) / max(tc0 - tc1, 1) + 0.5 * (tc0 - tc1 < 1.5)",
      [2, 3, 4].flatMap((back) => [
        `n${String(back)} = max(round((tt0 - tt${String(back)}) / max(p1, 0.05)), 1)`,
        `p${String(back)} = (tt0 - tt${String(back)}) / n${String(back)}`,
      ]),
      "raw = 60 / clamp(p4, 0.05, 4)",
      ["f1 = raw * 0.5 ^ (raw > 180)", "f2 = f1 * 0.5 ^ (f1 > 180)", "f3 = f2 * 2 ^ (f2 < 60)", "bt = f3 * 2 ^ (f3 < 60)"],
      "fill = (tc0 - tc4) / n4",
      "dev = max(abs(p2 / max(p4, 0.01) - 1), abs(p3 / max(p4, 0.01) - 1))",
      "cx = (tc0 - tc1 > 1.5) * (tc0 - tc2 > 1.5) * (tc0 - tc4 > 4.5) * smoothstep(0.6, 0.85, fill) * (1 - smoothstep(1.1, 1.3, fill)) * (1 - smoothstep(0.015, 0.0375, dev)) * (abstime - tt0 < 1.2)",
      "cy = (tc0 - tc1 > 1.5) * (tc0 - tc2 > 2.5) * (1 - smoothstep(0.03, 0.08, abs(p2 / max(p1, 0.01) - 1))) * (abstime - tt0 < 1.2)",
    ],
    Object.fromEntries(upTo(TEMPO_LOOKBACKS.length + 1).flatMap((tap) => [[`tc${String(tap)}`, 0], [`tt${String(tap)}`, 0]])),
  ),
  select("audiotempobt", "expression_audiotempoest", "bt"),
  select("audiotempocx", "expression_audiotempoest", "cx"),
  select("audiotempocy", "expression_audiotempoest", "cy"),
  lag("audiotempocs", "select_audiotempocx", 1, 0.05),
  lag("audiotempoquick", "select_audiotempocy", 0.4, 8),
  expression("audiotempogate", ["lag_audiotempocs"], ["hg = cx > 0.8", "cr = smoothstep(0.8, 0.95, cx)"], { cx: 0 }),
  select("audiotempocr", "expression_audiotempogate", "cr"),
  lag("audiotempoconf", "select_audiotempocr", 1.5, 8),
  hold("audiotempohold", "select_audiotempobt", "op('expression_audiotempogate').chan.hg"),
  expression(
    "audiotempoout",
    ["constant_audiodeclared", "lag_audiotempoconf", "lag_audiotempohold", "select_audiog"],
    [
      // SHIPPED DIFFERS: the project tests `value < 1.0001`, which reads above 1 for a
      // declared tempo between 1 and 1.0001. The same test as `bpmNow` below.
      "bpmConfidence = (value > 1) + (value <= 1) * cr * G",
      "bpmDetected = bt * (cr * G > 0.3)",
      `bpmNow = ${tempoInEffect("((bpmDetected > 0) * bpmDetected + (bpmDetected <= 0) * bpm)")}`,
    ],
    { bt: 0, cr: 0, G: 0 },
  ),

  // Notes: the lowest and the highest tracked note are the bass and the top voice. Their
  // pitches are held while nothing is tracked (`ga`), and `nwl` says how far to trust them.
  expression(
    "audionrange",
    ["select_audionotes"],
    [
      `nb = ${nest("min", TRACKED_NOTES.map((note) => trackedOr(note, "Pitch", "999")))}`,
      `nm = ${nest("max", TRACKED_NOTES.map((note) => trackedOr(note, "Pitch", "(-1)")))}`,
      "ga = nb < 998",
      `nw = ${nest("max", TRACKED_NOTES.map((note) => `(${tracked(note)} * voice${String(note)}Confidence)`))}`,
    ],
    MISSING_VOICE,
  ),
  select("audionbass", "expression_audionrange", "nb"),
  select("audionmelody", "expression_audionrange", "nm"),
  select("audionw", "expression_audionrange", "nw"),
  hold("audionbass", "select_audionbass", "op('expression_audionrange').chan.ga"),
  hold("audionmelody", "select_audionmelody", "op('expression_audionrange').chan.ga"),
  expression("audionwl", ["select_audionw"], ["nwl = nw"], { nw: 0 }),
  lag("audionw", "expression_audionwl", 0.5, 6),

  // Strikes: a voice strikes when its region jumps above its mean (`d`), or, for the bass
  // and the top while notes are tracked, when their note is struck. A Count with a hold-off
  // accepts them; a Trigger and a Rate count them over 8 s for the form scores.
  expression(
    "audionmap",
    ["lag_audionw", "select_audiodp", "select_audiod", "select_audionotes", "lag_audionmelody", "lag_audionbass"],
    [
      "Bn = (nb < 200) * round(nb) + (nb > 199) * 48",
      "Mx = max((nm > -0.5) * round(nm) + (nm < -0.5) * 72, Bn)",
      `rr = ${nest("max", VOICES.map((i) => `d${String(i)}`))} > -0.05`,
      "wv = smoothstep(0.3, 0.7, nwl)",
      `no0 = ${strikesOn("Bn")}`,
      `no4 = ${strikesOn("Mx")}`,
      "np0 = mod(Bn, 12)",
      "np4 = mod(Mx, 12)",
      VOICES.map((i) => {
        const note = i === 0 ? "no0" : i === MUSIC_VOICES - 1 ? "no4" : "0";
        const byNote = note === "0" ? "0" : "1";
        return `dd${String(i)} = max(${note} * rr * wv - 0.5, d${String(i)} - 2 * max(wv * ${byNote}, P))`;
      }),
      `nd = ${sum(TRACKED_NOTES.map(tracked))}`,
    ],
    { nb: 999, nm: -1, nwl: 0, P: 0, ...Object.fromEntries(VOICES.map((i) => [`d${String(i)}`, -1])), ...MISSING_VOICE },
  ),
  select("audiodd", "expression_audionmap", "dd[0-4]"),
  select("audionp", "expression_audionmap", "np0 np4"),
  select("audiopitch", "expression_audionmap", "Bn Mx wv nd"),
  member("audiostrike", "valueCount", { holdoff: expressionSlot("1.2 + 1.2 * op('constant_audiosmooth').chan.value", 1.8), threshold: 0 }, ["select_audiodd"]),
  member("audiostrike", "valueTrigger", { threshold: 0 }, ["select_audiod"]),
  member("audiostrike", "valueRate", { window: 8 }, ["trigger_audiostrike"]),
  expression("audioonsets", ["select_audiodd"], [
    // SHIPPED DIFFERS: the project published the strike signal raw, and it rests near -0.5
    // (the Count above reads it against 0). Shipped, `voiceNOnset` is that same test as a
    // channel: 1 while a strike is up, 0 at rest. A Count at its default threshold then
    // counts strikes from MusicFeatures and from MidiFeatures alike.
    VOICES.map((i) => `voice${String(i)}Onset = dd${String(i)} >= 0`),
  ]),

  // Harmony: which evidence names the five pitch classes. A chord (`A`), else tracked notes
  // (`N`), else the strongest chroma class (`Bk`), else, with Pitch Fallback, the tilt
  // guess (`Ck`). They are sampled when a chord change is accepted and held between.
  expression("audiochroma", ["select_audiochromain"], [
    `mxc = ${nest("max", PITCH_CLASSES.map((k) => tieBroken(`chroma${String(k)}`, k)))}`,
    `t1 = ${indexOfStrongest(PITCH_CLASSES.map((k) => tieBroken(`chroma${String(k)}`, k)), "mxc")}`,
    `diss = ${dissonance((semitones) => `(${intervalEnergy(semitones)})`)}`,
  ]),
  select("audiodiss", "expression_audiochroma", "diss"),
  select("audiotops", "expression_audiochroma", "t1"),
  expression(
    "audiotonal",
    [
      "select_audioconf",
      "select_audiotops",
      "lag_audionw",
      "select_audiochromain",
      "select_audiodp",
      "constant_audiofallback",
      "select_audionp",
      "select_audiopq",
      "select_audiochord",
    ],
    (() => {
      // The chord's own three classes are masked out; what is left and strong is its extension.
      const outsideChord = PITCH_CLASSES.map((k) => tieBroken(`chroma${String(k)} * ((${String(k)} != R) * (${String(k)} != Tt) * (${String(k)} != Fv))`, k));
      const guess = (voice: number): string => `mod(round(39.486 + 5.398 * q${String(voice)}), 12)`;
      return [
        "A = chordConfidence > 0.001",
        "N = nwl > 0.5",
        "Bk = (1 - A) * (1 - N) * (chromaConfidence > 0.4)",
        "Ck = (1 - A) * (1 - N) * (chromaConfidence < 0.4001) * value",
        "R = round(root)",
        "Tt = mod(R + 4 - (chordQuality > 1.5), 12)",
        "Fv = mod(R + 7, 12)",
        `mxe = ${nest("max", outsideChord)}`,
        `ex = (mxe > 0.25) * (${indexOfStrongest(outsideChord, "mxe")}) + (mxe < 0.2501) * Fv`,
        `p0 = A * R + (1 - A) * N * np0 + Bk * t1 + Ck * ${guess(0)}`,
        `p1 = A * Tt + (1 - A) * N * mod(np0 + 4, 12) + Bk * mod(t1 + 4, 12) + Ck * ${guess(1)}`,
        `p2 = A * Fv + (1 - A) * N * mod(np0 + 7, 12) + Bk * mod(t1 + 7, 12) + Ck * ${guess(2)}`,
        `p3 = A * ex + (1 - A) * N * mod(np0 + 10, 12) + Bk * mod(t1 + 10, 12) + Ck * ${guess(3)}`,
        `p4 = N * np4 + (1 - N) * ((A + Bk) * t1 + Ck * ${guess(4)})`,
        "dct = chordChangeCount - 0.5",
      ];
    })(),
    {
      ...Object.fromEntries(VOICES.map((i) => [`q${String(i)}`, 0])),
      root: 0,
      chordQuality: 0,
      chordConfidence: 0,
      chordChangeCount: 0,
      chromaConfidence: 0,
      nwl: 0,
      P: 0,
      np0: 0,
      np4: 0,
      t1: 0,
      ...MUSIC_TONAL_DEFAULTS,
    },
  ),
  select("audiodct", "expression_audiotonal", "dct"),
  select("audiohold", "expression_audiotonal", "p[0-4]"),
  select("audiohudtonal", "expression_audiotonal", "A N Bk"),
  member("audiochord", "valueCount", { holdoff: expressionSlot("2.5 + 2 * op('constant_audiosmooth').chan.value", 3.5), threshold: 0 }, ["select_audiodct"]),
  expression("audiogate", ["count_audiochord"], ["gr = dctSince < 0.05"], { dctSince: 99 }),
  hold("audiohold", "select_audiohold", "op('expression_audiogate').chan.gr", 3000),

  // Form: three raw scores from level, strike rate and fullness, each also ranked against
  // its own last minute, and a tension score from dissonance where chroma is trusted.
  expression(
    "audiosect",
    ["select_audioconf", "select_audiodiss", "rate_audiostrike", "select_audiosect"],
    [
      `dens = ${sum(VOICES.map((i) => `d${String(i)}`))}`,
      "dn = dens / (dens + 3) * G",
      "sE = 0.05 + 0.4 * L + 0.6 * dn",
      "sL = 0.1 + 0.6 * L + 0.3 * bn * G",
      "sD = 0.08 + 0.4 * L + 0.55 * full",
      ["rE = sE", "rL = sL", "rD = sD", "wl = wq"],
      "wc = smoothstep(0.3, 0.6, chromaConfidence)",
      "sT = ((1 - wc) * (0.1 + 0.35 * bn + 0.3 * dn) + wc * (0.08 + 0.35 * diss + 0.2 * dn + 0.1 * bn)) * G + 0.2 * (1 - G)",
    ],
    { L: 0, full: 0, bn: 0, G: 0, diss: 0, chromaConfidence: 0, wq: 0 },
  ),
  select("audiosectr", "expression_audiosect", "rE rL rD"),
  select("audiosects", "expression_audiosect", "sE sL sD sT wl"),
  select("audiohuddn", "expression_audiosect", "dn"),
  lag("audiosect", "select_audiosects", 6),
  lag("audiosectr", "select_audiosectr", 6),
  member("audiosect", "valueNormalize", { window: 60 }, ["lag_audiosectr"]),

  // Everything per voice, under the contract's names, with the scores.
  expression(
    "audiofeatures",
    [
      "expression_audioonsets",
      "normalize_audiosect",
      "select_audiopitch",
      "select_audiovel",
      "count_audiochord",
      "lag_audiohold",
      "lag_audionw",
      "select_audiodp",
      "constant_audiodense",
      "select_audiochromain",
      "lag_audiosect",
      "count_audiostrike",
      "normalize_audiovoice",
      "lag_audiotempoconf",
      "lag_audioenv",
    ],
    [
      "dense = wl * smoothstep(0.15, 0.4, cr)",
      VOICES.flatMap((i) => {
        const voice = `voice${String(i)}`;
        // Under drums (`P`) a region is mostly drum, so the envelope leans on the chroma at
        // the voice's pitch class, and in dense music (Dense Music × `dense`) on the ranked mean.
        const underDrums = `(1 - value * dense) * (${chromaAt(`p${String(i)}`)}) + value * dense * m${String(i)}`;
        return [
          `${voice}Start = ${startFrom(`dd${String(i)}`)}`,
          `${voice}Envelope = (1 - P) * env${String(i)} + P * G * (0.15 + 0.7 * (${underDrums}))`,
          `${voice}Velocity = env${String(i)}`,
          `${voice}PitchClass = mod(round(p${String(i)}), 12)`,
          `${voice}Onset = ${voice}Onset`,
        ];
      }),
      // Audio knows the octave of the bass and the top only, and only while notes are tracked.
      VOICES.map((i) => `voice${String(i)}Pitch = ${i === 0 ? "(wv > 0.5) * Bn" : i === MUSIC_VOICES - 1 ? "(wv > 0.5) * Mx" : "0"}`),
      "notesConfidence = nwl",
      "noteDensity = nd",
      ["sustain = 0", "soft = 0", "sustainSlow = 0", "softSlow = 0"],
      "root = voice0PitchClass",
      "chordIndex = dct",
      `energy = clamp(0.7 * rE * G + 0.3 * ${SCORE_CURVES.energy} + 0.2 * dense, 0, 1)`,
      `brightness = clamp(0.7 * rL * G + 0.3 * ${SCORE_CURVES.brightness}, 0, 1)`,
      `density = clamp(0.7 * rD * G + 0.3 * ${SCORE_CURVES.density} + 0.15 * dense, 0, 1)`,
      `tension = ${SCORE_CURVES.tension}`,
    ],
    {
      ...Object.fromEntries(VOICES.map((i) => [`dd${String(i)}`, 0])),
      ...Object.fromEntries(VOICES.map((i) => [`dd${String(i)}Since`, 0])),
      ...Object.fromEntries(VOICES.map((i) => [`env${String(i)}`, 0])),
      ...Object.fromEntries(VOICES.map((i) => [`p${String(i)}`, 0])),
      P: 0,
      G: 0,
      sw: 0,
      rE: 0,
      rL: 0,
      rD: 0,
      ...MUSIC_TONAL_DEFAULTS,
      dct: 0,
      sE: 0,
      sL: 0,
      sD: 0,
      sT: 0,
      ...Object.fromEntries(VOICES.map((i) => [`m${String(i)}`, 0.5])),
      wl: 0,
      cr: 0,
    },
  ),
  select("audioscores", "expression_audiofeatures", "root chordIndex tension energy brightness density dense"),

  // The beat count: `bpm` integrated. A Speed has no unbounded mode and starts at the
  // middle of its bounds (§T1797b), so the bounds are symmetric to start at 0.
  // SHIPPED DIFFERS: the project's bounds are ±50000, where `beats` wraps to -50000 after
  // about seven hours at 120. These wrap after sixteen years.
  expression("audiobeatrate", ["expression_audiotempoout"], ["beats = bpmNow / 60"]),
  member("audiobeats", "valueSpeed", { limit: "loop", maximum: BEATS_BOUND, minimum: -BEATS_BOUND }, ["expression_audiobeatrate"]),

  // The six outputs.
  select("audioonset", MUSIC_AUDIO_SOURCE, "onset kick"),
  groupOut("audiolevels", "levels", ["select_audiometerin", "lag_audioenv", "select_audiometerel"], {
    inputLevel: "el",
    gate: "G",
    level: "sw",
    levelFast: "L",
    ...Object.fromEntries(VOICES.map((region) => [`region${String(region)}`, `env${String(region)}`])),
  }),
  groupOut("audiobeats", "beats", ["select_audiohuddrums", "select_audiofast", "lag_audiobeat", "select_audioonset"], {
    onset: "onset",
    onsetLow: "kick",
    kick: "beatKick",
    snare: "beatSnare",
    hat: "beatHat",
    kickFast: "kF",
    snareFast: "sF",
    hatFast: "hF",
    drumPresence: "P",
  }),
  groupOut("audiotempogroup", "tempo", ["expression_audiotempoout", "speed_audiobeats"], {
    bpm: "bpmNow",
    bpmDetected: "bpmDetected",
    bpmConfidence: "bpmConfidence",
    beats: "beats",
    beatPhase: "fract(beats)",
  }),
  select("audionotesout", "expression_audiofeatures", NOTES_OUT),
  groupOut("audioharmony", "harmony", ["select_audioconf", "select_audiodiss", "select_audiokey", "select_audiohudtonal", "select_audioscores"], {
    root: "root",
    chordQuality: "chordQuality",
    chordConfidence: "chordConfidence",
    chordIndex: "chordIndex",
    tonalCenter: "tonalCenter",
    keyMode: "keyMode",
    keyConfidence: "keyConfidence",
    chromaConfidence: "chromaConfidence",
    dissonance: "diss",
    tension: "tension",
    pitchSource: "2 * A + (1 - A) * (3 * N + Bk) + 2 * A * N",
  }),
  groupOut("audioform", "form", ["select_audioscores", "select_audiohuddn", "select_audiohudsect"], {
    energy: "energy",
    brightness: "brightness",
    density: "density",
    dense: "dense",
    onsetRate: "dn",
    fullness: "full",
  }),
];

// ── MidiFeatures ─────────────────────────────────────────────────────────────────────────

/** The MIDI Notes node inside follows this many keys at once. */
const KEY_VOICES = upTo(8);
/** A key voice that still sounds. */
const sounding = (key: number): string => `(voice${String(key)}Envelope > 0.015)`;

/** The bass and the top note as integers (48 and 72 before any key), their span, and the touch curve's exponent. */
const KEY_RANGE_LINES = [
  "Bn = (kb < 200) * round(kb) + (kb > 199) * 48",
  "Mn = (km > -0.5) * round(km) + (km < -0.5) * 72",
  "Mx = max(Mn, Bn)",
  "sp = max(Mx - Bn, 1)",
  "gm = 1.6 - 1.2 * sense",
] as const;

/**
 * The five roles, low to high, each as a 0/1 selector over the key voices: the bass is the
 * key ON the lowest pitch, the top the key on the highest, and each inner role the newest
 * key (highest Id, `id1`…`id3`) in its third of the way between them.
 */
const ROLE_FRACTIONS = ["0.0", "0.25", "0.5", "0.75", "1.0"] as const;
const innerThird = (key: number, role: 1 | 2 | 3): string => {
  const z = `z${String(key)}`;
  const within = role === 1 ? `(${z} < 0.3334)` : role === 2 ? `(${z} > 0.3333) * (${z} < 0.6667)` : `(${z} > 0.6666)`;
  return `n${String(key)} * ${within}`;
};
const inRole = (key: number, role: number): string => {
  if (role === 0) return `(${sounding(key)} * (voice${String(key)}Pitch == Bn))`;
  if (role === MUSIC_VOICES - 1) return `(${sounding(key)} * (voice${String(key)}Pitch == Mx))`;
  const id = `id${String(role)}`;
  return `(${innerThird(key, role as 1 | 2 | 3)} * (voice${String(key)}Id == ${id}) * (${id} > 0))`;
};
/** Σ over the key voices in a role of one of their fields. An indexed pick (§T1794b's family) replaces these. */
const ofRole = (role: number, field: string): string => sum(KEY_VOICES.map((key) => `${inRole(key, role)} * voice${String(key)}${field}`));
const roleLines = (role: number): string[] => {
  const r = String(role);
  return [
    `pr${r} = min(${sum(KEY_VOICES.map((key) => inRole(key, role)))}, 1)`,
    // The modelled envelope through the touch curve, times the pedals (`pl`).
    `ev${r} = max(${ofRole(role, "Envelope")}, 0) ^ gm * pl`,
    `vl${r} = pr${r} * max(${ofRole(role, "Velocity")}, 0.001) ^ gm + (1 - pr${r}) * 0.5`,
    `o${r} = ${ofRole(role, "OnsetCount")}`,
    // An empty role rests at its place between the bass and the top.
    `pt${r} = pr${r} * (${ofRole(role, "Pitch")}) + (1 - pr${r}) * round(Bn + (Mx - Bn) * ${ROLE_FRACTIONS[role]!})`,
  ];
};

/** A struck key's lane: its pitch's place between the bass and the top, in fifths. One note alone strikes lanes 0 and 4. */
const inLane = (key: number, lane: number): string =>
  lane === MIDI_LANES - 1 ? `((pa${String(key)} == ${String(lane)}) + (Mx - Bn < 0.5) * (pa${String(key)} == 0))` : `((pa${String(key)} == ${String(lane)}))`;

const keyFields = (fields: readonly string[], value: (field: string) => number): Record<string, number> =>
  Object.fromEntries(KEY_VOICES.flatMap((key) => fields.map((field) => [`voice${String(key)}${field}`, value(field)])));

const midiMembers: readonly Member[] = [
  // The page's knobs, as channels (§T1800b).
  constant("keyssense", 0.5),
  constant("keyssmooth", 0.5),
  constant("keysdeclared", 0),
  expression("keyssensein", ["constant_keyssense"], ["sense = value"]),

  // The keyboard. Its envelope is a model (MIDI carries no sound): decay 4 s, release 0.15 s.
  member("piano", "midiNotes", {
    bendRange: 2,
    channel: 0,
    decay: 4,
    decayTracking: 0.5,
    device: "",
    halfPedal: true,
    pedalThreshold: 0.5,
    perKey: false,
    release: 0.15,
    voices: KEY_VOICES.length,
  }),
  select("keys", "keys_piano", "voice[0-7]Pitch voice[0-7]Envelope voice[0-7]Held voice[0-7]Velocity voice[0-7]OnsetCount voice[0-7]Id chordConfidence root"),
  select("keyscc", "keys_piano", "chordChangeCount"),
  select("keyschroma", "keys_piano", "chroma[0-9] chroma1[01] noteDensity"),
  select("keyson", "keys_piano", "noteOnCount"),
  select("keyspedalsrc", "keys_piano", "sustain soft"),
  select("keysrange", "keys_piano", "voice[0-7]Pitch voice[0-7]Envelope voice[0-7]Held"),
  select("keyshudfull", "keys_piano", "noteDensity"),
  select("keyskey", "keys_piano", "chord[QC]* key* tonalCenter chromaConfidence"),

  // Strikes as beats: MIDI has no drums, so `onset` is every strike by its velocity and
  // `onsetLow` the strikes below note 48.
  expression("keysbeat", ["select_keys"], [
    `onset = min(${sum(KEY_VOICES.map((key) => `voice${String(key)}OnsetCount * voice${String(key)}Velocity`))}, 1)`,
    `onsetLow = min(${sum(KEY_VOICES.map((key) => `voice${String(key)}OnsetCount * voice${String(key)}Velocity * (voice${String(key)}Pitch < 48)`))}, 1)`,
  ]),

  // The bass is the lowest key still sounding, the top the highest key held; both are held
  // while there is none (`ga`, `gh`).
  expression("keysrange", ["select_keysrange"], [
    `kb = ${nest("min", KEY_VOICES.map((key) => `(${sounding(key)} * voice${String(key)}Pitch + (1 - ${sounding(key)}) * 999)`))}`,
    `km = ${nest("max", KEY_VOICES.map((key) => `(voice${String(key)}Held * voice${String(key)}Pitch + (1 - voice${String(key)}Held) * (-1))`))}`,
    "ga = kb < 998",
    "gh = km > -0.5",
  ]),
  select("keysbass", "expression_keysrange", "kb"),
  select("keysmelody", "expression_keysrange", "km"),
  hold("keysbass", "select_keysbass", "op('expression_keysrange').chan.ga"),
  hold("keysmelody", "select_keysmelody", "op('expression_keysrange').chan.gh"),
  lag("keyspedal", "select_keyspedalsrc", 1.5, 2.3),

  // Eight key voices into five roles.
  expression(
    "keysmap",
    ["lag_keysbass", "lag_keysmelody", "select_keys", "lag_keyspedal", "expression_keyssensein"],
    [
      KEY_RANGE_LINES,
      "pl = 0.7 + 0.5 * sustain - 0.35 * soft",
      KEY_VOICES.flatMap((key) => {
        const k = String(key);
        return [`z${k} = (voice${k}Pitch - Bn) / sp`, `n${k} = ${sounding(key)} * (voice${k}Pitch > Bn) * (voice${k}Pitch < Mx)`];
      }),
      ([1, 2, 3] as const).map((role) => `id${String(role)} = ${nest("max", KEY_VOICES.map((key) => `(${innerThird(key, role)} * voice${String(key)}Id)`))}`),
      VOICES.flatMap(roleLines),
      `lv = (${sum(KEY_VOICES.map((key) => `voice${String(key)}Envelope`))})`,
      "spn = clamp((Mx - Bn) / 36, 0, 1)",
      "rc = (chordConfidence > 0.499) * root + (chordConfidence < 0.5) * mod(Bn, 12)",
      "lvs = lv / (lv + 1.5)",
    ],
    { kb: 999, km: -1, sense: 0.5, sustain: 0, soft: 0 },
  ),
  select("keysenv", "expression_keysmap", "ev[0-4] lvs"),
  select("keyslevel", "expression_keysmap", "lv spn"),
  select("keysonset", "expression_keysmap", "o[0-4]"),
  select("keysrc", "expression_keysmap", "pt[0-4] rc"),
  select("keysvoice", "expression_keysmap", "vl[0-4]"),
  lag("keysenv", "select_keysenv", expressionSlot("0.05 + 0.3 * op('constant_keyssmooth').chan.value", 0.2), 3),
  member("keysstrike", "valueCount", { holdoff: expressionSlot("1.2 + 1.2 * op('constant_keyssmooth').chan.value", 1.8), threshold: 0.5 }, ["select_keysonset"]),
  expression("keysonsets", ["select_keysonset"], [VOICES.map((role) => `voice${String(role)}Onset = o${String(role)}`)]),

  // Chord changes, accepted after a hold-off; the role pitches and the root are sampled then.
  member("keyschord", "valueCount", { holdoff: expressionSlot("1.5 + 2 * op('constant_keyssmooth').chan.value", 2.5), threshold: 0.5 }, ["select_keyscc"]),
  expression("keysgate", ["count_keyschord"], ["gr = chordChangeCountSince < 0.05"], { chordChangeCountSince: 99 }),
  hold("keyshold", "select_keysrc", "op('expression_keysgate').chan.gr"),

  // Lanes (MIDI only): every strike, unheld, by where it lies between the bass and the top.
  expression(
    "keysonset",
    ["lag_keysmelody", "lag_keysbass", "expression_keyssensein", "select_keys"],
    [
      KEY_RANGE_LINES,
      KEY_VOICES.flatMap((key) => {
        const k = String(key);
        return [`pa${k} = round(clamp((voice${k}Pitch - Bn) / sp, 0, 1) * 4)`, `st${k} = (voice${k}OnsetCount > 0.5) * ${sounding(key)}`];
      }),
      upTo(MIDI_LANES).flatMap((lane) => [
        `lane${String(lane)}Onset = min(${sum(KEY_VOICES.map((key) => `st${String(key)} * ${inLane(key, lane)}`))}, 1)`,
        `lane${String(lane)}Velocity = ${nest("max", ["0", ...KEY_VOICES.map((key) => `st${String(key)} * ${inLane(key, lane)} * max(voice${String(key)}Velocity, 0.001) ^ gm`)])}`,
      ]),
    ],
    { kb: 999, km: -1, sense: 0.5, ...keyFields(["Pitch", "Envelope", "Velocity", "OnsetCount"], (field) => (field === "Pitch" ? 60 : 0)) },
  ),
  select("keyslanes", "expression_keysonset", "lane*"),

  // Form and harmony scores from what is played: note rate over 8 s, summed level, spread.
  member("keys", "valueRate", { window: 8 }, ["select_keyson"]),
  expression(
    "keyssect",
    ["select_keyschroma", "rate_keys", "select_keyslevel"],
    [
      [1, 2, 3, 4, 5, 6].map((semitones) => `S${String(semitones)} = ${intervalEnergy(semitones)}`),
      `diss = ${dissonance((semitones) => `S${String(semitones)}`)}`,
      "rn = noteOnCount / (noteOnCount + 4)",
      "lvn = lv / (lv + 1.5)",
      "sE = 0.05 + 0.45 * rn + 0.5 * lvn",
      "sL = 0.1 + 0.75 * lvn",
      "sD = 0.08 + 0.4 * clamp(noteDensity / 16, 0, 1) + 0.35 * lvn",
      "sT = 0.08 + 0.45 * diss + 0.1 * spn + 0.12 * rn",
    ],
    { noteOnCount: 0, lv: 0, spn: 0, noteDensity: 0 },
  ),
  select("keyssects", "expression_keyssect", "sE sL sD sT"),
  select("keyshudsect", "expression_keyssect", "rn lvn"),
  lag("keyssect", "select_keyssects", 6),

  // Everything per voice, under the contract's names, with the scores.
  expression("keyspedalraw", ["select_keyspedalsrc"], ["sustainRaw = sustain", "softRaw = soft"]),
  expression(
    "keysfeatures",
    [
      "select_keysvoice",
      "count_keysstrike",
      "lag_keysenv",
      "select_keyshudfull",
      "lag_keyshold",
      "count_keyschord",
      "lag_keyssect",
      "lag_keyspedal",
      "expression_keysonsets",
      "expression_keyspedalraw",
    ],
    [
      VOICES.flatMap((role) => {
        const r = String(role);
        const voice = `voice${r}`;
        return [
          `${voice}Start = ${startFrom(`o${r}`)}`,
          `${voice}Envelope = ev${r}`,
          `${voice}Velocity = vl${r}`,
          `${voice}Pitch = round(pt${r})`,
          `${voice}PitchClass = mod(round(pt${r}), 12)`,
          `${voice}Onset = ${voice}Onset`,
        ];
      }),
      "notesConfidence = 1",
      "noteDensity = noteDensity",
      // The lagged pedals arrive under the raw names (a Lag publishes under its input's
      // name), so the raw ones come in renamed and take the names back last (§T1794b).
      ["sustainSlow = sustain", "softSlow = soft", "sustain = sustainRaw", "soft = softRaw"],
      "root = mod(round(rc), 12)",
      "chordIndex = chordChangeCount",
      Object.entries(SCORE_CURVES).map(([score, curve]) => `${score} = ${curve}`),
    ],
    {
      ...Object.fromEntries(VOICES.map((role) => [`ev${String(role)}`, 0])),
      ...Object.fromEntries(VOICES.map((role) => [`o${String(role)}`, 0])),
      ...Object.fromEntries(VOICES.map((role) => [`o${String(role)}Since`, 0])),
      ...Object.fromEntries(VOICES.map((role) => [`vl${String(role)}`, 0.5])),
      ...Object.fromEntries(VOICES.map((role) => [`pt${String(role)}`, 48 + 6 * role])),
      rc: 0,
      chordChangeCount: 0,
      sE: 0.05,
      sL: 0.1,
      sD: 0.08,
      sT: 0.2,
      sustain: 0,
      soft: 0,
    },
  ),
  select("keysscores", "expression_keysfeatures", "root chordIndex tension energy brightness density"),

  // The beat count, as in MusicFeatures: there is nothing to detect, so `bpm` is the declared
  // tempo or the project's. SHIPPED DIFFERS: the bounds, as there.
  expression("keysbeatrate", ["constant_keysdeclared"], [`beats = ${tempoInEffect("bpm")} / 60`]),
  member("keysbeats", "valueSpeed", { limit: "loop", maximum: BEATS_BOUND, minimum: -BEATS_BOUND }, ["expression_keysbeatrate"]),

  // The seven outputs. What a keyboard cannot know reads its rest value.
  groupOut("keyslevels", "levels", ["lag_keysenv", "select_keyshudsect", "select_keyshudfull"], {
    ...zeros(channelNames(MUSIC_FEATURE_GROUPS.levels)),
    gate: "noteDensity > 0",
    level: "lvs",
    levelFast: "lvn",
  }),
  groupOut("keysbeats", "beats", ["expression_keysbeat"], { ...zeros(channelNames(MUSIC_FEATURE_GROUPS.beats)), onset: "onset", onsetLow: "onsetLow" }),
  groupOut("keystempogroup", "tempo", ["speed_keysbeats", "constant_keysdeclared"], {
    bpm: tempoInEffect("bpm"),
    bpmDetected: "0",
    bpmConfidence: "value > 1",
    beats: "beats",
    beatPhase: "fract(beats)",
  }),
  select("keysnotesout", "expression_keysfeatures", NOTES_OUT),
  groupOut("keysharmony", "harmony", ["expression_keyssect", "select_keyskey", "select_keysscores"], {
    root: "root",
    chordQuality: "chordQuality",
    chordConfidence: "chordConfidence",
    chordIndex: "chordIndex",
    tonalCenter: "tonalCenter",
    keyMode: "keyMode",
    keyConfidence: "keyConfidence",
    chromaConfidence: "chromaConfidence",
    dissonance: "diss",
    tension: "tension",
    pitchSource: "3",
  }),
  groupOut("keysform", "form", ["select_keysscores", "select_keyshudfull", "select_keyshudsect"], {
    energy: "energy",
    brightness: "brightness",
    density: "density",
    dense: "0",
    onsetRate: "rn",
    fullness: "clamp(noteDensity / 16, 0, 1)",
  }),
];

// ── The two hosts ────────────────────────────────────────────────────────────────────────

export interface FeatureComponentSource {
  /** The host document's graph: the members, and around them a source, one tap an output and a picture. */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** The members: what is selected and saved as the component. */
  readonly selection: readonly NodeId[];
  /** Socket names by the inner endpoint each crosses on (`starter-components.ts`, `portNames`). */
  readonly portNames: Readonly<Record<string, string>>;
  /** The sockets top to bottom, as boundary node ids (`starter-components.ts`, `socketOrder`). */
  readonly socketOrder: { readonly inputs: readonly NodeId[]; readonly outputs: readonly NodeId[] };
  readonly publish: readonly PublishedParameter[];
  /** The tap outside each output, by group: `select_levels`, … What the host's picture and the tests read. */
  readonly taps: Readonly<Record<string, NodeId>>;
}

const number = (label: string, value: number, min: number, max: number, step: number, description: string): PublishedParameter["definition"] => ({
  type: "number",
  label,
  default: value,
  min,
  max,
  range: "bounded",
  step,
  description,
});

/** One tap an output, right of the instance: the cut wire is what makes the output socket, and the tap gives its bag a name to read. */
const taps = (outputs: Readonly<Record<string, string>>): Outside[] =>
  Object.entries(outputs).map(([group, from], index) => outside([COLUMN, index * ROW], select(group, from, "*")));
/** A synthesized Out is `out_<socket name>`; an In is `in_<socket name>`. */
const outputSockets = (outputs: Readonly<Record<string, string>>): NodeId[] => Object.keys(outputs).map((group) => `out_${group}`);
const tapNames = (outputs: Readonly<Record<string, string>>): Record<string, NodeId> =>
  Object.fromEntries(Object.keys(outputs).map((group) => [group, `select_${group}`]));
const outputNames = (outputs: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(outputs).map(([group, from]) => [`${from}.out`, group]));

/** The host's picture, under the instance: a disc whose brightness is one channel of one tap. Enough to see the component run. */
const picture = (brightness: string): Outside[] => [
  outside([-COLUMN, -2 * ROW], member("pulse", "circle", { center: [0.5, 0.5], radius: [0.16, 0.28], softness: 0.02, fillcolor: [1, 0.86, 0.6, 1], bgcolor: [0.02, 0.02, 0.03, 1] })),
  outside([0, -2 * ROW], member("pulse", "level", { brightness: expressionSlot(brightness, 0.3) }, [["input", "circle_pulse"]])),
  outside([COLUMN, -2 * ROW], member("main", "output", {}, [["input", "level_pulse"]])),
];

const MUSIC_OUTPUTS = {
  levels: "expression_audiolevels",
  beats: "expression_audiobeats",
  tempo: "expression_audiotempogroup",
  notes: "select_audionotesout",
  harmony: "expression_audioharmony",
  form: "expression_audioform",
} as const satisfies Record<MusicFeatureGroup, string>;

/**
 * MusicFeatures' host: a beat and a progression outside, the component, six taps.
 *
 * Audio Pattern plays 120 and Tone Pattern 60, so a chord lasts two bars of the beat: 4 s,
 * longer than the 3.5 s a chord change is held off at the default Smoothing, so `root`
 * follows every chord.
 */
export const musicFeaturesSource: FeatureComponentSource = (() => {
  const around = [
    outside([-COLUMN, 0], member("beat", "audioPattern", { bpm: 120, amount: 1 })),
    outside([-COLUMN, ROW], member("song", "tonePattern", { bpm: 60, key: 2, mode: "major", amount: 1 })),
    ...taps(MUSIC_OUTPUTS),
    ...picture("0.3 + 0.9 * op('select_beats').chan.kick"),
  ];
  return {
    ...assemble(musicMembers, around),
    selection: musicMembers.map((entry) => entry.node.id),
    portNames: {
      "select_audio.in": "audio",
      "select_audioonset.in": "audio",
      "switch_tonalchroma.in1": "tonal",
      "switch_tonalchord.in1": "tonal",
      "switch_tonalnotes.in1": "tonal",
      ...outputNames(MUSIC_OUTPUTS),
    },
    socketOrder: { inputs: ["in_audio", "in_tonal"], outputs: outputSockets(MUSIC_OUTPUTS) },
    taps: tapNames(MUSIC_OUTPUTS),
    publish: [
      {
        key: "sensitivity",
        definition: number("Sensitivity", 1, 0, 2, 0.01, "0 strict, 1 normal, 2 rescues a very quiet input: the gate thresholds, the range floor and the strike threshold."),
        targets: [{ nodeId: "constant_audiosense", key: "value" }],
      },
      {
        key: "smoothing",
        definition: number("Smoothing", 0.5, 0, 1, 0.01, "0 quick, 1 slow: the envelope lag (0.12 to 0.52 s), the strike hold-off (1.2 to 2.4 s) and the chord hold-off (2.5 to 4.5 s)."),
        targets: [{ nodeId: "constant_audiosmooth", key: "value" }],
      },
      {
        key: "denseMusic",
        definition: number("Dense Music", 0.65, 0, 1, 0.01, "How far the voice envelopes fall back to the ranked band means while the music is a wall of sound with a steady tempo."),
        targets: [{ nodeId: "constant_audiodense", key: "value" }],
      },
      {
        key: "declaredBpm",
        definition: number("Declared BPM", 0, 0, 300, 1, "Above 1: the tempo, claimed at confidence 1. 0: detect it; bpm falls back to the project tempo while nothing is detected."),
        targets: [{ nodeId: "constant_audiodeclared", key: "value" }],
      },
      {
        key: "hitDecay",
        definition: number("Hit Decay", 0.4, 0.05, 2, 0.01, "Seconds the tail of kick, snare and hat takes to fall."),
        targets: [{ nodeId: "tail_audiobeat", key: "tail" }],
      },
      {
        key: "pitchFallback",
        definition: number("Pitch Fallback", 0, 0, 1, 1, "1 guesses pitch classes from the spectral tilt when no chord, note or chroma is known; 0 leaves them at 0."),
        targets: [{ nodeId: "constant_audiofallback", key: "value" }],
      },
    ],
  };
})();

const MIDI_OUTPUTS = {
  levels: "expression_keyslevels",
  beats: "expression_keysbeats",
  tempo: "expression_keystempogroup",
  notes: "select_keysnotesout",
  harmony: "expression_keysharmony",
  form: "expression_keysform",
  lanes: "select_keyslanes",
} as const satisfies Record<MusicFeatureGroup | "lanes", string>;

/** MidiFeatures' host: the keyboard is inside, so there is no source to wire. Seven taps and the picture. */
export const midiFeaturesSource: FeatureComponentSource = (() => {
  const around = [...taps(MIDI_OUTPUTS), ...picture("0.3 + 0.9 * op('select_levels').chan.level")];
  return {
    ...assemble(midiMembers, around),
    selection: midiMembers.map((entry) => entry.node.id),
    portNames: outputNames(MIDI_OUTPUTS),
    socketOrder: { inputs: [], outputs: outputSockets(MIDI_OUTPUTS) },
    taps: tapNames(MIDI_OUTPUTS),
    publish: [
      {
        key: "device",
        definition: { type: "string", label: "Device", default: "", description: "MIDI input port id. Empty = any attached input." },
        targets: [{ nodeId: "keys_piano", key: "device" }],
      },
      {
        key: "channel",
        definition: number("Channel", 0, 0, 16, 1, "The MIDI channel, 1 to 16. 0 listens to all of them."),
        targets: [{ nodeId: "keys_piano", key: "channel" }],
      },
      {
        key: "sensitivity",
        definition: number("Sensitivity", 0.5, 0, 1, 0.01, "The touch curve: 0 needs a firm touch, 1 reads a light touch as strong."),
        targets: [{ nodeId: "constant_keyssense", key: "value" }],
      },
      {
        key: "smoothing",
        definition: number("Smoothing", 0.5, 0, 1, 0.01, "0 quick, 1 slow: the envelope lag (0.05 to 0.35 s), the strike hold-off (1.2 to 2.4 s) and the chord hold-off (1.5 to 3.5 s)."),
        targets: [{ nodeId: "constant_keyssmooth", key: "value" }],
      },
      {
        key: "declaredBpm",
        definition: number("Declared BPM", 0, 0, 300, 1, "Above 1: the tempo, claimed at confidence 1. 0: bpm is the project tempo, at confidence 0."),
        targets: [{ nodeId: "constant_keysdeclared", key: "value" }],
      },
    ],
  };
})();

/** The contract a tap's bag is held to, by tap: the six shared groups, and `lanes` on MidiFeatures. */
export const contractOf = (group: string): readonly FeatureChannel[] =>
  group === "lanes" ? MIDI_LANE_CHANNELS : MUSIC_FEATURE_GROUPS[group as MusicFeatureGroup];
