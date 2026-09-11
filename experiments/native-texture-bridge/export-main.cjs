/* global require, process, console, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require('electron');
const oracle = require(process.env.LOOM_EXPORT_ADDON);
app.enableSandbox();
app.setPath('userData', process.env.LOOM_EXPORT_PROFILE);
let phase = -1;
let terminal = false;
let released = 0;
let busy = false;
const results = [];
const timeout = setTimeout(() => fail(`Export timeout at selection ${phase}`), 45000);
function fail(error) {
  if (terminal) return;
  terminal = true;
  clearTimeout(timeout);
  console.error('SELECTED_EXPORT_FAIL', String(error));
  app.exit(1);
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1920, height: 1080, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      offscreen: { useSharedTexture: true, sharedTexturePixelFormat: 'argb', deviceScaleFactor: 1 } } });
  const wc = win.webContents;
  wc.on('console-message', event => {
    if (event.level === 'error') fail(event.message);
  });
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', event => event.preventDefault());
  wc.on('will-redirect', event => event.preventDefault());
  wc.on('render-process-gone', (_event, details) => fail(JSON.stringify(details)));
  wc.on('paint', async (event) => {
    const texture = event.texture;
    if (!texture) return fail('No shared GPU texture in paint event');
    if (terminal || phase < 0 || busy) { texture.release(); released++; return; }
    busy = true;
    let match = false;
    try {
      const info = texture.textureInfo;
      if (info.pixelFormat !== 'bgra') throw new Error(`Unexpected format: ${info.pixelFormat}`);
      const samples = [...await oracle.inspect(info.handle.ioSurface)];
      if (terminal) return;
      const expected = Array.from({ length: 16 }, (_, i) =>
        i % 4 === 0 ? (phase === 1 ? 0 : 255) : i % 4 === 1 ? (i < 8 ? 0 : 188) : i % 4 === 2 ? (phase === 1 ? 255 : 0) : 255);
      match = samples.every((value, i) => Math.abs(value - expected[i]) <= 2);
      if (match) results.push({ phase, samples, pixelFormat: info.pixelFormat, size: info.codedSize, colorSpace: info.colorSpace });
    } catch (error) { fail(error.stack); }
    finally { texture.release(); released++; busy = false; }
    if (!match || terminal) return;
    phase++;
    if (phase === 3) {
      terminal = true;
      clearTimeout(timeout);
      wc.executeJavaScript('window.exportProbe.dispose()').then(() => {
        console.log('SELECTED_EXPORT_PASS', JSON.stringify({ electron: process.versions.electron, pid: process.pid, released, results }));
        app.exit(0);
      }).catch(error => { terminal = false; fail(error); });
    } else wc.executeJavaScript(`window.exportProbe.select(${phase})`).catch(fail);
  });
  await wc.loadURL(process.env.LOOM_EXPORT_URL);
  await wc.executeJavaScript("import('/experiments/native-texture-bridge/export-renderer.ts').then(() => true)");
  phase = 0;
  await wc.executeJavaScript('window.exportProbe.select(0)');
}).catch(fail);
