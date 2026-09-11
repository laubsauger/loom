/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('loomNativeSurface', {
  frameReady: () => ipcRenderer.invoke('loom-native-output-frame-ready'),
});
