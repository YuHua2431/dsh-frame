"use strict";

/**
 * DSH Desktop (official runtime).
 *
 * A thin Electron shell: it owns the native window and the tray, starts the
 * officially installed `@deepseek-ai/dsh` web server in the background, and
 * points a sandboxed BrowserWindow at that server's loopback URL. No renderer
 * IPC plugin system, no Electron API exposed to the page, no vendored runtime.
 */

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { findDsh, findNode } = require("./runtime-locator");
const { DshServer } = require("./server-manager");
const { ShellViews } = require("./shell-views");
const { frameWindowOptions } = require("./window-chrome");
const { listPlugins, resolveProfileDir, setEnabled, suspectsFromLog, hasPluginMarket, dshHome } = require("./dsh-profile");
const { MARKET_KEY, MARKET_NAMESPACE, setSetting } = require("./dsh-settings");

const APP_ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(APP_ROOT, "assets");
const APP_ID = "local.dsh.desktop.official";

const DEFAULT_SETTINGS = {
  port: 3080,
  host: "127.0.0.1",
  dshBin: "",
  nodeBin: "",
  workspace: "",
  // Window close ends the app by default. The DSH service is detached and is
  // re-adopted on the next launch, so quitting costs nothing — and it stops a
  // closed window from stranding the app behind a tray icon the user may not
  // be able to find.
  minimizeToTray: false,
  startMinimized: false,
  openAtLogin: false,
  balloonShown: false,
  // Which DSH profile the shell composes, and an optional directory override.
  profile: "web",
  profileDir: "",
  // When false (the default) the shell asserts the market's own
  // `allowRestart: false` before every start, so the market cannot restart the
  // harness out from under it.
  allowMarketRestart: false,
};

let settings = { ...DEFAULT_SETTINGS };
let mainWindow = null;
let views = null;
let tray = null;
let server = null;
let quitting = false;
let stopServiceOnQuit = false;
let stoppingService = false;

// ── settings ────────────────────────────────────────────────────────────────

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function logFilePath() {
  return path.join(app.getPath("userData"), "logs", "dsh-server.log");
}

function appLogPath() {
  return path.join(app.getPath("userData"), "logs", "app.log");
}

/** Records the running service so a later launch re-adopts it instead of duplicating. */
function stateFilePath() {
  return path.join(app.getPath("userData"), "server.json");
}

/** Everything the window does lands here, so a black screen is diagnosable. */
function appLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(appLogPath()), { recursive: true });
    fs.appendFileSync(appLogPath(), line);
  } catch {}
  if (!app.isPackaged) process.stdout.write(line);
}

function loadSettings() {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    settings = { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("could not persist settings", error);
  }
}

// ── pages shown before / instead of the real UI ─────────────────────────────

