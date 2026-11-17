import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { analyseOffline } from "../app/audio-offline-analysis.ts";
import { captureConfigOf, syncLeadOf } from "../app/audio-capture-config.ts";
import { PRE_ANALYSIS_SAMPLE_RATE, readTrackAtPlayhead } from "../app/audio-pre-analysis.ts";
import { flattenComponents } from "../compiler/index.ts";
import { describeFinding } from "../compiler/document-findings.ts";
import { createComponentSystem, type ComponentRegistryView } from "../domain/components/index.ts";
import { MEDIA_TRANSPORT_KEYS, mediaPlayheadAt, mediaTransportFrom, type MediaTransportValues } from "../domain/media/transport.ts";
import { hdrPictureRefusal, pictureFileKind, pictureFileUrl } from "../domain/media/picture-file.ts";
import { effectiveParameterSchema, resolveStored } from "../domain/parameters/resolve.ts";
import { isParameterSlot } from "../domain/parameters/slots.ts";
import { loadProject } from "../domain/project/index.ts";
import { TONAL_NODE_TYPES } from "../domain/audio/tonal-fields.ts";
import { isSilencedSource } from "../domain/graph/bypass.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { AudioFeatures } from "../domain/types/frame.ts";
import type { FlatGraph, GraphDocument, GraphNode, ProjectDocument } from "../domain/types/graph.ts";
import type { NodeDefinition, TextureFormat } from "../domain/types/node-definition.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import type { ColorSpace } from "../domain/types/ports.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry, type NodeRegistryView } from "../nodes/registry/registry.ts";
import type { LinearDecode } from "../runtime/backend/backend-types.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { analyzeChannelEntries } from "../runtime/execution/analyze-channels.ts";
import { bytesAreEncoded, decodeToLinear, transferForSpace } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL, clamp01, decodeHalf, linearToSrgb, srgbToLinear } from "../runtime/export/pixel-format.ts";
import { PNG_SIGNATURE, pngChunk } from "../runtime/export/png.ts";
import { renderHeadless, type AccumulateTarget, type RenderFinding } from "../tests/headless/render-harness.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";

/**
 * T1738b — RENDER A SAVED PROJECT OFFLINE: the library half of `pnpm render`
 * (`render-project.ts` is the command, and the usage lives there).
 *
 * Every pre-render the perfumery pillar session delivered went through a scratch script, so the
 * pieces that script proved are here once:
 *
 *  - the project loads through `loadProject`, the app's own open path, with its component
 *    library installed, and renders through `renderHeadless`, the harness every headless gate
 *    uses — what this renders is what Loom renders;
 *  - `--spp N` steps N sub-frames per output frame at N × fps and averages them in LINEAR light:
 *    a shutter adds light, so black and white average to linear 0.5, which is encoded 188, not
 *    the 128 an average of display values gives. T1739b: summed on the GPU and read back once
 *    per output frame (`LoomBackend.accumulateOutput`), through the decode tables
 *    `LinearAverager` (the per-sub-frame CPU path) reads, so the two agree: bit for bit where
 *    alpha is 1 by construction, and on E1's fractional alpha as measured (`output-accumulator.ts`);
 *  - T1745b: a render is deterministic from its warm-up's first frame; by default a plan that
 *    carries state (`temporalStateOf`) is warmed from the timeline's frame 0 (`renderFrames`);
 *  - frames leave as 16-bit display values, so a 10-bit ProRes 4444 or HEVC Main 10 clip gets
 *    the averaged precision an 8-bit hand-off would throw away (T1741b's banding);
 *  - a Movie File In that names a local file plays it, decoded by ffmpeg at the node's media
 *    texture size into the T1737b `movies` feed through `BoundedFrameReader`, which holds at
 *    most a couple of frames and leaves the decoder blocked on its pipe while the GPU works. (A
 *    Buffer.concat reader ran CPU-bound with an idle GPU.)
 *
 *  - T1754b: an Audio File In's file is HEARD. It is decoded by ffmpeg to mono at the app's
 *    pre-analysis rate, walked by the app's own offline analysis (`analyseOffline`, tonal pass
 *    included when the document holds a tonal node) and read at the node's playhead on every
 *    stepped frame, through the harness's `audio` seam. Before this every audio node rendered
 *    silence here and nothing said so.
 *
 * Nothing here writes the document: `--set` and `--quality final` change what this render reads.
 */

