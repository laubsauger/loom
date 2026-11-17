import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addNode, openApp } from "./app.ts";

/**
 * T1751b — THE OWNER'S CASE, LITERALLY: sound in, notes on a node.
 *
 * An Audio In node and a Chroma node from the library, a C major chord on the microphone
 * (Chromium's fake capture device playing a file): the Chroma node's own tile reads C and
 * does not read C sharp or D sharp (the tile lists a node's first four channels). That is every seam at once — the capture
 * noticing the tonal node and re-acquiring with the pass on, the options reaching the audio
 * thread, the port, the reducer, the record, the node, the tile. Cut any one and the tile
 * reads zeros.
 *
 * In the lane with a real adapter (`NEEDS_A_REAL_ADAPTER`): a value tile reads nothing
 * until a plan is installed on a device. The analyser's numbers are pinned exactly
 * elsewhere (`chroma.test.ts`, `audio-tonal.spec.ts`); a microphone path carries the
 * browser's own input processing, so here the claim is which classes lead.
 */

/** C4, E4, G4 with six partials each, a slow tremolo so a noise suppressor does not take it for hum. */
function chordWav(seconds: number, sampleRate: number): Buffer {
  const count = seconds * sampleRate;
  const data = Buffer.alloc(44 + count * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + count * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) {
    let sample = 0;
    for (const note of [60, 64, 67]) {
      const frequency = 440 * 2 ** ((note - 69) / 12);
      for (let h = 1; h <= 6; h += 1) sample += (0.12 / h) * Math.sin((2 * Math.PI * frequency * h * i) / sampleRate);
    }
    sample *= 0.75 + 0.25 * Math.sin((2 * Math.PI * 3 * i) / sampleRate);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2);
  }
  return data;
}

const MIC_FILE = join(mkdtempSync(join(tmpdir(), "loom-chroma-")), "c-major.wav");
writeFileSync(MIC_FILE, chordWav(4, 48_000));

test.use({
  launchOptions: {
    args: [
      "--mute-audio",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${MIC_FILE}`,
    ],
  },
  permissions: ["microphone"],
});


test.describe("T1751b — the Chroma node in the product", () => {
  test("Audio In and a Chroma node: a C major chord on the microphone reads C, and neither C sharp nor D sharp, on the Chroma node's tile", async ({ page }) => {
    await openApp(page);
    await addNode(page, "input", "Audio In");
    const chromaId = await addNode(page, "input", "Chroma");
    const reading = async (channel: string): Promise<number> => {
      const value = await page
        .locator(`.react-flow__node[data-id="${chromaId}"] [data-channel-name="${channel}"]`)
        .first()
        .getAttribute("data-channel-value");
      return value === null || value === "" ? 0 : Number(value);
    };

    // The capture polls the document once a second, re-acquires with the tonal pass on,
    // and the first window needs 171 ms of sound: poll until the chord has arrived.
    await expect.poll(() => reading("chroma0"), { timeout: 20_000, intervals: [250] }).toBeGreaterThan(0.5);
    // The tile lists a node's first four channels: C, C sharp, D, D sharp. C is a chord tone.
    // C sharp and D sharp are not sounding at all. D is there, faintly and correctly: it is
    // the third partial of the chord's G.
    const classes = await Promise.all([0, 1, 2, 3].map((pitchClass) => reading(`chroma${String(pitchClass)}`)));
    console.log(`chroma0..3 on the tile: ${classes.map((value) => value.toFixed(3)).join(" ")}`);
    const [c, cSharp, d, dSharp] = classes as [number, number, number, number];
    expect(c).toBeGreaterThan(0.5);
    expect(cSharp).toBeLessThan(0.15);
    expect(dSharp).toBeLessThan(0.15);
    expect(d).toBeLessThan(c);
  });
});