/**
 * A shell-owned page shown before (or instead of) the real UI.
 *
 * Colours follow the OS theme through `prefers-color-scheme` and reuse the
 * frame's palette (chrome.css), so the splash, the 36px frame and the eventual
 * DSH page never flash three different backgrounds.
 */
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function page(body, script = "") {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f5f7; --fg: #1f2329; --muted: #6b7280;
    --panel: #ffffff; --border: rgba(0, 0, 0, 0.08); --track: #e3e5e9;
    --brand: #4d6bfe; --danger: #d0343a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181c; --fg: #e8e9ec; --muted: #9aa0aa;
      --panel: #1e1f24; --border: rgba(255, 255, 255, 0.12); --track: #2a2b31;
      --brand: #6b83ff; --danger: #ff6369;
    }
  }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
         box-sizing: border-box; padding: 28px;
         background: var(--bg); color: var(--fg);
         font: 14px/1.7 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .spinner { width: 30px; height: 30px; border-radius: 50%; border: 3px solid var(--track); border-top-color: var(--brand);
             animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .muted { color: var(--muted); max-width: 720px; text-align: center; }
  pre { max-width: min(880px, 92vw); max-height: 38vh; overflow: auto; padding: 12px 14px; border-radius: 10px;
        border: 1px solid var(--border); background: var(--panel); color: var(--fg);
        font-size: 12px; text-align: left; white-space: pre-wrap; }
  h1 { font-size: 17px; font-weight: 600; margin: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; width: 100%; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border);
           background: var(--panel); color: var(--fg); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
  button:disabled { opacity: .45; cursor: default; }
  table { border-collapse: collapse; width: min(880px, 92vw); font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  td.acts { text-align: right; white-space: nowrap; }
  tr.suspect { background: rgba(208, 52, 58, .12); }
  tr.suspect td { color: var(--danger); }
  .badge { color: var(--muted); font-size: 12px; }
  tr.suspect .badge { color: inherit; }
</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`)}`;
}

function bootPage(message) {
  return page(`<div class="spinner"></div><h1>正在启动 DeepSeek Harness…</h1><p class="muted">${escapeHtml(message)}</p>`);
}

/**
 * The failure page.
 *
 * Two actions, because those are the two things a user can actually do about a
 * failed boot: retry it, or go look at what the profile is composing.
 *
 * `pluginsUnavailable` is empty when the list is worth offering, and otherwise
 * carries the reason to show instead of the button — a button that could only
 * fail, or that would open an empty list, is worse than no button.
 *
 * The buttons only work on the shell's own pages; the bridge is not exposed to
 * the official DSH page, which shares this view.
 */
function errorPage(message, details, pluginsUnavailable = "") {
  const showPlugins = !pluginsUnavailable;
  const script = `
    const api = window.dshRecovery;
    const restart = document.getElementById('restart');
    const plugins = document.getElementById('plugins');
    if (!api) {
      for (const button of document.querySelectorAll('button')) button.disabled = true;
      document.getElementById('nobridge').hidden = false;
    } else {
      restart.onclick = async () => { restart.disabled = true; restart.textContent = '正在重启…'; await api.restart(); };
      if (plugins) plugins.onclick = async () => { plugins.disabled = true; await api.plugins(); };
    }
  `;
  return page(
    `<h1>启动失败</h1><p class="muted">${escapeHtml(message)}</p>` +
      (details ? `<pre>${escapeHtml(details)}</pre>` : "") +
      `<div class="actions">
         <button id="restart" type="button">重启 DSH 服务</button>
         ${showPlugins ? `<button id="plugins" type="button">打开插件列表</button>` : ""}
       </div>` +
      (showPlugins ? "" : `<p class="muted">${escapeHtml(pluginsUnavailable)}</p>`) +
      `<p class="muted" id="nobridge" hidden>恢复操作不可用（页面桥未就绪），请先查看日志。</p>`,
    script,
  );
}

/** The profile's plugins, with whatever the server log blamed marked in red. */
function pluginListPage(plugins, suspects, note) {
  const rows = plugins
    .map((plugin) => {
      const blamed = suspects.has(plugin.name);
      const action = plugin.official
        ? `<span class="badge">官方 bundle</span>`
        : `<button type="button" data-name="${escapeHtml(plugin.name)}" data-enable="${plugin.enabled ? "0" : "1"}">${
            plugin.enabled ? "禁用" : "启用"
          }</button>`;
      return `<tr class="${blamed ? "suspect" : ""}">
        <td>${escapeHtml(plugin.name)}</td>
        <td class="badge">${escapeHtml(plugin.version || "")}</td>
        <td class="badge">${plugin.enabled ? "已启用" : "已禁用"}</td>
        <td class="badge">${blamed ? "日志指向它" : ""}</td>
        <td class="acts">${action}</td>
      </tr>`;
    })
    .join("");
  const script = `
    const api = window.dshRecovery;
    for (const button of document.querySelectorAll('button[data-name]')) {
      button.onclick = async () => {
        button.disabled = true;
        if (button.dataset.enable === '1') await api.enable(button.dataset.name);
        else await api.disable(button.dataset.name);
      };
    }
    const back = document.getElementById('back');
    back.onclick = async () => { back.disabled = true; await api.back(); };
    const log = document.getElementById('log');
    log.onclick = () => api.openLog();
    const folder = document.getElementById('folder');
    folder.onclick = () => api.openProfile();
  `;
  return page(
    `<h1>插件列表</h1>` +
      `<p class="muted">${
        escapeHtml(note) ||
        "红行是日志里点到的可疑对象。禁用只是把它从 bundle 栈里摘掉（依赖仍然装着），可随时启用；改完点「返回」，再点「重启 DSH 服务」。"
      }</p>` +
      `<table><thead><tr><th>插件</th><th>版本</th><th>状态</th><th>诊断</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
      `<div class="actions">
         <button id="back" type="button">返回</button>
         <button id="log" type="button">打开日志</button>
         <button id="folder" type="button">打开 profile 目录</button>
       </div>`,
    script,
  );
}

/**
 * Remember and show the failure page.
 *
 * The message is kept because the plugin list and the failure page are the same
 * document: "返回" has to restore this page, and it must not restart anything.
 */
let lastFailure = { message: "", details: "" };

async function showFailure(message, details = "") {
  lastFailure = { message: String(message || ""), details: String(details || "") };
  // The list is offered only when there is something in it: official bundles are
  // not the user's to disable, so a profile with none of its own has nothing to
  // list — and a profile that cannot be read has nothing to show either.
  let pluginsUnavailable = "";
  try {
    const plugins = listPlugins(activeProfileDir());
    if (!plugins.some((plugin) => !plugin.official)) {
      pluginsUnavailable = "这个 profile 里没有第三方插件，没有可禁用的对象。";
    }
  } catch {
    pluginsUnavailable = "读不到 profile 的插件清单，暂时只能重启服务。";
  }
  appLog(`failure page: plugins=${pluginsUnavailable || "available"} ${lastFailure.message}`);
  return loadPage(errorPage(lastFailure.message, lastFailure.details, pluginsUnavailable));
}

// ── the DSH server ──────────────────────────────────────────────────────────

async function startServer() {
  const runtime = findDsh({ appRoot: APP_ROOT, override: settings.dshBin });
  if (!runtime) {
    throw new Error(
      "没有找到官方 @deepseek-ai/dsh。请先安装：npm i -g @deepseek-ai/dsh，或在设置里指定 CLI 入口。",
    );
  }
  const nodeBin = settings.nodeBin || findNode();
  if (!nodeBin) {
    throw new Error("没有找到 Node.js（DSH 需要 Node ^22.19 或 >=24）。请安装 Node 后重试。");
  }

  server = new DshServer({
    host: settings.host,
    port: settings.port,
    nodeBin,
    dshBin: runtime.dshBin,
    workspace: settings.workspace,
    profile: settings.profile,
    logFile: logFilePath(),
    stateFile: stateFilePath(),
  });
  server.runtime = runtime;

  server.on("exit", ({ code, signal }) => {
    if (quitting || stoppingService) return;
    const detail = code === null && signal ? `signal ${signal}` : `exit code ${code}`;
    appLog(`server exited (${detail})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      showFailure(`DSH 服务已退出（${detail}）。`, tailLog());
    }
    refreshTray();
  });

  // Before the harness starts: a running harness rewrites settings.yaml from
  // memory, so an assertion made afterwards would be lost.
  applyMarketRestartPolicy();

  const mode = await server.start();
  appLog(`server ready mode=${mode} url=${server.url ? `${server.host}:${server.port}` : "?"}`);
  return mode;
}

