import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { APP_VIEWPORT, openApp, selectNode } from "./app.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { WHIP_OUT_TYPE } from "@nodes/definitions/whip-out.ts";
import { buildProjectFile } from "@domain/project/project-file.ts";
import { document as exampleDocument, expressionSlot, settings as exampleSettings } from "@/examples/documents/builders.ts";

/**
 * §T1809b — WHIP Out, END TO END: the app publishes into a real MediaMTX and a second page
 * SUBSCRIBES to that server over WHEP and decodes the video. Everything asserted here is
 * what a wall reading the stream gets: the decoded size, the decoded frame rate, the
 * decoded pixels, and whether the server still has the stream after Publish goes off.
 *
 * Runs in `chromium-gpu` only (the picture comes from the app's real WebGPU backend).
 *
 * ## The server
 *
 * `mediamtx` from PATH (or `LOOM_MEDIAMTX`), started by this file on ports of its own and
 * bound to loopback, so a MediaMTX the owner runs on the default ports is not touched.
 * Without the binary this FAILS, by name; it never skips (`brew install mediamtx`).
 *
 * ## Why the pixel assertions are bands and the size is exact
 *
 * The picture is a Checker of black and saturated red, 8 × 8 over the frame. H.264 is
 * lossy and goes through limited-range YCbCr, so a decoded red is near (250, 5, 5), not
 * (255, 0, 0): a probe at a cell's centre is asserted as "this channel above 180, the
 * others below 80", which no codec error reaches from the wrong colour. The cells pin the
 * orientation on both axes: cell (0,0) is Color 1 (black), (1,0) and (0,1) are Color 2.
 * The decoded size is the node's Width × Height exactly.
 */

const HTTP_PORT = 18889;
const ICE_PORT = 18189;
const API_PORT = 19997;
const SERVER = `http://127.0.0.1:${String(HTTP_PORT)}`;
/** A password only this file's throwaway server knows; it must never reach a saved project. */
const LOGIN_PASS = "whip-e2e-only-9f3a";

test.use({ viewport: APP_VIEWPORT });
test.describe.configure({ mode: "serial" });

let server: ChildProcess | undefined;
let workDir = "";
let serverLog = "";

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "loom-whip-"));
  const config = join(workDir, "mediamtx.yml");
  writeFileSync(config, [
    "logLevel: info",
    "api: yes", `apiAddress: 127.0.0.1:${String(API_PORT)}`,
    "metrics: no", "pprof: no", "playback: no", "rtsp: no", "rtmp: no", "hls: no", "srt: no", "moq: no",
    "webrtc: yes", `webrtcAddress: 127.0.0.1:${String(HTTP_PORT)}`,
    `webrtcLocalUDPAddress: 127.0.0.1:${String(ICE_PORT)}`, "webrtcLocalTCPAddress: ''",
    "webrtcIPsFromInterfaces: no", "webrtcAdditionalHosts: [127.0.0.1]",
    // Anyone may publish and read, except on `loom-e2e-login`, which only "wall" may publish.
    "authInternalUsers:",
    "  - user: any", "    permissions:", "      - action: read", "      - action: api",
    "      - action: publish", "        path: '~^loom-e2e(-60|-busy)?$'",
    "  - user: wall", `    pass: ${LOGIN_PASS}`, "    permissions:", "      - action: publish", "        path: loom-e2e-login",
    "paths:", "  all_others:", "",
  ].join("\n"));
  const binary = process.env["LOOM_MEDIAMTX"] ?? "mediamtx";
  const child = spawn(binary, [config], { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });
  server = child;
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = new Error(`WHIP Out needs a MediaMTX to publish into and "${binary}" did not start (${error.message}). Install it (brew install mediamtx) or set LOOM_MEDIAMTX.`);
  });
  child.stdout.on("data", (chunk: Buffer) => { serverLog += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { serverLog += chunk.toString(); });
  await expect.poll(() => {
    if (failure !== undefined) throw failure;
    if (child.exitCode !== null) throw new Error(`MediaMTX exited at once:\n${serverLog}`);
    return /\[WebRTC\] started/.test(serverLog) && /\[API\] started/.test(serverLog);
  }, { timeout: 10_000 }).toBe(true);
});

