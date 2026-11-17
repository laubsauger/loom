import { isComponentNodeType } from "../components/component-type.ts";

/**
 * A NODE'S NAME CARRIES ITS KIND: `kind_role` (T1593b, owner's ruling 2026-10-05).
 *
 * `slider_lamp`, `light_lamp`, `blur_diffuse`, `lfo_pathx`. The kind is a prefix, the way
 * TouchDesigner practice names operators (`null_out`, `constant_color`), so a node says what
 * it is on the canvas at any zoom and inside every `op('…')` that reads it. A new node is
 * auto-named `kind` + number (`blur1`, `kernel1`, §V129), which already conforms; a rename
 * keeps the prefix and the person types the role.
 *
 * ## The three conforming forms
 *
 *     kind            blur
 *     kind<digits>    blur1, blur12        (what auto-naming mints)
 *     kind_<role>     blur_diffuse, lfo_path_x, geometry_car01
 *
 * A KIND is lowercase ASCII letters only: no digit and no underscore. That is what makes
 * the name parse one way: the kind is everything before the first underscore, or before
 * the trailing digits. A ROLE is letters, digits and underscores, starting with a letter or
 * a digit. Nothing else: a space, a comma, a dot or a colon in a name breaks one of the
 * reference forms that hold names (a name list splits on spaces and commas, a preset target
 * is `name.key`, a legacy channel is `name:channel`), and TouchDesigner allows the same
 * three classes for the same reason. Letters and digits are Unicode, not only ASCII:
 * nothing in the reference grammar needs ASCII.
 *
 * ## ONE TABLE, and why the kind is not a field on each definition
 *
 * The kinds are one shared namespace, like TouchDesigner's operator type names. Whether
 * two types may share a word is a property of the SET, and it can only be reviewed as a
 * list. The functions that use a kind (`conformsToKind`, auto-naming, the rename rule, the
 * shipped-name gate, the example builders, the phase 2 sweep) are pure functions of
 * `(name, type)` and run where no registry is in hand. So the table lives here, in the
 * domain, beside the naming rule, exactly as `SOURCE_REFERENCE_PARAMETERS` does. It is
 * TOTAL: every registered type has a row, and `src/examples/node-names.test.ts` (on
 * `pnpm test:gates`) fails by name when a new type lands without one.
 *
 * A type the table does not hold (a test fixture, a definition registered at runtime)
 * falls back to today's base, `nameBaseFor(type)`.
 *
 * ## STORED NAMES NEVER MOVE
 *
 * A kind is read when a name is MINTED or CHECKED, never when a document is loaded.
 * Changing a row changes what the next new node is called and what the gate asks of
 * shipped documents; it rewrites nothing. A node named `pointkernel1` yesterday is still
 * `pointkernel1` today, and every reference to it still resolves.
 *
 * ## How each kind was chosen
 *
 * 1. The type, lowercased, when that is one word: `blur`, `noise`, `feedback`.
 * 2. A leading FAMILY word is dropped. `point…`, `value…`, `custom…`, `component…` and
 *    `render…` say which shelf the node is on, and the node's body wash and port colours
 *    already say that; the kind names the operation. `pointKernel` → `kernel`,
 *    `valueMath` → `math`, `customWgsl` → `wgsl`, `renderInstances` → `instances`.
 * 3. A file input is named for its medium: `movieFileIn` → `movie`, `meshFileIn` → `mesh`.
 * 4. A compound stays whole when no single word says it: `cornerpin`, `camerablur`.
 *
 * The word is the one the library shows as the node's title wherever that is possible, so
 * a kind can be looked up by typing it.
 */