/** What a render of an output frame hands on: display values, 16 bits, straight alpha. */
export interface OutputFrame {
  /** The output frame index on the project's timeline (frame / fps = seconds). */
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` values, row-major, top row first: display-encoded RGBA, 0..65535. */
  readonly rgba: Uint16Array;
}

// ---------------------------------------------------------------------------------------------
// Sub-frames, averaged in linear light
// ---------------------------------------------------------------------------------------------

/** Readback value → linear light, cached per format: a half has 65,536 patterns, a byte 256. */
const linearTables = new Map<string, Float32Array>();
function linearTable(format: "rgba16float" | "rgba8", encoded: boolean): Float32Array {
  const key = `${format}:${encoded}`;
  const cached = linearTables.get(key);
  if (cached !== undefined) return cached;
  const size = format === "rgba16float" ? 65_536 : 256;
  const table = new Float32Array(size);
  for (let bits = 0; bits < size; bits += 1) {
    const value = format === "rgba16float" ? decodeHalf(bits) : bits / 255;
    table[bits] = encoded ? srgbToLinear(value) : value;
  }
  linearTables.set(key, table);
  return table;
}

/**
 * T1739b — how an output's stored channel patterns decode to linear light, as the tables a
 * GPU sum (`LoomBackend.accumulateOutput`) and `LinearAverager` both read: the declared space
 * decides (§V57, `bytesAreEncoded`), colour premultiplied by alpha except for `data`.
 * Undefined for a format no per-pattern table covers (`r32float`), which is averaged here.
 */
export function linearDecodeFor(format: TextureFormat, space: ColorSpace): LinearDecode | undefined {
  const table = format === "rgba16float" ? "rgba16float" : format === "rgba8unorm" || format === "rgba8unorm-srgb" ? "rgba8" : undefined;
  if (table === undefined) return undefined;
  return { colour: linearTable(table, bytesAreEncoded(format, space)), alpha: linearTable(table, false), premultiply: space !== "data" };
}

/**
 * The mean of `count` frames' linear sum (premultiplied unless the space is `data`),
 * display-encoded to 16 bits. One resolve for both sums, the GPU's and `LinearAverager`'s, so
 * the two can only differ where their sums do.
 *
 * `opaque` composites over black (in linear light) for a container with no alpha channel:
 * dropping a straight alpha would show whatever colour a transparent pixel happens to carry.
 */
export function resolveLinearSum(sum: Float32Array, count: number, space: ColorSpace, options: { readonly opaque?: boolean } = {}): Uint16Array {
  if (count === 0) throw new Error("resolveLinearSum: no frame was added.");
  const out = new Uint16Array(sum.length);
  const inverse = 1 / count;
  const premultiplied = space !== "data";
  const encode = transferForSpace(space) === "srgb" ? linearToSrgb : clamp01;
  const opaque = options.opaque === true;
  for (let i = 0; i < sum.length; i += 4) {
    const alpha = sum[i + 3]! * inverse;
    // Straight colour: the premultiplied mean over the mean alpha; over black it stays premultiplied.
    const unpremultiply = !premultiplied || opaque ? inverse : alpha > 0 ? inverse / alpha : 0;
    out[i] = Math.round(encode(sum[i]! * unpremultiply) * 65_535);
    out[i + 1] = Math.round(encode(sum[i + 1]! * unpremultiply) * 65_535);
    out[i + 2] = Math.round(encode(sum[i + 2]! * unpremultiply) * 65_535);
    out[i + 3] = opaque ? 65_535 : Math.round(clamp01(alpha) * 65_535);
  }
  return out;
}

/**
 * Sums sub-frames in LINEAR light and resolves their mean, display-encoded, to 16 bits.
 *
 * The readback is decoded the way `decodeToLinear` decodes it (§V57: the declared space
 * decides, `bytesAreEncoded`), through cached tables for the two formats a render target has
 * (`linearDecodeFor`, the GPU sum's own). Colour is summed PREMULTIPLIED by alpha, so a
 * sub-frame where a pixel is transparent adds no colour to it; a `data` output is summed
 * straight and leaves untransferred, as an export leaves it (`transferForSpace`).
 */
export class LinearAverager {
  readonly width: number;
  readonly height: number;
  private readonly format: TextureFormat;
  private readonly space: ColorSpace;
  private readonly sum: Float32Array;
  private added = 0;

  constructor(width: number, height: number, format: TextureFormat, space: ColorSpace) {
    this.width = width;
    this.height = height;
    this.format = format;
    this.space = space;
    this.sum = new Float32Array(width * height * 4);
  }

  /** Sub-frames added since the last `resolve`. */
  get count(): number {
    return this.added;
  }

  /** One sub-frame's readback: tightly packed rows in the target's own format. */
  add(bytes: Uint8Array): void {
    const pixels = this.width * this.height;
    const sum = this.sum;
    const premultiply = this.space !== "data";
    const accumulate = (index: number, r: number, g: number, b: number, a: number): void => {
      const weight = premultiply ? a : 1;
      sum[index] = sum[index]! + r * weight;
      sum[index + 1] = sum[index + 1]! + g * weight;
      sum[index + 2] = sum[index + 2]! + b * weight;
      sum[index + 3] = sum[index + 3]! + a;
    };
    const decode = linearDecodeFor(this.format, this.space);
    if (decode !== undefined && this.format === "rgba16float") {
      const halves = bytes.byteOffset % 2 === 0
        ? new Uint16Array(bytes.buffer, bytes.byteOffset, pixels * 4)
        : new Uint16Array(bytes.slice(0, pixels * 8).buffer);
      const { colour, alpha } = decode;
      for (let i = 0; i < pixels * 4; i += 4) {
        accumulate(i, colour[halves[i]!]!, colour[halves[i + 1]!]!, colour[halves[i + 2]!]!, alpha[halves[i + 3]!]!);
      }
    } else if (decode !== undefined) {
      const { colour, alpha } = decode;
      for (let i = 0; i < pixels * 4; i += 4) {
        accumulate(i, colour[bytes[i]!]!, colour[bytes[i + 1]!]!, colour[bytes[i + 2]!]!, alpha[bytes[i + 3]!]!);
      }
    } else {
      // Every other format through the export's own decoder (one-channel, 32-bit float).
      const rowStride = this.width * (BYTES_PER_PIXEL[this.format] ?? 4);
      const plane = decodeToLinear({ width: this.width, height: this.height, format: this.format, bytes, rowStride }, this.space);
      const rgba = plane.rgba;
      for (let i = 0; i < pixels * 4; i += 4) accumulate(i, rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!);
    }
    this.added += 1;
  }

  /**
   * The mean of what was added, display-encoded to 16 bits, and a fresh start.
   *
   * `opaque` composites over black (in linear light) for a container with no alpha channel:
   * dropping a straight alpha would show whatever colour a transparent pixel happens to carry.
   */
  resolve(options: { readonly opaque?: boolean } = {}): Uint16Array {
    if (this.added === 0) throw new Error("LinearAverager.resolve: no sub-frame was added.");
    const out = resolveLinearSum(this.sum, this.added, this.space, options);
    this.sum.fill(0);
    this.added = 0;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// A bounded reader of a decoder's frames
// ---------------------------------------------------------------------------------------------

/**
 * Whole frames off a decoder's stdout, at most a couple ahead of the consumer.
 *
 * The stream stays in PAUSED mode and is asked for exactly one frame's bytes at a time
 * (`read(frameBytes)`). Node then buffers about one frame (it raises the high-water mark to the
 * next power of two above the request), stops reading the pipe once that is full, and the
 * decoder blocks on its write: memory stays at a frame or two and no CPU goes to copying a
 * clip nobody has asked for yet. A trailing partial frame (a decoder that stopped mid-frame) is
 * dropped rather than handed on as half a picture.
 */
export class BoundedFrameReader {
  readonly frameBytes: number;
  private readonly stream: Readable;
  private failure: Error | undefined;
  private waiting: (() => void) | undefined;

  constructor(stream: Readable, frameBytes: number) {
    this.stream = stream;
    this.frameBytes = frameBytes;
    // ONE listener for the reader's life. Adding a `readable` listener while bytes are buffered
    // emits `readable` at once, so a listener added per wait spins on next-ticks and starves the
    // pipe it is waiting for: the decoder's data never gets a turn of the loop.
    const wake = (): void => {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting?.();
    };
    stream.on("readable", wake);
    stream.on("end", wake);
    stream.on("close", wake);
    stream.on("error", (error: Error) => {
      this.failure = error;
      wake();
    });
  }

  /** The next whole frame, or undefined once the stream has ended. */
  async next(): Promise<Uint8Array | undefined> {
    for (;;) {
      if (this.failure !== undefined) throw this.failure;
      // A null read leaves the stream asking for `readable` on the next bytes that arrive.
      const chunk = this.stream.read(this.frameBytes) as Buffer | null;
      if (chunk !== null) return chunk.length === this.frameBytes ? chunk : undefined;
      if (this.stream.readableEnded || this.stream.destroyed) return undefined;
      await new Promise<void>((resolveWait) => {
        this.waiting = resolveWait;
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Loading a project for a render
// ---------------------------------------------------------------------------------------------

export type RenderQuality = "live" | "final";

/** A project loaded for rendering: the document as this render reads it, and its catalogue. */
export interface PreparedProject {
  /** The file name without `.loom.json`; output files are named after it. */
  readonly name: string;
  /** Where a relative media path is looked for first (the project file's own directory). */
  readonly directory: string;
  readonly document: ProjectDocument;
  readonly components: ComponentRegistryView;
  readonly nodes: NodeRegistryView;
  /** What loading and the overrides said, one line each, for the command to print. */
  readonly notes: readonly string[];
}

export interface PrepareOptions {
  /** The file the text came from: names the outputs and anchors relative media paths. */
  readonly path?: string;
  /** `final`: every Render node, inside components too, at SSAA and high AO (T1740b stand-in). */
  readonly quality?: RenderQuality;
  /** `label.param=json` entries for top-level nodes, applied in order. */
  readonly set?: readonly string[];
}

/** The repository root, where `public/` serves the app's relative media paths. */
const REPO_ROOT = resolve(import.meta.dirname, "../..");

const FINAL_QUALITY: Readonly<Record<string, ParameterValue>> = { antialias: "ssaa", aoQuality: "high" };

/** `nodes` with every Render node at offline quality; the count it changed. */
function withFinalQuality(graph: GraphDocument): { graph: GraphDocument; renders: number } {
  let renders = 0;
  const nodes: Record<string, GraphNode> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type === "render") {
      renders += 1;
      nodes[id] = { ...node, parameters: { ...node.parameters, ...FINAL_QUALITY } };
    } else {
      nodes[id] = node;
    }
  }
  return { graph: { ...graph, nodes }, renders };
}

const nameOf = (node: GraphNode): string => (node.label !== undefined && node.label !== "" ? node.label : node.id);

/** A top-level node by its name (label) or id. */
function nodeNamed(graph: GraphDocument, name: string): GraphNode | undefined {
  return Object.values(graph.nodes).find((node) => node.label === name) ?? graph.nodes[name];
}

/** One `label.param=json` entry, applied to the document's own graph. */
function applySet(graph: GraphDocument, entry: string, nodes: NodeRegistryView): GraphDocument {
  const match = /^([^.=]+)\.([^=]+)=(.*)$/s.exec(entry.trim());
  if (match === null) throw new Error(`--set expects label.param=json, got "${entry}".`);
  const [, name, key, text] = match as unknown as [string, string, string, string];
  const node = nodeNamed(graph, name);
  if (node === undefined) {
    const names = Object.values(graph.nodes).map(nameOf).slice(0, 12).join(", ");
    throw new Error(`--set: the project has no node "${name}" at its top level (it has ${names}…).`);
  }
  const schema = effectiveParameterSchema(nodes.get(node.type), node.parameters);
  if (schema[key] === undefined) {
    throw new Error(`--set: "${nameOf(node)}" (${node.type}) has no parameter "${key}". It has: ${Object.keys(schema).join(", ")}.`);
  }
  let value: ParameterValue;
  try {
    value = JSON.parse(text) as ParameterValue;
  } catch {
    throw new Error(`--set: the value for ${name}.${key} is not JSON: ${text}. A string needs its quotes: ${name}.${key}="${text}".`);
  }
  return { ...graph, nodes: { ...graph.nodes, [node.id]: { ...node, parameters: { ...node.parameters, [key]: value } } } };
}

/**
 * Loads a `.loom.json` for a render through `loadProject` (migrations, the component library,
 * placeholders, caps), then applies `--set` and `--quality final` to what this render reads.
 * The file is never written. Throws on a file that does not load.
 */
export function prepareProject(text: string, options: PrepareOptions = {}): PreparedProject {
  const quality = options.quality ?? "live";
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  let innerRenders = 0;
  const installer = {
    register: (definition: GraphComponentDefinition): void => {
      if (quality !== "final") {
        system.components.register(definition);
        return;
      }
      const final = withFinalQuality(definition.graph);
      innerRenders += final.renders;
      system.components.register({ ...definition, graph: final.graph });
    },
  };
  const loaded = loadProject(text, { nodes: system.nodes, components: installer });
  if (!loaded.ok) {
    throw new Error(`The project did not load: ${loaded.reason}${loaded.diagnostics.length > 0 ? `\n${loaded.diagnostics.map((d) => `  ${d.code}: ${d.message}`).join("\n")}` : ""}`);
  }
  const notes = loaded.diagnostics.map((d) => `load ${d.severity} ${d.code}: ${d.message}`);
  let graph = loaded.document.graph;
  for (const entry of options.set ?? []) graph = applySet(graph, entry, system.nodes);
  if (quality === "final") {
    const final = withFinalQuality(graph);
    graph = final.graph;
    const total = final.renders + innerRenders;
    notes.push(
      total === 0
        ? "quality final: the project has no Render node, so nothing changed."
        : `quality final: ${total} Render node${total === 1 ? "" : "s"} (${innerRenders} inside components) at SSAA and high AO for this render.`,
    );
  }
  const path = options.path;
  return {
    name: path === undefined ? loaded.document.name : path.replace(/^.*[\\/]/, "").replace(/\.loom\.json$/, "").replace(/\.json$/, ""),
    directory: path === undefined ? process.cwd() : dirname(resolve(path)),
    document: { ...loaded.document, graph },
    components: system.components.view(),
    nodes: system.nodes,
    notes,
  };
}

/** The node a render reads: the one named, or the project's only Output node. */
export function outputNodeOf(document: ProjectDocument, name?: string): string {
  if (name !== undefined) {
    const node = nodeNamed(document.graph, name);
    if (node === undefined) throw new Error(`--output: the project has no node "${name}" at its top level.`);
    return node.id;
  }
  const outputs = Object.values(document.graph.nodes).filter((node) => node.type === "output");
  if (outputs.length === 0) throw new Error("The project has no Output node. Name the node to render with --output <label>.");
  if (outputs.length > 1) {
    throw new Error(`The project has ${outputs.length} Output nodes (${outputs.map(nameOf).join(", ")}). Choose one with --output <label>.`);
  }
  return outputs[0]!.id;
}

// ---------------------------------------------------------------------------------------------
// Movie File In: the node's own file, through ffmpeg
// ---------------------------------------------------------------------------------------------

/** Throws, naming the fix, when ffmpeg (and ffprobe, for a movie) is not on PATH. */
export function requireFfmpeg(why: string, tools: readonly string[] = ["ffmpeg"]): void {
  for (const tool of tools) {
    const run = spawnSync(tool, ["-version"], { stdio: "ignore" });
    if (run.error !== undefined || run.status !== 0) {
      throw new Error(`${tool} was not found on PATH, and ${why} needs it. Install it (brew install ffmpeg) and run again.`);
    }
  }
}

/** A local file a Movie File In's `file` names, or why there is none. */
function localMediaFile(url: string, directory: string): { path: string } | { reason: string } {
  if (url.trim() === "") return { reason: "has no file" };
  if (url.startsWith("blob:")) return { reason: `names a browser blob: URL (${url}), which lives only in the tab that made it. Relink it to a file path or a file:// URL` };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("file://")) return { reason: `names a remote URL (${url}); an offline render reads local files only` };
  const path = url.startsWith("file://") ? fileURLToPath(url.split("#")[0]!) : decodeURIComponent(url.split("#")[0]!.split("?")[0]!);
  const candidates = isAbsolute(path) ? [path] : [resolve(directory, path), join(REPO_ROOT, "public", path), resolve(process.cwd(), path)];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found === undefined ? { reason: `names ${url}, which is not a file here (looked at ${candidates.join(", ")})` } : { path: found };
}

