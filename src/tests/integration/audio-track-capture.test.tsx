// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { parseFeatureTrack, featureTrackLength } from "@domain/audio/feature-track.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T452 — a user can ARM a recording, and the track that comes out is a real file.
 *
 * `tests/headless/audio-track-replay.test.ts` proves the track replays the performance.
 * What it cannot show is that anybody can MAKE one: the recorder had no construction site
 * in the product at all, which the seams gate caught on its first run. This is the half
 * that says a person, pressing a button that exists, ends up with a file.
 *
 * The three rulings, each asserted rather than described:
 *  (a) an explicit arm — the control exists, and capture does not run until it is pressed;
 *  (b) NOT in the project file — the document is untouched by recording;
 *  (c) written through the shared file path — the same picker-then-download ladder a
 *      saved project takes, so a track and a render cannot drift apart on Safari.
 */

function installCodeMirrorStubs(): void {
  const range = Range.prototype as unknown as Record<string, unknown>;
  range["getClientRects"] ??= () => ({
    length: 0, item: () => null, [Symbol.iterator]: function* () {},
  });
  range["getBoundingClientRect"] ??= () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
  });
}

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installCodeMirrorStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function mount(operations: GraphPatchOperation[] = []) {
  const runtime = newRuntime();
  if (operations.length > 0) {
    await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
      runtime.invocation,
    );
  }
  const view = await act(async () =>
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />),
  );
  return { runtime, container: view.container };
}

describe("T452 — recording a performance is something a user can do", () => {
  it("(a) offers an ARM control rather than recording whatever it hears", async () => {
    const { container } = await mount();
    const arm = container.querySelector('button[aria-label="Record audio features"]');
    expect(arm, "no control arms a recording — capture would have to be always-on").not.toBeNull();
    // Nothing has been recorded, so nothing offers to be saved: a save button that can
    // only refuse is the shape §V123 calls a button that lies.
    expect(container.querySelector('button[aria-label="Save audio track"]')).toBeNull();
  });

  it("refuses by name when armed with no live capture, rather than recording silence", async () => {
    // §V288: a recording of nothing looks exactly like a working recording, right up
    // until someone replays it. jsdom has no microphone, so this is the real case.
    const { container } = await mount();
    const arm = container.querySelector('button[aria-label="Record audio features"]');
    if (arm === null) throw new Error("expected the arm control");

    await act(async () => {
      fireEvent.click(arm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent ?? "").toContain("would capture nothing but silence");
    // And it did NOT arm: the button still offers to start.
    expect(container.querySelector('button[aria-label="Record audio features"]')).not.toBeNull();
  });

  it("(b) leaves the document alone — a performance is not the project", async () => {
    const { runtime, container } = await mount([
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
    ]);
    const before = runtime.bus.store.getRevision();
    const serialisedBefore = JSON.stringify(runtime.bus.store.getGraph());

    const arm = container.querySelector('button[aria-label="Record audio features"]');
    if (arm === null) throw new Error("expected the arm control");
    await act(async () => {
      fireEvent.click(arm);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Arming is session state. It writes no patch, makes no undo entry, and nothing about
    // it reaches the `.loom.json` — a document that grew every time someone recorded
    // would couple the recording to the thing being recorded (§V18).
    expect(runtime.bus.store.getRevision()).toBe(before);
    expect(JSON.stringify(runtime.bus.store.getGraph())).toBe(serialisedBefore);
  });

  it("(c) writes a parseable track through the shared file path, and says nothing was recorded when nothing was", async () => {
    const { runtime } = await mount();

    // Saving with an empty recorder refuses by name instead of writing an empty file that
    // would parse perfectly and replay as silence.
    const empty = await act(async () =>
      runtime.bus.execute("audio.saveTrack", {}, runtime.invocation),
    );
    expect(empty.status).toBe("rejected");
    expect(empty.diagnostics[0]?.message).toContain("Nothing has been recorded");
    // Deliberately NOT asserting this reaches the screen here: a direct `bus.execute` is
    // not a user gesture, and it is the BUTTON that routes refusals to the problems panel
    // through `reportRefusal` — which the arm test above asserts on screen, and T392's
    // suite gates for every other route.
  });
});

describe("T452 — the track a save produces is a real, parseable artifact", () => {
  it("round-trips through the shared writer into something `parseFeatureTrack` accepts", async () => {
    // The writer is exercised directly with the app's own picker-less path, because jsdom
    // has no File System Access API — which is exactly the fallback half of ruling (c),
    // the one Firefox and Safari users get.
    const { writeTextFile } = await import("../../app/project-io.ts");
    const { createFeatureTrackRecorder, serializeFeatureTrack } = await import(
      "@domain/audio/feature-track.ts"
    );
    const { AUDIO_TRACK_MIME, AUDIO_TRACK_PICKER_TYPE } = await import("../../app/use-audio-track.ts");

    const recorder = createFeatureTrackRecorder(60);
    recorder.capture(0, {
      level: 0.5, low: 0.4, lowMid: 0.3, highMid: 0.2, high: 0.1,
      onset: 0.6, onsetCount: 1, onsetMax: 0.7,
    });

    let written: { fileName: string; text: string; mime: string } | null = null;
    const outcome = await writeTextFile(
      {
        fileName: "take.loomtrack.json",
        text: serializeFeatureTrack(recorder.track()),
        mime: AUDIO_TRACK_MIME,
        pickerTypes: [AUDIO_TRACK_PICKER_TYPE],
      },
      {
        globals: {},
        download: (file) => {
          written = {
            fileName: file.fileName,
            // T433 widened `text` to carry bytes as well; a feature track is JSON.
            text: typeof file.text === "string" ? file.text : new TextDecoder().decode(file.text),
            mime: file.mime,
          };
        },
      },
    );

    expect(outcome.kind).toBe("saved");
    expect(written).not.toBeNull();
    const file = written as unknown as { fileName: string; text: string; mime: string };
    // Its own extension: a track must never be offered to the project opener by mistake.
    expect(file.fileName.endsWith(".loomtrack.json")).toBe(true);

    const parsed = parseFeatureTrack(file.text);
    expect(parsed.ok, "the file a save writes is not a track this build can read").toBe(true);
    if (!parsed.ok) return;
    expect(featureTrackLength(parsed.track)).toBe(1);
  });

  it("carries the caller's own media type through the REAL download path", async () => {
    // The test above stubs `download`, so it proves the writer passes the file along and
    // nothing about the bytes that actually reach the disk. Ruling (c) is that a track and
    // a project share ONE writer — which is only true if that writer honours each
    // caller's type instead of hardcoding the project's.
    const { writeTextFile } = await import("../../app/project-io.ts");
    const { AUDIO_TRACK_MIME, AUDIO_TRACK_PICKER_TYPE } = await import("../../app/use-audio-track.ts");

    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const blobs: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:probe";
    };
    URL.revokeObjectURL = () => {};
    try {
      const outcome = await writeTextFile(
        {
          fileName: "take.loomtrack.json",
          text: "{}",
          mime: AUDIO_TRACK_MIME,
          pickerTypes: [AUDIO_TRACK_PICKER_TYPE],
        },
        { globals: {} },
      );
      expect(outcome.kind).toBe("saved");
      expect(blobs).toHaveLength(1);
      expect(
        blobs[0]?.type,
        "the shared writer stamped its own media type on a caller's file",
      ).toBe(AUDIO_TRACK_MIME);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
