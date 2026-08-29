import { describe, expect, it } from "vitest";
import { createShaderCompileCache } from "./shader-cache.ts";
import type { ShaderCompileOutput } from "./compile-types.ts";

const ok = (artifact: string): ShaderCompileOutput => ({ status: "ok", artifact, messages: [] });

describe("shader compile cache", () => {
  it("returns what it stored, and undefined for a key it has not seen", () => {
    const cache = createShaderCompileCache();
    cache.set("a", ok("program-a"));
    expect(cache.get("a")?.artifact).toBe("program-a");
    expect(cache.get("b")).toBeUndefined();
  });

  it("caches failures too, so retyping a broken shader does not recompile it", () => {
    const cache = createShaderCompileCache();
    const failure: ShaderCompileOutput = {
      status: "failed",
      messages: [{ type: "error", message: "boom", lineNum: 1, linePos: 1 }],
    };
    cache.set("bad", failure);
    expect(cache.get("bad")?.status).toBe("failed");
  });

  it("evicts the least recently used entry once full", () => {
    const cache = createShaderCompileCache(2);
    cache.set("a", ok("a"));
    cache.set("b", ok("b"));
    // Reading "a" makes "b" the least recently used.
    expect(cache.get("a")).toBeDefined();
    cache.set("c", ok("c"));

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("never grows past its limit, however many distinct shaders are compiled", () => {
    const cache = createShaderCompileCache(4);
    for (let index = 0; index < 100; index += 1) cache.set(`k${index}`, ok(`p${index}`));
    expect(cache.size).toBe(4);
  });
});
