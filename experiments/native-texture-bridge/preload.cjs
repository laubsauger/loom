/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const { sharedTexture, contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('proof', {
  receive: callback => sharedTexture.setSharedTextureReceiver(async (data, metadata) => {
    const imported = data.importedSharedTexture;
    let frame;
    let released = false;
    const release = () => {
      if (released) throw new Error('Frame references already released');
      frame?.close();
      imported.release();
      released = true;
    };
    try {
      frame = imported.getVideoFrame();
      if (metadata.fault === 'renderer-loss') {
        ipcRenderer.send('proof-held', metadata.sequence);
        // Intentionally retain both objects until this test renderer is killed.
        await new Promise(() => {});
      }
      const result = await callback(frame, metadata, () => {
        if (metadata.fault !== 'early-release') throw new Error('Unexpected early release');
        release();
      });
      if (metadata.fault === 'gpu-loss') ipcRenderer.send('proof-device-lost', metadata.sequence);
      else ipcRenderer.send('proof-result', { ...result, sandboxed: process.sandboxed });
    } catch (error) {
      ipcRenderer.send('proof-failed', String(error.stack ?? error));
    } finally {
      if (!released) release();
      if (metadata.fault === 'gpu-loss') ipcRenderer.send('proof-renderer-released', metadata.sequence);
    }
  }),
  ready: () => ipcRenderer.send('proof-ready'),
  submitted: sequence => ipcRenderer.send('proof-submitted', sequence),
  fail: message => ipcRenderer.send('proof-failed', message),
});
