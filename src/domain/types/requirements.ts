/**
 * T1340b — THE ONE REQUIREMENT VOCABULARY: what a node needs from the machine it runs on.
 *
 * ## Why this is a contract file and not a lookup in whoever asks
 *
 * The declaration used to be a `switch` on node type inside `src/examples/runtime-requirements.ts`.
 * That meant THE EXAMPLE LIST knew a Syphon node needs macOS and THE NODE DID NOT KNOW IT
 * ABOUT ITSELF, so a second surface had to either re-derive the map or import the examples
 * layer — and the hand-kept duplicate is exactly how the wordings drifted: the library said
 * *"Desktop only"*, the inspector said *"macOS desktop required"*, the input hook said
 * *"Syphon In requires the macOS desktop app"*, and each was written by someone who could
 * not see the other two. `NodeDefinition.requires` is the declaration of record now; every
 * surface reads THIS table for the words.
 *
 * ## Three kinds, not one flat list (the owner's own axis first)
 *
 * The seven ids below used to be one undifferentiated list, all wearing the same warning
 * colour. They answer three different questions, and the owner named the first one:
 * *"electron app or web browser and helper on localhost"*.
 *
 *   `host`      WHERE it must run. The plain browser is the default and is therefore
 *               UNSTATED — a requirement list says what is EXTRA.
 *   `platform`  WHICH machine. An OS or a CPU family; nothing anyone can install.
 *   `external`  WHAT the user must supply. A third-party SDK that is not bundled.
 *
 * And one member that is not a requirement at all:
 *
 *   `unsupported`  Nobody can satisfy it. `not-implemented` is here, alone.
 *
 * ⚠ `unsupported` MUST NOT WEAR THE ACTIONABLE COLOUR, and that is the whole reason the
 * category exists as a fourth value rather than as a flag. Every other tag names something
 * a person can DO — install the helper, open the desktop app, run this on a Mac. This one
 * cannot be satisfied by anyone, on any machine, today. Painting it the same as the other
 * six is a lie the reader acts on: they go looking for the Windows machine that would make
 * Spout work, and there isn't one.
 *
 * ## Order
 *
 * `RUNTIME_REQUIREMENTS` is the canonical order, and it is the CATEGORY order — host,
 * platform, external, unsupported — so a tag strip reads "where, then which machine, then
 * what to install, then the bad news" regardless of the order nodes appear in the document.
 */

/** The axis a requirement lives on. The colour is keyed off this, never off the id. */
export type RuntimeRequirementCategory = "host" | "platform" | "external" | "unsupported";

export type RuntimeRequirementId =
  | "helper"
  | "desktop"
  | "macos"
  | "windows"
  | "apple-silicon"
  | "ndi-sdk"
  | "not-implemented";

export interface RuntimeRequirement {
  readonly id: RuntimeRequirementId;
  readonly category: RuntimeRequirementCategory;
  /** The tag's words. Short enough to be a badge (§V90). */
  readonly label: string;
  /** The hover sentence, and the half of a node diagnostic that says what is needed. */
  readonly description: string;
  /**
   * Is this requirement's satisfaction a LIVE SESSION state — something that can become
   * true while the page stays open, and that a device pump is already narrating?
   *
   * True of `helper` alone: you start the helper and enter its pairing code, and OSC,
   * laser and Vision each report far more than "absent" about it (idle / connecting /
   * unreachable / refused — `osc-status.ts` enumerates seven). Everything else is fixed
   * for the life of the page: no amount of waiting turns a browser tab into the desktop
   * app.
   *
   * ⚑ THIS EXISTS SO THE NODE DIAGNOSTIC DOES NOT DOUBLE-REPORT, and it is declared here
   * rather than hard-coded as "skip helper" at the one call site — a skip list is how the
   * type switch this row deleted got written in the first place.
   */
  readonly liveState?: true;
}

/**
 * Every requirement, in category order. The single source for BOTH the example library's
 * tags and the node's own warning — there is no second table anywhere.
 */
