import { expect, test } from "@playwright/test";
import { addNode, openApp, selectNode } from "./app.ts";

/**
 * T1769b — THE INPUT GAIN IN A REAL CHROMIUM: a known tone on the microphone path, read off
 * the Audio In node's own tile at 0, +20 and -20 dB, at the closed-form value each time.
 *
 * Every stage after the device is the product's and the browser's own: the capture hook,
 * `getUserMedia` (Chromium's fake device, permission granted), the trim `GainNode`, the
 * shipped analysis worklet on the audio thread, the port, the hop reducer, the frame's
 * record, the node, the tile. The inspector's own field moves the gain.
 *
 * ## The one stand-in, and why
 *
 * A device stream carries the browser's input processing and Chromium's fake device plays a
 * beep, so neither is a signal with a known level. `createMediaStreamSource` is therefore
 * wrapped to hand back a looping buffer source IN THE APP'S OWN CONTEXT: a sine of exactly
 * 32 samples a period (bin 64 of the engine's 2048 window, at whatever rate the context
 * runs), amplitude 0.01, half a sample off the zero crossing. Same context, so sample-exact:
 * no resampler, no stream FIFO. What is replaced is the source node and nothing after it.
 *
 * ## The numbers
 *
 * Derived in `audio-input-gain.test.ts`: the Blackman window puts a bin-centred sine of
 * amplitude a on five bins (0.21 a, 0.125 a twice, 0.02 a twice), a bin's byte is
 * trunc(255 (dB + 100) / 70), and `lowMid` is the mean byte of the bins between 250 and
 * 2000 Hz over 255. The five bytes are 169/152/94 at 0.01, 242/225/167 at 0.1 and 96/79/21
 * at 0.001; the band's bin count follows the context's rate (75 at 48 kHz, 81 at 44.1).
 * The nearest any of those sits to a byte boundary is 0.047 of a byte (242.047), and a
 * settled `setTargetAtTime` is within a millionth of its target, three thousandths of that.
 *
 * ## No restart
 *
 * The page counts `getUserMedia` and `createMediaStreamSource`. Both stay at 1 from the
 * first reading to the last, across two changes of the gain and the capture's own
 * once-a-second document poll, and the status line stays live with no fallback named.
 *
 * In the lane with a real adapter (`NEEDS_A_REAL_ADAPTER`): a value tile reads nothing until
 * a plan is installed on a device.
 */

test.use({
  launchOptions: {
    args: ["--mute-audio", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

interface Probe {
  /** T1776b: what each `getUserMedia` call was asked for. */
  constraints: unknown[];
  userMedia: number;
  sources: number;
  sampleRate: number;
}

const AMPLITUDE = 0.01;
const FFT_SIZE = 2048;
/** The five Blackman bins' bytes, by trimmed amplitude. */
const TONE_BYTES = { "0": 169 + 2 * 152 + 2 * 94, "20": 242 + 2 * 225 + 2 * 167, "-20": 96 + 2 * 79 + 2 * 21 } as const;

/** `lowMid`'s bins at `sampleRate`: the bins whose centre is inside 250..2000 Hz (`bandAverage`'s rule). */
function lowMidBins(sampleRate: number): number {
  const binHz = sampleRate / FFT_SIZE;
  return Math.floor(2000 / binHz) - Math.ceil(250 / binHz) + 1;
}

test.describe("T1769b — Audio In's Input Gain, on the microphone path", () => {
  test("a tone at -40 dBFS reads its closed form at 0, +20 and -20 dB, and the device is opened once", async ({ page }) => {
    await page.addInitScript((amplitude) => {
      const probe = { constraints: [] as unknown[], userMedia: 0, sources: 0, sampleRate: 0 };
      (window as unknown as { __inputGainProbe: typeof probe }).__inputGainProbe = probe;
      const devices = navigator.mediaDevices;
      const open = devices.getUserMedia.bind(devices);
      devices.getUserMedia = (constraints) => {
        probe.userMedia += 1;
        probe.constraints.push(constraints);
        return open(constraints);
      };
      AudioContext.prototype.createMediaStreamSource = function (this: AudioContext) {
        probe.sources += 1;
        probe.sampleRate = this.sampleRate;
        const buffer = this.createBuffer(1, 2048, this.sampleRate);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < data.length; index += 1) data[index] = amplitude * Math.sin((2 * Math.PI * 64 * (index + 0.5)) / 2048);
        const source = this.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.start();
        return source as unknown as MediaStreamAudioSourceNode;
      };
    }, AMPLITUDE);

    await openApp(page);
    const nodeId = await addNode(page, "input", "Audio In");
    await selectNode(page, nodeId);
    const probe = (): Promise<Probe> => page.evaluate(() => (window as unknown as { __inputGainProbe: Probe }).__inputGainProbe);
    const lowMid = async (): Promise<number> => {
      const value = await page
        .locator(`.react-flow__node[data-id="${nodeId}"] [data-channel-name="lowMid"]`)
        .first()
        .getAttribute("data-channel-value");
      return value === null || value === "" ? Number.NaN : Number(value);
    };
    const setGain = async (decibels: string): Promise<void> => {
      const field = page.locator('input[aria-label="Input Gain (dB)"]');
      await field.scrollIntoViewIfNeeded();
      // A press that never moves hands the field to the keyboard.
      await field.click();
      await expect(field).not.toHaveAttribute("readonly", /.*/);
      await field.fill(decibels);
      await field.press("Enter");
    };

    // The capture polls the document once a second and then opens the device.
    await expect.poll(async () => (await probe()).sources, { timeout: 20_000, intervals: [250] }).toBe(1);
    const { sampleRate } = await probe();
    const expected = (gain: keyof typeof TONE_BYTES): number => TONE_BYTES[gain] / lowMidBins(sampleRate) / 255;
    console.log(`context at ${String(sampleRate)} Hz: lowMid is ${String(lowMidBins(sampleRate))} bins; expecting ${[expected("0"), expected("20"), expected("-20")].map((value) => value.toFixed(6)).join(" / ")}`);

    await expect.poll(lowMid, { timeout: 20_000, intervals: [250] }).toBe(expected("0"));

    await setGain("20");
    await expect.poll(lowMid, { timeout: 10_000, intervals: [100] }).toBe(expected("20"));

    await setGain("-20");
    await expect.poll(lowMid, { timeout: 10_000, intervals: [100] }).toBe(expected("-20"));

    // Longer than the capture's document poll: a structural change would have rebuilt by now.
    await page.waitForTimeout(1500);
    expect(await lowMid()).toBe(expected("-20"));
    expect(await probe()).toMatchObject({ userMedia: 1, sources: 1 });
    const status = page.locator("[data-audio-status]");
    await expect(status).toHaveAttribute("data-audio-status", "live");
    await expect(status).not.toContainText("polling");
    await expect(status).not.toContainText("unavailable");
    // T1776b: the one call asked for the raw device, and this Chromium's track reported all
    // three stages off when read back (the status names any it kept or would not report).
    expect((await probe()).constraints).toEqual([{ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }]);
    await expect(status).not.toContainText("The browser");
  });
});
