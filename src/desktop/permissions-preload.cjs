/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('loomPermissions', {
  list: () => ipcRenderer.invoke('loom-permissions-list'),
  openSystemSettings: () => ipcRenderer.invoke('loom-permissions-system-settings'),
  subscribe: callback => {
    if (typeof callback !== 'function') throw new Error('Permissions subscription requires a callback');
    const changed = () => callback();
    ipcRenderer.on('loom-permissions-changed', changed);
    return () => ipcRenderer.removeListener('loom-permissions-changed', changed);
  },
});
