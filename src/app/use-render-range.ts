import { useEffect, useRef, useState } from "react";

import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { frameRangeLength, projectFps, projectRange } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { isDeclaredSink } from "@compiler/index.ts";
import type { ExportInterface, OutputRef } from "@runtime/export/index.ts";
import { loadVideoEncoder } from "@runtime/export/index.ts";
import { transportHolderFor } from "./transport-commands.ts";
import type { RenderRangeOutcome } from "./render-range.ts";
import { registerRenderRangeCommand, renderFrameRange } from "./render-range.ts";
import { writeTextFile } from "./project-io.ts";

/**
 * The seam that makes "render the timeline out" a thing the app can do (T433, §V220).
 *
 * `createFrameRecorder`, `muxMp4` and the WebCodecs encoder have existed and been tested
 * since T111, with no construction site anywhere in the product — the seam gate said so
 * in writing. This hook is that site. It holds nothing itself: it composes the export
 * interface the agent ports already built, the transport the frame loop already owns and
 * the file ladder the project save already uses, so there is one of each rather than a
 * private copy per feature.
 *
 * ## Which output gets rendered
 *
 * The graph's DECLARED sink, exactly as the viewer picks it (§V28b): every visible
 * texture node is a preview sink, so "the first resolved output" would render an
 * arbitrary intermediate. With no Output node there is nothing to render and the command
 * says so by name (§V288) rather than producing a file of something nobody asked for.
 */

export interface RenderRangeSession {
  /** True while a take is running, for the header's control. */
  readonly rendering: boolean;
  /** Frames the current range would produce. Zero when nothing can render. */
  readonly frames: number;
}

export interface UseRenderRangeInputs {
  readonly bus: ShaderloomBus;
  readonly exports: ExportInterface | undefined;
  readonly compiled: CompiledGraph | null;
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly settings: ProjectSettings;
  readonly latestFrame: () => FrameInputs | null;
  readonly name: () => string;
  /** Test seam. The real one is a `VideoEncoder` behind the WebCodecs loader. */
  readonly loadEncoder?: typeof loadVideoEncoder;
  /** Test seam for the file ladder. */
  readonly write?: typeof writeTextFile;
}

const VIDEO_PICKER_TYPES = [
  {
    description: "MPEG-4 video",
    accept: { "video/mp4": [".mp4"] } as Readonly<Record<string, readonly string[]>>,
  },
];

function refuse(
  code: string,
  message: string,
  suggestion?: string,
): { kind: "refused"; diagnostic: RuntimeDiagnostic } {
  return {
    kind: "refused",
    diagnostic: {
      severity: "error",
      code,
      message,
      ...(suggestion === undefined ? {} : { suggestion }),
    },
  };
}

/** Strips a project file name back to a stem a video can sit beside. */
function videoFileName(projectName: string, start: number, end: number): string {
  const stem = projectName.replace(/\.loom\.json$/i, "").replace(/[^\w.-]+/g, "_") || "untitled";
  return `${stem}.${String(start)}-${String(end)}.mp4`;
}

export function useRenderRange(inputs: UseRenderRangeInputs): RenderRangeSession {
  const [rendering, setRendering] = useState(false);
  // Every input is read through ONE ref, at the moment the command runs: a take is
  // started by a keypress or the palette, and the handlers must not need re-registering
  // on every compile to see the current graph.
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const renderingRef = useRef(false);

  const range = projectRange(inputs.settings);
  const sink = declaredSink(inputs.compiled, inputs.graph, inputs.registry);

  useEffect(() => {
    const holder = registerRenderRangeCommand(inputs.bus);
    const handlers = {
      busy: () => renderingRef.current,
      render: async (): Promise<RenderRangeOutcome> => {
        const live = inputsRef.current;
        const api = live.exports;
        if (api === undefined) {
          return refuse(
            "export.noDevice",
            "There is no GPU device, so there are no frames to render.",
          );
        }
        const ref = declaredSink(live.compiled, live.graph, live.registry);
        if (ref === null) {
          return refuse(
            "export.noOutput",
            "This graph declares no Output, so there is nothing to render out.",
            "Add an Output node and connect it to the branch you want on the timeline.",
          );
        }
        const transport = transportHolderFor(live.bus).current;
        if (transport === null) {
          return refuse(
            "export.noTransport",
            "No frame loop is attached, so the timeline cannot be stepped.",
          );
        }
        const encoder = await (live.loadEncoder ?? loadVideoEncoder)();
        if (encoder === null) {
          return refuse(
            "export.encoderUnavailable",
            "This browser has no VideoEncoder, so a rendered range cannot be encoded.",
            "WebCodecs is required. Chromium-based browsers have it; Safari and Firefox may not.",
          );
        }

        const liveRange = projectRange(live.settings);
        renderingRef.current = true;
        setRendering(true);
        try {
          const rendered = await renderFrameRange({
            api,
            ref,
            range: liveRange,
            fps: projectFps(live.settings),
            encoder,
            transport: {
              isPlaying: transport.isPlaying,
              togglePlay: transport.togglePlay,
              seek: transport.seek,
              stepOnce: transport.stepOnce,
              latestFrame: live.latestFrame,
            },
          });
          // The report, not the byte count, decides whether this take is what was asked
          // for: a file with the right number of frames and a gap in the middle is wrong
          // in the one way a video player will never show you.
          if (!rendered.report.contiguous) {
            return refuse(
              "export.rangeNotContiguous",
              `The take covers frames ${String(rendered.report.firstFrameIndex)}–${String(
                rendered.report.lastFrameIndex,
              )} but is missing ${String(rendered.report.missing.length)} of them.`,
            );
          }
          const outcome = await (live.write ?? writeTextFile)({
            fileName: videoFileName(live.name(), liveRange.start, liveRange.end),
            text: rendered.bytes,
            mime: "video/mp4",
            pickerTypes: VIDEO_PICKER_TYPES,
          });
          if (outcome.kind === "failed") {
            return refuse("export.writeFailed", `The rendered range could not be written: ${outcome.reason}`);
          }
          return {
            kind: "rendered",
            frames: rendered.report.frames,
            // Cancelling the picker is not a failure — the frames were rendered, and the
            // count says so while the missing name says the file was not kept.
            fileName: outcome.kind === "saved" ? outcome.fileName : null,
          };
        } finally {
          renderingRef.current = false;
          setRendering(false);
        }
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [inputs.bus]);

  return { rendering, frames: sink === null ? 0 : frameRangeLength(range) };
}

/**
 * The graph's declared sink, port-scoped (§V59, §V28b).
 *
 * Same rule the viewer applies, and deliberately the same answer: what you render out is
 * what the viewer shows. Two ways of choosing "the output" would be two products.
 */
function declaredSink(
  compiled: CompiledGraph | null,
  graph: GraphDocument,
  registry: NodeRegistryView,
): OutputRef | null {
  for (const output of compiled?.outputs ?? []) {
    const type = graph.nodes[output.nodeId]?.type;
    const definition = type === undefined ? undefined : registry.get(type);
    if (definition !== undefined && isDeclaredSink(definition)) {
      return { nodeId: output.nodeId, portId: output.portId };
    }
  }
  return null;
}
