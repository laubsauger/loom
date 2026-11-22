/* global require, module, process, console, setTimeout, clearTimeout, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, session, dialog, ipcMain, sharedTexture, systemPreferences, shell } = require('electron');
const { isAbsolute, join } = require('node:path');
const { webPreferences, validateOrigin, allowNavigation, allowPopup, performWindowOptions } = require('./policy.cjs');
const { installFilePermissions } = require('./file-permissions.cjs');
const { installUnloadGate } = require('./unload-gate.cjs');
const origin = validateOrigin(process.env.LOOM_DESKTOP_URL);
const { createMarigoldExecutor } = require('../devices/native/marigold-executor.mjs');
const marigoldDirectory = process.env.LOOM_MARIGOLD_DIRECTORY ?? join(__dirname, '../../.cache/marigold-v2');
const nativePreparation = require('./native-preparation.cjs').installNativePreparation({ ipcMain, origin,
  executor: createMarigoldExecutor({ executable: join(marigoldDirectory, 'runtime/loom-marigold'),
    assetsDirectory: join(marigoldDirectory, 'models'), manifest: require('../devices/native/marigold-model-manifest.json') }),
});
const nativeOutput = process.env.LOOM_NATIVE_OUTPUT_ADDON
  ? require('./native-output.cjs').installNativeOutput(require(process.env.LOOM_NATIVE_OUTPUT_ADDON), origin) : null;
if (Boolean(nativeOutput) !== Boolean(process.env.LOOM_NATIVE_INPUT_ADDON))
  throw new Error('Desktop native video requires both input and output addons');
const nativeInput = process.env.LOOM_NATIVE_INPUT_ADDON
  ? require('./native-input.cjs').installNativeInput({ ipcMain, sharedTexture,
    native: require(process.env.LOOM_NATIVE_INPUT_ADDON), origin }) : null;
let nativeInference = null;
let nativeNdiInput = null;
let nativeNdiOutput = null;
const inferenceReady = process.env.LOOM_NATIVE_VISION_DIRECTORY
  ? Promise.all([import('../devices/native/vision-workers.mjs'), import('../devices/native/depth-models.mjs')])
    .then(([{ createVisionWorkers }, { createDepthModels }]) => {
      const directory = process.env.LOOM_NATIVE_VISION_DIRECTORY;
      const native = require(join(directory, 'vision-client.node'));
      const python = process.env.LOOM_NATIVE_PYTHON ? { python: process.env.LOOM_NATIVE_PYTHON } : {};
      const workers = createVisionWorkers({ directory, library: join(directory, 'vision-service.dylib'), native, ...python });
      // T1818b: Depth Pro 2 rides the same client, launcher and capture. Below macOS 15
      // its service is not built, and the probe says why instead of failing startup.
      const library = join(directory, 'depth-service.dylib');
      const depth = { workers: createVisionWorkers({ kind: 'depth', directory, library, native, ...python }),
        models: createDepthModels({ directory: process.env.LOOM_DEPTH_PRO2_DIRECTORY ?? join(__dirname, '../../.cache/depthpro2-coreml'),
          manifest: require('../devices/native/depth-model-manifest.json'), compiler: join(directory, 'depth-compile'), library }) };
      nativeInference = require('./native-inference.cjs').installNativeInference({ ipcMain, BrowserWindow, sharedTexture,
        workers, depth, origin });
    }) : Promise.resolve();
// Read-only main-process test seam; never exposed through renderer IPC/preload.
module.exports.nativeOutputDiagnostics = () => [...(nativeOutput?.diagnostics() ?? []), ...(nativeNdiOutput?.diagnostics() ?? [])];
module.exports.nativeInputDiagnostics = () => [...(nativeInput?.diagnostics() ?? []), ...(nativeNdiInput?.diagnostics() ?? [])];
module.exports.nativeInferenceDiagnostics = () => nativeInference?.diagnostics() ?? [];
module.exports.nativePreparationDiagnostics = () => nativePreparation.diagnostics();
app.on('before-quit', event => {
  if (nativePreparation.diagnostics().length === 0) return;
  event.preventDefault();
  void nativePreparation.dispose().then(() => app.quit()).catch(error => fail(String(error)));
});
app.on('will-quit', () => {
  const pending = nativeInput?.dispose();
  if (pending?.length) console.error('LOOM_NATIVE_INPUT_PENDING_SHUTDOWN', JSON.stringify(pending));
  const ndi = nativeNdiInput?.dispose();
  if (ndi?.length) console.error('LOOM_NDI_INPUT_PENDING_SHUTDOWN', JSON.stringify(ndi));
  const inference = nativeInference?.diagnostics();
  if (inference?.length) console.error('LOOM_NATIVE_INFERENCE_PENDING_SHUTDOWN', JSON.stringify(inference));
});
if (process.env.LOOM_NATIVE_NDI_ADDON && !nativeInput) throw new Error('NDI input requires the native desktop input host');
const appPreferences = { ...webPreferences, preload: join(__dirname, 'preload.cjs'),
  additionalArguments: [...(nativeOutput ? ['--loom-native-video'] : []), ...(process.env.LOOM_NATIVE_NDI_ADDON ? ['--loom-ndi-input'] : [])],
};
const profile = process.env.LOOM_DESKTOP_PROFILE;
if (!profile || !isAbsolute(profile)) throw new Error('An absolute desktop profile path is required');
app.setPath('userData', profile);
app.enableSandbox();
let failed = false;
const startup = setTimeout(() => fail('App window did not load within 60 seconds'), 60000);
async function fail(message) {
  if (failed) return;
  failed = true;
  clearTimeout(startup);
  console.error('LOOM_DESKTOP_FAILED', message);
  try { await nativePreparation.dispose(); }
  catch (error) { console.error('LOOM_NATIVE_PREPARATION_SHUTDOWN_FAILED', String(error)); }
  app.exit(1);
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!allowNavigation(url, origin)) {
      console.error('LOOM_DESKTOP_NAVIGATION_DENIED', url);
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!allowNavigation(url, origin)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(details => {
    if (details.frameName.startsWith('loom-native-output-')) {
      return { action: 'deny' }; // Native outputs are main-created, never popup-derived.
    }
    if (!allowPopup(details)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences, ...performWindowOptions(details) } };
  });
  contents.on('render-process-gone', (_event, details) => fail(JSON.stringify(details)));
});
app.on('child-process-gone', (_event, details) => fail(JSON.stringify(details)));
app.on('window-all-closed', () => { clearTimeout(startup); app.quit(); });
let started = false;
module.exports.startDesktop = () => {
  if (started) throw new Error('Desktop startup may run only once');
  started = true;
  return app.whenReady().then(async () => {
  await inferenceReady;
  const permissions = installFilePermissions({
    session: session.defaultSession, origin,
    notify: contents => contents.send('loom-permissions-changed'),
    // macOS has a separate OS consent gate. On other platforms Chromium's
    // getUserMedia path still enforces OS device/privacy policy after Loom consent.
    requestSystemAccess: mediaType => process.platform === 'darwin'
      ? systemPreferences.askForMediaAccess(mediaType) : Promise.resolve(true),
    confirm: async (contents, options) => {
      const parent = BrowserWindow.fromWebContents(contents);
      if (!parent || parent.isDestroyed()) return false;
      const result = await dialog.showMessageBox(parent, options);
      return result.response === 1;
    },
    report: message => console.error('LOOM_DESKTOP_PERMISSION', message),
  });
  session.defaultSession.registerPreloadScript({ type: 'frame', filePath: join(__dirname, 'permissions-preload.cjs') });
  const authorizePermissions = event => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== `${origin}/`)
      throw new Error('Permissions require the app main frame');
  };
  if (process.env.LOOM_NATIVE_NDI_ADDON) {
    const ndi = require(process.env.LOOM_NATIVE_NDI_ADDON);
    const beforeAccess = async event => {
      authorizePermissions(event);
      if (!await permissions.requestNdi(event.sender)) throw new Error('NDI local-network access denied');
    };
    nativeNdiInput = require('./native-input.cjs').installNativeInput({ ipcMain, sharedTexture,
      native: ndi.input, origin, transport: 'ndi', beforeAccess,
    });
    nativeNdiOutput = require('./native-output.cjs').installNativeOutput(ndi.output, origin, { transport: 'ndi', beforeAccess });
  }
  ipcMain.handle('loom-permissions-system-settings', async event => {
    authorizePermissions(event);
    if (process.platform !== 'darwin') throw new Error('Opening system permissions is not implemented on this platform');
    const error = await shell.openPath('/System/Applications/System Settings.app');
    if (error) throw new Error(`Cannot open System Settings: ${error}`);
  });
  ipcMain.handle('loom-permissions-list', event => {
    authorizePermissions(event);
    return permissions.snapshot(event.sender).map(entry => ({ ...entry,
      system: entry.id === 'ndi' ? 'managed-by-os'
        : entry.id !== 'speaker' && process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus(entry.id) : 'managed-by-browser',
    }));
  });
  const window = new BrowserWindow({ width: 1600, height: 1000, title: 'Loom Development', webPreferences: appPreferences });
  installUnloadGate({ window, inputs: {
    retireOwner: owner => Promise.all([nativePreparation.retireOwner(owner), nativeInput?.retireOwner(owner), nativeNdiInput?.retireOwner(owner),
      nativeOutput?.retireOwner(owner), nativeNdiOutput?.retireOwner(owner), nativeInference?.retireOwner(owner)]),
  }, onError: error => {
    console.error('LOOM_NATIVE_UNLOAD_FAILED', String(error));
    if (window.isDestroyed()) return; // The diagnostic is logged; no dialog can own a destroyed window.
    void dialog.showMessageBox(window, { type: 'error', message: 'Native processing could not close safely', detail: String(error) });
  } });
  await window.loadURL(`${origin}/`);
  clearTimeout(startup);
  console.log('LOOM_DESKTOP_LOADED', JSON.stringify({ origin, profile, electron: process.versions.electron }));
}).catch(error => fail(error.stack));
};
