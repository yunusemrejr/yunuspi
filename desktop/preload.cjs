const { contextBridge, ipcRenderer } = require('electron');

const invoke = (action, input) => ipcRenderer.invoke('yunuspi:action', action, input);
contextBridge.exposeInMainWorld('yunuspi', Object.freeze({
  snapshot: () => invoke('snapshot'),
  chooseProject: () => invoke('chooseProject'),
  createSession: projectId => invoke('createSession', { projectId }),
  openSession: (id, loaded = false) => invoke('openSession', { id, loaded }),
  warm: id => invoke('warm', { id }),
  history: (id, before) => invoke('history', { id, before }),
  sessionAction: (id, action) => invoke('sessionAction', { id, action }),
  projectAction: (id, action) => invoke('projectAction', { id, action }),
  checkCommand: (id, message) => invoke('checkCommand', { id, message }),
  updateSession: (id, patch) => invoke('updateSession', { id, patch }),
  prompt: (id, message, images) => invoke('prompt', { id, message, images }),
  abort: id => invoke('abort', { id }),
  models: id => invoke('models', { id }),
  setModel: (id, provider, modelId) => invoke('setModel', { id, provider, modelId }),
  setThinking: (id, level) => invoke('setThinking', { id, level }),
  stats: id => invoke('stats', { id }),
  commands: id => invoke('commands', { id }),
  extensionResponse: (id, response) => invoke('extensionResponse', { id, response }),
  chooseImages: () => invoke('chooseImages'),
  openExternal: url => invoke('openExternal', { url }),
  copyText: value => invoke('copyText', { value }),
  openData: () => invoke('openData'),
  importSession: () => invoke('importSession'),
  exportSession: id => invoke('exportSession', { id }),
  saveCredential: (provider, key) => invoke('saveCredential', { provider, key }),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('yunuspi:event', listener);
    return () => ipcRenderer.removeListener('yunuspi:event', listener);
  },
}));
