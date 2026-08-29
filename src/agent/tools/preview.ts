import type { GraphDocument } from "@domain/types/graph.ts";

import { renderPreviewInput, type RenderPreviewInput } from "../schemas.ts";
import { failed, ok } from "../tool-support.ts";
import { DEFAULT_OUTPUT_PORT, type AgentTool, type OutputRef } from "../types.ts";

/**
 * `render_preview` (T58, §V48, §V59, §I.tools).
 *
 * ## Port-scoped, always
 *
 * The tool takes `{nodeId, portId}` and defaults `portId` to "out" (§V59). A node with
 * two texture outputs has two previewable outputs, and `outputId === nodeId` would make
 * one of them unreachable — so the ref is built explicitly here and passed through
 * unchanged.
 *
 * ## It refuses before it reads
 *
 * The ref is checked against the document and the node manifest FIRST: unknown node,
 * undeclared port, or a port that is not a texture all come back as an error with a
 * diagnostic and no readback is attempted. That keeps a typo out of the export path
 * entirely, and it means an export implementation may assume the ref is structurally real.
 *
 * ## The readback goes through the export interface, never around it
 *
 * §V48 makes the export interface the sole readback surface and §V7 keeps readback out of
 * the playback loop. This tool holds a `PreviewExport` port (T68 supplies it) and has no
 * other way to obtain a pixel — there is no backend import in this directory.
 *
 * ## It needs the `export` grant
 *
 * The result is pixels leaving the app for the calling model. That is the export
 * capability class doing its job, even though no file is written (§V38).
 */

export interface PreviewImageData {
  readonly ref: OutputRef;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  /** Base64 PNG. Bounded by `maxSize`; the provider may return a smaller image. */
  readonly base64: string;
}

const DEFAULT_MAX_SIZE = 512;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Bytes to base64 without `Buffer` or `btoa`: this module runs in a browser tab, in a
 * worker and in Node, and neither global exists in all three.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64_ALPHABET[(triple >> 18) & 63] ?? "";
    out += BASE64_ALPHABET[(triple >> 12) & 63] ?? "";
    out += b === undefined ? "=" : (BASE64_ALPHABET[(triple >> 6) & 63] ?? "");
    out += c === undefined ? "=" : (BASE64_ALPHABET[triple & 63] ?? "");
  }
  return out;
}

export const renderPreview: AgentTool<RenderPreviewInput, PreviewImageData> = {
  name: "render_preview",
  title: "Render preview",
  description:
    "Render one texture output to a bounded-size PNG for visual inspection. An output is identified by node id AND port id; port defaults to \"out\".",
  kind: "read",
  inputSchema: renderPreviewInput,
  requires: { queries: ["graph.get"], ports: ["preview"] },
  capabilities: ["export"],
  mutates: false,
  async run(input, runtime) {
    const ref: OutputRef = { nodeId: input.nodeId, portId: input.portId ?? DEFAULT_OUTPUT_PORT };
    const graph = await runtime.query<GraphDocument>("graph.get", {});

    const node = graph.nodes[ref.nodeId];
    if (node === undefined) {
      return failed<PreviewImageData>("render_preview", "output.unknownNode", `No node with id "${ref.nodeId}".`, {
        revision: graph.revision,
        suggestion: "Call get_project_summary for the port-scoped outputs that exist.",
      });
    }

    const definition = runtime.bus.registry.get(node.type);
    if (definition === undefined) {
      return failed<PreviewImageData>(
        "render_preview",
        "output.unknownDefinition",
        `Node "${ref.nodeId}" has no registered definition, so its outputs are unknown.`,
        { revision: graph.revision },
      );
    }

    const port = definition.outputs.find((candidate) => candidate.id === ref.portId);
    if (port === undefined) {
      // The declared port ids are listed as data, not quoted into prose.
      return failed<PreviewImageData>(
        "render_preview",
        "output.unknownPort",
        `Node "${ref.nodeId}" declares no output port "${ref.portId}".`,
        {
          revision: graph.revision,
          suggestion: "Read the node's declared output ports with get_node.",
        },
      );
    }
    if (port.type.kind !== "texture2d") {
      return failed<PreviewImageData>(
        "render_preview",
        "output.notTexture",
        `Output "${ref.nodeId}:${ref.portId}" is a ${port.type.kind} port, which has no image to render.`,
        { revision: graph.revision },
      );
    }

    const exporter = runtime.ports.preview;
    if (exporter === undefined) {
      return failed<PreviewImageData>("render_preview", "export.missing", "No export interface is attached.", {
        revision: graph.revision,
      });
    }

    const maxSize = input.maxSize ?? DEFAULT_MAX_SIZE;
    let image;
    try {
      image = await exporter.renderPreview({ ref, maxSize });
    } catch {
      // The thrown value is not quoted: an exception message can carry document text,
      // and a tool result is data, never something the model should read as direction.
      return failed<PreviewImageData>(
        "render_preview",
        "export.failed",
        `The export interface could not render output "${ref.nodeId}:${ref.portId}".`,
        {
          revision: graph.revision,
          suggestion: "Compile the project and check diagnostics, then retry.",
        },
      );
    }

    return ok<PreviewImageData>(
      "render_preview",
      {
        ref: image.ref,
        mimeType: "image/png",
        width: image.width,
        height: image.height,
        byteLength: image.bytes.length,
        base64: encodeBase64(image.bytes),
      },
      { revision: graph.revision },
    );
  },
};

export const previewTools: readonly AgentTool[] = [renderPreview] as readonly AgentTool[];
