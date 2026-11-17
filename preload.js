'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, cb) => { const f = (_e, d) => cb(d); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };

contextBridge.exposeInMainWorld('api', {
  state: () => invoke('state'),
  importConf: (name, text) => invoke('import', name, text),
  getConfig: (id) => invoke('get-config', id),
  saveConfig: (id, name, text) => invoke('save-config', id, name, text),
  remove: (id) => invoke('delete', id),
  exportConf: (id) => invoke('export', id),
  pickFiles: () => invoke('pick-files'),
  connect: (id) => invoke('connect', id),
  disconnect: () => invoke('disconnect'),
  setSettings: (p) => invoke('set-settings', p),
  installWireGuard: () => invoke('install-wireguard'),
  checkUpdate: () => invoke('check-update'),
  installUpdate: () => invoke('install-update'),
  openExternal: (u) => invoke('open-external', u),
  win: (a) => ipcRenderer.send('win', a),
  onState: (cb) => on('state', cb),
  onStats: (cb) => on('stats', cb),
  onUpdate: (cb) => on('update', cb),
  onToast: (cb) => on('toast', cb),
  onMaximized: (cb) => on('maximized', cb),
});
