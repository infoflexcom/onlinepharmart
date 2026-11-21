"use strict";

// buildstudio/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("studio", {
  settings: {
    read: () => import_electron.ipcRenderer.invoke("settings:read"),
    write: (settings) => import_electron.ipcRenderer.invoke("settings:write", settings)
  },
  dialog: {
    pickFolder: (current) => import_electron.ipcRenderer.invoke("dialog:pick-folder", current),
    pickFile: (title) => import_electron.ipcRenderer.invoke("dialog:pick-file", title),
    savePrivateKey: (pem, keyId) => import_electron.ipcRenderer.invoke("dialog:save-private-key", pem, keyId)
  },
  project: { detect: (folder) => import_electron.ipcRenderer.invoke("project:detect", folder) },
  check: { run: () => import_electron.ipcRenderer.invoke("check:run") },
  tools: { install: (ids) => import_electron.ipcRenderer.invoke("tools:install", ids) },
  build: {
    run: (group) => import_electron.ipcRenderer.invoke("build:run", group),
    cancel: () => import_electron.ipcRenderer.invoke("build:cancel"),
    onStep: (handler) => {
      const listener = (_event, step) => handler(step);
      import_electron.ipcRenderer.on("build:step", listener);
      return () => import_electron.ipcRenderer.removeListener("build:step", listener);
    },
    onProgress: (handler) => {
      const listener = (_event, value) => handler(value);
      import_electron.ipcRenderer.on("build:progress", listener);
      return () => import_electron.ipcRenderer.removeListener("build:progress", listener);
    }
  },
  artefacts: {
    verify: () => import_electron.ipcRenderer.invoke("artefacts:verify"),
    openFolder: () => import_electron.ipcRenderer.invoke("artefacts:open-folder"),
    copyToDrive: (path) => import_electron.ipcRenderer.invoke("artefacts:copy-to-drive", path)
  },
  drives: { list: () => import_electron.ipcRenderer.invoke("drives:list") },
  vendor: {
    unlock: (password) => import_electron.ipcRenderer.invoke("vendor:unlock", password),
    generateKeys: (keyId) => import_electron.ipcRenderer.invoke("vendor:generate-keys", keyId)
  },
  log: {
    path: () => import_electron.ipcRenderer.invoke("log:path"),
    open: () => import_electron.ipcRenderer.invoke("log:open"),
    copy: () => import_electron.ipcRenderer.invoke("log:copy"),
    onLine: (handler) => {
      const listener = (_event, line) => handler(line);
      import_electron.ipcRenderer.on("log:line", listener);
      return () => import_electron.ipcRenderer.removeListener("log:line", listener);
    }
  },
  app: {
    info: () => import_electron.ipcRenderer.invoke("app:info"),
    currencies: () => import_electron.ipcRenderer.invoke("app:currencies"),
    openPolicyPage: () => import_electron.ipcRenderer.invoke("app:open-policy-page")
  }
});
