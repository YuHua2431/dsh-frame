"use strict";

/**
 * The frame document's only bridge to the main process.
 *
 * Deliberately tiny: the frame is chrome, not a plugin host. It may ask for its
 * own state, run a handful of allowlisted commands, and receive frame updates.
 * Nothing else crosses, and the official DSH page never sees this bridge — it is
 * a different `WebContentsView` with a different preload.
 */

const { contextBridge, ipcRenderer } = require("electron");

const COMMAND_CHANNEL = "dsh-shell:chrome";
const FRAME_CHANNEL = "dsh-shell:frame";

contextBridge.exposeInMainWorld("dshShell", {
  /** Run one allowlisted command; the main process validates the sender. */
  invoke: (command) => ipcRenderer.invoke(COMMAND_CHANNEL, String(command)),
  /** Subscribe to frame state (`{ dark, background, title }`); returns an unsubscribe. */
  onFrameState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on(FRAME_CHANNEL, handler);
    return () => ipcRenderer.removeListener(FRAME_CHANNEL, handler);
  },
});
