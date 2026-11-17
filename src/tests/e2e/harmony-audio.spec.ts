import { expect, test } from "@playwright/test";

test.use({ channel: "chromium" });

test("generated harmony produces real samples, follows the audio clock, and stops cleanly", async ({ page }) => {
  await page.route("**/harmony-audio-probe", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><button>Enable audio probe</button>" }));
  await page.goto("/harmony-audio-probe");
  await page.mouse.click(4, 4);
  const measured = await page.evaluate(async () => {
    const path = "/src/app/harmony-audio.ts";
    const { createHarmonyAudio } = await import(/* @vite-ignore */ path) as typeof import("../../app/harmony-audio.ts");
    const context = new AudioContext();
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    const mute = context.createGain();
    mute.gain.value = 1;
    analyser.connect(mute).connect(context.destination);
    // The runner's --mute-audio silences speakers while the real output graph still pulls samples.
    const measuredContext = new Proxy(context, {
      get(target, property) {
        if (property === "destination") return analyser;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const synth = createHarmonyAudio(measuredContext);
    const config = { seed: 31415, tempo: 68, initialKey: 2, initialMode: "minor", harmonicComplexity: 0.58, evolutionRate: 0.35, musicalEnergy: 0.45 };
    const samples = new Float32Array(analyser.fftSize);
    const rms = () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    };
    try {
      const deadline = performance.now() + 30000;
      while (synth.readiness().kind === "loading" && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const ready = synth.readiness();
      if (ready.kind !== "ready") throw new Error(`Piano not ready: ${JSON.stringify(ready)}`);
      synth.update(0, config, true, 0.5);
      await new Promise(resolve => setTimeout(resolve, 150));
      const sounding = rms();
      const beforeStall = synth.timeSeconds()!;
      const clockBefore = context.currentTime;
      // No render-frame updates: synthesis must continue on the audio clock alone.
      await new Promise(resolve => setTimeout(resolve, 250));
      const afterStall = synth.timeSeconds()!;
      const clockAfter = context.currentTime;
      synth.update(afterStall, config, false, 0.5);
      await new Promise(resolve => setTimeout(resolve, 120));
      return { sounding, elapsed: afterStall - beforeStall, stopped: rms(), stoppedTime: synth.timeSeconds(), beforeStall, afterStall, clockBefore, clockAfter, state: context.state };
    } finally {
      synth.dispose();
      analyser.disconnect();
      mute.disconnect();
      await context.close();
    }
  });
  expect(measured.sounding).toBeGreaterThan(0.001);
  // Muted headless output may pull samples in sparse quanta rather than wall time.
  // The synth must follow that actual audio clock, without substituting a render clock.
  expect(measured.beforeStall).toBeGreaterThan(0);
  expect(measured.elapsed, JSON.stringify(measured)).toBeCloseTo(measured.clockAfter - measured.clockBefore, 8);
  expect(measured.stopped).toBeLessThan(0.00001);
  expect(measured.stoppedTime).toBeUndefined();
});
