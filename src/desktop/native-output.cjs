/* global module, require, __dirname, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { ipcMain, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { Buffer } = require('node:buffer');
const { webPreferences } = require('./policy.cjs');

function installNativeOutput(native, origin, { transport = 'syphon', beforeAccess } = {}) {
  if (transport !== 'syphon' && transport !== 'ndi') throw new Error('Unknown native output transport');
  if (transport === 'ndi' && typeof beforeAccess !== 'function') throw new Error('NDI output requires permission');
  const prefix = transport === 'ndi' ? 'loom-ndi-output' : 'loom-native-output';
  const label = transport === 'ndi' ? 'NDI' : 'Syphon';
  const outputs = new Map();
  const opening = new Map();
  const owners = new Map();
  const unwatchOwner = owner => {
    if ([...opening.values()].some(record => record.owner === owner) ||
        [...outputs.values()].some(record => record.owner === owner && !record.closed)) return;
    const listeners = owners.get(owner);
    if (!listeners) return;
    for (const [event, listener] of Object.entries(listeners)) owner.removeListener(event, listener);
    owners.delete(owner);
  };
  const watchOwner = owner => {
    if (owners.has(owner)) return;
    const cancel = () => {
      for (const record of opening.values()) if (record.owner === owner) record.cancelled = true;
    };
    const retire = () => {
      cancel();
      for (const record of [...outputs.values()]) if (record.owner === owner) record.close();
    };
    const listeners = { destroyed: retire, 'render-process-gone': retire, 'did-navigate': retire,
      'did-start-navigation': details => { if (details.isMainFrame && !details.isSameDocument) cancel(); } };
    owners.set(owner, listeners);
    for (const [event, listener] of Object.entries(listeners)) owner.on(event, listener);
  };
  ipcMain.handle(`${prefix}-frame-ready`, event => {
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
  ipcMain.handle(`${prefix}-status`, (event, name) => {
    const { copied, dropped, error, size } = owned(event, name);
    return { copied, dropped, error, size, allocation: native.stats() };
  });
  const extent = (width, height) => {
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) throw new Error('Invalid native output dimensions');
  };
  ipcMain.handle(`${prefix}-open`, async (event, name, width, height, publisherName) => {
    authorize(event);
    if (typeof name !== 'string' || !/^loom-native-output-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid native output session');
    extent(width, height);
    if (typeof publisherName !== 'string' || !publisherName.trim() || publisherName.length > 256 || publisherName.includes('\0')) throw new Error(`Invalid ${label} publisher name`);
    if (transport === 'ndi' && Buffer.byteLength(publisherName, 'utf8') > 128)
      throw new Error('Loom NDI publisher names are limited to 128 UTF8 bytes');
    if (transport === 'ndi' && /[\\/:*?"<>|]/.test(publisherName))
      throw new Error('NDI publisher name contains reserved characters');
    // A pending consent prompt owns capacity/name too; it cannot open a late window
    // after the owner document has left or evade the bounded publisher count.
    const reserved = [...outputs.values(), ...opening.values()].filter(output => !output.attached);
    if (reserved.some(output => output.publisherName === publisherName)) throw new Error(`${label} publisher name is already in use`);
    if (outputs.has(name) || opening.has(name) || reserved.filter(o => o.owner === event.sender).length >= 4)
      throw new Error('Native output session limit reached');
    const owner = event.sender;
    const pending = { owner, publisherName, cancelled: false, attached: false, promise: null };
    opening.set(name, pending);
    watchOwner(owner);
    pending.promise = (async () => {
      if (beforeAccess) await beforeAccess(event);
      if (pending.cancelled) throw new Error('Native output owner retired during open');
      authorize(event);
      const window = new BrowserWindow({ width, height, show: false, useContentSize: true,
        webPreferences: { ...webPreferences, preload: join(__dirname, 'output-preload.cjs'), backgroundThrottling: false,
          additionalArguments: transport === 'ndi' ? ['--loom-ndi-output'] : [],
          offscreen: { useSharedTexture: true, sharedTexturePixelFormat: 'argb', deviceScaleFactor: 1 } } });
      const output = attach(owner, window, name, publisherName);
      pending.attached = true;
      try {
        await window.loadURL(`${origin}/src/desktop/output.html?name=${name}&width=${width}&height=${height}`);
        if (pending.cancelled || output.closed) throw new Error('Native output owner retired during load');
      } catch (error) {
        output.close(); await output.acknowledge(); throw error;
      }
    })();
    try { await pending.promise; }
    finally {
      opening.delete(name);
      unwatchOwner(owner);
    }
  });
  const closeOutput = (event, name) => {
    authorize(event);
    if (!outputs.has(name)) return; // Close is intentionally idempotent after OS teardown.
    const output = outputs.get(name);
    if (output.owner !== event.sender) throw new Error('Native output is not owned by this renderer');
    if (!output.closed) owned(event, name).window.close();
    return output.acknowledge(); // Acknowledgment means no publisher or GPU lease remains.
  };
  ipcMain.handle(`${prefix}-close`, (event, name) => {
    authorize(event);
    const pending = opening.get(name);
    if (!pending) return closeOutput(event, name);
    if (pending.owner !== event.sender) throw new Error('Native output is not owned by this renderer');
    pending.cancelled = true;
    return Promise.allSettled([pending.promise]).then(() => closeOutput(event, name));
  });
  ipcMain.handle(`${prefix}-resize`, (event, name, width, height) => {
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
      let acknowledgment;
      output.acknowledge = () => acknowledgment ??= drained.then(error => { if (error) throw error; });
      outputs.set(name, output);
      let stopping = false;
      const finish = () => {
        if (stopping) return;
        stopping = true;
        const done = () => { outputs.delete(name); unwatchOwner(owner); finishDrain(null); };
        const failed = error => {
          output.error = `Native output stop failed: ${String(error)}`;
          console.error(output.error);
          finishDrain(error); // Keep the failed publisher reserved; never silently reuse it.
        };
        try {
          const stopped = native.stop(publisherName);
          if (stopped && typeof stopped.then === 'function') void stopped.then(done, failed);
          else done();
        } catch (error) { failed(error); }
      };
      const retire = () => {
        if (output.closed) return;
        output.closed = true;
        // Keep the slot reserved until pending GPU work drains. Reusing its name
        // earlier would let an old completion stop the replacement publisher.
        if (!output.busy) finish();
        unwatchOwner(owner);
        contents.removeListener('render-process-gone', close);
      };
      const close = () => { retire(); if (!window.isDestroyed()) window.close(); };
      output.close = close;
      // Keep the old document's publisher alive during provisional navigation,
      // just like its inputs. Commit retires both; cancellation retires neither.
      watchOwner(owner);
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
        } catch (error) {
          output.error = String(error);
          console.error('LOOM_NATIVE_OUTPUT_PUBLISH_FAILED', publisherName, output.error);
        }
        finally {
          texture.release(); output.busy = false;
          if (output.closed) finish();
        }
      });
      window.once('closed', retire);
      return output;
  }
  return { attach, async retireOwner(owner) {
    const pending = [...opening.values()].filter(record => record.owner === owner);
    for (const record of pending) record.cancelled = true;
    // Open rejection belongs to its caller. Settlement permits checking the
    // authoritative publisher records, whose failed drainage still rejects.
    await Promise.allSettled(pending.map(record => record.promise));
    const records = [...outputs.values()].filter(record => record.owner === owner);
    for (const record of records) record.close();
    await Promise.all(records.map(record => record.acknowledge()));
  }, diagnostics() {
    return [...outputs].map(([name, output]) => ({ name, publisherName: output.publisherName,
      frameReady: output.frameReady, busy: output.busy, closed: output.closed,
      copied: output.copied, dropped: output.dropped, error: output.error,
      size: output.size ? [...output.size] : null }));
  } };
}
module.exports = { installNativeOutput };
