/**
 * THE EXAMPLE CAPABILITY VOCABULARY (T1162), and the categories that project out of it.
 *
 * Moved here whole by T1211, unchanged, because it now has TWO readers that cannot import
 * each other. `src/editor/library/example-catalogue.ts` derives a card's badges in the
 * browser off a Vite glob; `src/mcp/serve.ts` derives the SAME badges in Node off
 * `readdirSync`, so an MCP client can ask "which examples demonstrate points" without a
 * repo. Neither module can be imported by the other's runtime — one is `import.meta.glob`,
 * the other is `node:fs` — and T1162's whole argument was that a second copy of a tag list
 * is a list that goes stale. So the table lives where both can reach it, and this file
 * imports NOTHING: it is the derivation and no part of the reading.
 */

/**
 * THE EXAMPLE CATEGORIES (T846) — six, DERIVED from the node types the file uses.
 *
 * Derived rather than declared, and the choice is forced by §V88 more than by taste. An
 * explicit field would have to live somewhere: in the `.loom.json`, where it would be a
 * key the document schema does not name (the exact thing §T848 is preparing to gate), or
 * in a table beside the catalogue's glob, which is the "second table to keep in sync" the read
 * above already refuses. Derivation reads the SAME BYTES the runner gates on, so a
 * category cannot disagree with the file it describes, and a new example is categorised
 * the moment it is dropped in — §T732's rule that the category set grow with the
 * catalogue rather than with someone's memory.
 *
 * `image` is the fallback, not a bucket someone forgot to fill: an example that reaches
 * it uses no audio, no footage, no camera, no point system and no feedback loop, which
 * is a real and recognisable kind of file — a flat texture chain.
 */
export type ExampleCategory = "audio" | "video" | "3d" | "points" | "feedback" | "image";

/**
 * THE CAPABILITY TAGS (T1162) — what the example DEMONSTRATES, as opposed to what it
 * looks like.
 *
 * The owner's complaint was that a name plus a sentence of scene prose does not say what
 * a file is FOR: "Marionette is demonstrating pose, that is not clear." E34 Lidar opens
 * "a mast at the origin sweeps a ring of 240 rays over a dark terrain", which is the
 * picture and not the capability.
 *
 * A TAG IS A SUPERSET OF A CATEGORY, and that is the whole reason it earns its place
 * beside one. `categoryOf` is single-label WITH PRECEDENCE — E32 Pasture is filed under
 * `points` and its two feedback loops are invisible; E44 Sounding is filed under `video`
 * and its point cloud is invisible; E45 Pulse is `audio` and it is also a 3D scene full
 * of points. 15 examples close a temporal loop and 3 of them are categorised `feedback`.
 * So the tags are the multi-label truth the precedence throws away, plus four capabilities
 * the category taxonomy has no word for at all.
 *
 * DERIVED, never authored per example. An authored tag list is the artefact that goes
 * quietly wrong: E54 was rebuilt from a Laplacian into a trail system and E56 from a
 * position map into a rate drive within a week of each other, and hand-written tags would
 * still be describing the files they used to be. What IS authored here is one row per
 * capability — ten of them, not one per example — and every node type a row names is
 * checked against the registry by `example-tags.test.ts`, so a renamed node reddens a gate
 * rather than silently emptying a tag.
 */
export type ExampleTag = ExampleCategory | "wgsl" | "vision" | "device" | "component";

export interface Capability<Tag extends ExampleTag = ExampleTag> {
  readonly tag: Tag;
  /** What the badge says. Terse: the card's description carries the sentence. */
  readonly label: string;
  /** What the badge MEANS, on hover. A definition of the tag, never a claim about a file. */
  readonly meaning: string;
  /** Node types that earn the tag. Every one is asserted to be a registered type. */
  readonly nodeTypes: ReadonlySet<string>;
  /** Type PREFIX that earns the tag — component instances are `component:<name>@<v>`. */
  readonly typePrefix?: string;
}