function tailLog(lines = 40) {
  try {
    return fs.readFileSync(logFilePath(), "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Keep the plugin market from restarting the harness out from under the shell.
 *
 * `dshmarket` restarts the process it runs in to make pending plugin changes
 * take effect: it spawns a replacement and SIGTERMs itself
 * (`dshmarket/lib/restart.js`). That is right for a host nobody supervises, and
 * wrong here — it launches a second server on the same port and hands the shell
 * a process it did not start.
 *
 * The market documents the answer itself: `allowRestart: false` is "the
 * documented answer for a host owned by systemd, launchd or pm2 — a supervisor
 * restarts it, so the market's one-click restart must not launch a second one".
 * Its restart route enforces it with a 403, and reads the value per request.
 *
 * Asserted before every start, never only once: the value is ordinary settings
 * state, so a fresh DSH home, a deleted settings file or a reinstall would
 * otherwise silently bring the self-restart back. `allowMarketRestart` is the
 * one door that lets it through, and it is the user's to open.
 */
function applyMarketRestartPolicy() {
  if (!hasPluginMarket(activeProfileDir())) {
    appLog("market restart policy: dshmarket is not composed in this profile; nothing to assert");
    return { skipped: "no-market" };
  }
  const allow = Boolean(settings.allowMarketRestart);
  const result = setSetting(dshHome(), MARKET_NAMESPACE, MARKET_KEY, allow ? "true" : "false");
  appLog(`market restart policy: allowRestart=${allow} -> ${JSON.stringify(result)}`);
  return result;
}

/**
 * An unauthenticated request gets a plain-text 401 whose default black text is
 * invisible on the shell's dark background — the "black screen". Surface it as
 * an actionable page instead, and leave the page text in app.log either way.
 */
async function guardAuthentication() {
  const contents = pageContents();
  if (!contents) return;
  let text = "";
  try {
    text = await contents.executeJavaScript("document.body ? document.body.innerText : ''");
  } catch (error) {
    appLog(`auth check failed: ${error.message}`);
    return;
  }
  appLog(`page text ${text.length} chars: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  if (/authentication required/i.test(text)) {
    await showFailure(
      "服务拒绝了这次访问：没有拿到本次启动的 launch token。",
      `服务地址：${server ? `${server.host}:${server.port}` : "unknown"}\n\n` + readTail(logFilePath(), 20),
    );
    return;
  }
  await sampleContentTheme();
}

/**
 * Match the frame to the page it sits above.
 *
 * Two things are sampled from the live page:
 *
 *  - the page background, and the sidebar column's fill plus its width, so the
 *    frame can continue the sidebar's colour up into the title row;
 *  - nothing about class names: they are hashed per build (`pI_x6G_sidebarCol`).
 *    The column is found by colour and geometry instead, using the official
 *    `--dsw-specific-sidebar-fill` token, whose own description is "Sidebar
 *    column and title-row background".
 */
async function sampleContentTheme() {
  const contents = pageContents();
  if (!contents || !views) return;
  let sample = null;
  try {
    sample = await contents.executeJavaScript(`(() => {
      const painted = (element) => {
        if (!element) return "";
        const colour = getComputedStyle(element).backgroundColor;
        return colour && colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent" ? colour : "";
      };
      const toRgb = (value) => {
        const text = String(value).trim();
        const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (hex) {
          let digits = hex[1];
          if (digits.length === 3) digits = digits.split("").map((c) => c + c).join("");
          return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)).join(",");
        }
        const numbers = text.match(/\\d+/g);
        return numbers ? numbers.slice(0, 3).join(",") : "";
      };

      const bodyStyle = document.body ? getComputedStyle(document.body) : null;
      const token = bodyStyle ? bodyStyle.getPropertyValue("--dsw-specific-sidebar-fill").trim() : "";
      const background = painted(document.documentElement) || painted(document.body) || "";

      let sidebarWidth = 0;
      let sidebarFill = "";
      let sidebarBorder = "";
      const wanted = toRgb(token);
      if (wanted) {
        const viewportHeight = innerHeight;
        for (const element of document.querySelectorAll("body *")) {
          const rect = element.getBoundingClientRect();
          if (rect.x > 12 || rect.width < 24 || rect.height < viewportHeight * 0.5) continue;
          const style = getComputedStyle(element);
          if (toRgb(style.backgroundColor) !== wanted) continue;
          sidebarWidth = Math.round(rect.width);
          sidebarFill = style.backgroundColor;
          // Carry the column's own right edge so the band does not end 1px early.
          const edge = parseFloat(style.borderRightWidth) || 0;
          if (edge > 0) sidebarBorder = edge + "px solid " + style.borderRightColor;
          break;
        }
      }
      return { background, sidebarFill, sidebarWidth, sidebarBorder };
    })()`);
  } catch {
    return;
  }
  if (!sample || !sample.background) return;
  const parts = String(sample.background).match(/\d+(?:\.\d+)?/g) || [];
  const [r, g, b] = parts.map(Number);
  if (![r, g, b].every((value) => Number.isFinite(value))) return;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  views.setFrameState({
    dark: luminance < 140,
    background: sample.background,
    sidebarFill: sample.sidebarFill || "",
    sidebarWidth: Number.isFinite(sample.sidebarWidth) ? sample.sidebarWidth : 0,
    sidebarBorder: sample.sidebarBorder || "",
  });
}

// ── window ──────────────────────────────────────────────────────────────────

/** The official DSH page's web contents — the only document that is "the app". */
function pageContents() {
  if (!views || !views.content) return null;
  const contents = views.content.webContents;
  return contents.isDestroyed() ? null : contents;
}

/** Load something into the page view (the window's own document stays unused). */
function loadPage(url) {
  const contents = pageContents();
  return contents ? contents.loadURL(url) : Promise.resolve();
}

function iconPath(name) {
  const candidate = path.join(ASSETS_DIR, name);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: "#202124",
    title: "DSH",
    icon: iconPath("icon.ico"),
    // The window's own document is never loaded; it only hosts the two views.
    ...frameWindowOptions(),
  });

  // Two sibling views: the official DSH page below, the immersive frame above.
  views = new ShellViews({
    window: mainWindow,
    chromeFile: path.join(__dirname, "chrome.html"),
    chromePreload: path.join(__dirname, "chrome-preload.js"),
    contentPreload: path.join(__dirname, "content-preload.js"),
    product: "DSH",
    // The frame's restart button is the shell's own: it stops and respawns the
    // service rather than reloading the page.
    onCommand: (command) => (command === "restart" ? restartServer().then(() => ({ ok: true })) : undefined),
  });
  const contents = views.mount();

  // `ready-to-show` belongs to the window's own (unused) document, so the window
  // is revealed by the page's first paint instead, with a timer as a backstop.
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (!settings.startMinimized) showWindow();
  };
  contents.once("did-finish-load", reveal);
  setTimeout(reveal, 2000);

  mainWindow.on("close", (event) => {
    appLog("window close requested");
    if (quitting || !settings.minimizeToTray) return;
    event.preventDefault();
    mainWindow.hide();
    // Tell the user every time, not only once: otherwise closing the window
    // looks exactly like quitting while the shell keeps running in the tray.
    if (tray) {
      try {
        tray.displayBalloon({ title: "DSH 仍在后台运行", content: "窗口已收进托盘；要真正退出，请右键托盘图标选择「退出并停止服务」。" });
      } catch {}
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isOwnUrl(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isOwnUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = (input.key || "").toLowerCase();
    if (input.key === "F12" || (input.control && input.shift && key === "i")) {
      contents.toggleDevTools();
      event.preventDefault();
      return;
    }
    if (input.key === "F11") {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
      return;
    }
    if (!input.control) return;
    if (key === "r") {
      contents.reloadIgnoringCache();
      event.preventDefault();
    } else if (key === "0") {
      contents.setZoomLevel(0);
      event.preventDefault();
    } else if (key === "=" || key === "+") {
      contents.setZoomLevel(contents.getZoomLevel() + 0.5);
      event.preventDefault();
    } else if (key === "-") {
      contents.setZoomLevel(contents.getZoomLevel() - 0.5);
      event.preventDefault();
    }
  });

  attachDiagnostics(contents);

  loadPage(bootPage("正在准备官方 dsh 服务…"));
  appLog(`window created; loading boot page`);
}

/** Forward every load/renderer signal into app.log so failures are visible. */
function attachDiagnostics(contents) {
  contents.on("did-start-navigation", (_event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) appLog(`did-start-navigation ${url}`);
  });
  contents.on("did-finish-load", () => appLog(`did-finish-load ${contents.getURL()}`));
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    appLog(`did-fail-load code=${code} desc=${description} url=${url} mainFrame=${isMainFrame}`);
  });
  contents.on("did-fail-provisional-load", (_event, code, description, url, isMainFrame) => {
    appLog(`did-fail-provisional-load code=${code} desc=${description} url=${url} mainFrame=${isMainFrame}`);
  });
  contents.on("page-title-updated", (_event, title) => {
    appLog(`page-title-updated ${title}`);
    // The frame carries the page's own title, like a real title bar.
    if (views) views.setTitle(title);
  });
  contents.on("render-process-gone", (_event, details) => appLog(`render-process-gone ${JSON.stringify(details)}`));
  contents.on("unresponsive", () => appLog("unresponsive"));
  contents.on("responsive", () => appLog("responsive"));
  // Electron changed this signature across majors; accept both shapes.
  contents.on("console-message", (...args) => {
    const event = args[0];
    if (event && typeof event === "object" && typeof event.message === "string") {
      appLog(`console[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
      return;
    }
    appLog(`console[${args[1]}] ${args[2]} (${args[4]}:${args[3]})`);
  });
}

