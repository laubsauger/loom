import { beforeEach, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore, type GraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { Actor } from "@domain/types/commands.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { blurNode, solidNode } from "@nodes/registry/test-nodes.ts";

import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import { encodeBase64, type PreviewImageData } from "./tools/preview.ts";
import type { PreviewExport, PreviewImageRequest } from "./types.ts";

/**
 * `render_preview`: §V48 §V59 §V38 §V60.
 *
 * The two properties that matter are that an output is named BY PORT and that a ref the
 * document does not have is refused before anything reads a pixel.
 */

const agent: Actor = { kind: "agent", id: "claude" };

/** Two texture outputs on one node — the shape `outputId === nodeId` cannot express. */
const twoOutputNode: NodeDefinition = {
  ...solidNode,
  type: "test.two",
  title: "Two outputs",
  outputs: [
    { id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 4 } },
    { id: "mask", label: "Mask", type: { kind: "texture2d", sample: "float", channels: 1 } },
  ],
};

/** A node whose only output is not an image at all. */
const scalarNode: NodeDefinition = {
  ...solidNode,
  type: "test.scalar",
  title: "Scalar",
  outputs: [{ id: "out", label: "Out", type: { kind: "scalar", scalar: "f32" } }],
};

interface Fixture {
  store: GraphStore;
  surface: AgentToolSurface;
  requests: PreviewImageRequest[];
}

let fixture: Fixture;

function createFixture(exporter?: PreviewExport): Fixture {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const registry = createNodeRegistry([solidNode, blurNode, twoOutputNode, scalarNode]).view();
  const { bus } = createDomainBus({ store, registry });
  const requests: PreviewImageRequest[] = [];
  const port: PreviewExport = exporter ?? {
    renderPreview: (request) => {
      requests.push(request);
      return Promise.resolve({
        ref: request.ref,
        mimeType: "image/png" as const,
        width: Math.min(request.maxSize, 64),
        height: Math.min(request.maxSize, 32),
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10]),
      });
    },
  };
  const surface = createAgentToolSurface({
    bus,
    actor: agent,
    projectId: "project-1",
    ports: { preview: port },
    now: () => 1_000,
  });
  bus.grants.grant(agent, "export");
  return { store, surface, requests };
}

beforeEach(() => {
  fixture = createFixture();
});

async function addNode(type: string): Promise<string> {
  const outcome = await fixture.surface.callTool("add_node", { type });
  const data = outcome.data as { createdIds: Record<string, string> };
  return data.createdIds["$node"] ?? "";
}

describe("output identity is port-scoped (§V59)", () => {
  it("defaults to the port \"out\" and passes a full ref to the export interface", async () => {
    const nodeId = await addNode("test.solid");

    const outcome = await fixture.surface.callTool("render_preview", { nodeId });

    expect(outcome.status).toBe("ok");
    const request = fixture.requests[0];
    expect(request?.ref).toEqual({ nodeId, portId: "out" });
    const data = outcome.data as PreviewImageData;
    expect(data.ref).toEqual({ nodeId, portId: "out" });
  });

  it("renders a named second output on the same node", async () => {
    const nodeId = await addNode("test.two");

    const outcome = await fixture.surface.callTool("render_preview", { nodeId, portId: "mask" });

    expect(outcome.status).toBe("ok");
    expect(fixture.requests[0]?.ref).toEqual({ nodeId, portId: "mask" });
  });

  it("bounds the image and returns a decodable descriptor (§V60)", async () => {
    const nodeId = await addNode("test.solid");

    const outcome = await fixture.surface.callTool("render_preview", { nodeId, maxSize: 32 });

    expect(fixture.requests[0]?.maxSize).toBe(32);
    const data = outcome.data as PreviewImageData;
    expect(data.mimeType).toBe("image/png");
    expect(data.width).toBeLessThanOrEqual(32);
    expect(data.byteLength).toBe(6);
    expect(data.base64).toBe(encodeBase64(new Uint8Array([137, 80, 78, 71, 13, 10])));
  });
});

describe("it refuses an unknown output before any readback (§V48)", () => {
  it("refuses a node that is not in the document", async () => {
    const outcome = await fixture.surface.callTool("render_preview", { nodeId: "nope" });

    expect(outcome.status).toBe("error");
    expect(outcome.diagnostics[0]?.code).toBe("output.unknownNode");
    expect(fixture.requests).toHaveLength(0);
  });

  it("refuses a port the node's definition does not declare", async () => {
    const nodeId = await addNode("test.solid");

    const outcome = await fixture.surface.callTool("render_preview", { nodeId, portId: "mask" });

    expect(outcome.status).toBe("error");
    expect(outcome.diagnostics[0]?.code).toBe("output.unknownPort");
    expect(fixture.requests).toHaveLength(0);
  });

  it("refuses an output port that carries no image", async () => {
    const nodeId = await addNode("test.scalar");

    const outcome = await fixture.surface.callTool("render_preview", { nodeId });

    expect(outcome.status).toBe("error");
    expect(outcome.diagnostics[0]?.code).toBe("output.notTexture");
    expect(fixture.requests).toHaveLength(0);
  });

  it("reports an export failure as a diagnostic and quotes nothing it threw", async () => {
    const failing = createFixture({
      renderPreview: () => Promise.reject(new Error("secret internal detail")),
    });
    const added = await failing.surface.callTool("add_node", { type: "test.solid" });
    const nodeId = (added.data as { createdIds: Record<string, string> }).createdIds["$node"] ?? "";

    const outcome = await failing.surface.callTool("render_preview", { nodeId });

    expect(outcome.status).toBe("error");
    expect(outcome.diagnostics[0]?.code).toBe("export.failed");
    expect(JSON.stringify(outcome)).not.toContain("secret internal detail");
  });
});

describe("base64 transport encoding", () => {
  it("matches the reference encoding, including padding", () => {
    expect(encodeBase64(new Uint8Array([]))).toBe("");
    expect(encodeBase64(new Uint8Array([77]))).toBe("TQ==");
    expect(encodeBase64(new Uint8Array([77, 97]))).toBe("TWE=");
    expect(encodeBase64(new Uint8Array([77, 97, 110]))).toBe("TWFu");
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
