import { describe, expect, it } from "vitest";
import { graph, node } from "../examples/documents/builders.ts";
import { slotFromValue } from "../domain/parameters/slots.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { runtimeRequirement, type HostFacts } from "../domain/types/requirements.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { helperFactFrom, requirementDiagnostics } from "./use-requirement-diagnostics.ts";

const REGISTRY = createNodeRegistry(allNodeDefinitions).view();

const BROWSER: HostFacts = { shell: "browser", helper: "unknown", os: "macos" };
const MAC_DESKTOP: HostFacts = { shell: "desktop", helper: "paired", os: "macos" };

const on = (document: GraphDocument, host: HostFacts) => requirementDiagnostics(document, REGISTRY, host);

/**
 * T1340b — THE NODE CARRIES ITS OWN LIMITATION.
 *
 * ⚑ THE DEFECT, STATED AS ITS OWN SIGNATURE: a Syphon node on the canvas of a browser tab
 * showed NO warning of any kind. The example library knew the file needed macOS and the
 * desktop app; the inspector said so in a grey hint under a disabled dropdown; the node
 * itself — the thing the user is looking at, and the surface every other problem in this
 * app reports on — said nothing, so the way to find out was to wire it up and wonder why
 * the picture was black.
 *
 * These assert what the NODE BADGE reads, which is the consumer's value: `severity` and
 * `nodeId` are what `publishNodeStatus` counts, so a warning that does not carry both is
 * a warning nobody sees.
 */
