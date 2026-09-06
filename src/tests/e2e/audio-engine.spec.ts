import { expect, test } from "@playwright/test";
import { addNode, openApp } from "./app.ts";

/**
 * T1226 — THE ENGINE IN A REAL CHROMIUM: counts on a hop grid, and wired into the product.
 *
 * Two claims, each one thing the polled path could not do:
 *
 * 1. A CLICK TRAIN IS COUNTED, click for click. Ten clicks 100 ms apart rendered
 *    through an `OfflineAudioContext` into the shipped worklet: exactly ten hops carry
 *    `event`, one per click, each on the hop the click enters (the offline context is
 *    deterministic, so "the hop" is a number: `fftSize + k·hop` is the first window end
 *    past the click). The polled path would have counted whatever rAF happened to
 *    straddle — and the second of two clicks 100 ms apart on a 60 Hz display is not a
 *    problem for it, but 20 ms apart is, which the hop grid (10.7 ms) resolves. The
 *    hop-level values themselves are pinned analytically in `hop-analyser.test.ts`;
 *    this spec is the same engine through the real worklet + port + transfer.
 *
 * 2. THE PRODUCT PATH USES IT. An `Audio In` node on a fake microphone shows "Live"
 *    with NO fallback message. §V288 is what makes that an assertion: the polled path
 *    is NAMED in the status ("Analysis worklet unavailable …"), so a live status
 *    without the name is the engine, and a spec that makes the worklet fail to load
 *    turns this test red at the `polling` line. This is the claim T1225 left open
 *    ("nothing in the product reaches it yet"), and it is the one a build proof cannot
 *    make: a URL constant is not a factory, so the composition gate cannot see it
 *    (§B191's blind spot). (`addModule`'s fetch does not land in resource timing, so
 *    the status line is the observable.)
 *
 * Chromium's fake audio device (`--use-fake-device-for-media-stream`) is a real
 * `MediaStream` through the real `getUserMedia`, with the permission auto-granted;
 * what it carries is not asserted, only that the engine is what is listening to it.
 */

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

const FFT_SIZE = 2048;
const HOP = 512;
const SAMPLE_RATE = 48_000;
const CLICKS = 10;
/** 100 ms apart, on a hop boundary so every click enters its window at the same position. */
const CLICK_SPACING = HOP * 9;

interface HopRecord {
  readonly end: number;
  readonly flux: number;
  readonly event: boolean;
  readonly bandEvents: number[];
}

interface WorkletUrlModule {
  readonly AUDIO_ANALYSIS_WORKLET_URL: string;
}
interface ProtocolModule {
  readonly AUDIO_ANALYSIS_PROCESSOR_NAME: string;
  readonly AUDIO_ANALYSIS_OPTIONS: { readonly fftSize: number; readonly hop: number };
}

test.describe("T1226 — the analysis engine", () => {
  test("a click train through the shipped worklet is one event per click, on the hop it enters", async ({ page }) => {
    await page.goto("/");

    const hops = await page.evaluate(
      async ({ fftSize, hop, sampleRate, clicks, spacing }): Promise<HopRecord[]> => {
        const urlModulePath = "/src/app/audio-analysis-worklet-url.ts";
        const protocolModulePath = "/src/app/audio-analysis-protocol.ts";
        const { AUDIO_ANALYSIS_WORKLET_URL } = (await import(/* @vite-ignore */ urlModulePath)) as WorkletUrlModule;
        const { AUDIO_ANALYSIS_PROCESSOR_NAME, AUDIO_ANALYSIS_OPTIONS } = (await import(
          /* @vite-ignore */ protocolModulePath
        )) as ProtocolModule;

        const length = fftSize + spacing * (clicks + 1);
        const context = new OfflineAudioContext(1, length, sampleRate);
        await context.audioWorklet.addModule(AUDIO_ANALYSIS_WORKLET_URL);

        // Click c at fftSize + 1600 + c·spacing: past the first window, position 1600 in the
        // window it enters (w ≈ 0.25, well above the analyser's −100 dB floor).
        const buffer = context.createBuffer(1, length, sampleRate);
        const channel = buffer.getChannelData(0);
        for (let c = 0; c < clicks; c += 1) channel[fftSize + 1600 + c * spacing] = 1;
        const source = context.createBufferSource();
        source.buffer = buffer;

        const node = new AudioWorkletNode(context, AUDIO_ANALYSIS_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
          processorOptions: { ...AUDIO_ANALYSIS_OPTIONS, fftSize, hop },
        });
        source.connect(node);

        const records: HopRecord[] = [];
        let pong: (() => void) | null = null;
        node.port.onmessage = (event: MessageEvent) => {
          const data = event.data as
            | { type: "hop"; end: number; flux: number; event: boolean; bandEvents: Uint8Array }
            | { type: "pong" };
          if (data.type === "hop") {
            records.push({ end: data.end, flux: data.flux, event: data.event, bandEvents: Array.from(data.bandEvents) });
          } else if (data.type === "pong") {
            pong?.();
          }
        };

        source.start(0);
        await context.startRendering();
        await new Promise<void>((resolve) => {
          pong = resolve;
          node.port.postMessage({ type: "ping", id: 1 });
        });
        return records;
      },
      { fftSize: FFT_SIZE, hop: HOP, sampleRate: SAMPLE_RATE, clicks: CLICKS, spacing: CLICK_SPACING },
    );

    const events = hops.filter((record) => record.event);
    console.log(
      `hops=${hops.length} events=${events.length} at ends [${events.map((record) => record.end).join(", ")}] ` +
        `flux ${events.map((record) => record.flux.toFixed(4)).join(", ")}`,
    );
    expect(hops.length).toBeGreaterThan(CLICKS * 9);
    // One per click, on the first window end past the click.
    expect(events.map((record) => record.end)).toEqual(
      Array.from({ length: CLICKS }, (_, c) => {
        const sample = FFT_SIZE + 1600 + c * CLICK_SPACING;
        return FFT_SIZE + HOP * (Math.floor((sample - FFT_SIZE) / HOP) + 1);
      }),
    );
    // Every click enters at the same position, so every event carries the same flux —
    // the byte at w(1600 / 2048) / 2048 = −78.3 dB, which is 78 / 255 (hop-analyser.test.ts).
    for (const record of events) expect(record.flux).toBe(78 / 255);
    // And a click is broadband: the whole-spectrum adaptive stream (index 0) fires on it too.
    expect(events.every((record) => record.bandEvents[0] === 1)).toBe(true);
  });

  test("an Audio In node on a microphone runs the engine, not the fallback", async ({ page }) => {
    await openApp(page);
    const nodeId = await addNode(page, "input", "Audio In");
    const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    const status = page.locator("[data-audio-status]");

    // The capture hook polls the document once a second; the inspector reads the status
    // when it renders, and on an empty graph nothing else re-renders it — so re-select
    // the node until the status line reflects the capture.
    await expect
      .poll(
        async () => {
          await page.locator('[data-testid="graph-canvas"]').click({ position: { x: 40, y: 40 } });
          await node.click();
          return status.getAttribute("data-audio-status");
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBe("live");
    await expect(status).not.toContainText("polling");
    await expect(status).not.toContainText("unavailable");
  });
});
