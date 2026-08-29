import { describe, expect, it } from "vitest";
import {
  createShaderCompilePipeline,
  type ShaderCompilePipeline,
} from "./compile-pipeline.ts";
import { createShaderCompileCache } from "./shader-cache.ts";
import { createManualScheduler } from "./testing/manual-scheduler.ts";
import type { ManualScheduler } from "./testing/manual-scheduler.ts";
import { shaderSignature } from "./shader-signature.ts";
import { ShaderDiagnosticCode } from "./shader-diagnostics.ts";
import type {
  ShaderCompileOutput,
  ShaderCompileRequest,
  ShaderCompiler,
} from "./compile-types.ts";

const VALID = "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }";
const ALSO_VALID = "@fragment fn fs() -> @location(0) vec4f { return vec4f(0.5); }";
const BROKEN = "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0)"; // no closing brace

function request(source: string, overrides: Partial<ShaderCompileRequest> = {}): ShaderCompileRequest {
  return {
    nodeId: "node-1",
    source,
    entryPoints: ["fs"],
    targetSignature: "rgba16float:1",
    constants: {},
    bindingLayout: [{ group: 0, binding: 0, kind: "sampler" }],
    ...overrides,
  };
}

const syntaxError: ShaderCompileOutput = {
  status: "failed",
  messages: [{ type: "error", message: "expected '}'", lineNum: 1, linePos: 58 }],
};

/**
 * A compiler under the test's control. `outcomes` decides what each source compiles to;
 * anything not listed compiles cleanly. `calls` records what was actually asked for,
 * which is how debounce coalescing and cache hits are observed.
 */
interface FakeCompiler extends ShaderCompiler {
  readonly calls: ShaderCompileRequest[];
}

function createFakeCompiler(outcomes: Record<string, ShaderCompileOutput> = {}): FakeCompiler {
  const calls: ShaderCompileRequest[] = [];
  return {
    calls,
    async compile(input) {
      calls.push(input);
      const outcome: ShaderCompileOutput =
        outcomes[input.source] ?? { status: "ok", artifact: `program:${input.source}`, messages: [] };
      return outcome;
    },
  };
}

function createPipeline(
  compiler: ShaderCompiler,
  cache = createShaderCompileCache(),
): { pipeline: ShaderCompilePipeline; scheduler: ManualScheduler } {
  const scheduler = createManualScheduler();
  const pipeline = createShaderCompilePipeline({ compiler, cache, scheduler, debounceMs: 300 });
  return { pipeline, scheduler };
}

/** Request → let the debounce window elapse → wait for the compile to settle. */
async function compile(
  pipeline: ShaderCompilePipeline,
  scheduler: ManualScheduler,
  input: ShaderCompileRequest,
): Promise<void> {
  pipeline.request(input);
  scheduler.advance();
  await pipeline.flush();
}