export const RUNTIME_REQUIREMENTS: readonly RuntimeRequirement[] = [
  {
    id: "helper",
    category: "host",
    label: "Device helper",
    description: "Needs the local device helper running beside the page; a browser tab cannot open a socket itself.",
    liveState: true,
  },
  {
    id: "desktop",
    category: "host",
    // The owner's own words for this tag, kept verbatim. E74's prose and the e2e
    // requirement gate both quote it.
    label: "Desktop only",
    description: "Needs the Loom desktop app. A browser tab has no access to this transport at all.",
  },
  {
    id: "macos",
    category: "platform",
    label: "macOS",
    description: "Uses a macOS-only integration; no other operating system provides it.",
  },
  {
    id: "apple-silicon",
    category: "platform",
    label: "Apple Silicon",
    description: "Needs an Apple Silicon Mac and the configured Python Vision worker.",
  },
  {
    id: "windows",
    category: "platform",
    label: "Windows",
    description: "Targets Windows desktop video sharing; macOS cannot run this transport.",
  },
  {
    id: "ndi-sdk",
    category: "external",
    label: "NDI SDK",
    description: "Needs a locally supplied NDI SDK. The SDK is not bundled and must be installed separately.",
  },
  {
    id: "not-implemented",
    category: "unsupported",
    label: "Not implemented",
    description: "No shipping host implements this transport. The graph can be prepared and saved; nothing is published.",
  },
];

const BY_ID = new Map<RuntimeRequirementId, RuntimeRequirement>(
  RUNTIME_REQUIREMENTS.map((requirement) => [requirement.id, requirement]),
);

/** Throws on an unknown id rather than returning a blank tag — an untagged requirement
 * reads to the user as "this runs anywhere", which is the one wrong answer (§V997). */
export function runtimeRequirement(id: RuntimeRequirementId): RuntimeRequirement {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`Unknown runtime requirement: ${id}`);
  return found;
}

/** Dedupe into canonical (category) order, so the strip reads the same however the
 * document is ordered. */
export function orderRequirements(ids: Iterable<RuntimeRequirementId>): readonly RuntimeRequirement[] {
  const wanted = new Set(ids);
  return RUNTIME_REQUIREMENTS.filter((requirement) => wanted.has(requirement.id));
}

/** Is this requirement something a person could go and satisfy? False for `unsupported`
 * alone — the distinction the colour coding exists to carry. */
export function isActionableRequirement(requirement: RuntimeRequirement): boolean {
  return requirement.category !== "unsupported";
}

/**
 * ============================================================================
 * THE VERDICT: requirements × host facts → can this run here?
 * ============================================================================
 *
 * Pure, and deliberately so: a requirement set and a host-facts record in, a verdict out.
 * That is what lets "an NDI example on a browser tab is marked unrunnable" be a headless
 * assertion against a FAKE host rather than something only a headed lane can see.
 */

/**
 * What the page can honestly establish about the machine it is on.
 *
 * ⚠ EVERY MEMBER HAS AN "I CANNOT TELL" VALUE, and that is the point of the record. The
 * probe that fills it is allowed to be ignorant; it is NOT allowed to guess.
 */
export interface HostFacts {
  /** Which shell the page is running in. Knowable: the desktop app injects bridges. */
  readonly shell: "browser" | "desktop";
  /**
   * The local device helper. THREE states, because "not probed yet" is not "absent":
   * a tab one second after load has not finished opening its socket, and telling the user
   * the helper is missing is a confident wrong answer they act on (§V986).
   */
  readonly helper: "paired" | "absent" | "unknown";
  /** The operating system, from navigator facts. `unknown` when they are unavailable. */
  readonly os: "macos" | "windows" | "other" | "unknown";
}

/**
 * THREE VERDICTS, NOT TWO.
 *
 * `unknown` is a first-class answer and must render as one. A green tick on a requirement
 * the app cannot verify tells the user "this will work" on no evidence, and they find out
 * it does not by opening the file — the exact journey this whole vocabulary exists to
 * spare them.
 */
export type RequirementVerdict = "met" | "unmet" | "unknown";

export interface RequirementAssessment {
  readonly requirement: RuntimeRequirement;
  readonly verdict: RequirementVerdict;
}

/**
 * Can this host satisfy this one requirement?
 *
 * ⚠ THE `unknown` ARMS ARE THE LOAD-BEARING ONES AND THEY ARE NOT LAZINESS:
 *
 *  - `ndi-sdk` is a machine install. A browser cannot see the filesystem, and the desktop
 *    app only finds out by trying to load the library. Nothing here may claim either way.
 *  - `apple-silicon` is not reliably available to a page. Reading it off a WebGPU adapter
 *    string is a guess wearing a fact's clothes — the string is vendor-formatted, optional,
 *    and deliberately fuzzed in some builds. `unknown` is the true answer.
 *
 * `not-implemented` is the easy one and needs no detection at all: permanently unmet, on
 * every host, forever.
 */