function isOwnUrl(url) {
  if (!server) return false;
  return url.startsWith(`http://${server.host}:${server.port}/`) || url.startsWith(`http://localhost:${server.port}/`);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow();
}

// ── tray ────────────────────────────────────────────────────────────────────

function createTray() {
  const image = trayIcon();
  appLog(
    `tray: image empty=${image.isEmpty()} size=${JSON.stringify(image.getSize())} ` +
      `png=${JSON.stringify(nativeImage.createFromPath(iconPath("tray.png") || "").getSize())} ` +
      `ico=${JSON.stringify(nativeImage.createFromPath(iconPath("tray.ico") || "").getSize())}`,
  );
  tray = new Tray(image);
  tray.setToolTip("DSH");
  tray.on("click", toggleWindow);
  tray.on("double-click", showWindow);
  refreshTray();
  appLog(`tray: created destroyed=${tray.isDestroyed()}`);
}

/**
 * A plain PNG, handed over unresized.
 *
 * The multi-frame `.ico` is only used if the PNG is missing: Chromium's ICO
 * decoder reports a surprising size for it (a 32px frame reads back as 256px),
 * and the notification area is the one place where a decoding quirk shows up as
 * "no icon at all" rather than as a cosmetic difference.
 *
 * `--dsh-tray-test` swaps in a solid red square. It settles whether a missing
 * tray icon is the artwork being too subtle or the shell hiding the icon — a
 * question no amount of inspecting our own image can answer.
 */
function trayIcon() {
  if (process.argv.includes("--dsh-tray-test")) {
    appLog("tray: using the --dsh-tray-test solid red square");
    return redSquareIcon(32);
  }
  const png = iconPath("tray.png");
  const source = png || iconPath("tray.ico");
  if (!source) {
    appLog("tray: no icon asset found");
    return nativeImage.createEmpty();
  }
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) appLog(`tray: could not decode ${source}`);
  return image;
}

/** A fully opaque red square, built in memory (BGRA, premultiplied is not needed for 255 alpha). */
function redSquareIcon(size) {
  const buffer = Buffer.alloc(size * size * 4);
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    buffer[pixel * 4 + 0] = 0x00; // blue
    buffer[pixel * 4 + 1] = 0x00; // green
    buffer[pixel * 4 + 2] = 0xff; // red
    buffer[pixel * 4 + 3] = 0xff; // alpha
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function refreshTray() {
  if (!tray) return;
  const status = !server
    ? "服务：未启动"
    : server.owned
      ? `服务：本应用启动（${server.host}:${server.port}）`
      : `服务：复用上次的服务（${server.host}:${server.port}）`;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: "separator" },
      { label: "显示 / 隐藏窗口", click: toggleWindow },
      { label: "重新加载界面", click: () => { const contents = pageContents(); if (contents) contents.reload(); } },
      { label: "复制服务地址", click: () => server && clipboard.writeText(server.url) },
      { label: "重启 DSH 服务", click: () => restartServer() },
      { type: "separator" },
      {
        label: "开机自启",
        type: "checkbox",
        checked: Boolean(settings.openAtLogin),
        click: (item) => {
          settings.openAtLogin = item.checked;
          saveSettings();
          app.setLoginItemSettings({ openAtLogin: item.checked, args: [] });
        },
      },
      {
        label: "关闭窗口时收进托盘",
        type: "checkbox",
        checked: Boolean(settings.minimizeToTray),
        click: (item) => {
          settings.minimizeToTray = item.checked;
          saveSettings();
          appLog(`minimizeToTray=${item.checked}`);
        },
      },
      // Only meaningful when a market is actually composed: without one nothing
      // in this profile can restart the harness on its own.
      ...(hasPluginMarket(activeProfileDir())
        ? [
            {
              label: "允许插件市场自重启",
              type: "checkbox",
              checked: Boolean(settings.allowMarketRestart),
              click: (item) => {
                settings.allowMarketRestart = item.checked;
                saveSettings();
                applyMarketRestartPolicy();
                if (tray) {
                  try {
                    tray.displayBalloon({
                      title: item.checked ? "已允许插件市场自重启" : "已阻止插件市场自重启",
                      content: "重启 DSH 服务后生效。",
                    });
                  } catch {}
                }
              },
            },
          ]
        : []),
      { label: "打开服务日志", click: () => shell.openPath(logFilePath()) },
      { type: "separator" },
      { label: "退出（保留后台服务）", click: () => quit(false) },
      { label: "退出并停止服务", click: () => quit(true) },
    ]),
  );
}

