/* global require, module, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { join } = require('node:path');
const timers = require('node:timers');
const { webPreferences } = require('./policy.cjs');
const { AbortController } = globalThis;

/**
 * Main owns capture, Python session and imported result until GPU-aware ACK.
 * Two session kinds share it (T1818b): Person Mask (`vision`) and Depth Pro 2 on
 * Core ML (`depth`), the same capture, transport, lease and drain rules, and one
 * session cap, because both ride the one native XPC client.
 */
function installNativeInference({ ipcMain, BrowserWindow, sharedTexture, workers, depth = null, origin }) {
  const records = new Map();
  const preparations = new Map();
  const authorize = event => {
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== `${origin}/`)
      throw new Error('Native inference requires the app main frame');
  };
  const owned = (event, name, kind) => {
    authorize(event);
    const record = records.get(name);
    if (!record || record.owner !== event.sender || record.frame !== event.senderFrame || record.kind !== kind)
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
  async function open(event, kind, name, acquire, inputWidth, inputHeight, outputWidth, outputHeight) {
    if (records.has(name) || records.size >= 8) throw new Error('Native inference session cap reached');
    const record = { kind, name, owner: event.sender, frame: event.senderFrame, worker: null, window: null,
      opening: null, closing: null, busy: false, closed: false, quarantined: false, lease: null, pending: null,
      error: null, waiters: new Set(), frames: 0, listeners: {}, resetPending: false };
    records.set(name, record);
    const leave = () => { void close(record).catch(error => fault(record, error)); };
    record.listeners = { destroyed: leave, 'render-process-gone': leave, 'did-navigate': leave };
    for (const [eventName, listener] of Object.entries(record.listeners)) record.owner.on(eventName, listener);
    record.opening = (async () => {
      record.worker = await acquire();
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
          // A depth stream restarts at the frame after its reset, never mid-frame.
          if (record.resetPending) { record.resetPending = false; await record.worker.reset(); }
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
  }
  ipcMain.handle('loom-native-vision-open', async (event, name, inputWidth, inputHeight, outputWidth, outputHeight) => {
    authorize(event); extent([inputWidth, inputHeight, outputWidth, outputHeight]);
    if (typeof name !== 'string' || !/^loom-native-vision-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid native inference name');
    return open(event, 'vision', name, () => workers.open(), inputWidth, inputHeight, outputWidth, outputHeight);
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
  for (const kind of depth ? ['vision', 'depth'] : ['vision']) {
    ipcMain.handle(`loom-native-${kind}-close`, (event, name) => {
      authorize(event);
      if (!records.has(name)) return;
      return close(owned(event, name, kind));
    });
    ipcMain.handle(`loom-native-${kind}-status`, (event, name) => {
      const record = owned(event, name, kind);
      return { frames: record.frames, busy: record.busy || !!record.lease, error: record.error };
    });
  }
  if (depth) {
    ipcMain.handle('loom-native-depth-probe', event => { authorize(event); return depth.models.probe(); });
    ipcMain.handle('loom-native-depth-open', async (event, name, modelId, functionName, inputWidth, inputHeight,
      outputWidth, outputHeight) => {
      authorize(event); extent([inputWidth, inputHeight, outputWidth, outputHeight]);
      if (typeof name !== 'string' || !/^loom-native-depth-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid native depth name');
      if (!depth.models.ids.includes(modelId)) throw new Error('Unknown native depth model');
      const size = depth.models.functions.includes(functionName) ? /^res_(\d+)x(\d+)$/.exec(functionName) : null;
      if (!size) throw new Error('Unknown native depth model function');
      if (inputWidth !== Number(size[1]) || inputHeight !== Number(size[2]))
        throw new Error('Native depth input must be the model function\'s own size');
      // Refused, never acquired: only a consented prepare downloads or compiles.
      const compiled = await depth.models.compiled(modelId);
      return open(event, 'depth', name, () => depth.workers.open([compiled, functionName]),
        inputWidth, inputHeight, outputWidth, outputHeight);
    });
    ipcMain.handle('loom-native-depth-reset', (event, name) => {
      const record = owned(event, name, 'depth');
      if (record.closed) throw new Error('Native depth session is closed');
      if (record.error) throw new Error(record.error);
      record.resetPending = true;
    });
    // One acquisition per model, however many documents or nodes ask while it runs.
    ipcMain.handle('loom-native-depth-prepare', async (event, job, modelId) => {
      authorize(event);
      if (typeof job !== 'string' || !/^[a-z0-9-]{1,64}$/.test(job)) throw new Error('Invalid native depth preparation job');
      if (!depth.models.ids.includes(modelId)) throw new Error('Unknown native depth model');
      let preparation = preparations.get(modelId);
      if (!preparation) {
        const created = { abort: new AbortController(), subscribers: new Set(), done: null };
        created.done = Promise.resolve().then(() => depth.models.prepare(modelId, progress => {
          for (const subscriber of created.subscribers) {
            if (!subscriber.owner.isDestroyed()) subscriber.owner.send('loom-native-depth-progress', subscriber.job, progress);
          }
        }, created.abort.signal)).finally(() => { if (preparations.get(modelId) === created) preparations.delete(modelId); });
        preparations.set(modelId, preparation = created);
      }
      const subscriber = { owner: event.sender, job };
      preparation.subscribers.add(subscriber);
      try { await preparation.done; } finally { preparation.subscribers.delete(subscriber); }
    });
  }
  /** A document leaving abandons only the acquisitions nobody else still waits for. */
  const retirePreparations = owner => Promise.all([...preparations.values()].map(preparation => {
    for (const subscriber of [...preparation.subscribers]) if (subscriber.owner === owner) preparation.subscribers.delete(subscriber);
    if (preparation.subscribers.size) return undefined;
    preparation.abort.abort(new Error('Native depth preparation retired with its document'));
    return preparation.done.catch(() => undefined);
  }));
  return {
    retireOwner: owner => Promise.all([...[...records.values()].filter(record => record.owner === owner).map(close),
      retirePreparations(owner)]),
    diagnostics: () => [...records.values()].map(record => ({ kind: record.kind, name: record.name, busy: record.busy,
      frames: record.frames, coverage: record.coverage, producerPid: record.producerPid,
      resultHeld: !!record.lease, inputHeld: !!record.inputTexture, closed: record.closed, error: record.error })),
  };
}
module.exports = { installNativeInference };
