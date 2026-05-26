const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("zenTune", {
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  filePathForDrop: (file) => webUtils.getPathForFile(file),
  importDroppedPaths: (paths) => ipcRenderer.invoke("import-dropped-paths", paths),
  pickOutputFolder: () => ipcRenderer.invoke("pick-output-folder"),
  pickArtwork: () => ipcRenderer.invoke("pick-artwork"),
  convertTracks: (tracks, options) => ipcRenderer.invoke("convert-tracks", tracks, options),
  previewTrack: (track, mode) => ipcRenderer.invoke("preview-track", track, mode),
  analyzeWaveform: (payload) => ipcRenderer.invoke("analyze-waveform", payload),
  stopPreview: () => ipcRenderer.invoke("stop-preview"),
  openPath: (targetPath) => ipcRenderer.invoke("open-path", targetPath),
  onConvertProgress: (callback) => {
    ipcRenderer.on("convert-progress", (_event, payload) => callback(payload));
  }
});