async function restartServer() {
  if (stoppingService) return;
  stoppingService = true;
  try {
    if (server) await server.stop();
    server = null;
    if (mainWindow && !mainWindow.isDestroyed()) loadPage(bootPage("正在重启官方 dsh 服务…"));
    await startServer();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await loadPage(server.url);
      await guardAuthentication();
    }
  } catch (error) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showFailure(error.message, tailLog());
    }
  } finally {
    stoppingService = false;
    refreshTray();
  }
}

/** Count non-transparent pixels: an all-zero result renders as nothing. */
function opaquePixels(image) {
  try {
    const bitmap = image.toBitmap();
    let visible = 0;
    for (let index = 3; index < bitmap.length; index += 4) {
      if (bitmap[index] > 8) visible += 1;
    }
    return visible;
  } catch (error) {
    return `error: ${error.message}`;
  }
}

function quit(stopService) {
  appLog(`quit requested (stopService=${stopService})`);
  quitting = true;
  stopServiceOnQuit = stopService;
  app.quit();
}

// ── recovery ────────────────────────────────────────────────────────────────

const RECOVERY_CHANNEL = "dsh-shell:recovery";

/** The profile the shell composes; `profileDir` overrides it outright. */
function activeProfileDir() {
  return resolveProfileDir(settings.profile, settings.profileDir);
}

/** The whole server log: suspect parsing wants every line, not just the tail. */
function readServerLog() {
  try {
    return fs.readFileSync(logFilePath(), "utf8");
  } catch {
    return "";
  }
}

/** Show the plugin list with the log's suspects marked. */
async function showPluginList(note = "") {
  let plugins = [];
  let suspects = new Set();
  let problem = "";
  try {
    plugins = listPlugins(activeProfileDir());
    suspects = suspectsFromLog(
      readServerLog(),
      plugins.map((plugin) => plugin.name),
    );
  } catch (error) {
    problem = `读取 profile 失败：${error.message}`;
  }
  appLog(`recovery: ${plugins.length} plugins, suspects=[${[...suspects].join(", ")}] ${problem}`);
  await loadPage(pluginListPage(plugins, suspects, problem || note));
  return { ok: !problem, plugins: plugins.length, suspects: [...suspects] };
}

/**
 * The recovery commands.
 *
 * Guarded twice: the sender must be the page view, *and* the document must be
 * one of the shell's own `data:` pages. Sender identity alone is not enough,
 * because that same view hosts the official DSH page — and the third-party
 * client plugins running inside it.
 */
function wireRecovery() {
  ipcMain.handle(RECOVERY_CHANNEL, async (event, command, argument) => {
    const contents = pageContents();
    if (!contents || event.sender !== contents) {
      throw new Error("dsh-shell: untrusted recovery sender");
    }
    const frameUrl = event.senderFrame ? event.senderFrame.url : "";
    if (!frameUrl.startsWith("data:")) {
      throw new Error("dsh-shell: recovery is unavailable on this document");
    }
    switch (String(command)) {
      case "restart":
        await restartServer();
        return { ok: true };
      case "plugins":
        return showPluginList();
      case "back":
        // Back to the failure page. Deliberately does not restart: restarting is
        // the failure page's other button, and the user may still want to change
        // something else first.
        await showFailure(lastFailure.message, lastFailure.details);
        return { ok: true };
      case "disable":
      case "enable": {
        const name = String(argument || "");
        let result;
        try {
          result = setEnabled(activeProfileDir(), name, command === "enable");
        } catch (error) {
          result = { ok: false, reason: `写入 profile 失败：${error.message}` };
        }
        appLog(`recovery: ${command} ${name} -> ${JSON.stringify(result)}`);
        await showPluginList(
          result.ok
            ? `${command === "enable" ? "已启用" : "已禁用"} ${name}。点「返回」，再点「重启 DSH 服务」。`
            : result.reason,
        );
        return result;
      }
      case "open-log":
        await shell.openPath(logFilePath());
        return { ok: true };
      case "open-profile":
        await shell.openPath(activeProfileDir());
        return { ok: true };
      default:
        throw new Error("dsh-shell: unsupported recovery command");
    }
  });
}

// ── headless self-check ─────────────────────────────────────────────────────

/**
 * `DSH.exe --dsh-selftest=<file>` resolves the official runtime, attaches to or
 * starts the server, probes it, writes a JSON report, and exits — no window, no
 * tray. Exit code 0 means the whole shell half of the pipeline works.
 */
