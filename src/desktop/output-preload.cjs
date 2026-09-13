/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
const prefix = process.argv.includes('--loom-ndi-output') ? 'loom-ndi-output' : 'loom-native-output';
contextBridge.exposeInMainWorld('loomNativeSurface', {
  frameReady: () => ipcRenderer.invoke(`${prefix}-frame-ready`),
});
