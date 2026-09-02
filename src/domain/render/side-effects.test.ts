import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NODE_SIDE_EFFECTS, actsOnWorld, emissionRefusal } from "./side-effects.ts";
import { NODE_REPRODUCIBILITY } from "./reproducibility.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";

/**
 * T949 — "DOES THIS NODE ACT ON THE WORLD" AS A GATE, in the three halves the property has.
 *
 * ONE: the ledger is EXHAUSTIVE over the registry, so the hundredth node fails this file until its
 * author decides. That half alone is worth little — it is satisfied forever by typing
 * `"none"` — so TWO asserts the CONSEQUENCE: `emissionRefusal` denies under every policy
 * but a live session, and the pump reads it (`use-osc-bridge.test.tsx` drives the real
 * hook and asserts that no datagram leaves during a take). THREE is the structural half:
 * the emission must not live in the node definition at all, because no policy check at a
 * pump can stop a send inside `valueEvaluate`.
 *
 * NON-VACUITY IS ASSERTED, NOT ASSUMED. §T985's gate found its own escape route the hard
 * way: a derived scan that stops finding anything asserts a property over the empty set
 * and stays green. So this file pins the world-acting set BY NAME and puts a floor under
 * the registry it derives from — a broken import that yielded no definitions would make
 * every other assertion here true.
 */

const registryTypes = allNodeDefinitions.map((definition) => definition.type);

const DEFINITIONS_DIR = fileURLToPath(new URL("../../nodes/definitions/", import.meta.url));

/** Comments stripped: this is about what the CODE does, not what it explains about itself. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

function definitionSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith(".ts") && !/\.test\.tsx?$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  return walk(DEFINITIONS_DIR);
}

describe("T949 — the scan is finding the real catalogue, or it is measuring nothing", () => {
  it("derives from a registry that actually has nodes in it", () => {
    // A floor rather than a count (§V421: a number in a test goes stale silently). The
    // point is only that an import which yielded nothing cannot make this file green.
    expect(registryTypes.length).toBeGreaterThan(50);
    expect(registryTypes).toContain("oscOut");
    expect(definitionSources().length).toBeGreaterThan(30);
  });

  it("names the world-acting nodes, and there is exactly one today", () => {
    const acting = Object.entries(NODE_SIDE_EFFECTS)
      .filter(([, value]) => value !== "none")
      .map(([type, value]) => `${type}:${value}`)
      .sort();
    // NAMED rather than counted, the shape `reproducibility.test.ts` settled on: one
    // arriving is a decision somebody made on purpose, and one going missing is a red
    // test rather than a quiet loss of coverage.
    expect(acting).toEqual([
      // T942 tier 3. UDP at a host and port the document names — a lighting desk as often
      // as a synth. `pure` in NODE_REPRODUCIBILITY, and correctly so; see the ledger.
      "oscOut:emits",
    ]);
  });
});

describe("T949 — every registered node answers, or this fails", () => {
  it("classifies every node the registry can instantiate", () => {
    const missing = registryTypes.filter((type) => NODE_SIDE_EFFECTS[type] === undefined);
    expect(
      missing,
      "A node cannot ship without answering whether it ACTS ON THE WORLD (T949). Add it to " +
        "NODE_SIDE_EFFECTS — `none` if the only thing it changes is the picture, `emits` if " +
        "it sends anything out of this process to something that may act on it (a lighting " +
        "desk, a laser DAC, a DMX universe) — and say why beside the entry. This is NOT the " +
        "same question as NODE_REPRODUCIBILITY: an output node has no output, so it is `pure` " +
        "there, and `pure` is exactly what makes a node safe to evaluate in a headless export.",
    ).toEqual([]);
  });

  it("names no node that has stopped existing (§V421 rot)", () => {
    const live = new Set(registryTypes);
    const stale = Object.keys(NODE_SIDE_EFFECTS).filter((type) => !live.has(type));
    expect(stale, "NODE_SIDE_EFFECTS classifies a node the registry no longer has.").toEqual([]);
  });

  it("pins the ledger and the definitions to each other, in BOTH directions", () => {
    // The ledger is what makes a decision mandatory; the FIELD is what the emission site
    // reads. Two places, so they are held to each other — the shape `sourceReferences` and
    // SOURCE_REFERENCE_PARAMETERS already use. A node that declares `emits` and is not in
    // the ledger would never be reviewed; one in the ledger that forgot the field would be
    // reviewed and then ignored by every reader.
    const disagreements = allNodeDefinitions
      .filter((definition) => (definition.sideEffect ?? "none") !== NODE_SIDE_EFFECTS[definition.type])
      .map((definition) => `${definition.type}: field=${definition.sideEffect ?? "none"} ledger=${String(NODE_SIDE_EFFECTS[definition.type])}`);
    expect(disagreements).toEqual([]);
  });
});

describe("T949 — the axis is ORTHOGONAL to Reproducibility, and the tables prove it", () => {
  it("disagrees with NODE_REPRODUCIBILITY in both directions", () => {
    /*
     * The argument for a second record rather than a fourth `Reproducibility` value, as
     * an assertion. If the two axes were the same axis these would line up; they do not,
     * and they disagree in BOTH directions, which is what makes one field unable to
     * answer both questions.
     */
    // The most benign reproducibility answer there is, and the only world-acting node here.
    expect(NODE_REPRODUCIBILITY["oscOut"]).toBe("pure");
    expect(NODE_SIDE_EFFECTS["oscOut"]).toBe("emits");
    // And the mirror: a live device is the strongest answer on that axis and inert here.
    // Reading the world is not acting on it.
    for (const reader of ["webcam", "audioIn", "mouse", "midiIn", "oscIn"]) {
      expect(NODE_REPRODUCIBILITY[reader]).toBe("external-live");
      expect(NODE_SIDE_EFFECTS[reader]).toBe("none");
    }
  });
});

