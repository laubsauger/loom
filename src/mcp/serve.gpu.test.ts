import { describe, expect, it } from "vitest";

import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createHeadlessMcpServer } from "./serve.ts";

/**
 * T294 end to end: the HEADLESS server with a real GPU behind it. An MCP client
 * builds a graph with the same tool calls an in-tab agent would make, then asks for
 * pixels — and gets MCP image content computed on Dawn, over what is functionally
 * stdio. This is the "agents look at outputs with ease" story with nothing mocked:
 * transport shapes in, rendered bytes out.
 */

describe("headless MCP server on Dawn (T294)", () => {
  it("builds solid → output over the protocol and renders a preview with real pixels", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const sent: Array<Record<string, unknown>> = [];
    const server = createHeadlessMcpServer({ send: (message) => sent.push(message) });
    await server.ready;

    let nextId = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
      const id = nextId++;
      await server.receive({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const reply = sent.findLast((message) => message["id"] === id) as {
        result?: { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
      };
      return reply.result;
    };

    const createdId = (result: Awaited<ReturnType<typeof call>>): string | undefined => {
      const parsed = JSON.parse(result?.content?.[0]?.text ?? "{}") as {
        data?: { createdIds?: Record<string, string> };
      };
      return parsed.data?.createdIds?.["$node"];
    };
    const added = await call("add_node", { type: "solid", parameters: { color: [1, 0, 0, 1] } });
    const solidId = createdId(added);
    expect(solidId, "add_node must return the new node id").toBeTypeOf("string");

    const out = await call("add_node", {
      type: "output",
      placement: { relativeTo: solidId, direction: "right" },
    });
    const outId = createdId(out);
    await call("connect_ports", {
      source: { nodeId: solidId, portId: "out" },
      target: { nodeId: outId, portId: "input" },
    });

    // The revision notifications streamed while we built (quasi-realtime, T290).
    expect(sent.some((message) => message["method"] === "notifications/shaderloom/revision")).toBe(true);

    const preview = await call("render_preview", { nodeId: solidId, maxSize: 64 });
    const image = preview?.content?.find((entry) => entry.type === "image");
    expect(image, "render_preview must return MCP image content").toBeDefined();
    expect(image?.mimeType).toBe("image/png");
    // Real pixels: a PNG of a red solid is comfortably past any header-only size.
    expect((image?.data ?? "").length).toBeGreaterThan(100);

    server.dispose();
  });
});
