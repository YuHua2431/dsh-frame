"use strict";

/**
 * The two-view window shell.
 *
 * A `BrowserWindow` whose own document is never loaded hosts two child views:
 * the official DSH page below, and the 36px immersive frame above. The frame is
 * loaded with `loadFile()` and its IPC handler is pinned to that exact file URL,
 * so serving the frame over HTTP (or adding a query string) fails closed rather
 * than silently losing every command.
 */

const { pathToFileURL } = require("node:url");
const { app, ipcMain, nativeTheme, WebContentsView } = require("electron");

const { contentBounds, chromeBounds, framePadding, captionReserve } = require("./window-chrome");

const COMMAND_CHANNEL = "dsh-shell:chrome";
const FRAME_CHANNEL = "dsh-shell:frame";

/**
 * The only commands the frame may run.
 *
 * `state` keeps the frame drawn; `restart` is the shell's own restart affordance
 * in the title row. Everything else the frame once exposed (reload / browser /
 * devtools) lives in the tray menu instead.
 */
const COMMANDS = new Set(["state", "restart"]);

class ShellViews {
  constructor(options) {
    this.window = options.window;
    this.chromeFile = options.chromeFile;
    this.chromePreload = options.chromePreload;
    this.contentPreload = options.contentPreload;
    this.product = options.product || "DSH";
    /** Handled outside this module: commands the shell (not the frame) owns. */
    this.onCommand = options.onCommand;
    this.content = null;
    this.chrome = null;
    this.expanded = false;
    this.frameState = { dark: false, background: "", title: "", sidebarFill: "", sidebarWidth: 0, sidebarBorder: "" };
    this.disposers = [];
  }

  /**
   * Create both views, order them content-then-frame, and start the frame.
   * @returns {Electron.WebContents} the official DSH page's web contents.
   */
  mount() {
    const window = this.window;

    const contentPreferences = {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Keep painting while the window is being resized.
      backgroundThrottling: false,
    };
    // This preload exposes the recovery bridge to the shell's own `data:` pages
    // only; it deliberately declines on the official DSH page, which shares this
    // view. See `content-preload.js`.
    if (this.contentPreload) contentPreferences.preload = this.contentPreload;
    this.content = new WebContentsView({ webPreferences: contentPreferences });

    this.chrome = new WebContentsView({
      webPreferences: {
        preload: this.chromePreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    try {
      this.chrome.setBackgroundColor("#00000000");
    } catch {}

    // Order is what puts the frame on top; z-index inside either document is
    // irrelevant across views.
    window.contentView.addChildView(this.content);
    window.contentView.addChildView(this.chrome);

    this.chromeFileUrl = pathToFileURL(this.chromeFile).href;
    this.chrome.webContents.loadFile(this.chromeFile);

    this.wireWindow();
    this.wireCommands();
    this.wireFrameState();
    this.layout();

    return this.content.webContents;
  }

  /** Lay both views out for the window's current content size. */
  layout() {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    // A minimized window reports an empty client area; resizing then flashes a
    // zero-height band on restore.
    if (window.isMinimized()) return;
    const [width, height] = window.getContentSize();
    // Transient degenerate sizes during minimize/restore do the same.
    if (height <= 36) return;
    if (this.content) this.content.setBounds(contentBounds(width, height));
    if (this.chrome) this.chrome.setBounds(chromeBounds(width, height, this.expanded));
  }

  /** Grow the frame over the whole window so an in-frame popup is not clipped. */
  setExpanded(expanded) {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.layout();
  }

  loadContent(url) {
    return this.content.webContents.loadURL(url);
  }

  /** Merge a frame-state patch and push it if anything actually changed. */
  setFrameState(patch) {
    const next = { ...this.frameState, ...patch };
    if (
      next.dark === this.frameState.dark &&
      next.background === this.frameState.background &&
      next.title === this.frameState.title &&
      next.sidebarFill === this.frameState.sidebarFill &&
      next.sidebarWidth === this.frameState.sidebarWidth &&
      next.sidebarBorder === this.frameState.sidebarBorder
    ) {
      return;
    }
    this.frameState = next;
    if (this.chrome && !this.chrome.webContents.isDestroyed()) {
      this.chrome.webContents.send(FRAME_CHANNEL, this.frameState);
    }
  }

  setTitle(title) {
    this.setFrameState({ title });
  }

  /** Real title bar state the frame needs to render itself. */
  state() {
    return {
      platform: process.platform,
      product: this.product,
      version: app.getVersion(),
      padding: framePadding(process.platform),
      captionReserve: captionReserve(process.platform),
      ...this.frameState,
    };
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  wireWindow() {
    const window = this.window;
    let scheduled = false;
    const relayout = () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        this.layout();
      });
    };
    for (const event of ["resize", "restore", "show", "enter-full-screen", "leave-full-screen"]) {
      window.on(event, relayout);
      this.disposers.push(() => window.off(event, relayout));
    }
    // A frame that stayed expanded while the window lost focus would swallow
    // clicks meant for the page underneath.
    const collapse = () => this.setExpanded(false);
    for (const event of ["blur", "hide"]) {
      window.on(event, collapse);
      this.disposers.push(() => window.off(event, collapse));
    }
    if (this.chrome) {
      this.chrome.webContents.on("did-start-loading", collapse);
      this.chrome.webContents.on("render-process-gone", collapse);
    }
  }

  wireCommands() {
    ipcMain.handle(COMMAND_CHANNEL, (event, command) => {
      // Fail closed: only this frame view, only its main frame, only its file URL.
      if (!this.chrome || event.sender !== this.chrome.webContents) {
        throw new Error("dsh-shell: untrusted frame sender");
      }
      if (!event.senderFrame || event.senderFrame !== this.chrome.webContents.mainFrame) {
        throw new Error("dsh-shell: untrusted frame");
      }
      if (event.senderFrame.url !== this.chromeFileUrl) {
        throw new Error("dsh-shell: untrusted frame origin");
      }
      if (typeof command !== "string" || !COMMANDS.has(command)) {
        throw new Error("dsh-shell: unsupported command");
      }
      return this.run(command);
    });
    this.disposers.push(() => ipcMain.removeHandler(COMMAND_CHANNEL));
  }

  run(command) {
    switch (command) {
      case "state":
        return this.state();
      case "restart":
        // Owned by the shell: it knows how to stop and respawn the service.
        if (typeof this.onCommand === "function") return this.onCommand("restart");
        throw new Error("dsh-shell: no restart handler is installed");
      default:
        throw new Error("dsh-shell: unsupported command");
    }
  }

  wireFrameState() {
    const apply = () => {
      const dark = nativeTheme.shouldUseDarkColors;
      this.setFrameState({ dark });
      // The window's own background shows for a moment at startup and while the
      // views are laid out; keep it on the same palette as the frame.
      try {
        this.window.setBackgroundColor(dark ? "#17181c" : "#f4f5f7");
      } catch {}
    };
    nativeTheme.on("updated", apply);
    this.disposers.push(() => nativeTheme.off("updated", apply));
    apply();
  }

  /** Remove every listener, both views, and the IPC handler. */
  destroy() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
    const window = this.window;
    for (const view of [this.chrome, this.content]) {
      if (!view) continue;
      try {
        window.contentView.removeChildView(view);
      } catch {}
      try {
        const contents = view.webContents;
        if (typeof contents.close === "function") contents.close({ waitForBeforeUnload: false });
        else contents.destroy();
      } catch {}
    }
    this.chrome = null;
    this.content = null;
  }
}

module.exports = { ShellViews, COMMAND_CHANNEL, FRAME_CHANNEL };
