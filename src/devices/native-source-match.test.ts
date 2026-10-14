import { describe, expect, it } from "vitest";
import { nativeSourceBindOperations, nativeSourceLabel, resolveNativeSource } from "./native-source-match.ts";

/* VN113: the one rule for which live server a stored Syphon In means. Owner ruling
   (2026-10-10): by app + name, so a pipeline survives a publisher relaunch; the UUID only
   breaks a tie. */
const arena = (id: string, name = "LED FX", app = "Arena") => ({ id, name, app });

describe("resolveNativeSource", () => {
  it("binds the one live server with the stored app and name, whatever its UUID now is", () => {
    const match = resolveNativeSource({ id: "launch-1", app: "Arena", name: "LED FX" },
      [arena("launch-2", "Composition"), arena("launch-2b")]);
    expect(match).toEqual({ kind: "bound", source: arena("launch-2b"), by: "name", candidates: 1 });
  });

  it("does not take a server whose app OR name differs", () => {
    expect(resolveNativeSource({ id: "x", app: "Arena", name: "LED FX" },
      [arena("a", "LED FX 2"), { id: "b", name: "LED FX", app: "TouchDesigner" }]))
      .toEqual({ kind: "unresolved", by: "name" });
  });

  it("settles a tie on the stored UUID, and counts the candidates", () => {
    const match = resolveNativeSource({ id: "second", app: "Arena", name: "LED FX" }, [arena("first"), arena("second")]);
    expect(match).toEqual({ kind: "bound", source: arena("second"), by: "name", candidates: 2 });
  });

  it("without the stored UUID live, a tie goes to the first in discovery order", () => {
    const match = resolveNativeSource({ id: "gone", app: "Arena", name: "LED FX" }, [arena("first"), arena("second")]);
    expect(match).toEqual({ kind: "bound", source: arena("first"), by: "name", candidates: 2 });
  });

  it("with no live candidate stays unresolved, even when the stored UUID is live under another name", () => {
    // The name is the identity: a reused UUID on a different server must not win.
    expect(resolveNativeSource({ id: "u", app: "Arena", name: "LED FX" }, [arena("u", "Other")]))
      .toEqual({ kind: "unresolved", by: "name" });
  });

  it("an older document (no stored name) matches by UUID and reports the name it can learn", () => {
    expect(resolveNativeSource({ id: "u", app: "", name: "" }, [arena("v"), arena("u", "Stage")]))
      .toEqual({ kind: "bound", source: arena("u", "Stage"), by: "id", candidates: 1 });
    expect(resolveNativeSource({ id: "u", app: "", name: "" }, [arena("v")])).toEqual({ kind: "unresolved", by: "id" });
  });

  it("nothing stored is unselected, never the first server", () => {
    expect(resolveNativeSource({ id: "", app: "", name: "" }, [arena("a")])).toEqual({ kind: "unselected" });
  });

  it("names a server as app – name", () => {
    expect(nativeSourceLabel({ app: "Arena", name: "LED FX" })).toBe("Arena – LED FX");
    expect(nativeSourceLabel({ app: "", name: "LED FX" })).toBe("LED FX");
  });
});

describe("VN113 nativeSourceBindOperations", () => {
  const bind = { source: "u2", sourceApp: "Arena", sourceName: "DS" };
  it("a root node patches itself", () => {
    expect(nativeSourceBindOperations("syphon1", bind, new Map())).toEqual([{ op: "setParameters", nodeId: "syphon1", parameters: bind }]);
  });
  it("inside an instance: published keys go to their root origin, the rest to the instance's override, override first", () => {
    const origins = new Map([["feeds/syphonDS", { source: { nodeId: "feeds", key: "serverDS" } }]]);
    expect(nativeSourceBindOperations("feeds/syphonDS", bind, origins)).toEqual([
      { op: "setParameters", nodeId: "feeds", internalNodeId: "syphonDS", parameters: { sourceApp: "Arena", sourceName: "DS" } },
      { op: "setParameters", nodeId: "feeds", parameters: { serverDS: "u2" } },
    ]);
  });
  it("nested: the override is addressed from the root instance", () => {
    expect(nativeSourceBindOperations("rig/feeds/syphonDS", { source: "u2" }, undefined)).toEqual([
      { op: "setParameters", nodeId: "rig", internalNodeId: "feeds/syphonDS", parameters: { source: "u2" } },
    ]);
  });
});
