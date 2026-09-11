/* global require, module, process, console, setTimeout, clearTimeout, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, session, dialog, ipcMain, sharedTexture } = require('electron');
const { isAbsolute, join } = require('node:path');
const { webPreferences, validateOrigin, allowNavigation, allowPopup } = require('./policy.cjs');
const { installFilePermissions } = require('./file-permissions.cjs');
const { installUnloadGate } = require('./unload-gate.cjs');
const origin = validateOrigin(process.env.LOOM_DESKTOP_URL);
const nativeOutput = process.env.LOOM_NATIVE_OUTPUT_ADDON
  ? require('./native-output.cjs').installNativeOutput(require(process.env.LOOM_NATIVE_OUTPUT_ADDON), origin) : null;
if (Boolean(nativeOutput) !== Boolean(process.env.LOOM_NATIVE_INPUT_ADDON))
  throw new Error('Desktop native video requires both input and output addons');
const nativeInput = process.env.LOOM_NATIVE_INPUT_ADDON
  ? require('./native-input.cjs').installNativeInput({ ipcMain, sharedTexture,
    native: require(process.env.LOOM_NATIVE_INPUT_ADDON), origin }) : null;
// Read-only main-process test seam; never exposed through renderer IPC/preload.
module.exports.nativeInputDiagnostics = () => nativeInput?.diagnostics() ?? [];
app.on('will-quit', () => {
  const pending = nativeInput?.dispose();
  if (pending?.length) console.error('LOOM_NATIVE_INPUT_PENDING_SHUTDOWN', JSON.stringify(pending));
});
const appPreferences = nativeOutput ? { ...webPreferences, preload: join(__dirname, 'preload.cjs') } : webPreferences;
const profile = process.env.LOOM_DESKTOP_PROFILE;
if (!profile || !isAbsolute(profile)) throw new Error('An absolute desktop profile path is required');
app.setPath('userData', profile);
app.enableSandbox();
let failed = false;
const startup = setTimeout(() => fail('App window did not load within 60 seconds'), 60000);
function fail(message) {
  if (failed) return;
  failed = true;
  clearTimeout(startup);
  console.error('LOOM_DESKTOP_FAILED', message);
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
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences } };
  });
  contents.on('render-process-gone', (_event, details) => fail(JSON.stringify(details)));
});
app.on('child-process-gone', (_event, details) => fail(JSON.stringify(details)));
app.on('window-all-closed', () => { clearTimeout(startup); app.quit(); });
app.whenReady().then(async () => {
  installFilePermissions({
    session: session.defaultSession, origin,
    confirm: async (contents, options) => {
      const parent = BrowserWindow.fromWebContents(contents);
      if (!parent || parent.isDestroyed()) return false;
      const result = await dialog.showMessageBox(parent, options);
      return result.response === 1;
    },
    report: message => console.error('LOOM_DESKTOP_PERMISSION', message),
  });
  const window = new BrowserWindow({ width: 1600, height: 1000, title: 'Loom Development', webPreferences: appPreferences });
  if (nativeInput) installUnloadGate({ window, inputs: nativeInput, onError: error => {
    console.error('LOOM_NATIVE_UNLOAD_FAILED', String(error));
    if (window.isDestroyed()) return; // The diagnostic is logged; no dialog can own a destroyed window.
    void dialog.showMessageBox(window, { type: 'error', message: 'Native video could not close safely', detail: String(error) });
  } });
  await window.loadURL(`${origin}/`);
  clearTimeout(startup);
  console.log('LOOM_DESKTOP_LOADED', JSON.stringify({ origin, profile, electron: process.versions.electron }));
}).catch(error => fail(error.stack));
