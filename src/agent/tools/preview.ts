import type { GraphDocument } from "@domain/types/graph.ts";

import { SNAPSHOT_MAX_SIZE } from "../capabilities.ts";
import { describeOutputInput, renderPreviewInput, type DescribeOutputInput, type RenderPreviewInput } from "../schemas.ts";
import { failed, ok } from "../tool-support.ts";
import { DEFAULT_OUTPUT_PORT, type AgentTool, type OutputRef, type OutputStatsData } from "../types.ts";

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
 * ## It needs the `previewSnapshot` grant — and `export` for full fidelity (T1220)
 *
 * The result is pixels leaving the app for the calling model, but a TILE of a named output
 * is not the act `export` exists to guard; see `@agent/capabilities.ts` for the argument
 * and `SNAPSHOT_MAX_SIZE` for the bound that makes it a smaller ask. The bound is enforced
 * HERE, twice and against the actor's grants rather than against anything in the input:
 * the requested `maxSize` is clamped for an actor that does not hold `export`, and an
 * answer that comes back larger than the bound anyway is REFUSED rather than returned.
 * Two checks because they fail for different reasons — the clamp is the contract with a
 * provider that honours `maxSize`, the refusal is what happens when one does not — and a
 * bound that only one of them enforced would be a docstring, not a bound.
 */

export interface PreviewImageData {
  readonly ref: OutputRef;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  /** Base64 PNG. Bounded by `maxSize`; the provider may return a smaller image. */
  readonly base64: string;
  /**
   * T1220: the tile bound was applied to this call, because the actor holds
   * `previewSnapshot` and not `export`. Reported rather than silent — an agent that asked
   * for 2048 and got 384 should be told which of the two numbers it is reasoning about,
   * and §V338's rule is that a detection is shown, not merely branched on.
   */
  readonly snapshotBounded?: true;
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
  capabilities: ["previewSnapshot"],
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

    /*
     * T1220 — THE TILE BOUND, READ OFF THE ACTOR'S GRANTS.
     *
     * `export` is the full-fidelity capability and it is unchanged: an actor holding it
     * gets exactly the behaviour this tool has always had, up to the schema's 2048. An
     * actor holding only `previewSnapshot` cannot reach past the tile bound by any input,
     * because the number is not taken from the input at all — it is the min of what was
     * asked and what the capability allows. `bus.grants` is the bus-owned store §V38 makes
     * the sole authority; the invocation's advisory `capabilities` array is not consulted,
     * here or anywhere.
     */
    const fullFidelity = runtime.bus.grants.has(runtime.invocation().actor, "export");
    const requested = input.maxSize ?? (fullFidelity ? DEFAULT_MAX_SIZE : SNAPSHOT_MAX_SIZE);
    const maxSize = fullFidelity ? requested : Math.min(requested, SNAPSHOT_MAX_SIZE);
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

    /*
     * The second half of the bound, and it is not belt-and-braces: `maxSize` is a REQUEST
     * to a provider this module does not own (`PreviewExport` is injected, and the tests
     * inject their own), so a provider that ignores it would otherwise be a way through
     * the gate — an actor with the small capability receiving a full-resolution frame. The
     * pixels are dropped rather than downscaled: there is no image resampler in this
     * directory, and inventing one to salvage a provider that broke its contract would be
     * a silent repair of a loud bug (§V469's shape).
     */
    if (!fullFidelity && (image.width > SNAPSHOT_MAX_SIZE || image.height > SNAPSHOT_MAX_SIZE)) {
      return failed<PreviewImageData>(
        "render_preview",
        "export.snapshotOversize",
        `A preview snapshot is bounded to ${SNAPSHOT_MAX_SIZE}px on each edge, and the render came back ${image.width}x${image.height}; the pixels were discarded rather than returned.`,
        {
          revision: graph.revision,
          suggestion:
            "This is a bug in the attached preview provider, which ignored the requested maxSize — not something a different input can fix. Full-resolution readback is the `export` capability, which this actor does not hold (T1220, §V38).",
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
        ...(fullFidelity ? {} : { snapshotBounded: true as const }),
      },
      { revision: graph.revision },
    );
  },
};

/**
 * `describe_output` (T291): the texture as NUMBERS — per-channel min/max/mean on the
 * linear plane, resolution and format, no pixels. The look an agent reaches for FIRST:
 * "is it black? clipped? flat?" costs ~a hundred tokens here and thousands as a
 * thumbnail. Same seam and grant as render_preview (§V48, §V38) — statistics of pixels
 * are still pixel information leaving the app.
 *
 * T1220 moved that shared grant from `export` to `previewSnapshot`, and this tool needs no
 * bound of its own: three numbers per channel are already smaller than the tile the
 * capability allows, and there is no input by which they can become an image.
 */
export const describeOutput: AgentTool<DescribeOutputInput, OutputStatsData> = {
  name: "describe_output",
  title: "Describe output",
  description:
    "Summarise one texture output as numbers: per-channel min/max/mean (linear), resolution, format. Cheaper than a preview; reach for this first.",
  kind: "read",
  inputSchema: describeOutputInput,
  requires: { queries: ["graph.get"], ports: ["preview"] },
  capabilities: ["previewSnapshot"],
  mutates: false,
  async run(input, runtime) {
    const port = runtime.ports.preview;
    if (port?.describeOutput === undefined) {
      return failed<OutputStatsData>(
        "describe_output",
        "preview.statsUnavailable",
        "This session's preview port does not provide output statistics.",
      );
    }
    const ref: OutputRef = { nodeId: input.nodeId, portId: input.portId ?? DEFAULT_OUTPUT_PORT };
    try {
      return ok<OutputStatsData>("describe_output", await port.describeOutput(ref));
    } catch (error) {
      return failed<OutputStatsData>(
        "describe_output",
        "preview.statsFailed",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};

export const previewTools: readonly AgentTool[] = [renderPreview, describeOutput] as readonly AgentTool[];
