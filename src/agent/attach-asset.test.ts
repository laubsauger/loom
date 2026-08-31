import { beforeEach, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { Actor } from "@domain/types/commands.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import type { ToolResult } from "./types.ts";

/**
 * T542 — the asset hole. An agent could add `audioFileIn`, wire it, and drive every
 * parameter — and never hand it a FILE. `attach_asset` closes it: bytes in, a session
 * object URL out, bound the way the picker binds one, with the human name in the URL
 * fragment so the inspector SHOWS what arrived (§V338). And deliberately WITHOUT the
 * export grant: putting a file INTO the page is a write, not pixels leaving (§V38) —
 * this suite never grants export, which is the point.
 */

const agent: Actor = { kind: "agent", id: "claude" };

let surface: AgentToolSurface;
let bus: ReturnType<typeof createDomainBus>["bus"];

beforeEach(() => {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  bus = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() }).bus;
  surface = createAgentToolSurface({ bus, actor: agent, projectId: "p1" });
});

const WAV_BASE64 = Buffer.from("RIFFfakewav").toString("base64");

describe("attach_asset (T542)", () => {
  it("binds bytes to the node's one asset parameter as a named session URL — no export grant", async () => {
    const added = (await surface.callTool("add_node", { type: "audioFileIn" })) as ToolResult<{
      nodeId?: string;
      createdIds?: Record<string, string>;
    }>;
    expect(added.status).toBe("ok");
    const nodeId = Object.values(
      (added.data as { createdIds?: Record<string, string> })?.createdIds ?? {},
    )[0] as string;
    expect(nodeId).toBeDefined();

    const outcome = await surface.callTool("attach_asset", {
      nodeId,
      name: "kick loop.wav",
      mimeType: "audio/wav",
      dataBase64: WAV_BASE64,
    });
    expect((outcome as ToolResult<unknown>).status).toBe("ok");

    const stored = bus.store.getGraph().nodes[nodeId]?.parameters["file"];
    expect(typeof stored).toBe("string");
    // The picker's exact shape: an object URL with the human name riding the fragment,
    // which is what the inspector row displays.
    expect(stored as string).toMatch(/^blob:/);
    expect(stored as string).toContain(`#${encodeURIComponent("kick loop.wav")}`);
  });

  it("refuses by name when the node has no asset parameter", async () => {
    const added = (await surface.callTool("add_node", { type: "solid" })) as ToolResult<{
      createdIds?: Record<string, string>;
    }>;
    const nodeId = Object.values((added.data as { createdIds?: Record<string, string> })?.createdIds ?? {})[0] as string;

    const outcome = (await surface.callTool("attach_asset", {
      nodeId,
      name: "x.wav",
      mimeType: "audio/wav",
      dataBase64: WAV_BASE64,
    })) as ToolResult<unknown> & { code?: string; message?: string };
    expect(outcome.status).not.toBe("ok");
    expect(JSON.stringify(outcome)).toContain("no asset parameter");
  });

  it("refuses garbage base64 as data, not a throw", async () => {
    const added = (await surface.callTool("add_node", { type: "audioFileIn" })) as ToolResult<{
      createdIds?: Record<string, string>;
    }>;
    const nodeId = Object.values((added.data as { createdIds?: Record<string, string> })?.createdIds ?? {})[0] as string;
    const outcome = (await surface.callTool("attach_asset", {
      nodeId,
      name: "x.wav",
      mimeType: "audio/wav",
      dataBase64: "!!!not-base64!!!",
    })) as ToolResult<unknown>;
    expect(outcome.status).not.toBe("ok");
    expect(JSON.stringify(outcome)).toContain("base64");
  });
});
