/* global require, process, console, setTimeout, clearTimeout, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');
const { join } = require('node:path');
const native = require(process.env.SHADERLOOM_TEXTURE_ADDON);
app.setPath('userData', process.env.SHADERLOOM_PROOF_DATA);
let window;
let active;
let sequence = 0;
const results = [];
const rendererLoss = process.env.SHADERLOOM_PROOF_CHECK === 'renderer-loss';
const gpuLoss = process.env.SHADERLOOM_PROOF_CHECK === 'gpu-loss';
const earlyRelease = process.env.SHADERLOOM_PROOF_CHECK === 'early-release';
let gpuKilled = false;
let gpuGone = false;
let deviceLost = false;
function finishGpuLoss() {
  if (!gpuGone || !deviceLost || !active?.released) return;
  try {
    native.release();
    native.abort();
    console.log('NATIVE_TEXTURE_GPU_LOSS_PASS: submitted frame, GPU death, device loss, reference release, one producer acknowledgment');
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) { fail(error.stack); }
}
let rendererKilled = false;
let rendererGone = false;
function finishRendererLoss() {
  if (!rendererGone || !active?.released) return;
  try {
    native.release();
    native.abort();
    console.log('NATIVE_TEXTURE_RENDERER_LOSS_PASS: held frame released after renderer death; producer acknowledged once');
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) { fail(error.stack); }
}
let stage = 'waiting-for-app-ready';
function progress(next) {
  stage = next;
  console.log('NATIVE_TEXTURE_PROOF_STAGE', JSON.stringify({ stage, sequence, pid: process.pid }));
}
const watchdog = setTimeout(() => fail(`Timed out: ${stage}, frame ${sequence}, ${JSON.stringify(active)}`), 60000);

function fail(message) {
  console.error('NATIVE_TEXTURE_PROOF_FAILED', message);
  // Do not reclaim a surface possibly still in GPU use. Process teardown owns it.
  clearTimeout(watchdog);
  app.exit(1);
}

function advance() {
  if (!active?.released || !active?.result) return;
  try { native.release(); } catch (error) { fail(error.stack); return; }
  results.push(active.result);
  active = undefined;
  sequence++;
  if (sequence === 24) {
    let producerPid;
    try { producerPid = native.dispose(); } catch (error) { fail(error.stack); return; }
    const color = results.filter(r => r.format === 0);
    const data = results.filter(r => r.format === 1);
    console.log('NATIVE_TEXTURE_PROOF_RESULT', JSON.stringify({
      electron: process.versions.electron, chromium: process.versions.chrome,
      platform: process.platform, arch: process.arch, frames: results.length,
      producerPid, consumerPid: process.pid, producerReleaseAcks: results.length,
      allReferencesReleased: results.length, sandboxed: results.every(r => r.sandboxed),
      earlyReleases: results.filter(r => r.earlyReleased).length,
      colorMaxError: Math.max(...color.map(r => r.maxError)),
      floatMaxError: Math.max(...data.map(r => r.maxError)),
      floatSamples: data[0].samples, adapter: results[0].adapter,
      scope: 'Python/Metal producer -> XPC IOSurface capability -> Electron -> sandboxed WebGPU; not model inference or throughput',
    }));
    clearTimeout(watchdog);
    app.exit(results.every(r => r.sandboxed && r.earlyReleased === earlyRelease &&
      r.maxError < (r.format === 0 ? 0.01 : 0.005)) ? 0 : 2);
    return;
  }
  send().catch(error => fail(error.stack));
}

async function send() {
  if (active) throw new Error('Producer overrun');
  progress('producing');
  const format = sequence < 12 ? 0 : 1;
  active = { sequence, released: false, result: undefined };
  const handle = native.prepare(format, sequence);
  const imported = sharedTexture.importSharedTexture({
    textureInfo: {
      pixelFormat: format === 0 ? 'bgra' : 'rgbaf16',
      codedSize: { width: 64, height: 64 }, timestamp: sequence,
      // Identity sRGB->sRGB sampling probe, NOT a linear-light color pipeline.
      colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
      handle: { ioSurface: handle },
    },
    allReferencesReleased: () => {
      progress('references-released'); active.released = true;
      if (rendererLoss) finishRendererLoss(); else if (gpuLoss) finishGpuLoss(); else advance();
    },
  });
  try {
    progress('sending');
    await sharedTexture.sendSharedTexture({ frame: window.webContents.mainFrame,
      importedSharedTexture: imported }, { sequence, format,
      fault: rendererLoss ? 'renderer-loss' : gpuLoss ? 'gpu-loss' : earlyRelease ? 'early-release' : null });
  } finally {
    imported.release();
  }
}

app.whenReady().then(async () => {
  progress('app-ready');
  window = new BrowserWindow({ show: true, width: 360, height: 160,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!rendererLoss || !rendererKilled || details.reason !== 'killed') return fail(JSON.stringify(details));
    rendererGone = true;
    progress('renderer-killed');
    finishRendererLoss();
  });
  app.on('child-process-gone', (_event, details) => {
    if (!gpuLoss || !gpuKilled || gpuGone || details.type !== 'GPU' || details.reason !== 'killed')
      return fail(JSON.stringify(details));
    gpuGone = true;
    progress('gpu-killed');
    finishGpuLoss();
  });
  window.webContents.on('preload-error', (_event, _path, error) => fail(error.stack));
  window.webContents.on('did-fail-load', (_event, code, description) => fail(`Load failed ${code}: ${description}`));
  ipcMain.on('proof-failed', (_event, error) => fail(error));
  ipcMain.on('proof-submitted', (event, frame) => {
    if (!gpuLoss || gpuKilled || frame !== 0 || !active || active.released || event.sender !== window.webContents)
      return fail('Unexpected GPU-submitted signal');
    const processes = app.getAppMetrics().filter(metric => metric.type === 'GPU');
    if (processes.length !== 1 || processes[0].pid <= 0 || processes[0].pid === process.pid)
      return fail('Expected exactly one owned GPU child');
    gpuKilled = true;
    console.log('NATIVE_TEXTURE_GPU_KILL', JSON.stringify(processes[0]));
    process.kill(processes[0].pid, 'SIGKILL');
  });
  ipcMain.on('proof-device-lost', (event, frame) => {
    if (!gpuLoss || !gpuKilled || deviceLost || frame !== 0 || event.sender !== window.webContents)
      return fail('Unexpected device-loss signal');
    deviceLost = true;
    progress('device-lost');
    finishGpuLoss();
  });
  ipcMain.on('proof-renderer-released', (event, frame) => {
    if (!gpuLoss || !deviceLost || frame !== 0 || event.sender !== window.webContents)
      return fail('Unexpected renderer-release signal');
    progress('renderer-references-explicitly-released');
  });
  ipcMain.on('proof-held', (event, frame) => {
    if (!rendererLoss || rendererKilled || frame !== 0 || event.sender !== window.webContents)
      return fail('Unexpected held-frame signal');
    const pid = window.webContents.getOSProcessId();
    if (pid <= 0 || pid === process.pid) return fail('Invalid renderer PID');
    rendererKilled = true;
    process.kill(pid, 'SIGKILL');
  });
  ipcMain.on('proof-ready', () => { progress('renderer-ready'); send().catch(error => fail(error.stack)); });
  ipcMain.on('proof-result', (_event, result) => {
    if (!active || active.result || result.sequence !== active.sequence) return fail('Unexpected frame result');
    active.result = result;
    progress('pixels-checked');
    advance();
  });
  progress('loading-renderer');
  await window.loadFile(join(__dirname, 'index.html'));
}).catch(error => fail(error.stack));
