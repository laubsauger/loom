import { readFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { projectFps } from "../domain/types/graph.ts";
import {
  clipWriter,
  describeRenderFinding,
  outputNodeOf,
  prepareProject,
  renderFrames,
  requireFfmpeg,
  writePng16,
  type ClipFormat,
  type RenderOutcome,
  type RenderQuality,
} from "./offline-render.ts";

/**
 * T1738b — `pnpm render`: render any saved `.loom.json` offline, on Dawn, through Loom's own
 * load path and render harness (`offline-render.ts`). Run it through the machine-wide queue:
 *
 *   tools/heavy.sh pnpm render <project.loom.json> [options]
 *   (the same as: node --import ./src/tooling/alias-hooks.ts src/tooling/render-project.ts …)
 */
const USAGE = `pnpm render <project.loom.json> [options]

  --at 0,30            stills at these times, in seconds (the default: --at 0). 16-bit PNG.
  --clip S --from T    a clip S seconds long from T seconds (T defaults to 0)
  --spp N              N sub-frames per output frame at N x fps, summed in linear light on
                       the GPU and read back once a frame (antialiasing, motion blur); default 1
  --warmup S           step S seconds unseen before the first frame, so feedback, caches,
                       simulations and stateful values carry their history into it. Default:
                       from 0 s when the plan carries state, none when it carries none.
                       --warmup 0 starts cold. A render is deterministic from its warm-up's
                       first frame: by default, the frame at T is the frame a render from 0 makes.
  --fps N              output frames per second; default the project's rate
  --out PATH|DIR       a file (one still, or the clip) or a directory; default renders/<project>/
  --output LABEL       the node to render; default the project's only Output node
  --set label.param=json;...   override top-level parameters for this render (repeatable)
  --quality live|final final: every Render node, inside components too, at SSAA and high AO
  --format prores|hevc10|png   a clip as ProRes 4444 .mov (default), 10-bit HEVC .mp4
                       (hevc_videotoolbox) or a 16-bit PNG per frame

The document is never written. Clips, Movie File In and Audio File In decoding need ffmpeg on PATH.

Sound: an Audio File In's file is heard. It is analysed as the app pre-analyses it and read at
the node's playhead on every frame (locked to the timeline: the timeline's position; free run:
from its in point on the first stepped frame). A microphone, or a file not on this machine,
renders silence and the render says so. A file that is not 48 kHz is resampled by ffmpeg, not
by the browser, so its analysis can differ in the last bits from the app's; each reproduces
itself. A clip carries no soundtrack.`;

const SINGLE = new Set(["at", "clip", "from", "spp", "warmup", "fps", "out", "output", "quality", "format"]);

class UsageError extends Error {}

interface Arguments {
  readonly project: string;
  readonly flags: ReadonlyMap<string, string>;
  readonly set: readonly string[];
}

function parseArguments(argv: readonly string[]): Arguments | "help" {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const set: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") continue; // pnpm forwards a bare `--`
    if (arg === "--help" || arg === "-h") return "help";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name !== "set" && !SINGLE.has(name)) throw new UsageError(`Unknown option ${arg}.`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value.`);
    i += 1;
    if (name === "set") {
      set.push(...value.split(";").filter((entry) => entry.trim() !== ""));
    } else {
      if (flags.has(name)) throw new UsageError(`${arg} is given twice.`);
      flags.set(name, value);
    }
  }
  if (positional.length !== 1) throw new UsageError(positional.length === 0 ? "Name the project to render." : `One project at a time; got ${positional.join(", ")}.`);
  return { project: positional[0]!, flags, set };
}

function numberFlag(flags: ReadonlyMap<string, string>, name: string, check: { readonly min: number; readonly integer?: boolean; readonly above?: boolean }): number | undefined {
  const text = flags.get(name);
  if (text === undefined) return undefined;
  const value = Number(text);
  const bad = !Number.isFinite(value) || (check.integer === true && !Number.isInteger(value)) || (check.above === true ? value <= check.min : value < check.min);
  if (bad) throw new UsageError(`--${name} expects ${check.integer === true ? "a whole number" : "a number"} ${check.above === true ? "above" : "of at least"} ${check.min}, not "${text}".`);
  return value;
}

function oneOf<T extends string>(flags: ReadonlyMap<string, string>, name: string, allowed: readonly T[]): T | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${name} is one of ${allowed.join(", ")}, not "${value}".`);
  return value as T;
}

/** pnpm runs a script from the package root; a relative path is the caller's, from where they typed it. */
const callerPath = (path: string): string => (isAbsolute(path) ? path : resolve(process.env["INIT_CWD"] ?? process.cwd(), path));