describe("T1340b — a node whose host cannot run it says so", () => {
  it("warns on a macOS-desktop source sitting in a browser tab", () => {
    const [warning, ...rest] = on(graph([node("syphon", "syphonIn", [0, 0])], []), BROWSER);
    expect(rest).toEqual([]);
    expect(warning).toBeDefined();
    // A REAL diagnostic: `publishNodeStatus` counts `severity === "warning"` per `nodeId`,
    // so these two fields are exactly what puts "1 warn" on the node and a row in the
    // problems pane. Anything weaker renders as a lookalike the panel would not agree with.
    expect(warning!.severity).toBe("warning");
    expect(warning!.nodeId).toBe("syphon");
    expect(warning!.message).toContain("Syphon In");
    // This host IS a Mac, so only the shell is missing — and the sentence names only what
    // is actually unmet. Listing "macOS" at a reader who is already on one would teach
    // them the message is boilerplate.
    expect(warning!.message).toContain(runtimeRequirement("desktop").label);
    expect(warning!.message).not.toContain(runtimeRequirement("macos").label);
  });

  it("names the platform too when the platform is genuinely wrong", () => {
    const linuxBrowser: HostFacts = { shell: "browser", helper: "unknown", os: "other" };
    const [warning] = on(graph([node("syphon", "syphonIn", [0, 0])], []), linuxBrowser);
    expect(warning?.message).toContain(runtimeRequirement("desktop").label);
    expect(warning?.message).toContain(runtimeRequirement("macos").label);
  });

  it("reports the platform as unverified rather than met when the browser will not say", () => {
    // §V986 in the node's own sentence: a browser that reports no usable platform has not
    // told us this is a Mac. Silently dropping macOS from the list would read as "that part
    // is fine".
    const opaque: HostFacts = { shell: "browser", helper: "unknown", os: "unknown" };
    const [warning] = on(graph([node("syphon", "syphonIn", [0, 0])], []), opaque);
    expect(warning?.message).toContain(runtimeRequirement("desktop").label);
    expect(warning?.message).not.toContain(runtimeRequirement("macos").label);
    expect(warning?.suggestion).toContain(runtimeRequirement("macos").label);
    expect(warning?.suggestion).toContain("unverified");
  });

  it("falls silent on the machine that can actually run it", () => {
    // The paired half of the claim above: if this warned everywhere it would be chrome,
    // not a diagnostic, and a user in the desktop app would learn to ignore it.
    expect(on(graph([node("syphon", "syphonIn", [0, 0])], []), MAC_DESKTOP)).toEqual([]);
    expect(on(graph([node("syphon", "syphonOut", [0, 0])], []), MAC_DESKTOP)).toEqual([]);
  });

  it("says nothing at all about the nodes that need nothing", () => {
    const ordinary = graph([
      node("noise", "noise", [0, 0]),
      node("blur", "blur", [1, 0]),
      node("out", "output", [2, 0]),
    ], []);
    expect(on(ordinary, BROWSER)).toEqual([]);
    expect(on(ordinary, MAC_DESKTOP)).toEqual([]);
  });

  it("keeps warning about the unimplementable transport on the host it was written for", () => {
    // Spout on a Windows desktop meets both of its satisfiable requirements and is STILL
    // unrunnable. A verdict derived only from "is this the right machine" would go quiet
    // here, which is the exact moment a user concludes it works.
    const windows: HostFacts = { shell: "desktop", helper: "paired", os: "windows" };
    const [warning] = on(graph([node("spout", "spoutOut", [0, 0])], []), windows);
    expect(warning?.severity).toBe("warning");
    expect(warning?.nodeId).toBe("spout");
    expect(warning?.message).toContain("cannot run anywhere yet");
  });

  it("leaves the helper to the pumps that actually probed it", () => {
    // OSC, laser and Person Mask on the helper transport all declare `helper`, and the OSC
    // and Vision bridges report its live state per node with far more than this can know.
    // A second warning here would put two rows on one node disagreeing about how much is
    // established.
    const devices = graph([
      node("osc", "oscIn", [0, 0]),
      node("laser", "laserOut", [1, 0]),
      node("mask", "personMask", [2, 0]),
    ], []);
    expect(on(devices, { ...BROWSER, helper: "absent" })).toEqual([]);
  });

  it("follows a parameter that changes what the node needs", () => {
    // Person Mask on the Native GPU transport needs the desktop app; on the helper
    // transport it does not. Same node type, different answer — which is why the
    // declaration is a function of the node's values and not a row in a type table.
    const native = graph([{
      ...node("mask", "personMask", [0, 0]),
      parameters: { transport: slotFromValue("native") },
    }], []);
    const [warning] = on(native, BROWSER);
    expect(warning?.nodeId).toBe("mask");
    expect(warning?.message).toContain(runtimeRequirement("desktop").label);
    // Apple Silicon cannot be checked from here, so it is named as unverified rather than
    // claimed either way.
    expect(warning?.suggestion).toContain(runtimeRequirement("apple-silicon").label);
    expect(on(graph([node("mask", "personMask", [0, 0])], []), BROWSER)).toEqual([]);
  });

  it("lights the component INSTANCE when the unrunnable node is inside it", () => {
    // Flattening gives an internal node the id `instance/inner`, and the canvas draws the
    // instance. A warning published against the flat id names no node the user can see and
    // is dropped on the floor by `publishNodeStatus` — a silent instance with a hidden
    // Syphon in it is the §V986 shape all over again.
    const flattened = graph([
      { ...node("inner", "syphonIn", [0, 0]), id: "inst/inner" },
      { ...node("deeper", "ndiIn", [1, 0]), id: "inst/nested/deeper" },
    ], []);
    const flat: GraphDocument = {
      ...flattened,
      nodes: Object.fromEntries(Object.values(flattened.nodes).map((entry) => [entry.id, entry])),
    };
    const warnings = on(flat, BROWSER);
    expect(warnings.map((entry) => entry.nodeId)).toEqual(["inst", "inst"]);
    // Two different messages, because the two nodes need different things — the instance
    // badge reads 2 and the panel says which two.
    expect(new Set(warnings.map((entry) => entry.message)).size).toBe(2);
  });
});

describe("T1340b — the helper's three-valued fact (§V986)", () => {
  it("calls an unprobed socket unknown, not absent", () => {
    // ⚑ THE SENTENCE THIS PREVENTS: "the helper is not running", said one second after the
    // page opened, by a tab that has not yet opened a socket. `idle` is the state on load
    // and whenever nothing has asked for a device; `connecting` is a socket mid-open.
    expect(helperFactFrom({ kind: "idle" })).toBe("unknown");
    expect(helperFactFrom({ kind: "connecting" })).toBe("unknown");
  });

  it("calls a silent port absent and a refusal absent, because this page has no helper either way", () => {
    expect(helperFactFrom({ kind: "unreachable" })).toBe("absent");
    expect(helperFactFrom({ kind: "refused", reason: "stale code" })).toBe("absent");
  });

  it("calls an attached helper paired even when its stream is in trouble", () => {
    // A broken stream is a helper problem, not a missing helper, and the pump that owns
    // the stream is the one with the words for it.
    expect(helperFactFrom({ kind: "attached" })).toBe("paired");
    expect(helperFactFrom({ kind: "listening", ports: [9000] })).toBe("paired");
    expect(helperFactFrom({ kind: "error", reason: "socket closed" })).toBe("paired");
  });
});