/**
 * The ffmpeg filter that puts the file into the media texture the way the app's fit shader
 * puts it on the output. The app's texture is the file's own size and the shader fits it; here
 * the texture is the node's size (the harness feeds bytes at the plan's extent), so the fit is
 * done in the decode and the shader, seeing matching aspects, adds only the zoom — which is the
 * same picture, anchors included.
 */
function fitFilter(fit: string, anchorX: number, anchorY: number, size: readonly [number, number]): string {
  const [w, h] = size;
  if (fit === "fit") return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=${w}:${h}:(ow-iw)*${anchorX}:(oh-ih)*${anchorY}:color=black@0`;
  if (fit === "fill") return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}:(iw-ow)*${anchorX}:(ih-oh)*${anchorY}`;
  return `scale=${w}:${h}:flags=lanczos`;
}

interface VideoFacts {
  /** ffmpeg's rational, for the `fps` filter that puts a variable-rate file on a fixed grid. */
  readonly rate: string;
  readonly fps: number;
  readonly duration: number;
  readonly frames: number;
}

function probeVideo(path: string): VideoFacts {
  const text = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration", "-of", "json", path], { encoding: "utf8" });
  const json = JSON.parse(text) as { streams?: Array<Record<string, string | undefined>>; format?: { duration?: string } };
  const stream = json.streams?.[0];
  if (stream === undefined) throw new Error(`${path} holds no video stream.`);
  const rational = (value: string | undefined): number => {
    const [n, d] = (value ?? "").split("/").map(Number);
    return n !== undefined && d !== undefined && d > 0 && Number.isFinite(n / d) && n / d > 0 ? n / d : 0;
  };
  const rate = rational(stream["avg_frame_rate"]) > 0 ? stream["avg_frame_rate"]! : stream["r_frame_rate"]!;
  const fps = rational(rate);
  if (fps <= 0) throw new Error(`${path}: ffprobe reports no frame rate.`);
  const duration = Number(stream["duration"] ?? json.format?.duration ?? 0);
  const counted = Number(stream["nb_frames"]);
  const frames = Number.isInteger(counted) && counted > 0 ? counted : Math.max(1, Math.round(duration * fps));
  return { rate, fps, duration: Number.isFinite(duration) ? duration : 0, frames };
}