const CLIP_EXTENSIONS: Readonly<Record<string, ClipFormat>> = { ".mov": "prores", ".mp4": "hevc10" };

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === "help") {
    console.log(USAGE);
    return;
  }
  const { flags } = parsed;
  if (flags.has("at") && flags.has("clip")) throw new UsageError("--at renders stills and --clip a clip; give one of them.");
  if (flags.has("from") && !flags.has("clip")) throw new UsageError("--from sets where a --clip starts; a still's time is --at.");
  const spp = numberFlag(flags, "spp", { min: 1, integer: true }) ?? 1;
  const warmup = numberFlag(flags, "warmup", { min: 0 });
  const quality = oneOf<RenderQuality>(flags, "quality", ["live", "final"]) ?? "live";
  const outFlag = flags.get("out");
  const out = outFlag === undefined ? undefined : callerPath(outFlag);

  const projectPath = callerPath(parsed.project);
  const project = prepareProject(readFileSync(projectPath, "utf8"), { path: projectPath, quality, set: parsed.set });
  for (const note of project.notes) console.log(note);
  const fps = numberFlag(flags, "fps", { min: 0, above: true }) ?? projectFps(project.document.settings);
  const outputNodeId = outputNodeOf(project.document, flags.get("output"));
  const outDir = out !== undefined && extname(out) === "" ? out : out === undefined ? resolve("renders", project.name) : undefined;
  const pngFor = (dir: string) => (index: number): string => join(dir, `${project.name}-f${String(index).padStart(5, "0")}.png`);
  const summary = `${fps} fps, spp ${spp}, quality ${quality}`;
  const warmed = (outcome: RenderOutcome): string => (outcome.warmupFrames === 0 ? "" : `, warmed ${(outcome.warmupFrames / fps).toFixed(3)} s`);

  /**
   * Each warning once, with the output frame it first appeared at. And each error that did not
   * stop the render (the device's own, a GPU validation error at a frame): the frames are
   * written, and the console says what went wrong in them.
   */
  const said = new Set<string>();
  const report = (outcome: RenderOutcome): void => {
    for (const finding of outcome.findings) {
      const severity = finding.diagnostic.severity;
      if ((severity !== "warning" && severity !== "error") || finding.retained) continue;
      const key = `${finding.diagnostic.code}|${finding.diagnostic.nodeId ?? ""}|${finding.diagnostic.message}`;
      if (said.has(key)) continue;
      said.add(key);
      console.log(`${severity} at ${describeRenderFinding(finding, outcome, spp, project.document.graph)}`);
    }
  };
  const notes = new Set<string>();
  const onNote = (note: string): void => {
    if (notes.has(note)) return;
    notes.add(note);
    console.log(note);
  };

  const started = performance.now();
  const clipSeconds = numberFlag(flags, "clip", { min: 0, above: true });
  if (clipSeconds !== undefined) {
    const from = numberFlag(flags, "from", { min: 0 }) ?? 0;
    const inferred = out === undefined ? undefined : CLIP_EXTENSIONS[extname(out).toLowerCase()];
    const format = oneOf<ClipFormat>(flags, "format", ["prores", "hevc10", "png"]) ?? inferred ?? "prores";
    if (out !== undefined && extname(out) !== "" && inferred !== format) {
      throw new UsageError(`--out ${outFlag} does not fit --format ${format}: ProRes writes .mov, hevc10 .mp4, png a directory of frames.`);
    }
    if (format !== "png") requireFfmpeg(`a ${format === "prores" ? "ProRes" : "HEVC"} clip`);
    const first = Math.round(from * fps);
    const count = Math.max(1, Math.round(clipSeconds * fps));
    const extension = format === "prores" ? ".mov" : ".mp4";
    const path = outDir === undefined ? out! : format === "png" ? outDir : join(outDir, `${project.name}-f${String(first).padStart(5, "0")}-${count}f${extension}`);
    const writer = clipWriter(format, path, fps, pngFor(path));
    const every = Math.max(1, Math.round(count / 10));
    let size = "";
    const outcome = await renderFrames({
      project, outputNodeId, fps, spp, first, count, onNote,
      ...(warmup === undefined ? {} : { warmup }),
      ...(format === "hevc10" ? { opaque: true } : {}),
      onFrame: async (frame) => {
        size = `${frame.width}x${frame.height}`;
        await writer.write(frame);
        const done = frame.index - first + 1;
        if (done % every === 0 || done === count) {
          console.log(`  ${done}/${count} frames, ${((performance.now() - started) / 1000 / done).toFixed(2)} s a frame`);
        }
      },
    });
    await writer.close();
    report(outcome);
    console.log(`${path}  ${count} frames ${size} from frame ${first} (${(first / fps).toFixed(3)} s), ${summary}${warmed(outcome)}, in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return;
  }

  if (flags.has("format") && flags.get("format") !== "png") throw new UsageError("A still is a PNG; --format chooses a clip's container.");
  const times = (flags.get("at") ?? "0").split(",").map((text) => {
    const value = Number(text);
    if (text.trim() === "" || !Number.isFinite(value) || value < 0) throw new UsageError(`--at takes times in seconds, not "${text}".`);
    return value;
  });
  if (outDir === undefined && extname(out!).toLowerCase() !== ".png") throw new UsageError(`--out ${outFlag}: a still is a .png file, or give a directory.`);
  if (outDir === undefined && times.length > 1) throw new UsageError(`--out ${outFlag} names one file and --at asks for ${times.length} stills; give a directory.`);
  for (const at of times) {
    const frameIndex = Math.round(at * fps);
    const path = outDir === undefined ? out! : pngFor(outDir)(frameIndex);
    let written = "";
    const outcome = await renderFrames({
      project, outputNodeId, fps, spp, first: frameIndex, count: 1, onNote,
      ...(warmup === undefined ? {} : { warmup }),
      onFrame: (frame) => {
        writePng16(path, frame);
        written = `${path}  ${frame.width}x${frame.height} at frame ${frameIndex} (${(frameIndex / fps).toFixed(3)} s), ${summary}`;
      },
    });
    console.log(`${written}${warmed(outcome)}`);
    report(outcome);
  }
}

try {
  await main();
  // Dawn's device keeps the event loop alive; the work is done.
  process.exit(0);
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