async function runHeadlessSelftest(outFile) {
  const report = {
    app: app.getVersion(),
    electron: process.versions.electron,
    electronNode: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
  };
  let code = 0;
  try {
    loadSettings();
    report.settings = { ...settings };
    const runtime = findDsh({ appRoot: APP_ROOT, override: settings.dshBin });
    if (!runtime) throw new Error("official @deepseek-ai/dsh was not found");
    report.runtime = runtime;
    const nodeBin = settings.nodeBin || findNode();
    if (!nodeBin) throw new Error("Node.js was not found");
    report.nodeBin = nodeBin;

    const candidate = new DshServer({
      host: settings.host,
      port: settings.port,
      nodeBin,
      dshBin: runtime.dshBin,
      workspace: settings.workspace,
      logFile: logFilePath(),
      stateFile: stateFilePath(),
    });
    report.mode = await candidate.start({ timeoutMs: 90000 });
    report.url = candidate.url;
    report.probe = await probePort(candidate.host, candidate.port);
    if (!report.probe) throw new Error(`no answer on ${candidate.url}`);
    if (report.mode === "spawned") await candidate.stop();
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.message;
    report.logTail = tailLog(25);
    code = 1;
  }
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {}
  finishProcess(code);
}

/**
 * Leave the process the way a normal quit would.
 *
 * `app.exit()` tears the process down abruptly and leaves Chromium's helper
 * processes behind on Windows; those stragglers keep a handle on the app's own
 * directory, which then refuses to be replaced on the next build.
 */
function finishProcess(code) {
  process.exitCode = code;
  app.quit();
}