/** ffmpeg arguments that decode `path` from source frame `index` through `filter`, as RGBA8. */
function decodeArguments(path: string, filter: string, video: VideoFacts | undefined, index: number, single: boolean): string[] {
  // A quarter frame early: ffmpeg keeps the first frame at or after the seek, so frame `index`
  // is the first out whichever way the seek time rounds.
  const seek = video === undefined || index === 0 ? [] : ["-ss", ((index - 0.25) / video.fps).toFixed(6)];
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", ...seek, "-i", path, "-map", "0:v:0",
    "-vf", video === undefined ? filter : `fps=${video.rate},${filter}`,
    ...(single ? ["-frames:v", "1"] : []), "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ];
}

/** One frame, synchronously (the harness asks for a frame inside the step), or undefined past the end. */
function decodeOne(path: string, filter: string, video: VideoFacts | undefined, index: number, frameBytes: number): Uint8Array | undefined {  const bytes = execFileSync("ffmpeg", decodeArguments(path, filter, video, index, true), { maxBuffer: frameBytes + (1 << 20), stdio: ["ignore", "pipe", "inherit"] });
  return bytes.length >= frameBytes ? new Uint8Array(bytes.buffer, bytes.byteOffset, frameBytes) : undefined;
}

/** How far ahead a decoder decodes through, rather than seeking again. */
const RESTART_SECONDS = 2;

/**
 * One video on one Movie File In. The harness asks for a stepped frame's picture synchronously
 * (`frameAt`); `prefetch`, awaited between frames, has normally decoded it already off one
 * streaming decoder. A frame it has not (the first, a jump) is decoded on the spot.
 */
class VideoFeed {
  private readonly path: string;
  private readonly video: VideoFacts;
  private readonly need: (frame: number) => number | null;
  private readonly filterFor: (size: readonly [number, number]) => string;
  private size: readonly [number, number] | undefined;
  private filter = "";
  private decoder: { child: ChildProcess; closed: Promise<number | null>; said: () => string; reader: BoundedFrameReader; next: number } | undefined;
  private held: { index: number; bytes: Uint8Array } | undefined;
  /** The last source frame the file actually holds, once a decoder has run off its end. */
  private last: number;

  constructor(path: string, video: VideoFacts, need: (frame: number) => number | null, filterFor: (size: readonly [number, number]) => string) {
    this.path = path;
    this.video = video;
    this.need = need;
    this.filterFor = filterFor;
    this.last = video.frames - 1;
  }

  private indexAt(frame: number): number | null {
    const index = this.need(frame);
    return index === null ? null : Math.min(Math.max(index, 0), this.last);
  }

  frameAt(size: readonly [number, number], frame: number): Uint8Array {
    if (this.size === undefined) {
      this.size = size;
      this.filter = this.filterFor(size);
    }
    const frameBytes = size[0] * size[1] * 4;
    const index = this.indexAt(frame);
    if (index === null) return new Uint8Array(frameBytes); // outside the window under extend "black"
    if (this.held?.index === index) return this.held.bytes;
    const bytes = decodeOne(this.path, this.filter, this.video, index, frameBytes) ?? this.held?.bytes ?? new Uint8Array(frameBytes);
    this.held = { index, bytes };
    return bytes;
  }

  private restart(index: number): void {
    this.stop();
    const size = this.size!;
    const child = spawn("ffmpeg", decodeArguments(this.path, this.filter, this.video, index, false), { stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
    // Kept, not shown: a decoder stopped on purpose (a seek, the render's end) complains of a
    // broken pipe. What it said is shown when it stops on its own.
    let said = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      if (said.length < 8_192) said += chunk.toString();
    });
    this.decoder = { child, closed, said: () => said.trim(), reader: new BoundedFrameReader(child.stdout!, size[0] * size[1] * 4), next: index };
  }

  async prefetch(frame: number): Promise<void> {
    if (this.size === undefined) return; // not asked for yet: the first frame is decoded where it is asked
    const index = this.indexAt(frame);
    if (index === null || this.held?.index === index) return;
    const gap = Math.max(48, Math.ceil(this.video.fps * RESTART_SECONDS));
    if (this.decoder === undefined || index < this.decoder.next || index - this.decoder.next > gap) this.restart(index);
    const decoder = this.decoder!;
    while (decoder.next <= index) {
      const bytes = await decoder.reader.next();
      if (bytes === undefined) {
        const code = await decoder.closed;
        if (code !== 0) throw new Error(`ffmpeg stopped decoding ${this.path} (exit ${String(code)}): ${decoder.said()}`);
        // The file ends before its stated length: hold the last frame it really has.
        this.last = Math.max(0, decoder.next - 1);
        this.stop();
        return;
      }
      if (decoder.next === index) this.held = { index, bytes };
      decoder.next += 1;
    }
  }

  stop(): void {
    if (this.decoder === undefined) return;
    this.decoder.child.stdout?.destroy();
    this.decoder.child.kill();
    this.decoder = undefined;
  }
}

/** The media this render feeds: videos per stepped frame, stills once, and what it could not. */
interface MediaFeeds {
  readonly movies: Record<string, (size: readonly [number, number], frame: number) => Uint8Array>;
  readonly pictures: Record<string, (size: readonly [number, number]) => Uint8Array>;
  readonly notes: readonly string[];
  /** The names of the videos that run free: they start at their in point on the first stepped frame. */
  readonly freeRun: readonly string[];
  prefetch(frame: number): Promise<void>;
  close(): void;
}

const FIT_KEYS = ["imageFit", "imageAnchorX", "imageAnchorY"];

