/* global module, require, __dirname, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { ipcMain, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { webPreferences } = require('./policy.cjs');

function installNativeOutput(native, origin) {
  const outputs = new Map();
  ipcMain.handle('loom-native-output-frame-ready', event => {
    const output = [...outputs.values()].find(entry => entry.contents === event.sender && !entry.closed);
    if (!output || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Native frame readiness requires the owning output main frame');
    output.frameReady = true;
    output.contents.startPainting();
  });
  const authorize = event => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== `${origin}/`) throw new Error('Native output requires the app main frame');
  };
  const owned = (event, name) => {
    authorize(event);
    const output = outputs.get(name);
    if (!output || output.closed || output.owner !== event.sender) throw new Error('Native output is not owned by this renderer');
    return output;
  };
  ipcMain.handle('loom-native-output-status', (event, name) => {
    const { copied, dropped, error, size } = owned(event, name);
    return { copied, dropped, error, size, allocation: native.stats() };
  });
  const extent = (width, height) => {
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) throw new Error('Invalid native output dimensions');
  };
  ipcMain.handle('loom-native-output-open', async (event, name, width, height, publisherName) => {
    authorize(event);
    if (typeof name !== 'string' || !/^loom-native-output-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid native output session');
    extent(width, height);
    if (typeof publisherName !== 'string' || !publisherName.trim() || publisherName.length > 256 || publisherName.includes('\0')) throw new Error('Invalid Syphon publisher name');
    if ([...outputs.values()].some(output => output.publisherName === publisherName)) throw new Error('Syphon publisher name is already in use');
    if (outputs.has(name) || [...outputs.values()].filter(o => o.owner === event.sender).length >= 4) throw new Error('Native output session limit reached');
    const window = new BrowserWindow({ width, height, show: false, useContentSize: true,
      webPreferences: { ...webPreferences, preload: join(__dirname, 'output-preload.cjs'), backgroundThrottling: false,
        offscreen: { useSharedTexture: true, sharedTexturePixelFormat: 'argb', deviceScaleFactor: 1 } } });
    attach(event.sender, window, name, publisherName);
    try { await window.loadURL(`${origin}/src/desktop/output.html?name=${name}&width=${width}&height=${height}`); }
    catch (error) { window.close(); throw error; }
  });
  ipcMain.handle('loom-native-output-close', (event, name) => {
    authorize(event);
    if (!outputs.has(name)) return; // Close is intentionally idempotent after OS teardown.
    const output = outputs.get(name);
    if (output.owner !== event.sender) throw new Error('Native output is not owned by this renderer');
    if (!output.closed) owned(event, name).window.close();
    return output.drained; // Acknowledgment means no publisher or GPU lease remains.
  });
  ipcMain.handle('loom-native-output-resize', (event, name, width, height) => {
    extent(width, height);
    owned(event, name).window.setContentSize(width, height);
  });
  function attach(owner, window, name, publisherName) {
      if (outputs.has(name)) throw new Error('Duplicate native output name');
      const contents = window.webContents;
      contents.stopPainting();
      let finishDrain;
      const drained = new Promise(resolve => { finishDrain = resolve; });
      const output = { owner, window, contents, publisherName, drained, frameReady: false, copied: 0, dropped: 0, error: null, size: null, busy: false, closed: false };
      outputs.set(name, output);
      const finish = () => { native.stop(publisherName); outputs.delete(name); finishDrain(); };
      const retire = () => {
        if (output.closed) return;
        output.closed = true;
        // Keep the slot reserved until pending GPU work drains. Reusing its name
        // earlier would let an old completion stop the replacement publisher.
        if (!output.busy) finish();
        for (const [event, listener] of Object.entries(listeners)) owner.removeListener(event, listener);
        contents.removeListener('render-process-gone', close);
      };
      const close = () => { retire(); window.close(); };
      // Keep the old document's publisher alive during provisional navigation,
      // just like its inputs. Commit retires both; cancellation retires neither.
      const listeners = { destroyed: close, 'render-process-gone': close, 'did-navigate': close };
      for (const [event, listener] of Object.entries(listeners)) owner.on(event, listener);
      contents.on('render-process-gone', close);
      contents.on('console-message', event => { if (event.level === 'error') {
        output.error = event.message;
        console.error('LOOM_NATIVE_OUTPUT_ERROR', event.message);
      } });
      contents.on('paint', async event => {
        const texture = event.texture;
        // Initial window paints are not graph frames and must not advertise a
        // blank Syphon source while the renderer transport is still attaching.
        if (!output.frameReady) { texture?.release(); return; }
        if (!texture) { output.error = 'Native output returned no shared GPU texture'; return; }
        if (output.busy || output.closed || output.error) { texture.release(); output.dropped++; return; }
        output.busy = true;
        try {
          const info = texture.textureInfo;
          if (info.pixelFormat !== 'bgra') throw new Error(`Unsupported native SDR format: ${info.pixelFormat}`);
          await native.publish(info.handle.ioSurface, publisherName);
          output.copied++;
          output.size = [info.codedSize.width, info.codedSize.height];
        } catch (error) { output.error = String(error); }
        finally {
          texture.release(); output.busy = false;
          if (output.closed) finish();
        }
      });
      window.once('closed', retire);
  }
  return { attach };
}
module.exports = { installNativeOutput };