/**
 * ## A COMPONENT INSTANCE IS NAMED FOR ITS COMPONENT (ruled 2026-10-05, phase 1b)
 *
 * An instance of Bloom is `bloom1`, then `bloom_glow`. Its kind is THE COMPONENT'S OWN
 * NAME, lowercased to the kind character set (`kindFromName`): to a reader an instance of
 * Bloom is "a bloom", exactly as a Blur is "a blur". It is not `comp`: that would say only
 * that the node is a component, which the stacked card on the canvas already says.
 *
 * So an instance's kind is NOT a function of its type string. The type carries the
 * component's id (`component:cmp_7@2`), and an id is opaque: a saved component's id is
 * minted, not spelled from its name. The name lives on the component's definition, which
 * the registry hands out as the instance's `title`. `kindOf` takes that pair; `kindOfType`
 * refuses an instance type by name rather than answer with a word that is wrong.
 *
 * Two consequences, both deliberate:
 *
 *  - A component MAY share a word with a built-in kind. One called "Blur" makes instances
 *    of kind `blur`, numbered in the same sequence as Blur nodes (`blur1`, `blur2`), so
 *    names stay unique. To the reader it is that kind of thing, and conformance is a
 *    question about a name and a kind, never about which type holds the kind.
 *  - RENAMING A COMPONENT RENAMES NO NODE. A kind is read when a name is minted or
 *    checked, so instances made under the old name keep it and every reference to them
 *    still resolves. They simply stop carrying the (new) kind: the canvas shows their type
 *    again, and the title editor offers the new kind the next time one is renamed.
 */

/** What an instance is called when its component's name holds no ASCII letter at all (`2×2`, `光`). */
export const COMPONENT_KIND = "component";

/**
 * A component's name as a kind: lowercased, and everything but `a`–`z` dropped, because a
 * kind holds nothing else (that is what makes `kind_role` parse one way). `Depth Points`
 * → `depthpoints`, `Bloom 2` → `bloom`.
 */
export function kindFromName(name: string): string {
  const kind = name.toLowerCase().replace(/[^a-z]/g, "");
  return kind.length > 0 ? kind : COMPONENT_KIND;
}

/**
 * What `kindOf` needs to know about a node's definition. For a built-in type the type is
 * enough; for a component instance the kind is in the `title`, which the component
 * registry sets to the component's own name (`componentNodeDefinition`).
 */
export interface KindSource {
  readonly type: string;
  readonly title: string;
}

/**
 * node type → kind. Total over the registered built-in types (gated).
 *
 * Grouped by library shelf. A comment marks each kind that differs from the type's own
 * lowercased word, with the reason.
 */