describe("V9 — an invalid edit never blanks the output", () => {
  it("retains the last valid program and flags the output stale", async () => {
    // The headline invariant. Someone mid-keystroke has invalid WGSL almost
    // continuously; if a failed compile dropped the program, the render would go black
    // on most characters typed and the tool would be unusable.
    const compiler = createFakeCompiler({ [BROKEN]: syntaxError });
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    const good = pipeline.state.program;
    expect(good).not.toBeNull();
    expect(pipeline.state.stale).toBe(false);

    await compile(pipeline, scheduler, request(BROKEN));

    expect(pipeline.state.program).toBe(good);
    expect(pipeline.state.program?.artifact).toBe(`program:${VALID}`);
    expect(pipeline.state.stale).toBe(true);
    expect(pipeline.state.errors).toHaveLength(1);
    expect(pipeline.state.errors[0]?.code).toBe(ShaderDiagnosticCode.error);
  });

  it("installs the new program and clears stale on the next valid edit", async () => {
    const compiler = createFakeCompiler({ [BROKEN]: syntaxError });
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    await compile(pipeline, scheduler, request(BROKEN));
    expect(pipeline.state.stale).toBe(true);

    await compile(pipeline, scheduler, request(ALSO_VALID));

    expect(pipeline.state.stale).toBe(false);
    expect(pipeline.state.program?.artifact).toBe(`program:${ALSO_VALID}`);
    expect(pipeline.state.errors).toEqual([]);
  });

  it("does not claim staleness for a shader that never compiled at all", async () => {
    // There is no last-valid output to be stale — the node simply has no program yet.
    // Saying "stale" here would send the user hunting for a good frame that never existed.
    const compiler = createFakeCompiler({ [BROKEN]: syntaxError });
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(BROKEN));

    expect(pipeline.state.program).toBeNull();
    expect(pipeline.state.stale).toBe(false);
    expect(pipeline.state.errors).toHaveLength(1);
  });

  it("leaves no pending stale flag when the compile call itself throws", async () => {
    // A rejected compile is still a settled compile: the phase must return to idle and
    // the stale flag must stay clearable, or the UI shows "compiling…" and a stale badge
    // for the rest of the session.
    const compiler: ShaderCompiler = {
      async compile(input) {
        if (input.source === BROKEN) throw new Error("device lost");
        return { status: "ok", artifact: `program:${input.source}`, messages: [] };
      },
    };
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    await compile(pipeline, scheduler, request(BROKEN));

    expect(pipeline.state.phase).toBe("idle");
    expect(pipeline.state.stale).toBe(true);
    expect(pipeline.state.errors[0]?.code).toBe(ShaderDiagnosticCode.internal);

    await compile(pipeline, scheduler, request(ALSO_VALID));
    expect(pipeline.state.phase).toBe("idle");
    expect(pipeline.state.stale).toBe(false);
  });

  it("does not cache a thrown compile — the throw was about the moment, not the text", async () => {
    let attempts = 0;
    const compiler: ShaderCompiler = {
      async compile(input) {
        attempts += 1;
        if (attempts === 1) throw new Error("device lost");
        return { status: "ok", artifact: `program:${input.source}`, messages: [] };
      },
    };
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    expect(pipeline.state.program).toBeNull();

    await compile(pipeline, scheduler, request(VALID));
    expect(attempts).toBe(2);
    expect(pipeline.state.program?.artifact).toBe(`program:${VALID}`);
  });
});

describe("V27 — errors and warnings arrive separated", () => {
  it("keeps a warning out of the error list, and a warning alone is not a failure", async () => {
    const warned: ShaderCompileOutput = {
      status: "ok",
      artifact: "program:warned",
      messages: [
        { type: "warning", message: "unused variable 'k'", lineNum: 4, linePos: 7 },
        { type: "info", message: "workgroup size defaulted", lineNum: 0, linePos: 0 },
      ],
    };
    const compiler = createFakeCompiler({ [VALID]: warned });
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));

    expect(pipeline.state.errors).toEqual([]);
    expect(pipeline.state.warnings).toHaveLength(1);
    expect(pipeline.state.warnings[0]?.source).toEqual({ file: "node-1", line: 4, column: 7 });
    expect(pipeline.state.info).toHaveLength(1);
    // A shader that only warns still compiled, so the output is current.
    expect(pipeline.state.stale).toBe(false);
    expect(pipeline.state.program?.artifact).toBe("program:warned");
  });
});

describe("debounce (doc §9.3)", () => {
  it("coalesces a burst of keystrokes into one compile of the final text", async () => {
    const compiler = createFakeCompiler();
    const { pipeline, scheduler } = createPipeline(compiler);

    pipeline.request(request("a"));
    pipeline.request(request("ab"));
    pipeline.request(request("abc"));
    expect(compiler.calls).toHaveLength(0);
    expect(pipeline.state.phase).toBe("pending");

    scheduler.advance();
    await pipeline.flush();

    expect(compiler.calls).toHaveLength(1);
    expect(compiler.calls[0]?.source).toBe("abc");
    expect(pipeline.state.compileCount).toBe(1);
  });

  it("compiles nothing until the quiet window elapses", () => {
    const compiler = createFakeCompiler();
    const { pipeline } = createPipeline(compiler);
    pipeline.request(request(VALID));
    expect(compiler.calls).toHaveLength(0);
    expect(pipeline.state.phase).toBe("pending");
  });

  it("flush compiles the queued edit immediately — the blur / explicit-action path", async () => {
    const compiler = createFakeCompiler();
    const { pipeline } = createPipeline(compiler);

    pipeline.request(request(VALID));
    await pipeline.flush();

    expect(compiler.calls).toHaveLength(1);
    expect(pipeline.state.program?.artifact).toBe(`program:${VALID}`);
  });

  it("drops the result of a compile that a newer edit superseded", async () => {
    // Promise order is not request order. Whichever settles last, the newest request has
    // to be the one that decides what runs.
    const gates = new Map<string, () => void>();
    const compiler: ShaderCompiler = {
      compile(input) {
        return new Promise((resolve) => {
          gates.set(input.source, () =>
            resolve({ status: "ok", artifact: `program:${input.source}`, messages: [] }),
          );
        });
      },
    };
    const { pipeline, scheduler } = createPipeline(compiler);

    pipeline.request(request("first"));
    scheduler.advance();
    pipeline.request(request("second"));
    scheduler.advance();

    // The stale compile answers last.
    gates.get("second")?.();
    await pipeline.flush();
    gates.get("first")?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pipeline.state.program?.artifact).toBe("program:second");
  });
});

