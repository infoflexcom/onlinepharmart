import { contextBridge, ipcRenderer } from 'electron'

/**
 * The one bridge between the window and the build machine.
 *
 * The window never gets `require`, never gets Node, and never gets a path to the filesystem: it can only call the
 * functions listed here. That matters more than usual for a build tool, because the window displays output from
 * npm and from installers, and a window with Node access showing outside text is how a build machine gets taken
 * over by something a log line contains.
 */
contextBridge.exposeInMainWorld('studio', {
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (settings: unknown) => ipcRenderer.invoke('settings:write', settings),
  },
  dialog: {
    pickFolder: (current: string | null) => ipcRenderer.invoke('dialog:pick-folder', current),
    pickFile: (title: string) => ipcRenderer.invoke('dialog:pick-file', title),
    savePrivateKey: (pem: string, keyId: string) => ipcRenderer.invoke('dialog:save-private-key', pem, keyId),
  },
  project: { detect: (folder: string) => ipcRenderer.invoke('project:detect', folder) },
  check: { run: () => ipcRenderer.invoke('check:run') },
  tools: { install: (ids: string[]) => ipcRenderer.invoke('tools:install', ids) },
  build: {
    run: (group: string) => ipcRenderer.invoke('build:run', group),
    cancel: () => ipcRenderer.invoke('build:cancel'),
    onStep: (handler: (step: unknown) => void) => {
      // The listener is registered once per window; returning a remover keeps a re-render from stacking them.
      const listener = (_event: unknown, step: unknown): void => handler(step)
      ipcRenderer.on('build:step', listener)
      return () => ipcRenderer.removeListener('build:step', listener)
    },
    onProgress: (handler: (value: unknown) => void) => {
      const listener = (_event: unknown, value: unknown): void => handler(value)
      ipcRenderer.on('build:progress', listener)
      return () => ipcRenderer.removeListener('build:progress', listener)
    },
  },
  artefacts: {
    verify: () => ipcRenderer.invoke('artefacts:verify'),
    openFolder: () => ipcRenderer.invoke('artefacts:open-folder'),
    copyToDrive: (path: string) => ipcRenderer.invoke('artefacts:copy-to-drive', path),
  },
  drives: { list: () => ipcRenderer.invoke('drives:list') },
  vendor: {
    unlock: (password: string) => ipcRenderer.invoke('vendor:unlock', password),
    generateKeys: (keyId: string) => ipcRenderer.invoke('vendor:generate-keys', keyId),
  },
  log: {
    path: () => ipcRenderer.invoke('log:path'),
    open: () => ipcRenderer.invoke('log:open'),
    copy: () => ipcRenderer.invoke('log:copy'),
    onLine: (handler: (line: string) => void) => {
      const listener = (_event: unknown, line: string): void => handler(line)
      ipcRenderer.on('log:line', listener)
      return () => ipcRenderer.removeListener('log:line', listener)
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    currencies: () => ipcRenderer.invoke('app:currencies'),
  },
})