export const NODE_KINDS: Readonly<Record<string, string>> = {
  // generators
  solid: "solid",
  noise: "noise",
  ramp: "ramp",
  uv: "uv",
  checker: "checker",
  circle: "circle",
  rectangle: "rectangle",
  text: "text",
  matte: "matte",
  floatMapIn: "floatmap",
  personMask: "personmask",

  // shaders: one family, the multi-input form is a variant of the same thing
  customWgsl: "wgsl",
  customWgslMulti: "wgsl",

  // filters
  transform: "transform",
  flip: "flip",
  mirror: "mirror",
  crop: "crop",
  tile: "tile",
  cornerPin: "cornerpin",
  gridWarp: "gridwarp",
  blur: "blur",
  edge: "edge",
  convolve: "convolve",
  displace: "displace",
  remap: "remap",
  slope: "slope",
  streak: "streak",
  halo: "halo",
  lens: "lens",
  flare: "flare",
  crt: "crt",
  crtTube: "crttube",
  cameraBlur: "camerablur",
  depth: "depth",
  pose: "pose",

  // colour
  level: "level",
  hsv: "hsv",
  threshold: "threshold",
  limit: "limit",
  lookup: "lookup",
  reorder: "reorder",
  premultiply: "premultiply",
  filmGrade: "filmgrade",

  // composite
  composite: "composite",
  cross: "cross",
  over: "over",
  add: "add",
  multiply: "multiply",
  screen: "screen",
  difference: "difference",
  mask: "mask",
  layer: "layer",

  // temporal
  feedback: "feedback",
  cache: "cache",
  echo: "echo",
  slitScan: "slitscan",

  // utility
  null: "null",
  switch: "switch",
  // The library calls it an Annotation and every shipped one is named `note…`.
  annotate: "note",

  // component boundary: TouchDesigner's In and Out, one kind per direction whatever the
  // payload. Their names are socket labels, so the convention does not bind them
  // (`SOCKET_NAMED_TYPES`); the kind is what a new one is auto-named with.
  componentIn: "in",
  componentInPoints: "in",
  componentInValue: "in",
  componentOut: "out",
  componentOutPoints: "out",
  componentOutValue: "out",

  // inputs
  movieFileIn: "movie",
  webcam: "webcam",
  screenIn: "screenin",
  syphonIn: "syphonin",
  ndiIn: "ndiin",
  spoutIn: "spoutin",
  audioIn: "audioin",
  // `audio` alone would not say which of the three audio sources it is.
  audioFileIn: "audiofile",
  // T1751b: a tonal node is named for what it reads off the capture, as a person says it.
  audioChroma: "chroma",
  audioChord: "chord",
  audioNotes: "notes",
  midiIn: "midiin",
  // T1762b: the keyboard's notes. `notes` is the audio Notes node's word (§T1755b).
  midiNotes: "keys",
  oscIn: "oscin",

  // outputs
  output: "output",
  window: "window",
  syphonOut: "syphonout",
  ndiOut: "ndiout",
  spoutOut: "spoutout",
  oscOut: "oscout",
  laserOut: "laserout",

  // values: sources
  lfo: "lfo",
  constant: "constant",
  timer: "timer",
  analyze: "analyze",
  mouse: "mouse",
  // T1787b: the project tempo and beat clock.
  tempo: "tempo",
  channelIn: "channelin",
  audioPattern: "pattern",
  // T1757b: the tonal nodes' test signal. `pattern` is Audio Pattern's.
  tonePattern: "tones",
  harmony: "harmony",
  noteField: "notefield",

  // values: operators. The `value` family word is dropped; the word left is the title.
  // Four of them are the same operation as a texture or point node and share its kind,
  // as a Limit TOP and a Limit CHOP share `limit` in TouchDesigner.
  valueMath: "math",
  valueLimit: "limit",
  valueSelect: "select",
  valueSlope: "slope",
  valueTrigger: "trigger",
  valueLag: "lag",
  valueFilter: "filter",
  valueSwitch: "switch",
  valueStep: "step",
  valueNormalize: "normalize",
  valueSpeed: "speed",
  valueRange: "range",
  valueTail: "tail",
  valueBeat: "beat",
  valueTrend: "trend",
  valueRate: "rate",
  valueNovelty: "novelty",
  valueCount: "count",
  valueDelay: "delay",
  valueExpression: "expression",

  // controls and shows
  slider: "slider",
  toggle: "toggle",
  button: "button",
  xyPad: "xypad",
  panel: "panel",
  presets: "presets",
  cueList: "cuelist",
  // VN61: keyframed lanes, each a channel (`automation_score`).
  automation: "automation",

  // scene
  camera: "camera",
  light: "light",
  projector: "projector",
  geometry: "geometry",
  render: "render",
  // One family: what it is, is a material. The shading model is a variant.
  materialUnlit: "material",
  materialPhong: "material",
  materialPbr: "material",
  materialGlass: "material",
  materialWgsl: "material",

  // points: sources
  pointGenerator: "generator",
  pointGrid: "grid",
  pointLine: "line",
  // The same shape as the texture Circle, on points.
  pointCircle: "circle",
  pointSphere: "sphere",
  pointTube: "tube",
  pointTorus: "torus",
  pointBox: "box",
  // Spelled out on the owner's ruling (2026-10-05): `texpoints` did not say what it was.
  pointsFromTexture: "texturepoints",
  meshFileIn: "mesh",

  // points: operators
  pointKernel: "kernel",
  pointKernelAdvanced: "kernel",
  pointRay: "ray",
  // The same ruling: it SAMPLES a texture onto an attribute, and `texattr` said neither half.
  textureToAttribute: "sample",
  pointTopology: "topology",
  pointCurve: "curve",
  pointCurveFrames: "frames",
  pointResample: "resample",
  pointSweep: "sweep",
  pointRope: "rope",
  pointGather: "gather",
  pointProximity: "proximity",
  pointRange: "range",
  pointTransform: "transform",
  laserPath: "laserpath",

  // points: renderers, named for what they draw
  renderPoints: "points",
  renderInstances: "instances",
  renderSurface: "surface",
};

