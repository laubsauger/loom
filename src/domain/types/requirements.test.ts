import { describe, expect, it } from "vitest";
import {
  RUNTIME_REQUIREMENTS,
  assessRequirement,
  assessRequirements,
  describeRequirementProblem,
  isActionableRequirement,
  orderRequirements,
  rollUpVerdict,
  runtimeRequirement,
  type HostFacts,
  type RuntimeRequirementId,
} from "./requirements.ts";

const BROWSER: HostFacts = { shell: "browser", helper: "unknown", os: "macos" };
const MAC_DESKTOP: HostFacts = { shell: "desktop", helper: "paired", os: "macos" };

const ALL_IDS = RUNTIME_REQUIREMENTS.map((entry) => entry.id);

/**
 * T1340b. These assert the two things the taxonomy exists to make true, and both are
 * about what a USER does after reading a tag:
 *
 *  - an actionable requirement and an unsatisfiable one must never be indistinguishable,
 *    because the reader acts on the difference (go install it, versus there is nothing to
 *    install);
 *  - a requirement the app cannot check must never read as checked, because "it will work"
 *    on no evidence is found out by opening the file, which is the journey this prevents.
 */
describe("T1340b — the requirement vocabulary", () => {
  it("files exactly one requirement as unsatisfiable, and it is the one nobody can act on", () => {
    const unsupported = RUNTIME_REQUIREMENTS.filter((entry) => !isActionableRequirement(entry));
    expect(unsupported.map((entry) => entry.id)).toEqual(["not-implemented"]);
    // The colour is keyed off `category` and nothing else, so sharing a category IS
    // sharing a colour. Every other tag names something a person can go and get.
    expect(unsupported[0]!.category).toBe("unsupported");
    for (const entry of RUNTIME_REQUIREMENTS) {
      if (entry.id === "not-implemented") continue;
      expect(entry.category).not.toBe("unsupported");
    }
  });

  it("gives every requirement a label and a hover sentence, so no tag renders bare", () => {
    for (const entry of RUNTIME_REQUIREMENTS) {
      expect(entry.label.length, entry.id).toBeGreaterThan(0);
      expect(entry.description.length, entry.id).toBeGreaterThan(20);
      expect(runtimeRequirement(entry.id)).toBe(entry);
    }
  });

  it("orders by category so a tag strip reads the same however the document is ordered", () => {
    const forwards = orderRequirements(["ndi-sdk", "macos", "helper"]).map((entry) => entry.id);
    const backwards = orderRequirements(["helper", "macos", "ndi-sdk"]).map((entry) => entry.id);
    expect(forwards).toEqual(["helper", "macos", "ndi-sdk"]);
    expect(backwards).toEqual(forwards);
    expect(orderRequirements(["macos", "macos"]).length).toBe(1);
  });

  it("marks the helper — and only the helper — as a live session state", () => {
    // The flag is what stops the node diagnostic restating what the OSC, laser and Vision
    // pumps say with far more detail. Anything else declaring it would go silent on a node
    // for no reason a reader could recover.
    const live = RUNTIME_REQUIREMENTS.filter((entry) => entry.liveState === true);
    expect(live.map((entry) => entry.id)).toEqual(["helper"]);
  });
});