export function assessRequirement(id: RuntimeRequirementId, host: HostFacts): RequirementVerdict {
  switch (id) {
    case "helper":
      return host.helper === "paired" ? "met" : host.helper === "absent" ? "unmet" : "unknown";
    case "desktop":
      return host.shell === "desktop" ? "met" : "unmet";
    case "macos":
      return host.os === "unknown" ? "unknown" : host.os === "macos" ? "met" : "unmet";
    case "windows":
      return host.os === "unknown" ? "unknown" : host.os === "windows" ? "met" : "unmet";
    case "apple-silicon":
    case "ndi-sdk":
      return "unknown";
    case "not-implemented":
      return "unmet";
  }
}

/** Every declared requirement with its verdict, deduped, in canonical category order. */
export function assessRequirements(
  ids: Iterable<RuntimeRequirementId>,
  host: HostFacts,
): readonly RequirementAssessment[] {
  return orderRequirements(ids).map((requirement) => ({
    requirement,
    verdict: assessRequirement(requirement.id, host),
  }));
}

/**
 * The roll-up for one document or one node: `unmet` beats `unknown` beats `met`.
 *
 * Unmet dominates because one impossible requirement makes the whole thing impossible —
 * a Syphon example on Windows does not become half-runnable because the other two tags
 * check out. `unknown` beats `met` for the same asymmetry one step weaker: a list of
 * requirements where one cannot be checked has not been verified, and saying it has is the
 * confident wrong answer again. An EMPTY requirement set rolls up to `met`, which is the
 * honest reading of "needs nothing beyond a browser tab".
 */
export function rollUpVerdict(assessments: readonly RequirementAssessment[]): RequirementVerdict {
  if (assessments.some((entry) => entry.verdict === "unmet")) return "unmet";
  if (assessments.some((entry) => entry.verdict === "unknown")) return "unknown";
  return "met";
}

/** The labels, comma-joined — the same words in the same order as the badge strip, so a
 * reader who saw the tags recognises the sentence. Never prose-joined with "and": these
 * are TAG NAMES ("Desktop only", "Not implemented") and reading them as English produces
 * "it needs Desktop only and macOS". */
function tags(words: readonly string[]): string {
  return words.join(", ");
}

/**
 * THE NODE'S OWN WARNING TEXT — one wording, derived from the same table the tags read.
 *
 * Returns null when there is nothing to say, which is the overwhelming majority of nodes.
 *
 * ## What it deliberately does NOT report
 *
 * A requirement marked `liveState` (the helper, and only the helper) is skipped here. Not
 * because it does not matter, but because three device pumps already narrate it with a
 * detail this function cannot reach: `osc-status.ts` alone distinguishes seven reasons
 * there is no OSC, including *connecting* and *the helper refused your code*. Reporting
 * "needs the helper" beside "the helper refused your code" would put two warnings on one
 * node that disagree about how much is known.
 *
 * ## What it says when it CANNOT tell (§V986)
 *
 * Unknown requirements never become a warning on their own — "we could not check the NDI
 * SDK" is not a problem with the node — but when something else IS unmet they are named in
 * the suggestion, so the reader is not left to infer that everything unmentioned checked
 * out. Silence about an unverifiable fact reads as a pass.
 */
export function describeRequirementProblem(
  title: string,
  assessments: readonly RequirementAssessment[],
): { readonly message: string; readonly suggestion?: string } | null {
  const unmet = assessments.filter(
    (entry) => entry.verdict === "unmet" && entry.requirement.liveState !== true,
  );
  if (unmet.length === 0) return null;
  const unknown = assessments.filter(
    (entry) => entry.verdict === "unknown" && entry.requirement.liveState !== true,
  );
  const unverified =
    unknown.length === 0
      ? ""
      : ` This machine cannot be checked for — ${tags(unknown.map((entry) => entry.requirement.label))} — so that part is unverified.`;

  const impossible = unmet.find((entry) => entry.requirement.category === "unsupported");
  if (impossible !== undefined) {
    // Not "you need X": there is no X. Say so plainly rather than sending the reader
    // shopping for a machine that would fix it.
    return {
      message: `${title} cannot run anywhere yet — ${impossible.requirement.label.toLowerCase()}. The graph still edits, saves and previews; nothing is published.`,
      suggestion: `${impossible.requirement.description}${unverified}`,
    };
  }
  const labels = tags(unmet.map((entry) => entry.requirement.label));
  return {
    message: `${title} cannot run on this machine. Needs: ${labels}. The graph still edits and saves.`,
    suggestion: `${unmet.map((entry) => entry.requirement.description).join(" ")}${unverified}`,
  };
}
