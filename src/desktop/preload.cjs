/* global require, window, Event, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
const inputs = new Map();
const deliveries = new Set();
const opening = new Set();
let retiring = false;
let unloadPrepared = false;
let usedNativeInput = false;
window.addEventListener('beforeunload', event => {
  // A locally forgotten session can still have a main-process GPU release pending.
  // Once this document has opened inputs, only the main drain can authorize unload.
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
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: imported }, metadata) => {
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
    open: async (name, width, height, publisherName) => {
      if (retiring) throw new Error('Native output document is retiring');
      usedNativeInput = true; // All native activity participates in the unload gate.
      const pending = ipcRenderer.invoke(`${prefix}-open`, name, width, height, publisherName);
      opening.add(pending);
      try { await pending; } finally { opening.delete(pending); }
    },
    close: name => ipcRenderer.invoke(`${prefix}-close`, name),
    resize: (name, width, height) => ipcRenderer.invoke(`${prefix}-resize`, name, width, height),
    status: name => ipcRenderer.invoke(`${prefix}-status`, name),
  };
}
contextBridge.exposeInMainWorld('loomDesktop', {
  vision: {
    open: async (name, width, height, outputWidth, outputHeight, consume) => {
      if (retiring) throw new Error('Native inference document is retiring');
      if (typeof consume !== 'function') throw new Error('Native inference requires a frame consumer');
      usedNativeInput = true;
      const pending = ipcRenderer.invoke('loom-native-vision-open', name, width, height, outputWidth, outputHeight);
      opening.add(pending);
      let id;
      try { id = await pending; } finally { opening.delete(pending); }
      inputs.set(id, { consume, closed: false, polling: false, consuming: false, error: null });
      return id;
    },
    status: async id => {
      const record = input(id);
      const result = await ipcRenderer.invoke('loom-native-vision-status', id);
      if (record.error) throw new Error(record.error);
      return result;
    },
    close: async id => {
      const record = inputs.get(id);
      if (record) record.closed = true;
      try { return await ipcRenderer.invoke('loom-native-vision-close', id); }
      finally { if (record) forget(id, record); }
    },
  },
  input: {
    prepareForUnload: async () => {
      retiring = true;
      window.dispatchEvent(new Event('loom-native-input-retire'));
      // A denied/failed open still settles ownership. Its caller receives the
      // rejection; main's retireOwner remains the authority for safe drainage.
      await Promise.allSettled([...opening]);
      for (const record of inputs.values()) record.closed = true;
      for (const release of [...deliveries]) release();
    },
    commitUnload: () => { unloadPrepared = true; },
    ...createInputBridge('loom-native-input'),
  },
  ...(process.argv.includes('--loom-ndi-input') ? {
    ndiInput: createInputBridge('loom-ndi-input'), ndiOutput: createOutputBridge('loom-ndi-output'),
  } : {}),
  ...createOutputBridge('loom-native-output'),
});
