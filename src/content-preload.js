"use strict";

/**
 * The bridge the shell's own pages use — and only those.
 *
 * This preload is attached to the *view*, and that same view is where the
 * official DSH page lives. It must therefore never hand the official page — or
 * any third-party client plugin running inside it — a way into the main process.
 *
 * So it does nothing unless the document is one of the shell's own `data:` pages,
 * and the main process validates the same thing a second time on its own side.
 */

const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "dsh-shell:recovery";

function isShellPage() {
  try {
    return String(window.location.protocol) === "data:";
  } catch {
    return false;
  }
}

if (isShellPage()) {
  contextBridge.exposeInMainWorld("dshRecovery", {
    restart: () => ipcRenderer.invoke(CHANNEL, "restart"),
    plugins: () => ipcRenderer.invoke(CHANNEL, "plugins"),
    back: () => ipcRenderer.invoke(CHANNEL, "back"),
    disable: (name) => ipcRenderer.invoke(CHANNEL, "disable", String(name)),
    enable: (name) => ipcRenderer.invoke(CHANNEL, "enable", String(name)),
    openLog: () => ipcRenderer.invoke(CHANNEL, "open-log"),
    openProfile: () => ipcRenderer.invoke(CHANNEL, "open-profile"),
  });
}