describe("compile cache (doc §9.3)", () => {
  it("hits for text that differs only in whitespace, and does not recompile", async () => {
    const compiler = createFakeCompiler();
    const cache = createShaderCompileCache();
    const { pipeline, scheduler } = createPipeline(compiler, cache);

    await compile(pipeline, scheduler, request(VALID));
    expect(compiler.calls).toHaveLength(1);

    await compile(pipeline, scheduler, request(`${VALID}   \n\n`));

    expect(compiler.calls).toHaveLength(1);
    expect(pipeline.state.compileCount).toBe(1);
    expect(pipeline.state.cacheHits).toBe(1);
    expect(pipeline.state.program?.signature).toBe(shaderSignature(request(VALID)));
  });

  it("misses when the binding layout changes, even for identical text", async () => {
    // The same WGSL against a different layout is a different program. A cache that hit
    // here would keep rendering a pipeline bound to resources that have moved.
    const compiler = createFakeCompiler();
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    await compile(
      pipeline,
      scheduler,
      request(VALID, { bindingLayout: [{ group: 0, binding: 3, kind: "sampler" }] }),
    );

    expect(compiler.calls).toHaveLength(2);
    expect(pipeline.state.cacheHits).toBe(0);
  });

  it("replays a cached failure without asking the compiler again", async () => {
    const compiler = createFakeCompiler({ [BROKEN]: syntaxError });
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    await compile(pipeline, scheduler, request(BROKEN));
    await compile(pipeline, scheduler, request(BROKEN));

    expect(compiler.calls.filter((call) => call.source === BROKEN)).toHaveLength(1);
    expect(pipeline.state.stale).toBe(true);
    expect(pipeline.state.errors).toHaveLength(1);
  });

  it("returns to a good program from cache when the user undoes back to it", async () => {
    // Ctrl-Z out of a broken edit is the most common recovery there is; it must clear
    // stale without a recompile.
    const compiler = createFakeCompiler({ [BROKEN]: syntaxError });
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    await compile(pipeline, scheduler, request(BROKEN));
    await compile(pipeline, scheduler, request(VALID));

    expect(pipeline.state.stale).toBe(false);
    expect(pipeline.state.errors).toEqual([]);
    expect(compiler.calls.filter((call) => call.source === VALID)).toHaveLength(1);
  });
});

describe("pipeline lifecycle", () => {
  it("notifies subscribers on every state change and stops after unsubscribe", async () => {
    const compiler = createFakeCompiler();
    const { pipeline, scheduler } = createPipeline(compiler);
    const seen: string[] = [];
    const unsubscribe = pipeline.subscribe((state) => seen.push(state.phase));

    await compile(pipeline, scheduler, request(VALID));
    expect(seen).toContain("pending");
    expect(seen).toContain("compiling");
    expect(seen[seen.length - 1]).toBe("idle");

    unsubscribe();
    const before = seen.length;
    await compile(pipeline, scheduler, request(ALSO_VALID));
    expect(seen).toHaveLength(before);
  });

  it("clears a previous node's program and errors when the editor switches node", async () => {
    // Node B must not inherit node A's retained program or its error list.
    const compiler = createFakeCompiler({ [BROKEN]: syntaxError });
    const { pipeline, scheduler } = createPipeline(compiler);

    await compile(pipeline, scheduler, request(VALID));
    await compile(pipeline, scheduler, request(BROKEN));
    expect(pipeline.state.stale).toBe(true);

    pipeline.request(request(VALID, { nodeId: "node-2" }));

    expect(pipeline.state.nodeId).toBe("node-2");
    expect(pipeline.state.program).toBeNull();
    expect(pipeline.state.stale).toBe(false);
    expect(pipeline.state.errors).toEqual([]);
  });

  it("stops scheduling and compiling once disposed", async () => {
    const compiler = createFakeCompiler();
    const { pipeline, scheduler } = createPipeline(compiler);

    pipeline.request(request(VALID));
    pipeline.dispose();
    scheduler.advance();
    await pipeline.flush();

    expect(compiler.calls).toHaveLength(0);
  });
});