/**
 * The kinds more than one type holds, DELIBERATELY, each with its members.
 *
 * Two reasons a kind is shared, and no third:
 *
 *  - VARIANTS of one thing: the library titles them `X · variant` or `X (variant)`.
 *    `wgsl`, `kernel`, `material`, `in`, `out`.
 *  - THE SAME OPERATION on another payload, under the same title. `limit`, `slope`,
 *    `switch`, `range`, `transform`, `circle`. This is TouchDesigner's own model (a
 *    Transform TOP and a Transform SOP are both `transform1`); the payload is drawn on
 *    the node.
 *
 * `node-kinds.test.ts` holds this list equal to what the table actually shares, so a
 * second type cannot take an existing kind by accident.
 */
export const KIND_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  wgsl: ["customWgsl", "customWgslMulti"],
  kernel: ["pointKernel", "pointKernelAdvanced"],
  material: ["materialUnlit", "materialPhong", "materialPbr", "materialGlass", "materialWgsl"],
  in: ["componentIn", "componentInPoints", "componentInValue"],
  out: ["componentOut", "componentOutPoints", "componentOutValue"],
  limit: ["limit", "valueLimit"],
  slope: ["slope", "valueSlope"],
  switch: ["switch", "valueSwitch"],
  range: ["valueRange", "pointRange"],
  transform: ["transform", "pointTransform"],
  circle: ["circle", "pointCircle"],
};

/**
 * Types whose NAME is published as something else's label, so the convention does not bind
 * them: a component's In and Out. Naming an In names the SOCKET the component shows from
 * outside (`boundary-ports.ts`), and `in_depth` on a socket would say the direction twice.
 * They are auto-named with their kind (`in1`), never prefixed on a rename, and the gate
 * does not ask them to conform.
 */
export const SOCKET_NAMED_TYPES: ReadonlySet<string> = new Set([
  "componentIn",
  "componentInPoints",
  "componentInValue",
  "componentOut",
  "componentOutPoints",
  "componentOutValue",
]);

/**
 * The numbering base a node type had before kinds, and the fallback for a type the table
 * does not hold: the last dotted segment of the type, lowercased, stripped to word
 * characters. `core.noise` → `noise`.
 */
export function nameBaseFor(type: string): string {
  const segment = type.split(".").at(-1) ?? type;
  const base = segment.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return base.length > 0 ? base : "node";
}

/**
 * The kind word a node of this BUILT-IN type is named with: the table's row, or the old
 * base for a type the table does not hold.
 *
 * A component instance's type is refused, by name. Its kind is its component's name, which
 * a type string does not carry, and a quiet `component` here would be a wrong word minted
 * into a document. Ask `kindOf` with the definition instead.
 */
export function kindOfType(type: string): string {
  if (isComponentNodeType(type)) {
    throw new Error(
      `kindOfType("${type}"): a component instance is named for its component, and the type does not carry the component's name. Use kindOf(definition), or kindFromName(<the component's name>).`,
    );
  }
  return Object.hasOwn(NODE_KINDS, type) ? (NODE_KINDS[type] as string) : nameBaseFor(type);
}

/** The kind a node with this definition is named with. Total: every definition has one. */
export function kindOf(definition: KindSource): string {
  return isComponentNodeType(definition.type) ? kindFromName(definition.title) : kindOfType(definition.type);
}

/** False for the types whose name is a published label (`SOCKET_NAMED_TYPES`). */
export function kindBindsName(type: string): boolean {
  return !SOCKET_NAMED_TYPES.has(type);
}

const ROLE = /^[\p{L}\p{N}][\p{L}\p{N}_]*$/u;
const DIGITS = /^[0-9]+$/;

/**
 * THE one answer to "does this name carry this kind" (T1593b).
 *
 * True for `kind`, `kind<digits>` and `kind_<role>`. Case-sensitive: a name is an
 * identifier, and `Blur_soft` is a different name from `blur_soft`.
 */
export function conformsToKind(name: string, kind: string): boolean {
  if (!name.startsWith(kind)) return false;
  const rest = name.slice(kind.length);
  if (rest === "" || DIGITS.test(rest)) return true;
  return rest.startsWith("_") && ROLE.test(rest.slice(1));
}

/** `kind_role`; the bare kind when there is no role. Composes, and checks nothing. */
export function withKind(kind: string, role: string): string {
  return role === "" ? kind : `${kind}_${role}`;
}

