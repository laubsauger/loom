import { describe, expect, it } from "vitest";
import { listExampleProjects } from "./example-catalogue.ts";
import type { ExampleProject } from "./example-catalogue.ts";
import {
  EXAMPLE_LINK_PARAM,
  exampleLinkName,
  exampleLinkUrl,
  readExampleLink,
  resolveExampleLink,
  withoutExampleLink,
} from "./example-link.ts";

/**
 * THE LINK CONTRACT (T1278).
 *
 * What a person gets from the copy action and what a boot makes of the URL they were sent
 * are two halves of one promise, and the promise is that the second understands the first.
 * So the assertions here are about the ANSWER a link produces — which example, or a named
 * refusal — and the last case walks a URL out of the producer and back through the reader
 * without either being told what the other wrote.
 */

const CATALOGUE = listExampleProjects();

function named(fileName: string): ExampleProject {
  const entry = CATALOGUE.find((candidate) => candidate.fileName === fileName);
  if (entry === undefined) throw new Error(`${fileName} is not in the shipped catalogue`);
  return entry;
}

describe("what counts as a name", () => {
  it("takes the stem the copy action writes", () => {
    const resolved = resolveExampleLink("E11-Gradient-Remap", CATALOGUE);
    expect(resolved).toEqual({ kind: "match", example: named("E11-Gradient-Remap.loom.json") });
  });

  it("takes the full file name, which is what every other surface calls an example", () => {
    // `project.open`'s `fileName`, `last-opened.ts` and the agent's `get_example` all
    // speak this spelling; a name copied from one of them must not fail here.
    const resolved = resolveExampleLink("E11-Gradient-Remap.loom.json", CATALOGUE);
    expect(resolved).toEqual({ kind: "match", example: named("E11-Gradient-Remap.loom.json") });
  });

  it("takes the bare id, which is what somebody types or truncates a link to", () => {
    const resolved = resolveExampleLink("E11", CATALOGUE);
    expect(resolved).toEqual({ kind: "match", example: named("E11-Gradient-Remap.loom.json") });
  });

  it("does not confuse E1 with E10, because the hyphen is part of the id", () => {
    // The whole reason a bare id is safe to accept at all. Both ship.
    expect(resolveExampleLink("E1", CATALOGUE)).toEqual({
      kind: "match",
      example: named("E1-Feedback-Echo.loom.json"),
    });
    expect(resolveExampleLink("E10", CATALOGUE)).toEqual({
      kind: "match",
      example: named("E10-Instanced-Torus.loom.json"),
    });
  });

  it("ignores case and surrounding space, because a link is pasted by hand", () => {
    expect(resolveExampleLink("  e11-gradient-remap  ", CATALOGUE)).toEqual({
      kind: "match",
      example: named("E11-Gradient-Remap.loom.json"),
    });
  });

  it("refuses a partial title rather than guessing at one", () => {
    // "Gradient" is in exactly one shipped name, and it still resolves to nothing: a link
    // that opened the example the sender ALMOST asked for is worse than one that says no.
    expect(resolveExampleLink("Gradient", CATALOGUE)).toEqual({
      kind: "unknown",
      requested: "Gradient",
    });
  });

  it("names an unknown request back rather than falling through to something plausible", () => {
    const resolved = resolveExampleLink("E999-Nothing", CATALOGUE);
    expect(resolved).toEqual({ kind: "unknown", requested: "E999-Nothing" });
  });

  it("refuses a bare id no file carries", () => {
    expect(CATALOGUE.some((entry) => entry.fileName.startsWith("E999-"))).toBe(false);
    expect(resolveExampleLink("E999", CATALOGUE).kind).toBe("unknown");
  });
});

describe("reading the link off a URL", () => {
  it("finds the name a query carries", () => {
    expect(readExampleLink("?example=E11-Gradient-Remap")).toBe("E11-Gradient-Remap");
  });

  it("is absent when the query has no example in it", () => {
    expect(readExampleLink("")).toBeNull();
    expect(readExampleLink("?theme=dark")).toBeNull();
  });

  it("reads a blank value as ABSENT, not as an unknown example", () => {
    // `?example=` names nothing, so there is no wrong name to report and no reason to
    // refuse the boot. Anything non-blank is a name and fails loudly instead.
    expect(readExampleLink("?example=")).toBeNull();
    expect(readExampleLink("?example=%20%20")).toBeNull();
  });
});

describe("taking the link back out of the address", () => {
  it("leaves an address with nothing else in its query reading as if no link had come", () => {
    expect(withoutExampleLink("https://host.example/loom/?example=E11-Gradient-Remap")).toBe(
      "https://host.example/loom/",
    );
  });

  it("keeps everything else about the address, including the hash", () => {
    expect(
      withoutExampleLink("https://host.example/loom/?example=E11&debug=1#node-42"),
    ).toBe("https://host.example/loom/?debug=1#node-42");
  });

  it("reports that there was nothing to remove, so a caller can tell", () => {
    expect(withoutExampleLink("https://host.example/loom/")).toBeNull();
  });
});

describe("the producer and the reader cannot drift apart", () => {
  it("round-trips every shipped example from a URL back to the same row", () => {
    /*
     * The gate on the whole contract. A copied link is a string that leaves this app and
     * comes back through a different function on somebody else's machine, so the two ends
     * are asserted against each other rather than against a literal either could be
     * edited away from — and against ALL 59 rows, so a name with an unexpected character
     * in it cannot be the one that breaks.
     */
    for (const example of CATALOGUE) {
      const url = exampleLinkUrl(example.fileName, "https://host.example", "/loom/");
      const requested = readExampleLink(new URL(url).search);
      expect(requested, url).not.toBeNull();
      expect(resolveExampleLink(requested as string, CATALOGUE), url).toEqual({
        kind: "match",
        example,
      });
    }
  });

  it("writes the stem, on whichever base the build was served from", () => {
    expect(exampleLinkUrl("E11-Gradient-Remap.loom.json", "https://host.example", "/loom/")).toBe(
      "https://host.example/loom/?example=E11-Gradient-Remap",
    );
    // The dev server's base. A hard-coded `/loom/` would produce a link that 404s here.
    expect(exampleLinkUrl("E11-Gradient-Remap.loom.json", "http://localhost:5173", "/")).toBe(
      "http://localhost:5173/?example=E11-Gradient-Remap",
    );
  });

  it("names the query key once, so the producer and the reader spell it the same", () => {
    expect(EXAMPLE_LINK_PARAM).toBe("example");
    expect(exampleLinkName("E11-Gradient-Remap.loom.json")).toBe("E11-Gradient-Remap");
  });
});