describe("T1340b — requirements × host facts → verdict", () => {
  it("answers `unknown`, never `met`, for the two facts a page cannot establish", () => {
    // ⚑ THE DEFECT THIS PINS: a green tick on an unverifiable requirement says "this will
    // work" on no evidence. An NDI SDK is a machine install a browser cannot see; Apple
    // Silicon is not reliably reported, and reading it off a WebGPU adapter string is a
    // guess wearing a fact's clothes. Asserted on the MOST capable host there is, because
    // that is where a wrong `met` would be most tempting.
    expect(assessRequirement("ndi-sdk", MAC_DESKTOP)).toBe("unknown");
    expect(assessRequirement("apple-silicon", MAC_DESKTOP)).toBe("unknown");
    expect(assessRequirement("ndi-sdk", BROWSER)).toBe("unknown");
    expect(assessRequirement("apple-silicon", BROWSER)).toBe("unknown");
  });

  it("separates 'the helper is not running' from 'nobody has looked yet'", () => {
    // §V986: both sentences are about the same missing helper and they are not the same
    // claim. A tab one second after load has not probed anything.
    expect(assessRequirement("helper", { ...BROWSER, helper: "unknown" })).toBe("unknown");
    expect(assessRequirement("helper", { ...BROWSER, helper: "absent" })).toBe("unmet");
    expect(assessRequirement("helper", { ...BROWSER, helper: "paired" })).toBe("met");
  });

  it("knows which shell it is in, and reads the OS only when the OS is readable", () => {
    expect(assessRequirement("desktop", BROWSER)).toBe("unmet");
    expect(assessRequirement("desktop", MAC_DESKTOP)).toBe("met");
    expect(assessRequirement("macos", MAC_DESKTOP)).toBe("met");
    expect(assessRequirement("windows", MAC_DESKTOP)).toBe("unmet");
    // `other` is a POSITIVE finding — we read a platform and it was neither.
    expect(assessRequirement("macos", { ...BROWSER, os: "other" })).toBe("unmet");
    // …and `unknown` is not. A browser that reports no usable platform gets neither answer.
    expect(assessRequirement("macos", { ...BROWSER, os: "unknown" })).toBe("unknown");
    expect(assessRequirement("windows", { ...BROWSER, os: "unknown" })).toBe("unknown");
  });

  it("never invents a verdict it has no rule for", () => {
    // Every id in the table is answered by `assessRequirement`; a new one added without a
    // rule would fall through and produce `undefined`, which renders as a silent pass.
    for (const id of ALL_IDS) {
      expect(["met", "unmet", "unknown"], id).toContain(assessRequirement(id, MAC_DESKTOP));
    }
  });

  it("rolls up so that one impossible requirement is not softened by the others", () => {
    const ids: RuntimeRequirementId[] = ["desktop", "macos", "ndi-sdk"];
    // On a Mac desktop, two check out and one cannot be checked — so the file has NOT
    // been verified, and saying it has is the confident-zero again.
    expect(rollUpVerdict(assessRequirements(ids, MAC_DESKTOP))).toBe("unknown");
    // In a browser the desktop requirement is definitively unmet, and that dominates.
    expect(rollUpVerdict(assessRequirements(ids, BROWSER))).toBe("unmet");
    // Nothing declared is the honest "a browser tab is enough".
    expect(rollUpVerdict(assessRequirements([], BROWSER))).toBe("met");
  });
});

describe("T1340b — the node's warning text", () => {
  it("says nothing about a node whose requirements this host meets", () => {
    expect(describeRequirementProblem("Syphon In", assessRequirements(["desktop", "macos"], MAC_DESKTOP))).toBeNull();
    expect(describeRequirementProblem("Blur", assessRequirements([], BROWSER))).toBeNull();
  });

  it("names every unmet requirement, and names what it could not check beside them", () => {
    const problem = describeRequirementProblem("NDI In", assessRequirements(["desktop", "macos", "ndi-sdk"], BROWSER));
    expect(problem).not.toBeNull();
    expect(problem!.message).toContain("NDI In");
    expect(problem!.message).toContain(runtimeRequirement("desktop").label);
    // ⚑ The unverifiable one is NAMED rather than omitted. Silence about a fact nobody
    // checked reads as a pass: a user who sees only "needs the desktop app" installs the
    // desktop app and is then surprised by the SDK.
    expect(problem!.suggestion).toContain(runtimeRequirement("ndi-sdk").label);
    expect(problem!.suggestion).toContain("unverified");
  });

  it("does not restate the helper, which three device pumps narrate with more than it knows", () => {
    // An OSC node on a machine whose helper is known absent: the bridge says WHICH of seven
    // states it is in, so a flat "needs the helper" beside it would be two warnings on one
    // node disagreeing about how much is known.
    expect(describeRequirementProblem("OSC In", assessRequirements(["helper"], { ...BROWSER, helper: "absent" }))).toBeNull();
    // And a Person Mask on the helper transport is likewise the bridge's to report.
    expect(describeRequirementProblem("Person Mask", assessRequirements(["helper", "macos"], { ...BROWSER, helper: "absent" }))).toBeNull();
  });

  it("tells the reader there is nothing to go and get, rather than what to install", () => {
    const problem = describeRequirementProblem("Spout Out", assessRequirements(["desktop", "windows", "not-implemented"], BROWSER));
    expect(problem).not.toBeNull();
    // The unsatisfiable requirement takes over the sentence: naming "Desktop only" and
    // "Windows" first would send the reader to find a Windows machine that cannot help.
    expect(problem!.message).toContain("cannot run anywhere yet");
    expect(problem!.message).not.toContain("it needs");
    // …and it still says the document is not broken, which is the part that keeps someone
    // from deleting the node.
    expect(problem!.message).toContain("edits");
  });
});