/**
 * Every Movie File In this render reaches (inside components too: the flattened graph is what
 * the harness keys media by), fed from its own file. A video plays by the node's transport,
 * `mediaPlayheadAt` with the clock the node chose: locked to the timeline, the position is the
 * timeline's (§V436); in free run it starts at its in point on the render's first STEPPED
 * frame, its warm-up's first (§T1745b), which is how the app starts it when the document opens
 * (`freeRun` names them for the note). A file that cannot be found keeps the harness test card,
 * and the notes say why.
 */
function mediaFeeds(
  project: PreparedProject,
  graph: GraphDocument,
  timing: { readonly firstSubFrame: number; readonly subFps: number; readonly runUp: () => number },
): MediaFeeds {
  const notes: string[] = [];
  const freeRun: string[] = [];
  const movies: MediaFeeds["movies"] = {};
  const pictures: MediaFeeds["pictures"] = {};
  const feeds: VideoFeed[] = [];
  const definition: NodeDefinition | undefined = project.nodes.get("movieFileIn");
  let checked = false;
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "movieFileIn") continue;
    const name = nameOf(node);
    const resolved = resolveStored(node, definition);
    const read = (key: string): ParameterValue | undefined => resolved.get(key)?.value;
    const url = pictureFileUrl(read("file"));
    const refusal = hdrPictureRefusal(url);
    const local = refusal === null ? localMediaFile(url, project.directory) : { reason: refusal };
    if ("reason" in local) {
      notes.push(`Movie File In "${name}" ${local.reason}. It shows the harness test card in this render.`);
      continue;
    }
    if (!checked) {
      requireFfmpeg(`decoding a Movie File In's file`, ["ffmpeg", "ffprobe"]);
      checked = true;
    }
    const moving = [...MEDIA_TRANSPORT_KEYS, ...FIT_KEYS, "file"].filter((key) => {
      const stored = node.parameters[key];
      return isParameterSlot(stored) && stored.mode !== "static";
    });
    if (moving.length > 0) notes.push(`Movie File In "${name}": ${moving.join(", ")} ${moving.length === 1 ? "is" : "are"} not static; this render reads ${moving.length === 1 ? "it" : "them"} at rest.`);
    const fit = String(read("imageFit") ?? "fit");
    const anchorX = typeof read("imageAnchorX") === "number" ? (read("imageAnchorX") as number) : 0.5;
    const anchorY = typeof read("imageAnchorY") === "number" ? (read("imageAnchorY") as number) : 0.5;
    const filterFor = (size: readonly [number, number]): string => fitFilter(fit, anchorX, anchorY, size);
    if (pictureFileKind(url) === "still") {
      pictures[node.id] = (size) => {
        const bytes = decodeOne(local.path, filterFor(size), undefined, 0, size[0] * size[1] * 4);
        if (bytes === undefined) throw new Error(`ffmpeg decoded no picture from ${local.path} (Movie File In "${name}").`);
        return bytes;
      };
      continue;
    }
    const video = probeVideo(local.path);
    const transport: MediaTransportValues = mediaTransportFrom(read);
    if (transport.playMode === "freeRun") freeRun.push(name);
    const need = (frame: number): number | null => {
      // The node's clock (`createMediaClock`, for a transport that does not move): the timeline
      // times speed under the lock; the render's own elapsed time times speed, while playing, in
      // free run — counted from the first stepped frame (a run-up frame's index is negative).
      const offset = transport.playMode === "freeRun"
        ? (transport.play ? ((timing.runUp() + frame) / timing.subFps) * transport.speed : 0)
        : ((timing.firstSubFrame + frame) / timing.subFps) * transport.speed;
      const head = mediaPlayheadAt(transport, offset, video.duration);
      return head.visible ? Math.floor(head.position * video.fps + 1e-6) : null;
    };
    const feed = new VideoFeed(local.path, video, need, filterFor);
    feeds.push(feed);
    movies[node.id] = (size, frame) => feed.frameAt(size, frame);
  }
  return {
    movies,
    pictures,
    notes,
    freeRun,
    prefetch: async (frame) => {
      for (const feed of feeds) await feed.prefetch(frame);
    },
    close: () => {
      for (const feed of feeds) feed.stop();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Audio File In: the node's own file, heard through the app's offline analysis
// ---------------------------------------------------------------------------------------------

/** The node types that read the session's audio capture. */
const AUDIO_READERS: readonly string[] = ["audioIn", "audioFileIn", ...TONAL_NODE_TYPES];

/** What this render feeds the audio nodes: a record per stepped frame, or nothing and why. */
interface AudioFeed {
  /** The harness's `audio` seam; absent, every audio node reads silence. */
  readonly audio?: (frame: number) => AudioFeatures | null;
  readonly notes: readonly string[];
  /** The Audio File In that runs free, named for the note the warm-up writes. */
  readonly freeRun?: string;
}

/** A local audio file as mono float PCM at `sampleRate`: what the app's fixed-rate decode hands its analysis. */
export function decodeAudio(path: string, sampleRate: number): Float32Array {
  const run = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-"], {
    maxBuffer: 2 ** 31 - 1,
  });
  if (run.error !== undefined || run.status !== 0) {
    throw new Error(`ffmpeg could not decode ${path}: ${run.error?.message ?? run.stderr.toString().trim()}`);
  }
  const bytes = run.stdout;
  // A copy: a Buffer's bytes sit at an offset a Float32Array may not start on.
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + Math.floor(bytes.byteLength / 4) * 4));
}

/**
 * T1754b — the session's ONE capture, offline. WHICH node is the source is the app's own rule
 * (`captureConfigOf`: a bound Audio File In beats a microphone). The file is walked once at the
 * render's own step rate, so every sub-frame reads the record of its own interval, and read
 * where the node's transport puts the file: under the timeline lock that is the timeline's
 * position, sync offset included (`readTrackAtPlayhead`, the function the app reads with), and
 * at the node's Input Gain (T1769b: `config.inputGainDb`, the number the app walks its own track at); in
 * free run it starts at its in point on the render's first STEPPED frame, as a free-running
 * movie does here and as the app starts it when the document opens.
 *
 * What it cannot hear it says: a microphone, a file that is not on this machine. The audio
 * nodes read silence then, the same silence every run.
 *
 * ffmpeg's resampler is not Chrome's, so a file that is not already at 48 kHz is analysed
 * from samples that differ in the last bits from the app's. Each side reproduces itself; the
 * two are not bit-equal to each other.
 */
