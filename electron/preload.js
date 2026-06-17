'use strict';

// Minimal, context-isolated bridge. The SPA uses the presence of
// `window.electronAPI` to know it is running in the desktop app (in web mode
// this object is absent, so no desktop-only UI renders). The update API
// (checkUpdate / startUpdate / onUpdateLog) will be added here in the
// Update & Distribution phase.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
});
