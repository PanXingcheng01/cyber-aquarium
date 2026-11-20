'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aq', {
  load: () => ipcRenderer.invoke('aq:load'),
  save: (patch) => ipcRenderer.invoke('aq:save', patch),
  dragStart: () => ipcRenderer.invoke('aq:drag-start'),
  dragEnd: () => ipcRenderer.invoke('aq:drag-end'),
  setSize: (name) => ipcRenderer.invoke('aq:set-size', name),
  setTheme: (value) => ipcRenderer.invoke('aq:theme', value),
  setEffects: (value) => ipcRenderer.invoke('aq:effects', value),
  listThemePacks: () => ipcRenderer.invoke('aq:theme-packs'),
  openThemesFolder: () => ipcRenderer.invoke('aq:themes-folder'),
  setTop: (value) => ipcRenderer.invoke('aq:top', value),
  quit: () => ipcRenderer.invoke('aq:quit'),
  openManual: () => ipcRenderer.invoke('aq:manual'),
})