/**
 * The role a conforming name carries: `lamp` for `slider_lamp`, the empty string for a
 * bare or numbered name (`blur`, `blur1` have no role), and `null` for a name that does
 * not conform at all.
 */
export function roleOf(name: string, kind: string): string | null {
  if (!conformsToKind(name, kind)) return null;
  const rest = name.slice(kind.length);
  return rest.startsWith("_") ? rest.slice(1) : "";
}

/**
 * Free text as a role: every run of characters a name may not hold becomes one
 * underscore, and the ends are trimmed of them. `Bloom pass` → `Bloom_pass`.
 */
export function roleFromText(text: string): string {
  return text.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
}

/**
 * `roleFromText` for a field still being typed in: a trailing underscore stays, because
 * the next word is on its way. The title editor shows this as the person types, so a space
 * is seen to become an underscore instead of changing after Enter.
 */
export function roleWhileTyping(text: string): string {
  return text.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+/, "");
}

export interface ConventionalName {
  /** The name to store. */
  readonly name: string;
  /** True when the kind was put in front of what was typed. */
  readonly prefixed: boolean;
}

/**
 * What a typed name becomes under a kind: THE rename rule, for every door (`node.rename`,
 * the title editor, the agent tools).
 *
 *  - It already conforms: taken as it is. `blur_soft` stays `blur_soft`, and so does
 *    `blur2`.
 *  - It conforms once cleaned (`blur soft`, `Blur_soft`): the cleaned name, no second
 *    prefix.
 *  - Otherwise the kind goes in front of the cleaned text: `soft` → `blur_soft`,
 *    `Bloom pass` → `blur_Bloom_pass`.
 *
 * Blank text, and text with nothing a name can hold, come back unchanged: there is no
 * role to prefix, and the caller's own refusal of a blank name should see what was typed.
 */
export function nameInKind(typed: string, kind: string): ConventionalName {
  const text = typed.trim();
  if (text === "") return { name: typed, prefixed: false };
  if (conformsToKind(text, kind)) return { name: text, prefixed: false };
  const cleaned = roleFromText(text);
  if (cleaned === "") return { name: typed, prefixed: false };
  if (cleaned.slice(0, kind.length).toLowerCase() === kind) {
    const recased = kind + cleaned.slice(kind.length);
    if (conformsToKind(recased, kind)) return { name: recased, prefixed: false };
  }
  return { name: withKind(kind, cleaned), prefixed: true };
}

/**
 * `nameInKind` for a node with this definition. A socket-named type's name comes back
 * unchanged. The definition, not the type, because a component instance's kind is its
 * component's name.
 */
export function conventionalName(typed: string, definition: KindSource): ConventionalName {
  return kindBindsName(definition.type) ? nameInKind(typed, kindOf(definition)) : { name: typed, prefixed: false };
}

/**
 * What a surface with room for ONE WORD shows for a node (a Panel board, the phone, the
 * Layers list): the role when the name carries its kind and has one, else the name as it
 * is (ruled 2026-10-05).
 *
 * `presets_looks` is `looks` on stage: the board already draws a bank as a bank, so the
 * kind in front would be the same fact twice, in the one place where every character is
 * read from across a room. A name with no role (`presets1`) and a name that does not carry
 * its kind (`looks`, anything saved before the rule) are shown whole; nothing is cut from
 * a name the rule did not make.
 */
export function roleOrName(name: string, kind: string): string {
  const role = roleOf(name, kind);
  return role === null || role === "" ? name : role;
}

/**
 * The conforming form of an explicit label that does NOT conform (`lamp` on a slider →
 * `slider_lamp`). `null` when the label already conforms, when the convention does not
 * bind this definition, or when no name can be made from the text.
 *
 * For the one door that stores a label exactly and so can only WARN: a patch.
 */
export function conformingFormOf(label: string, definition: KindSource): string | null {
  if (!kindBindsName(definition.type)) return null;
  const kind = kindOf(definition);
  if (conformsToKind(label.trim(), kind)) return null;
  const named = nameInKind(label, kind);
  return conformsToKind(named.name, kind) ? named.name : null;
}