/**
 * The MEDIUM rows, in PRECEDENCE ORDER — and the category taxonomy is now a projection of
 * exactly these (first match wins, `image` when none does).
 *
 * Precedence is the whole design of the CATEGORY, because the interesting examples match
 * several. The order runs from the ingredient that most changes what the file IS to the
 * one that least does: an audio input changes what every downstream parameter MEANS, so
 * E45 Pulse is an audio example even though it is also a 3D scene full of points; footage
 * changes where the picture comes from, so E44 Sounding is a video example even though
 * what it renders is a point cloud; a camera makes it a 3D scene; points make it a point
 * system; a feedback edge makes it a simulation.
 *
 * §V487/§V748: these sets were the body of `CATEGORY_SIGNATURES` and are unchanged, so
 * every shipped example keeps the category it had — `example-tags.test.ts` pins that by
 * asserting `categoryOf` IS the first medium tag for all 57. The tags do not re-derive
 * them; there is one table and two readings of it.
 *
 * Measured over the 57 examples shipped at T1162, audio / video / 3d / points / feedback /
 * image runs 17 / 14 / 17 / 26 / 15 / 14 AS TAGS and 17 / 8 / 9 / 6 / 3 / 14 AS CATEGORIES.
 * Precedence costs `points` twenty files and `feedback` twelve, and that gap is the whole
 * argument for shipping both readings rather than one.
 */
const MEDIUM_SIGNATURES: readonly Capability<ExampleCategory>[] = [
  {
    tag: "audio",
    label: "audio",
    meaning: "A sound signal drives the graph: an audio file, a beat pattern, or a meter.",
    nodeTypes: new Set(["audioFileIn", "audioPattern", "analyze", "channelIn"]),
  },
  {
    tag: "video",
    label: "video",
    meaning: "Footage, a live camera, or an external video stream is in the chain.",
    nodeTypes: new Set(["movieFileIn", "webcam", "depth", "slitScan", "syphonIn", "syphonOut", "ndiIn", "ndiOut", "spoutIn", "spoutOut"]),
  },
  {
    tag: "3d",
    label: "3D",
    meaning: "A 3D scene: a camera, geometry, lights and materials rendered to a texture.",
    nodeTypes: new Set([
      "camera",
      "geometry",
      "light",
      "materialUnlit",
      "materialPhong",
      "materialGlass",
      "render",
      "projector",
    ]),
  },
  {
    tag: "points",
    label: "points",
    meaning: "A GPU point system: attributes in buffers, a kernel over them, an instanced draw.",
    nodeTypes: new Set([
      "pointBox",
      "pointGenerator",
      "pointGrid",
      "pointKernel",
      "pointKernelAdvanced",
      "pointLine",
      "pointProximity",
      "pointRay",
      "pointSphere",
      "pointTopology",
      "pointTorus",
      "pointTube",
      "pointsFromTexture",
      "renderInstances",
      "renderPoints",
      "textureToAttribute",
    ]),
  },
  {
    // `feedback` only. `cache` was in this set and taken back out: three examples hold a
    // frame without being simulations, and it pulled them out of the categories that
    // actually describe them.
    tag: "feedback",
    label: "feedback",
    meaning: "Closes a temporal loop: this frame reads the frame before it.",
    nodeTypes: new Set(["feedback"]),
  },
];

/**
 * The medium fallback. Reached when an example uses no audio, no footage, no camera, no
 * point system and no feedback loop — a flat texture chain, which is a real and
 * recognisable kind of file and not a bucket someone forgot to fill. 14 of the 57 shipped
 * examples reach it.
 *
 * The SAME predicate as the category fallback, deliberately: `image` is in the tags exactly
 * when the category is `image`, so the two never say different things about the same file.
 * Half of those 14 also carry `wgsl`, which is the pairing that makes the fallback worth
 * rendering at all — "a flat texture chain, with a hand-written shader in it" is a real
 * description, and neither half says it alone.
 */
const IMAGE: Capability<ExampleCategory> = {
  tag: "image",
  label: "image",
  meaning: "A flat texture chain: generators and per-pixel filters, no simulation and no scene.",
  nodeTypes: new Set(),
};

/**
 * The TECHNIQUE rows. No category counterpart, which is the point of them — these are the
 * four things the six-bucket taxonomy has no word for, and three of the four are what
 * §T728's coverage census is about.
 *
 * They do not participate in `categoryOf`. Adding one cannot move an example between
 * groups; it can only add a badge.
 */
