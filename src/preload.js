'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledger', {
  getState: () => ipcRenderer.invoke('app:getState'),
  chooseDataDir: () => ipcRenderer.invoke('dialog:chooseDataDir'),
  importFiles: mode => ipcRenderer.invoke('dialog:import', mode),
  importPaths: payload => ipcRenderer.invoke('import:paths', payload),
  removeStatement: key => ipcRenderer.invoke('data:remove', key),
  getOverview: account => ipcRenderer.invoke('data:overview', account || null),
  positionsAt: payload => ipcRenderer.invoke('data:positionsAt', payload),
  getHealth: () => ipcRenderer.invoke('data:health'),
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: key => ipcRenderer.invoke('trash:restore', key),
  trashPurge: () => ipcRenderer.invoke('trash:purge'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupExport: () => ipcRenderer.invoke('backup:export'),
  backupRestore: () => ipcRenderer.invoke('backup:restore'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: cfg => ipcRenderer.invoke('config:set', cfg),
  chooseMonitorDir: () => ipcRenderer.invoke('dialog:chooseMonitorDir'),
  logWrite: msg => ipcRenderer.invoke('log:write', msg),
  exportCsv: payload => ipcRenderer.invoke('data:exportCsv', payload),
  exportXlsx: payload => ipcRenderer.invoke('data:exportXlsx', payload),
  showDataDir: () => ipcRenderer.invoke('shell:showDataDir'),
  onMonitorImported: cb => ipcRenderer.on('monitor:imported', (evt, results) => cb(results)),
});