function audioFeed(
  project: PreparedProject,
  graph: GraphDocument,
  timing: { readonly firstSubFrame: number; readonly subFps: number; readonly runUp: () => number },
): AudioFeed {
  const readers = Object.values(graph.nodes).filter((node) => AUDIO_READERS.includes(node.type) && !isSilencedSource(node));
  if (readers.length === 0) return { notes: [] };
  const silent = (why: string): AudioFeed => ({ notes: [`${why} The audio nodes read silence in this render.`] });
  const config = captureConfigOf(graph);
  if (config === null) return silent("No Audio File In with a file is live in this project.");
  if (config.source === "mic" || config.nodeId === null) {
    return silent("Audio In listens to a microphone, and an offline render has none. Put the sound on an Audio File In to render it.");
  }
  const node = graph.nodes[config.nodeId];
  if (node === undefined) return silent("The Audio File In that holds the capture is not in the flattened graph.");
  const name = nameOf(node);
  const local = localMediaFile(config.url, project.directory);
  if ("reason" in local) return silent(`Audio File In "${name}" ${local.reason}.`);
  requireFfmpeg(`decoding an Audio File In's file`);
  const samples = decodeAudio(local.path, PRE_ANALYSIS_SAMPLE_RATE);
  const duration = samples.length / PRE_ANALYSIS_SAMPLE_RATE;
  const { track, tempo } = analyseOffline(samples, PRE_ANALYSIS_SAMPLE_RATE, timing.subFps, config.detector, config.tonal, config.inputGainDb);

  const resolved = resolveStored(node, project.nodes.get("audioFileIn"));
  const read = (key: string): ParameterValue | undefined => resolved.get(key)?.value;
  const transport: MediaTransportValues = mediaTransportFrom(read);
  const free = transport.playMode === "freeRun";
  const lead = free ? 0 : syncLeadOf(read);
  const notes = [
    `Audio File In "${name}": heard ${duration.toFixed(2)} s of ${local.path}${config.tonal ? ", tonal pass on" : ""}${config.inputGainDb === 0 ? "" : `, input gain ${config.inputGainDb > 0 ? "+" : ""}${String(config.inputGainDb)} dB`}${tempo.confidence > 0 ? `, ${tempo.bpm.toFixed(1)} BPM estimated` : ""}.`,
  ];
  const moving = [...MEDIA_TRANSPORT_KEYS, "syncOffset", "inputGain", "file"].filter((key) => {
    const stored = node.parameters[key];
    return isParameterSlot(stored) && stored.mode !== "static";
  });
  if (moving.length > 0) notes.push(`Audio File In "${name}": ${moving.join(", ")} ${moving.length === 1 ? "is" : "are"} not static; this render reads ${moving.length === 1 ? "it" : "them"} at rest.`);
  return {
    notes,
    ...(free ? { freeRun: name } : {}),
    audio: (frame) => {
      if (!free) return readTrackAtPlayhead(track, transport, (timing.firstSubFrame + frame) / timing.subFps, duration, lead);
      // A free-running file that is not playing is silent, as the paused element is in the app.
      if (!transport.play) return null;
      return readTrackAtPlayhead(track, transport, (timing.runUp() + frame) / timing.subFps, duration, 0);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The render
// ---------------------------------------------------------------------------------------------

export interface RenderRun {
  readonly project: PreparedProject;
  /** The node read back (`outputNodeOf`). */
  readonly outputNodeId: string;
  /** Output frames per second. */
  readonly fps: number;
  /** Sub-frames per output frame, stepped at `spp × fps` and averaged in linear light. */
  readonly spp: number;
  /** The first output frame (seconds × fps). */
  readonly first: number;
  /** How many output frames. */
  readonly count: number;
  /** Composite over black: the container has no alpha channel. */
  readonly opaque?: boolean;
  /**
   * T1745b: seconds stepped unseen before the first output frame. Undefined, the default:
   * from the timeline's frame 0 when the plan carries state from frame to frame
   * (`temporalStateOf`), none when it carries none. 0 starts cold. Never before frame 0.
   */
  readonly warmup?: number;
  /**
   * T1739b: where sub-frames are summed. `gpu`, the default: on the device, one readback per
   * output frame. `cpu`: every sub-frame read back and summed here, the reference `gpu` is
   * held to. A format no per-pattern table decodes (`r32float`), or a sum larger than the
   * device can bind, is summed here either way.
   */
  readonly averaging?: "gpu" | "cpu";
  /** Each output frame, awaited (an encoder pipe back-pressures here). */
  readonly onFrame: (frame: OutputFrame) => void | Promise<void>;
  /** A sentence about the media this render feeds, or its warm-up, before the first frame. */
  readonly onNote?: (note: string) => void;
}

export interface RenderOutcome {
  /** Everything said about the render, with the sub-frame it first appeared at (§T1641b). */
  readonly findings: readonly RenderFinding[];
  readonly firstSubFrame: number;
  readonly subFps: number;
  /** T1745b: output frames stepped unseen before `first`. */
  readonly warmupFrames: number;
  /** T1745b: what in the plan carries state from frame to frame (`temporalStateOf`); empty when nothing does. */
  readonly state: readonly string[];
  /** T1739b: where the sub-frames were summed. */
  readonly averaged: "gpu" | "cpu";
  /** T1739b: readbacks made: one per output frame summed on the GPU, one per sub-frame here. */
  readonly readbacks: number;
}

/**
 * T1745b — WHAT CARRIES STATE FROM ONE FRAME TO THE NEXT, read off the compiled plan (and the
 * value graph's own declarations), one line per carrier naming its node. A frame of such a
 * render depends on every frame stepped before it; with none, each frame is a function of its
 * own time and a render can start anywhere.
 *
 *  - a feedback pair (`pingPong`): a Feedback, or any node whose output is temporal;
 *  - a history ring (`ring`): a Cache, an Echo, a Slit Scan;
 *  - a simulation's buffer pair (`bufferPair`): points that read last frame's points;
 *  - a target whose first draw of the frame does not clear: the trails pattern (`plan.ts`);
 *  - an Analyze node, whose reduction the NEXT frame reads (§V144);
 *  - a value node that declares `stateful` (a Lag, a Trigger: §V181).
 *
 * Read from the plan, so a carrier no sink reaches (pruned) carries nothing into the picture.
 */
export function temporalStateOf(plan: CompiledGraph, graph: FlatGraph, nodes: NodeRegistryView): string[] {
  const carriers = new Set<string>();
  const named = (nodeId: string | undefined, fallback: string): string => {
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    return node === undefined ? fallback : `"${nameOf(node)}"`;
  };
  /** The node that writes a resource, else the first that reads it. */
  const ownerOf = (resourceId: string): string | undefined => {
    const writes = plan.passes.find((pass) =>
      ((pass.kind === "effect" || pass.kind === "draw") && pass.target === resourceId) ||
      ((pass.kind === "dispatch" || pass.kind === "draw") && pass.buffers?.some((binding) => binding.resourceId === resourceId)));
    const reads = plan.passes.find((pass) =>
      (pass.kind === "effect" || pass.kind === "draw" || pass.kind === "dispatch") && pass.textures?.some((binding) => binding.resourceId === resourceId));
    const pass = writes ?? reads;
    return pass !== undefined && "nodeId" in pass ? pass.nodeId : undefined;
  };
  for (const resource of plan.resources) {
    if (resource.kind === "pingPong") carriers.add(`feedback ${named(ownerOf(resource.id), resource.id)}`);
    else if (resource.kind === "ring") carriers.add(`history ${named(ownerOf(resource.id), resource.id)}`);
    else if (resource.kind === "bufferPair") carriers.add(`simulation ${named(ownerOf(resource.id), resource.id)}`);
  }
  const firstWrite = new Map<string, PassDescriptor>();
  for (const pass of plan.passes) {
    if ((pass.kind === "effect" || pass.kind === "draw") && !firstWrite.has(pass.target)) firstWrite.set(pass.target, pass);
  }
  for (const [target, pass] of firstWrite) {
    // `clear: false` keeps last frame's pixels under the draw. An indirect draw clears whatever it says (`plan.ts`).
    if (pass.kind === "draw" && pass.clear === false && typeof pass.instances === "number") carriers.add(`trails ${named(pass.nodeId, target)}`);
  }
  const allocated = new Set(plan.resources.map((resource) => resource.id));
  for (const entry of analyzeChannelEntries(graph, nodes)) {
    if (allocated.has(entry.resourceId)) carriers.add(`analyze ${named(entry.nodeId, entry.channel)}`);
  }
  for (const node of Object.values(graph.nodes)) {
    const definition = nodes.get(node.type);
    if (definition?.stateful !== undefined && definition.valueEvaluate !== undefined) carriers.add(`value ${named(node.id, node.id)}`);
  }
  return [...carriers];
}

/** The warm-up's length in output frames, and the sentence that says why. */
function warmupOf(run: RenderRun, state: readonly string[]): { frames: number; note: string | undefined } {
  const before = run.first;
  const seconds = (frames: number): string => `${(frames / run.fps).toFixed(3)} s`;
  const carriers = state.length <= 3 ? state.join(", ") : `${state.slice(0, 3).join(", ")} and ${state.length - 3} more`;
  if (run.warmup === undefined) {
    if (before === 0) return { frames: 0, note: undefined };
    if (state.length === 0) return { frames: 0, note: `warm-up: none; nothing in the plan carries state from frame to frame, so frame ${before} renders as it would from 0.` };
    return {
      frames: before,
      note: `warm-up: frames 0 to ${before - 1} (${seconds(before)}) are stepped unseen, because ${carriers} carr${state.length === 1 ? "ies" : "y"} state from frame to frame; frame ${before} is the frame a render from 0 makes. --warmup 0 starts cold, --warmup S steps S seconds.`,
    };
  }
  const asked = Math.round(run.warmup * run.fps);
  const frames = Math.min(asked, before);
  if (frames < asked) return { frames, note: `warm-up: --warmup ${run.warmup} reaches before frame 0, so the render steps from frame 0 (${seconds(frames)}).` };
  if (frames === 0) return { frames, note: state.length > 0 && before > 0 ? `warm-up: none (--warmup ${run.warmup}), so ${carriers} start${state.length === 1 ? "s" : ""} from cleared state at frame ${before}.` : undefined };
  return { frames, note: `warm-up: ${frames} frame${frames === 1 ? "" : "s"} (${seconds(frames)}) stepped unseen before frame ${before}${state.length === 0 ? "; nothing in the plan carries state, so they change nothing" : ""}.` };
}

/**
 * Renders `count` output frames from `first`, each the linear mean of `spp` sub-frames that
 * start at its own time: output frame f is sub-frames f·spp … f·spp + spp − 1 at spp × fps, so a
 * still at a time and the clip frame at that time are the same picture. The transport reports
 * the project rate and `subframes` to expressions (T1435b). An error stops the render, naming
 * the node and the frame (the harness's rule); warnings come back in `findings`.
 *
 * T1739b: the sub-frames are summed on the GPU and read back once per output frame
 * (`averaging`), through the decode `LinearAverager` uses, and resolved by the same
 * `resolveLinearSum`.
 *
 * T1745b: a render is DETERMINISTIC FROM THE FIRST FRAME OF ITS WARM-UP. The warm-up steps
 * the frames before `first` at the render's own rate (spp × fps: a feedback steps once per
 * sub-frame, so a run-up at the output rate would hand the first frame a history `spp` times
 * shorter than the frames after it hold) and reads nothing back. By default a plan that carries
 * state (`temporalStateOf`) is warmed from the timeline's frame 0, so the frame at T is the
 * frame at T of a render from 0; a plan that carries none is not warmed, since its frames do
 * not depend on the ones before. A free-running movie starts at the warm-up's first frame.
 */
export async function renderFrames(run: RenderRun): Promise<RenderOutcome> {
  if (!Number.isInteger(run.spp) || run.spp < 1) throw new Error(`spp must be a whole number of at least 1, not ${run.spp}.`);
  if (!Number.isInteger(run.count) || run.count < 1) throw new Error(`A render needs at least one frame, not ${run.count}.`);
  if (run.warmup !== undefined && !(Number.isFinite(run.warmup) && run.warmup >= 0)) throw new Error(`warmup is a number of seconds of at least 0, not ${run.warmup}.`);
  const dawn = await probeDawn();
  if (dawn.error !== undefined) throw new Error(`Dawn did not start: ${dawn.error}`);
  const subFps = run.fps * run.spp;
  const firstSubFrame = run.first * run.spp;
  const frames = run.count * run.spp;
  const flattened = flattenComponents({ graph: run.project.document.graph, registry: run.project.nodes, components: run.project.components }).graph;
  let runUp = 0;
  const feeds = mediaFeeds(run.project, flattened, { firstSubFrame, subFps, runUp: () => runUp });
  for (const note of feeds.notes) run.onNote?.(note);
  const sound = audioFeed(run.project, flattened, { firstSubFrame, subFps, runUp: () => runUp });
  for (const note of sound.notes) run.onNote?.(note);
  let state: string[] = [];
  let warmupFrames = 0;
  let space: ColorSpace | undefined;
  let averaged: "gpu" | "cpu" = "cpu";
  let averager: LinearAverager | undefined;
  let made = 0;
  const emit = async (width: number, height: number, rgba: Uint16Array): Promise<void> => {
    await run.onFrame({ index: run.first + made, width, height, rgba });
    made += 1;
  };
  const resolveOptions = run.opaque === true ? { opaque: true } : {};
  /** The GPU sum's decode, when this output has one and the device can bind its sum. */
  const gpuDecode = (output: AccumulateTarget): LinearDecode | undefined => {
    const decode = linearDecodeFor(output.format, output.space);
    const bound = Math.min(output.limits["maxStorageBufferBindingSize"] ?? 0, output.limits["maxBufferSize"] ?? 0);
    const fits = output.size[0] * output.size[1] * 16 <= bound;
    if (decode !== undefined && !fits) run.onNote?.(`spp: a ${output.size[0]}×${output.size[1]} sum is larger than this device binds (${bound} bytes), so each sub-frame is read back and summed on the CPU.`);
    if (decode === undefined || !fits) return undefined;
    averaged = "gpu";
    return decode;
  };
  try {
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: run.project.document.graph,
      settings: run.project.document.settings,
      components: run.project.components,
      frames,
      startFrame: firstSubFrame,
      capture: Array.from({ length: frames }, (_, index) => index),
      fps: subFps,
      subframes: run.spp,
      animate: true,
      outputNodeId: run.outputNodeId,
      movies: feeds.movies,
      pictures: feeds.pictures,
      ...(sound.audio === undefined ? {} : { audio: sound.audio }),
      warmup: (plan) => {
        state = temporalStateOf(plan, flattened, run.project.nodes);
        const warm = warmupOf(run, state);
        warmupFrames = warm.frames;
        runUp = warm.frames * run.spp;
        if (warm.note !== undefined) run.onNote?.(warm.note);
        const started = firstSubFrame - runUp;
        for (const name of started > 0 ? feeds.freeRun : []) {
          run.onNote?.(
            `Movie File In "${name}" runs free, so it starts at its in point on this render's first stepped frame (${(started / subFps).toFixed(3)} s), not at that point of the timeline. Lock it to the timeline for a take that follows the timeline.`,
          );
        }
        if (started > 0 && sound.freeRun !== undefined) {
          run.onNote?.(
            `Audio File In "${sound.freeRun}" runs free, so it starts at its in point on this render's first stepped frame (${(started / subFps).toFixed(3)} s), not at that point of the timeline. Lock it to the timeline for a take that follows the timeline.`,
          );
        }
        return runUp;
      },
      beforeFrames: (control) => {
        // The declared space of what is read back decides its decode (§V57).
        space = control.plan.outputs.find((output) => output.resourceId === control.outputResourceId)?.space;
      },
      ...(run.averaging === "cpu"
        ? {}
        : {
            accumulate: {
              every: run.spp,
              decode: gpuDecode,
              onSum: async (sum) => {
                if (space === undefined) throw new Error(`The plan names no space for "${run.outputNodeId}"'s output.`);
                await emit(sum.width, sum.height, resolveLinearSum(sum.sum, sum.count, space, resolveOptions));
              },
            },
          }),
      onCapture: async (frame) => {
        if (space === undefined) throw new Error(`The plan names no space for "${run.outputNodeId}"'s output.`);
        averager ??= new LinearAverager(frame.width, frame.height, frame.format, space);
        averager.add(frame.bytes);
        if (averager.count === run.spp) await emit(frame.width, frame.height, averager.resolve(resolveOptions));
      },
      // Between frames, the warm-up's included: the next frame's movie bytes off the decoder.
      betweenFrames: (_control, index) => feeds.prefetch(index + 1),
    });
    if (made !== run.count) throw new Error(`The render made ${made} of ${run.count} frames.`);
    return { findings: result.findings, firstSubFrame, subFps, warmupFrames, state, averaged, readbacks: result.readbacks };
  } finally {
    feeds.close();
  }
}

/** A finding as one line, with the output frame and time it first appeared at. */
export function describeRenderFinding(finding: RenderFinding, outcome: RenderOutcome, spp: number, graph: GraphDocument): string {
  const node = finding.diagnostic.nodeId === undefined ? undefined : graph.nodes[finding.diagnostic.nodeId];
  const said = describeFinding({ diagnostic: finding.diagnostic, node: node === undefined ? undefined : { id: node.id, name: nameOf(node), type: node.type }, component: undefined });
  if (finding.frame === null) return `before the first frame: ${said}`;
  const sub = outcome.firstSubFrame + finding.frame;
  return `frame ${Math.floor(sub / spp)} (${(sub / outcome.subFps).toFixed(3)} s): ${said}`;
}

// ---------------------------------------------------------------------------------------------
// Writing frames
// ---------------------------------------------------------------------------------------------

/** A 16-bit RGBA PNG (rows Up-filtered, deflated): the still a 16-bit frame deserves. */
export function encodePng16(width: number, height: number, rgba: Uint16Array): Uint8Array {
  const stride = width * 8;
  const raw = new Uint8Array((stride + 1) * height);
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    for (let i = 0; i < width * 4; i += 1) {
      const value = rgba[y * width * 4 + i]!;
      row[i * 2] = value >> 8;
      row[i * 2 + 1] = value & 0xff;
    }
    const start = y * (stride + 1);
    raw[start] = 2; // Up: each byte less the one above it
    for (let x = 0; x < stride; x += 1) raw[start + 1 + x] = (row[x]! - previous[x]!) & 0xff;
    [previous, row] = [row, previous];
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 16; // bit depth
  header[9] = 6; // RGBA
  const parts = [Uint8Array.from(PNG_SIGNATURE), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function writePng16(path: string, frame: OutputFrame): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng16(frame.width, frame.height, frame.rgba));
}

export type ClipFormat = "prores" | "hevc10" | "png";

/**
 * How each format leaves ffmpeg. The RGB → YUV matrix is BT.709 (swscale's default is BT.601, a
 * visible shift in any HD player), and the stream is tagged BT.709 by `setparams`: ffmpeg drops
 * `-color_trc`/`-color_primaries` given as output options here, leaving them "unknown".
 */
const BT709 = "scale=out_color_matrix=bt709:out_range=tv";
const TAGGED = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709";
const ENCODERS: Readonly<Record<Exclude<ClipFormat, "png">, readonly string[]>> = {
  // ProRes 4444: 10-bit, full chroma, alpha kept.
  prores: ["-vf", `${BT709},${TAGGED}`, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"],
  // HEVC Main 10 on the Mac's hardware encoder; no alpha (frames arrive composited over black).
  hevc10: ["-vf", `${BT709},format=p010le,${TAGGED}`, "-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-b:v", "40M", "-tag:v", "hvc1", "-movflags", "+faststart"],
};

export interface FrameWriter {
  write(frame: OutputFrame): Promise<void>;
  /** Finishes the file; throws when the encoder failed. */
  close(): Promise<void>;
}

/**
 * Frames into a ProRes 4444 `.mov` or HEVC Main 10 `.mp4` through ffmpeg, as 16-bit RGBA on its
 * stdin (back-pressured: a write waits for the pipe to drain), or a PNG per frame into
 * `fileFor(index)`.
 */
export function clipWriter(format: ClipFormat, path: string, fps: number, fileFor: (index: number) => string): FrameWriter {
  if (format === "png") {
    return { write: async (frame) => writePng16(fileFor(frame.index), frame), close: async () => undefined };
  }
  let encoder: ChildProcess | undefined;
  let closed: Promise<number | null> = Promise.resolve(0);
  let failure: Error | undefined;
  return {
    async write(frame) {
      if (encoder === undefined) {
        mkdirSync(dirname(path), { recursive: true });
        const child = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y",
          // `pipe:0`, not `-`: `-` is read as a file, and on macOS a pipe's size is what it holds
          // right now, so ffmpeg reports the first frame "truncated" to 64 KiB (it is not).
          "-f", "rawvideo", "-pix_fmt", "rgba64le", "-s", `${frame.width}x${frame.height}`, "-r", String(fps), "-i", "pipe:0",
          ...ENCODERS[format], path,
        ], { stdio: ["pipe", "inherit", "inherit"] });
        closed = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
        child.stdin!.on("error", (error: Error) => {
          failure = error;
        });
        encoder = child;
      }
      if (failure !== undefined) throw new Error(`ffmpeg stopped taking frames for ${path}: ${failure.message}`);
      const stdin = encoder.stdin!;
      // rgba64le: every platform this runs on is little-endian, so the array's own bytes are it.
      if (!stdin.write(Buffer.from(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength))) {
        await new Promise<void>((done) => {
          const finish = (): void => {
            stdin.off("drain", finish);
            stdin.off("error", finish);
            done();
          };
          stdin.on("drain", finish);
          stdin.on("error", finish);
        });
      }
    },
    async close() {
      if (encoder === undefined) return;
      encoder.stdin!.end();
      const code = await closed;
      if (code !== 0) throw new Error(`ffmpeg exited with code ${String(code)} writing ${path}${failure === undefined ? "" : ` (${failure.message})`}.`);
    },
  };
}