const TECHNIQUE_SIGNATURES: readonly Capability[] = [
  {
    tag: "wgsl",
    label: "WGSL",
    meaning: "Carries hand-written WGSL — a shader authored in the file rather than a node chain.",
    nodeTypes: new Set(["customWgsl"]),
  },
  {
    // `depth` is deliberately in BOTH this row and `video`: it reads footage AND infers
    // structure from it. Tags are multi-label, so it does not have to be filed as one
    // or the other the way a category does.
    tag: "vision",
    label: "vision",
    meaning: "Infers structure from an image on-device: body pose, a person matte, or depth.",
    nodeTypes: new Set(["pose", "personMask", "matte", "depth"]),
  },
  {
    // `laserPath` with no `laserOut` is E49 and E50: they PLAN for the hardware without
    // opening the DAC, which is why the meaning says "plans or drives" rather than "sends".
    tag: "device",
    label: "device",
    meaning: "Plans or connects external devices and streams: laser, OSC, MIDI, Syphon, or NDI.",
    nodeTypes: new Set(["oscIn", "oscOut", "laserOut", "laserPath", "midiIn", "syphonIn", "syphonOut", "ndiIn", "ndiOut", "spoutIn", "spoutOut"]),
  },
  {
    tag: "component",
    label: "component",
    meaning: "Instantiates a component — a subgraph reused as one node, flattened at compile.",
    nodeTypes: new Set(),
    typePrefix: "component:",
  },
];

/** Every capability row, in the order a card renders them: medium first, then technique. */
export const EXAMPLE_CAPABILITIES: readonly Capability[] = [
  ...MEDIUM_SIGNATURES,
  IMAGE,
  ...TECHNIQUE_SIGNATURES,
];

function earns(capability: Capability, used: ReadonlySet<string>): boolean {
  for (const type of used) {
    if (capability.nodeTypes.has(type)) return true;
    if (capability.typePrefix !== undefined && type.startsWith(capability.typePrefix)) return true;
  }
  return false;
}

/**
 * Every capability a set of node types earns, medium tags first. Never empty: an example
 * that earns no medium tag earns `image`, which is the same predicate `categoryOf` falls
 * back on, so `image` is in the tags exactly when the category is `image`.
 *
 * Pure, so the gate can call it on a fixture with the capability and a fixture without.
 */
export function tagsOf(nodeTypes: Iterable<string>): readonly ExampleTag[] {
  const used = new Set(nodeTypes);
  const medium = MEDIUM_SIGNATURES.filter((capability) => earns(capability, used));
  const technique = TECHNIQUE_SIGNATURES.filter((capability) => earns(capability, used));
  return [...(medium.length === 0 ? [IMAGE] : medium), ...technique].map(({ tag }) => tag);
}

/** The card's label and hover meaning for one tag. */
export function capabilityOf(tag: ExampleTag): Capability {
  const capability = EXAMPLE_CAPABILITIES.find((entry) => entry.tag === tag);
  // Unreachable through `tagsOf`, which only ever returns rows from this same list; the
  // throw is for a caller that invents a tag rather than deriving one.
  if (capability === undefined) throw new Error(`no capability row for tag ${tag}`);
  return capability;
}

/**
 * The category for a set of node types: the FIRST medium tag, or `image`. Pure, so the
 * gate can call it on a fixture.
 */
export function categoryOf(nodeTypes: Iterable<string>): ExampleCategory {
  const used = new Set(nodeTypes);
  return MEDIUM_SIGNATURES.find((capability) => earns(capability, used))?.tag ?? IMAGE.tag;
}

/**
 * Markdown stripped to the plain sentence a card shows.
 *
 * Only the inline forms the example docs actually use — code spans, links, bold, italic.
 * Not a markdown parser: this reads one paragraph of curated prose, and a parser here
 * would be machinery for a job the corpus does not have.
 */
function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The description: the `.md`'s first PROSE paragraph.
 *
 * Every shipped example opens `# En — Name`, a blank line, then the sentence that says
 * what the thing is. Headings, fences, tables, quotes and list items are skipped so the
 * rule survives a file that opens differently, and a file with no prose at all yields
 * "" rather than a heading masquerading as a description.
 */
export function firstParagraph(markdown: string): string {
  for (const block of markdown.split(/\n[ \t]*\n/)) {
    const text = block.trim();
    if (text === "") continue;
    if (NOT_PROSE.test(text)) continue;
    return plainText(text);
  }
  return "";
}

/**
 * Blocks that are structure rather than sentences.
 *
 * The list markers require a FOLLOWING SPACE, and that is not fussiness — `*` and `-`
 * open a bullet only when spaced, and a bare `[-*+]` guard silently swallows any
 * paragraph that opens in **bold** or *italic*. No shipped example does today; the guard
 * that assumes none ever will is the kind that fails on the file nobody re-checked.
 */
const NOT_PROSE = /^(#|>|\||```|<|[-*+][ \t]|\d+[.)][ \t]|-{3,}$)/;
