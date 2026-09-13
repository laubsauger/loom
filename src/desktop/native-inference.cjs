/* global require, module, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { join } = require('node:path');
const timers = require('node:timers');
const { webPreferences } = require('./policy.cjs');

/** Main owns capture, Python session and imported result until GPU-aware ACK. */
function installNativeInference({ ipcMain, BrowserWindow, sharedTexture, workers, origin }) {
  const records = new Map();
  const authorize = event => {
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== `${origin}/`)
      throw new Error('Native inference requires the app main frame');
  };
  const owned = (event, name) => {
    authorize(event);
    const record = records.get(name);
    if (!record || record.owner !== event.sender || record.frame !== event.senderFrame)
      throw new Error('Native inference session is not owned by this renderer');
    return record;
  };
  const extent = values => {
    if (!values.every(value => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error('Invalid native inference extent');
  };
  const changed = record => { for (const fn of [...record.waiters]) fn(); };
  const fault = (record, error) => {
    record.error ??= String(error);
    timers.clearTimeout(record.pending?.timer);
    record.pending?.reject(error instanceof Error ? error : new Error(String(error)));
    record.pending = null;
    changed(record);
  };
  const completed = record => {
    if (record.busy || record.lease || record.quarantined) return;
    timers.clearTimeout(record.pending?.timer);
    record.pending?.resolve({ kind: 'completed' }); record.pending = null;
    changed(record);
  };
  async function release(record, lease) {
    if (lease.releasing) { fault(record, new Error('Duplicate native inference GPU release')); return; }
    lease.releasing = true;
    try {
      await record.worker.release(lease.result.sequence);
      if (record.lease === lease) record.lease = null;
      completed(record);
    } catch (error) { record.quarantined = true; fault(record, error); }
  }
  function close(record) {
    if (record.closing) return record.closing;
    record.closed = true;
    if (record.window && !record.window.isDestroyed()) record.window.webContents.stopPainting();
    if (!record.busy && !record.lease) {
      timers.clearTimeout(record.pending?.timer);
      record.pending?.resolve({ kind: 'closed' });
      record.pending = null;
    }
    record.closing = (async () => {
      await record.opening;
      await new Promise((resolve, reject) => {
        const done = error => { timers.clearTimeout(timer); record.waiters.delete(check); if (error) reject(error); else resolve(); };
        const check = () => {
          if (record.quarantined) done(new Error(record.error ?? 'Native inference retains uncertain GPU leases'));
          else if (!record.busy && !record.lease) done();
        };
        const timer = timers.setTimeout(() => done(new Error('Native inference GPU drainage timed out')), 15000);
        record.waiters.add(check); check();
      });
      await record.worker.close();
      if (record.window && !record.window.isDestroyed()) record.window.close();
      for (const [event, listener] of Object.entries(record.listeners)) record.owner.removeListener(event, listener);
      records.delete(record.name);
    })();
    return record.closing;
  }
  ipcMain.handle('loom-native-vision-open', async (event, name, inputWidth, inputHeight, outputWidth, outputHeight) => {
    authorize(event); extent([inputWidth, inputHeight, outputWidth, outputHeight]);
    if (typeof name !== 'string' || !/^loom-native-vision-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid native inference name');
    if (records.has(name) || records.size >= 8) throw new Error('Native inference session cap reached');
    const record = { name, owner: event.sender, frame: event.senderFrame, worker: null, window: null,
      opening: null, closing: null, busy: false, closed: false, quarantined: false, lease: null, pending: null,
      error: null, waiters: new Set(), frames: 0, listeners: {} };
    records.set(name, record);
    const leave = () => { void close(record).catch(error => fault(record, error)); };
    record.listeners = { destroyed: leave, 'render-process-gone': leave, 'did-navigate': leave };
    for (const [eventName, listener] of Object.entries(record.listeners)) record.owner.on(eventName, listener);
    record.opening = (async () => {
      record.worker = await workers.open();
      if (record.closed) return;
      const height = Math.ceil(inputHeight * 4 / 3);
      const window = new BrowserWindow({ width: inputWidth, height, show: false, useContentSize: true,
        webPreferences: { ...webPreferences, preload: join(__dirname, 'inference-preload.cjs'), backgroundThrottling: false,
          offscreen: { useSharedTexture: true, sharedTexturePixelFormat: 'argb', deviceScaleFactor: 1 } } });
      record.window = window;
      const contents = window.webContents;
      record.contents = contents;
      contents.stopPainting();
      window.once('closed', leave);
      contents.on('render-process-gone', leave);
      contents.on('paint', async event => {
        const texture = event.texture;
        if (!texture) { if (record.pending) fault(record, new Error('Native inference capture returned no GPU texture')); return; }
        if (!record.pending || record.closed || record.busy || record.error) { texture.release(); return; }
        contents.stopPainting(); timers.clearTimeout(record.pending.timer); record.busy = true;
        let accepted = false, inputDone = false, lease;
        try {
          const info = texture.textureInfo;
          if (info.pixelFormat !== 'bgra' || info.codedSize.width !== inputWidth || info.codedSize.height !== height)
            throw new Error('Native inference capture format/size changed');
          const request = record.worker.infer(info.handle.ioSurface, [inputWidth, inputHeight], [outputWidth, outputHeight]);
          accepted = true;
          const result = await request;
          record.coverage = result.coverage;
          record.producerPid = result.producerPid;
          inputDone = true; texture.release();
          lease = { result, imported: null, entered: false, releasing: false };
          record.lease = lease;
          if (record.closed) { await release(record, lease); return; }
          if (result.width !== outputWidth || result.height !== outputHeight) throw new Error('Native inference result extent changed');
          lease.entered = true;
          lease.imported = sharedTexture.importSharedTexture({ textureInfo: {
            pixelFormat: 'rgbaf16', codedSize: { width: result.width, height: result.height },
            // Identity color conversion: these floats are measurements, NOT a
            // display image. The graph samples their numerical values unchanged.
            colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
            handle: { ioSurface: result.handle },
          }, allReferencesReleased: () => { void release(record, lease); } });
          if (lease.releasing) throw new Error('Native inference result released before transfer');
          await sharedTexture.sendSharedTexture({ frame: record.frame, importedSharedTexture: lease.imported },
            { session: name, sequence: result.sequence, width: result.width, height: result.height, coverage: result.coverage });
          record.frames++;
        } catch (error) {
          if (!inputDone && (!accepted || error.code === 'VISION_REQUEST_REFUSED')) { texture.release(); inputDone = true; }
          if (!inputDone) { record.quarantined = true; record.inputTexture = texture; }
          if (lease && !lease.entered) await release(record, lease);
          if (lease?.entered && !lease.imported && !lease.releasing) record.quarantined = true;
          fault(record, error);
        } finally {
          if (lease?.imported) {
            try { lease.imported.release(); }
            catch (error) { record.quarantined = true; fault(record, error); }
          }
          record.busy = false;
          completed(record);
        }
      });
      await window.loadURL(`${origin}/src/desktop/inference.html?name=${name}&width=${inputWidth}&height=${height}`);
    })();
    try { await record.opening; return name; }
    catch (error) {
      fault(record, error);
      // Startup owns no submitted frame. Retire any acquired worker/window, but
      // keep a failed cleanup visible rather than silently discarding its slot.
      if (record.worker) await record.worker.close();
      if (record.window && !record.window.isDestroyed()) record.window.destroy();
      for (const [eventName, listener] of Object.entries(record.listeners)) record.owner.removeListener(eventName, listener);
      records.delete(name); throw error;
    }
  });
  ipcMain.handle('loom-native-vision-frame', event => {
    const record = [...records.values()].find(record => record.contents === event.sender);
    if (!record || record.closed || event.senderFrame !== event.sender.mainFrame) throw new Error('Unknown native inference capture frame');
    if (record.error) throw new Error(record.error);
    if (record.pending || record.busy || record.lease) throw new Error('Native inference capture is busy');
    return new Promise((resolve, reject) => {
      record.pending = { resolve, reject, timer: timers.setTimeout(() => {
        event.sender.stopPainting();
        fault(record, new Error('Native inference GPU capture timed out before submission'));
      }, 15000) };
      // invalidate() composites Electron's CPU backing bitmap and can emit a
      // texture-less paint even in shared-texture mode. Resume the GPU consumer;
      // the renderer has already submitted the new ImageBitmap to its compositor.
      event.sender.startPainting();
    });
  });
  ipcMain.handle('loom-native-vision-close', (event, name) => {
    authorize(event);
    if (!records.has(name)) return;
    return close(owned(event, name));
  });
  ipcMain.handle('loom-native-vision-status', (event, name) => {
    const record = owned(event, name);
    return { frames: record.frames, busy: record.busy || !!record.lease, error: record.error };
  });
  return {
    retireOwner: owner => Promise.all([...records.values()].filter(record => record.owner === owner).map(close)),
    diagnostics: () => [...records.values()].map(record => ({ name: record.name, busy: record.busy,
      frames: record.frames, coverage: record.coverage, producerPid: record.producerPid,
      resultHeld: !!record.lease, inputHeld: !!record.inputTexture, closed: record.closed, error: record.error })),
  };
}
module.exports = { installNativeInference };
