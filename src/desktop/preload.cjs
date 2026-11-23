/* global require, window, Event, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
const nativeVideo = process.argv.includes('--loom-native-video');
const inputs = new Map();
const preparationJobs = new Map();
const deliveries = new Set();
const opening = new Set();
const depthProgress = new Map();
let depthJobs = 0;
let retiring = false;
let unloadPrepared = false;
let usedNativeInput = false;
window.addEventListener('beforeunload', event => {
  // Native video references and static worker processes both need the main drain.
  if (!unloadPrepared && usedNativeInput) {
    event.preventDefault(); event.returnValue = false;
  }
});
window.addEventListener('pagehide', () => {
  for (const record of inputs.values()) record.closed = true;
  for (const release of [...deliveries]) release();
});
const input = id => {
  const record = inputs.get(id);
  if (!record || record.closed) throw new Error('Native input session is closed or unknown');
  if (record.error) throw new Error(record.error);
  return record;
};
const forget = (id, record) => {
  if (record.closed && !record.polling && !record.consuming) inputs.delete(id);
};
// Receiver registration is synchronous and precedes exposure of open/poll.
if (nativeVideo) sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: imported }, metadata) => {
  const record = inputs.get(metadata.session);
  let frame;
  let consuming = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    deliveries.delete(release);
    try { frame?.close(); } finally { imported.release(); }
  };
  deliveries.add(release);
  try {
    if (!record) throw new Error('Native input arrived for an unknown session');
    if (record.closed) return;
    if (record.consuming) throw new Error('Overlapping native input delivery');
    record.consuming = true; consuming = true;
    frame = imported.getVideoFrame();
    await record.consume(frame, metadata);
  } catch (error) {
    if (!record) throw error;
    // Preserve callback errors for poll; do not turn failure into an empty frame.
    record.error = String(error);
  } finally {
    release();
    if (record && consuming) record.consuming = false;
    if (record) forget(metadata.session, record);
  }
});
function createInputBridge(prefix) {
  return {
    list: () => ipcRenderer.invoke(`${prefix}-list`),
    open: async (uuid, consume) => {
      if (retiring) throw new Error('Native input document is retiring');
      if (typeof consume !== 'function') throw new Error('Native input requires a frame consumer');
      usedNativeInput = true;
      const pending = ipcRenderer.invoke(`${prefix}-open`, uuid);
      opening.add(pending);
      let id;
      try { id = await pending; } finally { opening.delete(pending); }
      inputs.set(id, { prefix, consume, closed: false, polling: false, consuming: false, error: null });
      return id;
    },
    poll: async id => {
      const record = input(id);
      if (record.prefix !== prefix) throw new Error('Native input transport does not own this session');
      if (record.polling) throw new Error('Native input poll already in flight');
      record.polling = true;
      try {
        const result = await ipcRenderer.invoke(`${prefix}-poll`, id);
        if (result.kind === 'closed') record.closed = true;
        if (record.error) throw new Error(record.error);
        return result;
      } finally { record.polling = false; forget(id, record); }
    },
    close: async id => {
      const record = inputs.get(id);
      if (!record || record.closed) throw new Error('Native input session is closed or unknown');
      if (record.prefix !== prefix) throw new Error('Native input transport does not own this session');
      record.closed = true;
      try { return await ipcRenderer.invoke(`${prefix}-close`, id); }
      finally { forget(id, record); }
    },
  };
}
function createOutputBridge(prefix) {
  return {
    nativeOutput: true,
    open: async (name, width, height, publisherName, options) => {
      if (retiring) throw new Error('Native output document is retiring');
      usedNativeInput = true; // All native activity participates in the unload gate.
      // VN132: only a literal `alpha: true` crosses; the main process validates it again.
      const pending = options?.alpha === true
        ? ipcRenderer.invoke(`${prefix}-open`, name, width, height, publisherName, true)
        : ipcRenderer.invoke(`${prefix}-open`, name, width, height, publisherName);
      opening.add(pending);
      try { await pending; } finally { opening.delete(pending); }
    },
    close: name => ipcRenderer.invoke(`${prefix}-close`, name),
    resize: (name, width, height) => ipcRenderer.invoke(`${prefix}-resize`, name, width, height),
    status: name => ipcRenderer.invoke(`${prefix}-status`, name),
  };
}
// T1818b: Person Mask and Depth Pro 2 share one capture transport and receiver.
async function openInference(channel, args, consume) {
  if (retiring) throw new Error('Native inference document is retiring');
  if (typeof consume !== 'function') throw new Error('Native inference requires a frame consumer');
  usedNativeInput = true;
  const pending = ipcRenderer.invoke(channel, ...args);
  opening.add(pending);
  let id;
  try { id = await pending; } finally { opening.delete(pending); }
  inputs.set(id, { consume, closed: false, polling: false, consuming: false, error: null });
  return id;
}
function createInferenceSessions(kind) {
  return {
    status: async id => {
      const record = input(id);
      const result = await ipcRenderer.invoke(`loom-native-${kind}-status`, id);
      if (record.error) throw new Error(record.error);
      return result;
    },
    close: async id => {
      const record = inputs.get(id);
      if (record) record.closed = true;
      try { return await ipcRenderer.invoke(`loom-native-${kind}-close`, id); }
      finally { if (record) forget(id, record); }
    },
  };
}
// Progress for a consented acquisition arrives as events; the job id routes it.
if (nativeVideo) ipcRenderer.on('loom-native-depth-progress', (_event, job, progress) => depthProgress.get(job)?.(progress));
function preparationJob(id) {
  const record = preparationJobs.get(id);
  if (!record) throw new Error('Native preparation job is closed or unknown');
  return record;
}
function closePreparation(id) {
  const record = preparationJob(id);
  if (!record.closing) record.closing = ipcRenderer.invoke('loom-preparation-close', id).then(result => {
    preparationJobs.delete(id);
    return result;
  });
  return record.closing;
}
const lifecycle = {
    prepareForUnload: async () => {
      retiring = true;
      window.dispatchEvent(new Event('loom-native-input-retire'));
      // A denied/failed open still settles ownership. Its caller receives the
      // rejection; main's retireOwner remains the authority for safe drainage.
      await Promise.allSettled([...opening]);
      for (const record of inputs.values()) record.closed = true;
      for (const release of [...deliveries]) release();
      await Promise.all([...preparationJobs.keys()].map(closePreparation));
    },
    commitUnload: () => { unloadPrepared = true; },
};

contextBridge.exposeInMainWorld('loomDesktop', {
  preparation: {
    probe: () => ipcRenderer.invoke('loom-preparation-probe'),
    start: async request => {
      if (retiring) throw new Error('Native preparation document is retiring');
      usedNativeInput = true;
      const pending = ipcRenderer.invoke('loom-preparation-start', request);
      opening.add(pending);
      try {
        const id = await pending;
        if (typeof id !== 'string' || id.length === 0) throw new Error('Native preparation returned no owned job identifier');
        preparationJobs.set(id, { closing: null });
        return id;
      } finally { opening.delete(pending); }
    },
    status: id => { preparationJob(id); return ipcRenderer.invoke('loom-preparation-status', id); },
    cancel: id => { preparationJob(id); return ipcRenderer.invoke('loom-preparation-cancel', id); },
    close: closePreparation,
  },
  ...(nativeVideo ? { vision: {
    open: (name, width, height, outputWidth, outputHeight, consume) =>
      openInference('loom-native-vision-open', [name, width, height, outputWidth, outputHeight], consume),
    ...createInferenceSessions('vision'),
  }, depth: {
    // Never downloads or compiles: it reports what prepare would fetch and whether it is cached.
    probe: () => ipcRenderer.invoke('loom-native-depth-probe'),
    // The consented acquisition: pinned, hash-verified download, then one compile.
    prepare: async (modelId, onProgress) => {
      if (retiring) throw new Error('Native depth document is retiring');
      if (typeof onProgress !== 'function') throw new Error('Native depth preparation requires a progress consumer');
      usedNativeInput = true; // main retirement abandons an acquisition no other document awaits
      const job = `depth-${++depthJobs}`;
      depthProgress.set(job, onProgress);
      try { await ipcRenderer.invoke('loom-native-depth-prepare', job, modelId); }
      finally { depthProgress.delete(job); }
    },
    open: (name, modelId, functionName, inputWidth, inputHeight, outputWidth, outputHeight, consume) =>
      openInference('loom-native-depth-open', [name, modelId, functionName, inputWidth, inputHeight, outputWidth, outputHeight], consume),
    // A new stream: the next captured frame starts from a fresh model state.
    reset: async id => { input(id); return ipcRenderer.invoke('loom-native-depth-reset', id); },
    ...createInferenceSessions('depth'),
  } } : {}),
  lifecycle,
  ...(nativeVideo ? { input: { ...lifecycle, ...createInputBridge('loom-native-input') } } : {}),
  ...(nativeVideo && process.argv.includes('--loom-ndi-input') ? {
    ndiInput: createInputBridge('loom-ndi-input'), ndiOutput: createOutputBridge('loom-ndi-output'),
  } : {}),
  ...(nativeVideo ? createOutputBridge('loom-native-output') : {}),
});