describe("T949 — the refusal, and it denies by default", () => {
  const oscOut = allNodeDefinitions.find((definition) => definition.type === "oscOut");
  const noise = allNodeDefinitions.find((definition) => definition.type === "noise");

  it("lets a world-acting node emit in a live session and nowhere else", () => {
    expect(actsOnWorld(oscOut)).toBe(true);
    expect(emissionRefusal(oscOut, "live-session")).toBeNull();
    const refusal = emissionRefusal(oscOut, "blocked");
    // A SENTENCE, not a boolean: §V365 — the reason has to be able to reach a surface, or
    // a rig that goes dark during a take is indistinguishable from a broken one.
    expect(refusal).toContain("only a live session");
    expect(refusal).toContain("OSC Out");
  });

  it("never stands in the way of a node that changes nothing but the picture", () => {
    expect(actsOnWorld(noise)).toBe(false);
    expect(emissionRefusal(noise, "blocked")).toBeNull();
    expect(emissionRefusal(undefined, "blocked")).toBeNull();
  });
});

describe("T949 — the emission does not live in the node, and that is checked", () => {
  it("names no egress API in any node definition module", () => {
    /*
     * The structural half, and the one no policy check can replace: a send inside
     * `valueEvaluate` or `compile` would fire once per frame of a headless export with
     * nothing in a position to refuse it. `oscOut` got this right before there was a rule
     * — its evaluate is a passthrough and the send is pumped from the app's live frame
     * loop — and this is what keeps the next output node honest.
     *
     * Comments are stripped first: `osc.ts` says "there is no socket here and no
     * `WebSocket`", and a rule that reds on a module for explaining itself is a rule
     * people delete.
     */
    const egress = /\bWebSocket\b|\bXMLHttpRequest\b|\bfetch\s*\(|\bsendBeacon\b|\bRTCPeerConnection\b|navigator\s*\.\s*(usb|serial|bluetooth|hid)\b/;
    const offenders = definitionSources()
      .filter((file) => egress.test(code(file)))
      .map((file) => basename(file));
    expect(
      offenders,
      "A world-acting node must not perform its own emission: the definition stays a pure " +
        "function and a SESSION-only pump does the sending, consulting `emissionRefusal`. " +
        "That is what makes a headless export, a take and every Dawn gate silent (T949).",
    ).toEqual([]);
  });
});