function probePort(host, port) {
  return new Promise((resolve) => {
    const request = require("node:http").get({ host, port, path: "/", timeout: 2000 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

// ── UI probe ────────────────────────────────────────────────────────────────

function readTail(file, lines) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * `DSH.exe --dsh-probe-ui=<file>` opens the real window, waits for the page to
 * settle, then reports what the renderer actually contains. A black screen gets
 * a cause instead of a guess.
 */
/** Read the frame document's rendered state; null when it has no live DOM. */
async function reportFrameDom() {
  if (!views || !views.chrome) return null;
  const contents = views.chrome.webContents;
  if (contents.isDestroyed()) return null;
  try {
    return await contents.executeJavaScript(`(() => {
      const frame = document.querySelector('.frame');
      const product = document.getElementById('product');
      const title = document.getElementById('title');
      const band = frame ? getComputedStyle(frame, '::before') : null;
      return {
        readyState: document.readyState,
        hasBody: Boolean(document.body),
        platform: document.body ? document.body.dataset.platform : null,
        theme: document.body ? document.body.dataset.theme : null,
        fill: document.body ? getComputedStyle(document.body).backgroundColor : null,
        frameHeight: frame ? Math.round(frame.getBoundingClientRect().height) : null,
        product: product ? product.textContent : null,
        title: title ? title.textContent : null,
        actions: document.querySelectorAll('.action').length,
        bridge: typeof window.dshShell === 'object',
        sidebarVarWidth: document.body ? document.body.style.getPropertyValue('--sidebar-width') : null,
        sidebarVarFill: document.body ? document.body.style.getPropertyValue('--sidebar-fill') : null,
        bandWidth: band ? band.width : null,
        bandFill: band ? band.backgroundColor : null,
        bandBorder: band ? band.borderRightWidth + ' ' + band.borderRightColor : null,
      };
    })()`);
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Ask the frame document to run a real command through the bridge.
 *
 * This exercises the URL-pinned IPC handler from the actual frame: if the packed
 * `loadFile()` URL does not match the pinned one, every command fails closed and
 * the frame's buttons do nothing — invisible without a check like this.
 */
async function reportFrameBridge() {
  if (!views || !views.chrome) return null;
  const contents = views.chrome.webContents;
  if (contents.isDestroyed()) return null;
  try {
    return await contents.executeJavaScript(`window.dshShell.invoke('state').then(
      (value) => ({ ok: true, platform: value && value.platform, padding: value && value.padding }),
      (error) => ({ ok: false, error: String((error && error.message) || error) })
    )`);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Sample the official page's column geometry.
 *
 * The sidebar's colour has an official token — `--dsw-specific-sidebar-fill`,
 * documented as "Sidebar column and title-row background" — so the frame can
 * match it without guessing at class names. What still has to be measured is how
 * wide the column is and which element is painted with that token.
 */
async function reportLayoutDom() {
  const contents = pageContents();
  if (!contents) return null;
  try {
    return await contents.executeJavaScript(`(() => {
      const TOKENS = ['--dsw-specific-sidebar-fill', '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2'];
      const readVars = (element) => {
        const style = getComputedStyle(element);
        const out = {};
        for (const name of TOKENS) out[name] = style.getPropertyValue(name).trim();
        return out;
      };
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          cls: typeof element.className === 'string' ? element.className.slice(0, 100) : null,
          id: element.id || null,
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
          bg: style.backgroundColor,
          token: style.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
        };
      };
      const vw = innerWidth;
      const vh = innerHeight;
      const leftColumn = [...document.querySelectorAll('body *')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 24 && rect.width < vw * 0.45 && rect.height >= vh * 0.5 && rect.x < 12;
      });
      const topLevel = [...document.body.children].flatMap((child) => [child, ...child.children]).slice(0, 24);
      return {
        htmlVars: readVars(document.documentElement),
        bodyVars: readVars(document.body),
        leftColumn: leftColumn.slice(0, 8).map(describe),
        topLevel: topLevel.map(describe),
        viewport: { vw, vh },
      };
    })()`);
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Read the splash's colours in both OS themes.
 *
 * The splash is what the content view shows before the real page, so a fixed
 * near-black there is very visible. This proves it follows the theme instead.
 */
async function reportSplashTheme() {
  const contents = pageContents();
  if (!contents) return null;
  const previous = nativeTheme.themeSource;
  const out = {};
  for (const source of ["light", "dark"]) {
    try {
      nativeTheme.themeSource = source;
      await contents.loadURL(bootPage("probe"));
      await new Promise((resolve) => setTimeout(resolve, 400));
      out[source] = await contents.executeJavaScript(
        "({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color })",
      );
    } catch (error) {
      out[source] = { error: error.message };
    }
  }
  nativeTheme.themeSource = previous;
  return out;
}

/**
 * Inspect the title-row restart button and then actually press it.
 *
 * Pressing it is the only way to know the frame's `restart` command reaches the
 * shell instead of being refused as unsupported, so this waits for the service
 * to come back and reports whether it did.
 */
async function reportRestartButton() {
  if (!views || !views.chrome) return null;
  const chrome = views.chrome.webContents;
  if (chrome.isDestroyed()) return null;
  let button = null;
  try {
    button = await chrome.executeJavaScript(`(() => {
      const element = document.getElementById('restart');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        rightOffset: Math.round(innerWidth - rect.right),
        color: style.color,
        background: style.backgroundColor,
        dragging: style.getPropertyValue('-webkit-app-region'),
        title: element.title,
      };
    })()`);
  } catch (error) {
    return { error: error.message };
  }
  if (!button) return { missing: true };

  const beforePort = server ? server.port : null;
  try {
    await chrome.executeJavaScript("document.getElementById('restart').click(); true");
  } catch (error) {
    return { ...button, clickError: error.message };
  }

  const deadline = Date.now() + 90000;
  let cameBack = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const contents = pageContents();
    if (!contents) break;
    const url = contents.getURL();
    if (!url.startsWith("http://")) continue;
    try {
      const text = await contents.executeJavaScript("document.body ? document.body.innerText.length : 0");
      if (text > 20) {
        cameBack = true;
        break;
      }
    } catch {}
  }
  return { ...button, beforePort, afterPort: server ? server.port : null, cameBack };
}

async function runUiProbe(outFile) {
  const report = {
    electron: process.versions.electron,
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
  };
  let code = 0;
  try {
    loadSettings();
    report.settings = { ...settings };
    const runtime = findDsh({ appRoot: APP_ROOT, override: settings.dshBin });
    if (!runtime) throw new Error("official @deepseek-ai/dsh was not found");
    report.runtime = runtime;
    const nodeBin = settings.nodeBin || findNode();
    report.nodeBin = nodeBin;

    server = new DshServer({
      host: settings.host,
      port: settings.port,
      nodeBin,
      dshBin: runtime.dshBin,
      workspace: settings.workspace,
      logFile: logFilePath(),
      stateFile: stateFilePath(),
    });
    report.mode = await server.start({ timeoutMs: 90000 });
    report.url = server.url;

    createWindow();
    // A window-less shell whose tray icon did not load is a zombie the user
    // cannot see or close, so the probe reports the icon's real state.
    const trayPath = iconPath("tray.ico") || iconPath("tray.png");
    let rawSize = null;
    let finalSize = null;
    let trayError = null;
    let rawVisible = null;
    let finalVisible = null;
    try {
      if (trayPath) {
        const raw = nativeImage.createFromPath(trayPath);
        rawSize = raw.getSize();
        rawVisible = opaquePixels(raw);
      }
      createTray();
      const final = trayIcon();
      finalSize = final.getSize();
      finalVisible = opaquePixels(final);
    } catch (error) {
      trayError = error.message;
    }
    report.tray = {
      assetsDir: ASSETS_DIR,
      path: trayPath || null,
      rawSize,
      finalSize,
      // A tray icon that resizes down to zero opaque pixels is invisible in the
      // notification area even though `Tray` constructed without error.
      rawVisiblePixels: rawVisible,
      finalVisiblePixels: finalVisible,
      created: Boolean(tray),
      error: trayError,
    };
    await loadPage(server.url);
    report.loaded = true;
    await guardAuthentication();
    report.settledUrl = pageContents() ? pageContents().getURL() : "";
    // The frame is its own document; report what it actually rendered, plus the
    // live bounds of both views, so a layout bug is visible without a screenshot.
    report.frame = {
      bounds: views && views.chrome ? views.chrome.getBounds() : null,
      contentBounds: views && views.content ? views.content.getBounds() : null,
      state: views ? views.frameState : null,
      dom: await reportFrameDom(),
    };
    report.frameBridge = await reportFrameBridge();
    report.layout = await reportLayoutDom();    // The split must survive a resize: the band stays 36px, the page keeps the rest.
    if (views && views.chrome && views.content) {
      const before = views.chrome.getBounds();
      mainWindow.setContentSize(1000, 700);
      await new Promise((resolve) => setTimeout(resolve, 800));
      report.resize = {
        before,
        frame: views.chrome.getBounds(),
        content: views.content.getBounds(),
      };
      mainWindow.setContentSize(1440, 920);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 8000));
    report.page = await pageContents().executeJavaScript(`(() => {
      const body = document.body;
      const root = document.getElementById('root');
      return {
        readyState: document.readyState,
        title: document.title,
        href: location.href,
        elements: document.querySelectorAll('*').length,
        htmlLength: document.documentElement ? document.documentElement.outerHTML.length : 0,
        bodyText: body ? body.innerText.slice(0, 1500) : null,
        hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
        // Must stay false: the recovery bridge is for the shell's own pages only,
        // and this document shares their view.
        hasRecoveryBridge: typeof window.dshRecovery !== 'undefined',
        rootChildren: root ? root.childElementCount : null,
        bodyBackground: body ? getComputedStyle(body).backgroundColor : null,
        visibility: document.visibilityState
      };
    })()`);
  } catch (error) {
    report.error = error.message;
    report.stack = String(error.stack || "").split(/\r?\n/).slice(0, 12);
    code = 1;
  }
  // The probe owns a server (spawned or re-adopted); never leave it running.
  try {
    if (server) await server.stop();
  } catch {}
  report.splash = await reportSplashTheme();
  // Last, because it really does restart the service.
  report.restartButton = await reportRestartButton();
  report.appLogTail = readTail(appLogPath(), 60);
  report.serverLogTail = readTail(logFilePath(), 30);
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {}
  finishProcess(code);
}

/** Read the shell page's rendered state, so a probe can assert on it. */
async function readShellPage() {
  const contents = pageContents();
  if (!contents) return null;
  try {
    return await contents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('tbody tr')].map((row) => ({
        cls: row.className,
        name: row.cells[0] ? row.cells[0].textContent : null,
        version: row.cells[1] ? row.cells[1].textContent : null,
        state: row.cells[2] ? row.cells[2].textContent : null,
        diag: row.cells[3] ? row.cells[3].textContent : null,
        color: row.cells[0] ? getComputedStyle(row.cells[0]).color : null,
        action: row.cells[4] ? row.cells[4].textContent.trim() : null,
      }));
      return {
        heading: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
        buttons: [...document.querySelectorAll('button')].map((button) => button.textContent),
        hasBridge: typeof window.dshRecovery === 'object',
        rows,
      };
    })()`);
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * `DSH.exe --dsh-probe-recovery=<file>` drives the recovery UI for real.
 *
 * It forces the failure page, clicks both buttons through the actual bridge, and
 * disables the suspect — against whatever `settings.profileDir` points at, which
 * is why the probe always runs with a throwaway profile directory.
 */
async function runRecoveryProbe(outFile) {
  const report = { userData: app.getPath("userData") };
  let code = 0;
  try {
    loadSettings();
    wireRecovery();
    report.profileDir = activeProfileDir();
    // The unreadable-profile case is one of the cases under test, so listing must
    // not take the probe down with it.
    const safeList = (stage) => {
      try {
        return listPlugins(activeProfileDir());
      } catch (error) {
        return `${stage} 读不到: ${error.message}`;
      }
    };
    report.pluginsBefore = safeList("before");

    createWindow();
    // A real failure leaves this text in the server log; write it so the suspect
    // parser sees exactly what it would see in production.
    const suspicion =
      "failed to import loader entry neu-theme (dsh-neu-theme): The requested module " +
      "'@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'";
    try {
      fs.writeFileSync(logFilePath(), `Error: dsh: plugin tree failed to load: ${suspicion}\n`);
    } catch {}
    await showFailure("探针：故意制造的启动失败", `Error: ${suspicion}`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    report.errorPage = await readShellPage();

    await pageContents().executeJavaScript("document.getElementById('plugins').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 900));
    report.pluginPage = await readShellPage();

    // Fire-and-forget on purpose: the handler replaces this very document, so
    // awaiting the invoke from inside it would leave the promise orphaned and the
    // probe would hang here forever.
    await pageContents().executeJavaScript("void window.dshRecovery.disable('dsh-neu-theme'); true");
    await new Promise((resolve) => setTimeout(resolve, 900));
    report.afterDisablePage = await readShellPage();
    report.pluginsAfter = listPlugins(activeProfileDir());

    await pageContents().executeJavaScript("void window.dshRecovery.enable('dsh-neu-theme'); true");
    await new Promise((resolve) => setTimeout(resolve, 900));
    report.afterEnablePage = await readShellPage();
    report.pluginsRestored = listPlugins(activeProfileDir());

    // "返回" must land back on the failure page without restarting anything.
    await pageContents().executeJavaScript("document.getElementById('back').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 700));
    report.afterBack = await readShellPage();
  } catch (error) {
    report.error = error.message;
    report.stack = String(error.stack || "").split(/\r?\n/).slice(0, 10);
    code = 1;
  }
  report.appLogTail = readTail(appLogPath(), 40);
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {}
  finishProcess(code);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

const selftestArg = process.argv.find((argument) => argument.startsWith("--dsh-selftest"));
const probeArg = process.argv.find((argument) => argument.startsWith("--dsh-probe-ui"));
const recoveryProbeArg = process.argv.find((argument) => argument.startsWith("--dsh-probe-recovery"));

function outFileFor(argument, fallback) {
  if (!argument.includes("=")) return fallback;
  return argument.split("=").slice(1).join("=");
}

if (selftestArg) {
  const outFile = outFileFor(selftestArg, path.join(APP_ROOT, ".selftest", "electron.json"));
  app.whenReady().then(() => runHeadlessSelftest(outFile));
} else if (probeArg) {
  const outFile = outFileFor(probeArg, path.join(APP_ROOT, ".selftest", "ui.json"));
  app.whenReady().then(() => runUiProbe(outFile));
} else if (recoveryProbeArg) {
  const outFile = outFileFor(recoveryProbeArg, path.join(APP_ROOT, ".selftest", "recovery.json"));
  app.whenReady().then(() => runRecoveryProbe(outFile));
} else if (!app.requestSingleInstanceLock()) {
  // Secondary launch: the running instance already received our argv.
  app.quit();
} else if (process.argv.includes("--dsh-quit")) {
  // We own the lock, so nothing is running to quit — this was a no-op.
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--dsh-quit")) {
      // Escape hatch for a shell whose tray icon the user cannot find:
      // `DSH.exe --dsh-quit` quits the running instance and stops its service.
      quit(true);
      return;
    }
    showWindow();
  });

  app.on("window-all-closed", () => {
    // Closing the last window ends the app unless tray mode is on. The service
    // itself is detached and is re-adopted by the next launch, so nothing that
    // was running is lost.
    if (!settings.minimizeToTray) app.quit();
  });

  app.on("before-quit", (event) => {
    quitting = true;
    // Logged distinctly from "window close requested": both fire during a quit,
    // so only this line proves the app really is going away.
    appLog(`before-quit (stopService=${stopServiceOnQuit})`);
    // A re-adopted server is not `owned`, but "quit and stop the service" must
    // stop it too — stop() resolves the pid for either case.
    if (stopServiceOnQuit && server && !stoppingService) {
      event.preventDefault();
      stoppingService = true;
      server.stop().finally(() => app.quit());
    }
  });

  app.whenReady().then(async () => {
    loadSettings();
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(["clipboard-read", "clipboard-sanitized-write", "notifications", "fullscreen"].includes(permission));
    });
    if (!app.isPackaged) Menu.setApplicationMenu(null);

    // Registered before any page can be shown, so a failed first boot already has
    // working buttons.
    wireRecovery();

    // Both calls are outside the server try/catch on purpose: a failure here
    // leaves the app running with no window and no tray, which is invisible
    // without logging it.
    try {
      createWindow();
      createTray();
    } catch (error) {
      appLog(`window/tray setup failed: ${error.message}`);
    }

    try {
      await startServer();
      refreshTray();
      if (mainWindow && !mainWindow.isDestroyed()) {
        await loadPage(server.url);
        await guardAuthentication();
      }
      // The frame follows the page's own colours; re-sample so a theme switch in
      // the app moves the frame with it.
      setInterval(() => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) sampleContentTheme();
      }, 2000);
    } catch (error) {
      appLog(`startup failed: ${error.message}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        await showFailure(error.message, tailLog());
      }
    }
  });
}
