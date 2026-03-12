const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("siylo", {
  getState: () => ipcRenderer.invoke("siylo:get-state"),
  start: () => ipcRenderer.invoke("siylo:start"),
  stop: () => ipcRenderer.invoke("siylo:stop"),
  updateConfig: (partialConfig) => ipcRenderer.invoke("siylo:update-config", partialConfig),
  simulateSession: (commandText) => ipcRenderer.invoke("siylo:simulate-session", commandText),
  openDashboard: () => ipcRenderer.invoke("siylo:open-dashboard"),
  onStateChanged: (listener) => {
    const subscription = (_, state) => listener(state);
    ipcRenderer.on("siylo:state-changed", subscription);

    return () => {
      ipcRenderer.removeListener("siylo:state-changed", subscription);
    };
  }
});
