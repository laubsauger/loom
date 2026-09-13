/* global module, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { Buffer } = require('node:buffer');
const console = require('node:console');
const { setTimeout, clearTimeout } = require('node:timers');

// T1344. Electron-main adapter; inject Electron/native seams for lifetime tests.
// Register the preload sharedTexture receiver before invoking poll. Metadata sent
// with each texture is {session, sequence, width, height}; native handles/lease IDs
// never travel through invoke replies. Close renderer VideoFrames/import refs when
// consumed. ONLY allReferencesReleased allows the native IOSurface to be retired.
function installNativeInput({ ipcMain, sharedTexture, native, origin, maxSessions = 8,
  transport = 'syphon', beforeAccess, onError = error => console.error(error) }) {
  if (!['syphon', 'ndi'].includes(transport)) throw new Error('Invalid native input transport');
  if ((beforeAccess !== undefined && typeof beforeAccess !== 'function') ||
      (transport === 'ndi' && typeof beforeAccess !== 'function'))
    throw new Error('NDI input requires a permission callback');
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64)
    throw new Error('Invalid native input session cap');
  if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin))
    throw new Error('Native input requires an exact HTTP origin without trailing slash');
  const sessions = new Map();
  const owners = new Map();
  const drainWaiters = new Set();
  const changed = () => { for (const waiter of [...drainWaiters]) waiter(); };
  const prefix = transport === 'ndi' ? 'loom-ndi-input' : 'loom-native-input';
  const channels = ['list', 'open', 'poll', 'close'].map(name => `${prefix}-${name}`);
  let nextSession = 0;
  let disposed = false;
  const fault = (record, error) => {
    if (!record.error) record.error = String(error);
    onError(`Native input ${record.id}: ${String(error)}`);
    changed();
  };
  const authorized = event => {
    if (disposed) throw new Error('Native input adapter is disposed');
    if (!event.sender || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame ||
        event.sender.getURL() !== `${origin}/`) throw new Error('Native input requires the app main frame');
  };
  const owned = (event, id) => {
    authorized(event);
    const record = sessions.get(id);
    if (!record || record.owner !== event.sender || record.frame !== event.senderFrame)
      throw new Error('Native input session is not owned by this renderer frame');
    return record;
  };
  const snapshot = record => ({ closed: record.closed, nativeClosed: record.nativeClosed,
    complete: record.closed && record.nativeClosed && !record.opening && !record.busy && !record.lease,
    opening: record.opening, acquiring: record.busy,
    offline: record.offline, receivedFrames: record.receivedFrames,
    retainedLease: Boolean(record.lease), quarantined: Boolean(record.closeFailed || record.lease?.quarantined),
    error: record.error });
  function forget(record) {
    if (!record.closed || record.opening || record.busy || record.lease || !record.nativeClosed) return;
    if (!sessions.has(record.id)) return;
    sessions.delete(record.id);
    if (![...sessions.values()].some(other => other.owner === record.owner)) {
      const listeners = owners.get(record.owner);
      for (const [name, listener] of Object.entries(listeners)) record.owner.removeListener(name, listener);
      owners.delete(record.owner);
    }
    changed();
  }
  function retire(record) {
    record.closed = true;
    if (!record.opening && !record.closeAttempted && !record.nativeClosed) {
      record.closeAttempted = true;
      const failed = error => { record.closeFailed = true; fault(record, error); };
      try {
        const closing = native.close(record.nativeSession);
        if (closing && typeof closing.then === 'function') {
          record.closing = Promise.resolve(closing).then(() => {
            record.nativeClosed = true; forget(record); changed();
          }, failed);
        } else record.nativeClosed = true;
      } catch (error) { failed(error); }
    }
    forget(record);
    return snapshot(record);
  }
  function watch(owner) {
    if (owners.has(owner)) return;
    const closeAll = () => {
      for (const record of [...sessions.values()]) if (record.owner === owner) retire(record);
    };
    // A provisional navigation leaves the current document alive (and can be
    // cancelled). Retire at main-document commit, before the new page opens inputs.
    // did-navigate excludes subframes and same-document navigation.
    const listeners = { destroyed: closeAll, 'render-process-gone': closeAll, 'did-navigate': closeAll };
    owners.set(owner, listeners);
    for (const [name, listener] of Object.entries(listeners)) owner.on(name, listener);
  }
  function releaseNative(record, lease) {
    if (lease.releaseAttempted) {
      fault(record, new Error('Duplicate native input release callback'));
      return;
    }
    lease.releaseAttempted = true;
    try {
      native.release(lease.frame.leaseId);
      lease.released = true;
      if (record.lease === lease) record.lease = null;
      forget(record);
    } catch (error) { lease.quarantined = true; fault(record, error); }
  }
  function validFrame(frame) {
    if (typeof frame.leaseId !== 'string' || !frame.leaseId || !Buffer.isBuffer(frame.handle) || frame.handle.length !== 8 ||
        ![frame.width, frame.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384) ||
        !Number.isSafeInteger(frame.sequence) || frame.sequence < 1)
      throw new Error('Malformed native BGRA input frame');
  }
  ipcMain.handle(channels[0], event => {
    authorized(event);
    if (!beforeAccess) return native.list();
    const frame = event.senderFrame;
    let navigated = false;
    const retired = () => { navigated = true; };
    const events = ['did-navigate', 'destroyed', 'render-process-gone'];
    for (const name of events) event.sender.on(name, retired);
    return (async () => {
      try {
        await beforeAccess(event);
        authorized(event);
        if (navigated || event.sender.mainFrame !== frame)
          throw new Error('Native input owner closed or navigated during permission');
        const sources = await native.list();
        authorized(event);
        if (navigated || event.sender.mainFrame !== frame)
          throw new Error('Native input owner closed or navigated during discovery');
        return sources;
      } finally {
        for (const name of events) event.sender.removeListener(name, retired);
      }
    })();
  });
  ipcMain.handle(channels[1], (event, uuid) => {
    authorized(event);
    if (typeof uuid !== 'string' || !uuid || uuid.length > 4096 || uuid.includes('\0'))
      throw new Error('Invalid exact native input source UUID');
    // Retired sessions with pending imports stay counted: close/open churn cannot
    // turn a missing allReferencesReleased callback into unbounded native memory.
    if (sessions.size >= maxSessions) throw new Error('Native input session cap reached, including retained leases');
    const frame = event.senderFrame;
    const id = `${prefix}-${++nextSession}`;
    const record = { id, nativeSession: null, owner: event.sender, frame,
      opening: true, closeAttempted: false, closeFailed: false, closing: null,
      closed: false, nativeClosed: false, busy: false, lease: null, error: null,
      offline: false, receivedFrames: 0 };
    watch(event.sender);
    sessions.set(id, record);
    const current = () => !record.closed && !disposed && !record.owner.isDestroyed() &&
      record.owner.mainFrame === frame && record.owner.getURL() === `${origin}/`;
    return (async () => {
      let opened = false;
      try {
        if (beforeAccess) await beforeAccess(event);
        if (!current()) throw new Error('Native input owner closed or navigated during open');
        record.nativeSession = await native.open(uuid);
        opened = true;
        if (!current()) throw new Error('Native input owner closed or navigated during open');
        return id;
      } catch (error) {
        record.opening = false;
        if (!opened) record.nativeClosed = true;
        retire(record);
        if (record.closing) await record.closing;
        if (record.closeFailed) throw new Error(record.error, { cause: error });
        throw error;
      } finally {
        record.opening = false;
        forget(record); changed();
      }
    })();
  });
  ipcMain.handle(channels[2], async (event, id) => {
    const record = owned(event, id);
    if (record.closed) throw new Error('Native input session is closed');
    if (record.error) throw new Error(record.error);
    if (record.opening || record.busy || record.lease) return { kind: 'busy' };
    record.busy = true;
    let lease, outcome, pollError;
    try {
      const frame = await native.acquire(record.nativeSession);
      // NDI keeps its SDK receiver connected to the selected identity while the
      // sender is offline. This control result owns no native or Chromium lease.
      const offline = transport === 'ndi' && frame?.kind === 'offline' && Object.keys(frame).length === 1;
      if (frame !== null && !offline) {
        lease = { frame, imported: null, enteredImport: false, releaseAttempted: false,
          released: false, mainReleaseAttempted: false, quarantined: false };
        record.lease = lease;
      }
      if (record.closed || record.owner.isDestroyed() || record.owner.mainFrame !== record.frame ||
          record.owner.getURL() !== `${origin}/`) throw new Error('Native input owner closed or navigated during acquire');
      if (offline) { record.offline = true; outcome = { kind: 'offline' }; }
      else if (frame === null) outcome = { kind: 'empty' };
      else {
        validFrame(frame);
        lease.enteredImport = true;
        lease.imported = sharedTexture.importSharedTexture({ textureInfo: {
          pixelFormat: 'bgra', codedSize: { width: frame.width, height: frame.height },
          colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
          handle: { ioSurface: frame.handle },
        }, allReferencesReleased: () => releaseNative(record, lease) });
        if (lease.released) throw new Error('Native input import released before transfer');
        if (record.closed || record.owner.isDestroyed() || record.owner.mainFrame !== record.frame ||
            record.owner.getURL() !== `${origin}/`) throw new Error('Native input owner closed or navigated during import');
        await sharedTexture.sendSharedTexture({ frame: record.frame, importedSharedTexture: lease.imported },
          { session: id, sequence: frame.sequence, width: frame.width, height: frame.height });
        if (record.closed) throw new Error('Native input session closed during transfer');
        record.offline = false; record.receivedFrames++;
        outcome = { kind: 'sent', sequence: frame.sequence, width: frame.width, height: frame.height };
      }
    } catch (error) {
      if (lease && !lease.enteredImport && typeof lease.frame?.leaseId === 'string') releaseNative(record, lease);
      // A throwing import can have entered native code before failing. There is
      // no returned object to release and no proof of absent Chromium references.
      // Keep its ONE slot until the supplied callback arrives; never guess/retry.
      if (lease?.enteredImport && !lease.imported && !lease.released) lease.quarantined = true;
      // Retirement cancels an in-flight acquire/transfer. Its receiver may no
      // longer exist; return an explicit terminal result, not a live-input fault.
      // Uncertain imports remain quarantined above; release failures still reject
      // in finally and keep their capacity reserved.
      if (record.closed) outcome = { kind: 'closed' };
      else {
        fault(record, error);
        pollError = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      if (lease?.imported && !lease.mainReleaseAttempted) {
        lease.mainReleaseAttempted = true;
        try { lease.imported.release(); }
        catch (error) {
          lease.quarantined = true; fault(record, error);
          pollError ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      record.busy = false;
      forget(record);
    }
    if (pollError) throw pollError;
    if (record.error) throw new Error(record.error);
    return outcome;
  });
  ipcMain.handle(channels[3], (event, id) => {
    const record = owned(event, id);
    const result = retire(record);
    if (!record.closing) return result;
    return record.closing.then(() => {
      if (record.closeFailed) throw new Error(record.error);
      return snapshot(record);
    });
  });
  return {
    async retireOwner(owner) {
      const records = [...sessions.values()].filter(record => record.owner === owner);
      for (const record of records) retire(record);
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); drainWaiters.delete(check);
          if (error) reject(error); else resolve();
        };
        const check = () => {
          const pending = records.filter(record => !snapshot(record).complete);
          const failed = pending.find(record => record.error && (record.closeFailed || record.lease?.quarantined));
          if (failed) finish(new Error(failed.error));
          else if (pending.length === 0) finish();
        };
        const timer = setTimeout(() => finish(new Error('Native input GPU drainage timed out; navigation remains blocked')), 15000);
        drainWaiters.add(check); check();
      });
    },
    diagnostics: () => [...sessions.values()].map(record => ({ session: record.id, ...snapshot(record) })),
    dispose() {
      if (!disposed) {
        disposed = true;
        for (const channel of channels) ipcMain.removeHandler(channel);
        for (const record of [...sessions.values()]) retire(record);
      }
      return [...sessions.values()].map(record => ({ session: record.id, ...snapshot(record) }));
    },
  };
}
module.exports = { installNativeInput };