test.afterAll(() => {
  server?.kill();
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

interface ServerPath { readonly name: string; readonly ready: boolean; readonly tracks: readonly string[] }
/** What the server itself says about a path: a publisher on it right now, and its tracks. */
async function serverPath(name: string): Promise<ServerPath | undefined> {
  const response = await fetch(`http://127.0.0.1:${String(API_PORT)}/v3/paths/list`);
  const body = await response.json() as { items: readonly ServerPath[] };
  return body.items.find((item) => item.name === name);
}
const pathReady = async (name: string): Promise<boolean> => (await serverPath(name))?.ready === true;

interface Fixture {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly bitrate: number;
  /**
   * "checker": black and red cells through a Hue Offset. "cycling": the same with the hue
   * turning a quarter turn a second, so every frame differs. "noise": a new field every
   * frame, which no bitrate here can carry.
   */
  readonly picture: "checker" | "cycling" | "noise";
  /** H.264 profile; the node's default (High) when absent. */
  readonly profile?: string;
  /** Key frame every, in seconds; the node's default (0, the server asks) when absent. */
  readonly keyInterval?: number;
  readonly audio?: boolean;
}

/** The project, built through the real bus and the real save path; returns the WHIP Out's id. */
async function projectFile(fixture: Fixture): Promise<{ text: string; whip: string; hsv: string | undefined }> {
  const store = createGraphStore();
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const source = fixture.picture !== "noise"
    ? [
        { op: "addNode" as const, ref: "$src", type: "checker", label: "checker_cells", position: { x: 0, y: 0 }, parameters: { color2: [1, 0, 0, 1] } },
        { op: "addNode" as const, ref: "$pic", type: "hsv", label: "hsv_shift", position: { x: 350, y: 0 },
          parameters: fixture.picture === "cycling" ? { hueoffset: expressionSlot("fract(time / 4) * 360 - 180", 0) } : {} },
        { op: "connect" as const, source: { nodeId: "$src", portId: "out" }, target: { nodeId: "$pic", portId: "input" } },
      ]
    : [
        { op: "addNode" as const, ref: "$pic", type: "noise", label: "noise_busy", position: { x: 350, y: 0 },
          parameters: { period: 0.01, seed: expressionSlot("floor(time * 60)", 1) } },
      ];
  const result = await bus.execute("graph.applyPatch", {
    baseRevision: store.view.getGraph().revision,
    operations: [
      ...source,
      { op: "addNode", ref: "$out", type: "output", label: "output_main", position: { x: 700, y: 0 } },
      { op: "addNode", ref: "$whip", type: WHIP_OUT_TYPE, label: "whipout_wall", position: { x: 700, y: 400 },
        parameters: { server: SERVER, path: fixture.path, width: fixture.width, height: fixture.height, frameRate: fixture.frameRate, bitrate: fixture.bitrate,
          ...(fixture.profile === undefined ? {} : { profile: fixture.profile }),
          ...(fixture.keyInterval === undefined ? {} : { keyInterval: fixture.keyInterval }),
          ...(fixture.audio === undefined ? {} : { audio: fixture.audio }) } },
      { op: "connect", source: { nodeId: "$pic", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
      { op: "connect", source: { nodeId: "$pic", portId: "out" }, target: { nodeId: "$whip", portId: "input" } },
    ],
    label: "WHIP Out fixture",
  }, { actor: { kind: "system", id: "whip-test" }, projectId: "whip-test", capabilities: [] });
  expect(result.status).toBe("applied");
  const graph = store.view.getGraph();
  const idOf = (type: string): string | undefined => Object.values(graph.nodes).find((node) => node.type === type)?.id;
  const project = exampleDocument("whip-test", "WHIP Out fixture", exampleSettings({ outputResolution: { width: 1280, height: 720 } }), graph);
  const file = buildProjectFile({ document: project, now: () => project.updatedAt });
  return { text: file.text, whip: idOf(WHIP_OUT_TYPE)!, hsv: idOf("hsv") };
}

async function openProject(page: Page, text: string): Promise<void> {
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: "whip-test.loom.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.getByTestId("viewer-canvas")).toBeVisible();
}

/**
 * The subscriber: a page that pulls the path over WHEP and plays it in a `<video>`. It
 * records, per PRESENTED frame, the wall clock and the colour at the centre of cell (1,0).
 */
async function subscribe(reader: Page, path: string): Promise<void> {
  // A page the dev server really serves, not a routed one: Chromium asks for the local
  // network permission when a page whose own address it cannot place fetches a loopback
  // address, and refuses in a headless run ("access the `loopback` address space").
  await reader.goto("/src/tests/e2e/whep-reader-fixture.html");
  await reader.evaluate(async (url) => {
    const state = (window as unknown as { whep: Record<string, unknown> }).whep = {} as Record<string, unknown>;
    const pc = new RTCPeerConnection();
    pc.addTransceiver("video", { direction: "recvonly" });
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    document.body.append(video);
    pc.addEventListener("track", (event) => {
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void video.play();
    });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") resolve();
      else {
        setTimeout(resolve, 1500);
        pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") resolve(); });
      }
    });
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/sdp" }, body: pc.localDescription?.sdp ?? "" });
    if (!response.ok) throw new Error(`WHEP ${String(response.status)}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
    const probe = document.createElement("canvas");
    const draw = probe.getContext("2d", { willReadFrequently: true })!;
    /** The decoded colour at a point given as a fraction of the frame. */
    probe.width = probe.height = 1;
    // One texel, copied alone: a whole 1080p frame read back per presented frame would
    // load the machine the measurement is made on.
    const at = (u: number, v: number): number[] => {
      draw.drawImage(video, Math.floor(u * video.videoWidth), Math.floor(v * video.videoHeight), 1, 1, 0, 0, 1, 1);
      return [...draw.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const frames: Array<{ at: number; rgb: number[] }> = [];
    const onFrame = (): void => {
      if (video.videoWidth > 0) frames.push({ at: Date.now(), rgb: at(1.5 / 8, 0.5 / 8) });
      if (frames.length > 2000) frames.splice(0, 1000);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    Object.assign(state, { pc, video, at, frames });
  }, `${SERVER}/${path}/whep`);
}

interface Received { readonly frames: number; readonly keys: number; readonly bytes: number; readonly at: number }
const received = (reader: Page): Promise<Received> =>
  reader.evaluate(async () => {
    const { pc } = (window as unknown as { whep: { pc: RTCPeerConnection } }).whep;
    let out = { frames: 0, keys: 0, bytes: 0, at: performance.now() };
    (await pc.getStats()).forEach((entry: { type?: string; kind?: string; framesDecoded?: number; keyFramesDecoded?: number; bytesReceived?: number }) => {
      if (entry.type === "inbound-rtp" && entry.kind === "video") {
        out = { frames: entry.framesDecoded ?? 0, keys: entry.keyFramesDecoded ?? 0, bytes: entry.bytesReceived ?? 0, at: performance.now() };
      }
    });
    return out;
  });

/** Decoded frames per second, key frames decoded and received kbit/s over `seconds`, from the subscriber's own statistics. */
async function measure(reader: Page, seconds: number): Promise<{ fps: number; kbps: number; keys: number }> {
  const before = await received(reader);
  await reader.waitForTimeout(seconds * 1000);
  const after = await received(reader);
  const elapsed = (after.at - before.at) / 1000;
  return { fps: (after.frames - before.frames) / elapsed, kbps: ((after.bytes - before.bytes) * 8) / 1000 / elapsed, keys: after.keys - before.keys };
}

const size = (reader: Page): Promise<[number, number]> =>
  reader.evaluate(() => {
    const { video } = (window as unknown as { whep: { video: HTMLVideoElement } }).whep;
    return [video.videoWidth, video.videoHeight] as [number, number];
  });
const colourAt = (reader: Page, u: number, v: number): Promise<number[]> =>
  reader.evaluate(([x, y]) => (window as unknown as { whep: { at(u: number, v: number): number[] } }).whep.at(x!, y!), [u, v]);

const isBlack = (rgb: number[]): boolean => rgb.every((channel) => channel < 80);
const isRed = (rgb: number[]): boolean => rgb[0]! > 180 && rgb[1]! < 80 && rgb[2]! < 80;
const isGreen = (rgb: number[]): boolean => rgb[1]! > 180 && rgb[0]! < 80 && rgb[2]! < 80;

test("a subscriber decodes Loom's picture at 1920×1080 and 30 fps, follows a change, and loses the stream when Publish goes off", async ({ page, context }) => {
  test.setTimeout(120_000);
  // Baseline: the profile this machine encodes in hardware. The rate below is asserted, and
  // Constrained Baseline's software encoder does not hold it on a shared machine (see there).
  const fixture: Fixture = { path: "loom-e2e", width: 1920, height: 1080, frameRate: 30, bitrate: 6000, picture: "checker", profile: "baseline" };
  const file = await projectFile(fixture);
  await openProject(page, file.text);
  // The server has a publisher on the path: the stream is up without a click in the app.
  await expect.poll(() => pathReady(fixture.path), { timeout: 30_000 }).toBe(true);

  const reader = await context.newPage();
  await subscribe(reader, fixture.path);
  await expect.poll(() => size(reader), { timeout: 20_000 }).toEqual([1920, 1080]);

  // Audio is off by default: video is all the server is sent.
  expect((await serverPath(fixture.path))?.tracks).toEqual(["H264"]);

  // The picture, with its orientation: Color 1 at the top left, Color 2 right of it and below it.
  await expect.poll(async () => isBlack(await colourAt(reader, 0.5 / 8, 0.5 / 8)), { timeout: 10_000 }).toBe(true);
  expect(isRed(await colourAt(reader, 1.5 / 8, 0.5 / 8)), "cell (1,0) is Color 2").toBe(true);
  expect(isRed(await colourAt(reader, 0.5 / 8, 1.5 / 8)), "cell (0,1) is Color 2").toBe(true);
  expect(isBlack(await colourAt(reader, 1.5 / 8, 1.5 / 8)), "cell (1,1) is Color 1").toBe(true);

  /*
   * The rate the subscriber decodes, in steady state (a subscriber joining asks for a key
   * frame, and the encoder drops a few frames around it). 30 asked for; measured 29.7 and
   * 29.9 with this profile. A band, because both ends are on wall clocks.
   * Constrained Baseline is encoded in software by this Chromium on this Mac and
   * delivered 24.5 to 29.7 here at a load average of 4 to 10 while the capture ran at
   * 29.9 to 30.2 (§T1815b): too loose to assert a rate on, so it is not used for this.
   */
  await reader.waitForTimeout(4000);
  const rate = await measure(reader, 4);
  console.log(`[whip-out] 1920x1080@30 static checker: ${rate.fps.toFixed(1)} fps, ${rate.kbps.toFixed(0)} kbit/s received`);

  // The node says what it measured, on the node.
  await page.bringToFront();
  await selectNode(page, file.whip);
  await expect(page.locator('[data-whip-state="live"]')).toContainText(`${SERVER}/${fixture.path}/whip`);
  await expect(page.locator("[data-whip-measured]")).toContainText("1920×1080");
  await expect(page.locator("[data-whip-measured]")).toContainText("H.264 Baseline");
  console.log(`[whip-out] the node reports: ${await page.locator("[data-whip-measured]").innerText()}`);
  expect(rate.fps).toBeGreaterThan(27);
  expect(rate.fps).toBeLessThan(33);

  // A change in the graph reaches the glass: Hue Offset 120° turns the red cells green.
  // The delay is from the key that commits the edit to the first green frame PRESENTED by
  // the subscriber: Loom's own frame, capture, encode, the server, jitter buffer, decode.
  await selectNode(page, file.hsv!);
  const field = page.getByLabel("Hue Offset", { exact: true }).first();
  await field.click();
  await field.fill("120");
  await page.evaluate(() => {
    window.addEventListener("keydown", (event) => {
      if (event.key === "Enter") (window as unknown as { committedAt: number }).committedAt = Date.now();
    }, { capture: true, once: true });
  });
  await field.press("Enter");
  const committedAt = await page.evaluate(() => (window as unknown as { committedAt: number }).committedAt);
  const firstGreen = (): Promise<number | null> =>
    reader.evaluate(() => {
      const { frames } = (window as unknown as { whep: { frames: Array<{ at: number; rgb: number[] }> } }).whep;
      return frames.find((frame) => frame.rgb[1]! > 180 && frame.rgb[0]! < 80)?.at ?? null;
    });
  await expect.poll(firstGreen, { timeout: 10_000 }).not.toBeNull();
  const delay = (await firstGreen())! - committedAt;
  console.log(`[whip-out] ${String(delay)} ms from the committing key to the first changed frame presented by the subscriber`);
  expect(isGreen(await colourAt(reader, 1.5 / 8, 0.5 / 8))).toBe(true);
  expect(isBlack(await colourAt(reader, 0.5 / 8, 0.5 / 8))).toBe(true);
  // Live, not buffered: a second is ten times what was measured when this was written.
  expect(delay).toBeGreaterThan(0);
  expect(delay).toBeLessThan(1500);

  // Publish off: the session is ended at the server, not left to time out.
  await selectNode(page, file.whip);
  await page.getByRole("switch", { name: "Publish", exact: true }).click();
  await expect.poll(() => pathReady(fixture.path), { timeout: 5_000 }).toBe(false);
  await expect(page.locator('[data-whip-state="off"]')).toBeVisible();
});

/** How many different colours the subscriber presented at cell (1,0) since `since` (wall clock). */
const coloursSince = (reader: Page, since: number): Promise<number> =>
  reader.evaluate((from) => {
    const { frames } = (window as unknown as { whep: { frames: Array<{ at: number; rgb: number[] }> } }).whep;
    return new Set(frames.filter((frame) => frame.at >= from).map((frame) => frame.rgb.join(","))).size;
  }, since);

test("60 fps with a hardware profile: a subscriber decodes far more than thirty different frames a second, and a key frame every second", async ({ page, context }) => {
  test.setTimeout(120_000);
  const fixture: Fixture = { path: "loom-e2e-60", width: 1920, height: 1080, frameRate: 60, bitrate: 6000, picture: "cycling", profile: "high", keyInterval: 1 };
  const file = await projectFile(fixture);
  await openProject(page, file.text);
  await expect.poll(() => pathReady(fixture.path), { timeout: 30_000 }).toBe(true);
  const reader = await context.newPage();
  await subscribe(reader, fixture.path);
  await expect.poll(() => size(reader), { timeout: 20_000 }).toEqual([1920, 1080]);
  await reader.waitForTimeout(4000);
  const since = Date.now();
  const rate = await measure(reader, 6);
  const colours = await coloursSince(reader, since);
  console.log(`[whip-out] 1920x1080@60 High, cycling hue: ${rate.fps.toFixed(1)} fps, ${rate.kbps.toFixed(0)} kbit/s, ${String(rate.keys)} key frames and ${String(colours)} distinct colours in 6 s`);
  await page.bringToFront();
  await selectNode(page, file.whip);
  await expect(page.locator("[data-whip-measured]")).toContainText("H.264 High");
  /*
   * 60 asked for. On this shared machine, with this page decoding 1080p beside the app
   * that encodes it, 45.6 to 59.3 arrived with the load (§T1815b: in the slow runs the
   * capture itself delivered 48 to 56 of 60 to the hardware encoder). The floor is what no 30 fps stream can reach; with
   * Constrained Baseline (software on this Mac) the same test decodes 11 to 14.
   */
  expect(rate.fps).toBeGreaterThan(40);
  expect(rate.fps).toBeLessThan(66);
  // DIFFERENT frames: the hue turns 90° a second, so a repeated or frozen picture shows a
  // handful of colours where a live one shows hundreds.
  expect(colours).toBeGreaterThan(100);
  // Key frame every 1 s, set above (the node's default is 0). The server alone asks about every 2 s,
  // which is 3 in this window; the node's own clock makes it 6.
  expect(rate.keys).toBeGreaterThanOrEqual(5);
});

test("a picture the Bitrate cannot carry keeps its frame rate and stays under the Bitrate, and the node says what size was sent", async ({ page, context }) => {
  test.setTimeout(120_000);
  const fixture: Fixture = { path: "loom-e2e-busy", width: 1920, height: 1080, frameRate: 30, bitrate: 6000, picture: "noise", audio: true };
  const file = await projectFile(fixture);
  await openProject(page, file.text);
  await expect.poll(() => pathReady(fixture.path), { timeout: 30_000 }).toBe(true);
  const reader = await context.newPage();
  await subscribe(reader, fixture.path);
  await expect.poll(async () => (await size(reader))[0], { timeout: 20_000 }).toBeGreaterThan(0);
  // Audio is on: the server lists an Opus track beside the video (its content is not read here).
  expect((await serverPath(fixture.path))?.tracks).toEqual(["H264", "Opus"]);
  // Let the encoder's rate control settle on the cap before reading it.
  await reader.waitForTimeout(5000);
  const rate = await measure(reader, 5);
  const [width, height] = await size(reader);
  console.log(`[whip-out] 1920x1080@30 noise: ${String(width)}x${String(height)}, ${rate.fps.toFixed(1)} fps, ${rate.kbps.toFixed(0)} kbit/s received`);
  /*
   * The frame rate is what holds (T1815b): a new noise field every frame wants far more
   * than 6 Mbit/s, and the encoder pays in size, never above the size asked for and at its
   * shape. Under "keep the size" the same picture arrived at 6.4 to 8.8 fps.
   */
  expect(rate.fps).toBeGreaterThan(24);
  expect(width).toBeLessThanOrEqual(1920);
  expect(width * 9).toBe(height * 16);
  expect(rate.kbps).toBeLessThan(fixture.bitrate * 1.25);
  // The node does not claim the size it was asked for: it reports the one that was sent.
  await page.bringToFront();
  await selectNode(page, file.whip);
  // (Polled against the size the subscriber has NOW: the encoder moves between sizes.)
  await expect.poll(async () => {
    const [w, h] = await size(reader);
    return ((await page.locator("[data-whip-measured]").textContent()) ?? "").includes(`${String(w)}×${String(h)}`);
  }, { timeout: 15_000 }).toBe(true);
});

test("a server that asks for a login: the node says so, a token typed on the node gets it in, and the saved project does not hold it", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture: Fixture = { path: "loom-e2e-login", width: 640, height: 360, frameRate: 30, bitrate: 2000, picture: "checker" };
  const file = await projectFile(fixture);
  await openProject(page, file.text);
  await selectNode(page, file.whip);
  // Refused, and said so on the node; the server has no publisher.
  await expect(page.locator('[data-whip-state="retrying"]')).toContainText("refused the login (401)");
  expect(await pathReady(fixture.path)).toBe(false);

  // MediaMTX reads a bearer token as user:pass for its internal users.
  const token = page.getByLabel("Token", { exact: true });
  await token.fill(`wall:${LOGIN_PASS}`);
  await token.press("Enter");
  await expect.poll(() => pathReady(fixture.path), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('[data-whip-state="live"]')).toBeVisible();
  // The section shows that a token is held, never the token.
  await expect(page.getByRole("button", { name: "Forget token", exact: true })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(LOGIN_PASS);

  // Saved while live with the token in use: the file does not contain it.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-save").click();
  const saved = await (await download).createReadStream();
  let text = "";
  for await (const chunk of saved) text += String(chunk);
  expect(JSON.parse(text)).toBeTruthy();
  expect(text).toContain(fixture.path);
  expect(text).not.toContain(LOGIN_PASS);

  // Forgotten: the session ends at the server and the login is refused again.
  await page.keyboard.press("Escape");
  await selectNode(page, file.whip);
  await page.getByRole("button", { name: "Forget token", exact: true }).click();
  await expect.poll(() => pathReady(fixture.path), { timeout: 10_000 }).toBe(false);
  await expect(page.locator('[data-whip-state="retrying"]')).toContainText("refused the login (401)");
});
