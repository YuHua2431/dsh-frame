"use strict";

/**
 * Owns the DSH web server process.
 *
 * The shell spawns `dsh --profile web --no-open --port <port>` hidden in the
 * background and re-adopts a server left behind by an earlier run of this same
 * shell instead of starting a second one.
 *
 * The process tree is killed only when the user explicitly asks for it: the
 * "keep the service" quit leaves it running so the next launch re-adopts it.
 */

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

/** One cheap HTTP probe; resolves true only for a real answer (any status). */
function probe(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: "/", timeout: timeoutMs }, (response) => {
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

function findFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DshServer extends EventEmitter {
  constructor(options) {
    super();
    this.host = options.host || "127.0.0.1";
    this.requestedPort = options.port || 3080;
    this.port = this.requestedPort;
    this.nodeBin = options.nodeBin;
    this.dshBin = options.dshBin;
    this.workspace = options.workspace || "";
    this.profile = options.profile || "web";
    this.logFile = options.logFile;
    this.stateFile = options.stateFile;
    this.child = null;
    this.owned = false;
    this.reused = false;
    this.recordedPid = null;
    this.exited = false;
    this.stopping = false;
    this.authenticatedUrl = null;
  }

  get url() {
    return this.authenticatedUrl || `http://${this.host}:${this.port}/`;
  }

  /**
   * Boot (or re-adopt) the DSH web server this shell owns.
   *
   * The shell never attaches to a server it did not start: DSH authorizes the
   * browser surface with a per-activation launch token printed only on the
   * owning process's stdout, so a foreign server can never be reached — every
   * unauthenticated request gets a 401 ("dsh web authentication required").
   * Owning the process is what makes the token readable.
   *
   * A server left behind by an EARLIER RUN OF THIS SHELL is not foreign: its
   * launch URL was recorded in server.json, so the next launch re-adopts it
   * rather than starting a second one. Without that, every "quit, keeping the
   * service" + relaunch cycle would stack up another server sharing ~/.dsh.
   *
   * @returns {Promise<"reused"|"spawned">}
   */
  async start({ timeoutMs = 120000, reuse = true } = {}) {
    if (reuse && (await this.tryReuse())) return "reused";

    // Prefer the configured port; step aside if something else already holds it.
    if (await isPortTaken(this.host, this.requestedPort)) {
      this.port = await findFreePort(this.host);
    }

    // Only this run's output may be scanned for the token line.
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        fs.writeFileSync(this.logFile, "");
      } catch {}
    }

    this.child = spawn(this.nodeBin, [this.dshBin, "--profile", this.profile, "--no-open", "--port", String(this.port)], {
      cwd: this.workspace || undefined,
      env: { ...process.env },
      windowsHide: true,
      // Detached so the service outlives the shell: "退出（保留后台服务）" must
      // really leave it running, and only the explicit stop may kill the tree.
      detached: true,
      stdio: this.logFile ? ["ignore", openLog(this.logFile), openLog(this.logFile)] : "ignore",
    });
    // Let the shell exit without waiting on the service it just started.
    this.child.unref();
    this.owned = true;
    this.reused = false;
    this.exited = false;

    this.child.on("error", (error) => {
      this.exited = true;
      this.emit("exit", { code: null, error });
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (!this.stopping) this.emit("exit", { code, signal });
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error(`DSH server exited before it became ready (see ${this.logFile})`);
      const launched = readLaunchUrl(this.logFile, this.host);
      if (launched) {
        this.authenticatedUrl = launched;
        if (await probe(this.host, this.port)) {
          this.recordedPid = this.child.pid;
          this.writeState();
          return "spawned";
        }
      }
      await delay(200);
    }
    throw new Error(`DSH server did not announce a launch URL within ${Math.round(timeoutMs / 1000)}s (see ${this.logFile})`);
  }

  /**
   * Re-adopt the server recorded by a previous run of this shell.
   *
   * The recorded launch URL still answers 303 while that activation's token is
   * valid, which is exactly the window in which the server is still usable. Any
   * other answer (401, timeout, nothing listening) means the record is stale and
   * a fresh server is needed.
   */
  async tryReuse() {
    const state = this.readState();
    if (!state || !state.url || !state.port) return false;
    if (!(await probeAuthenticated(state.url))) {
      this.clearState();
      return false;
    }
    this.port = state.port;
    this.authenticatedUrl = state.url;
    this.recordedPid = state.pid || null;
    this.reused = true;
    this.owned = false;
    this.exited = false;
    return true;
  }

  readState() {
    if (!this.stateFile) return null;
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return null;
    }
  }

  writeState() {
    if (!this.stateFile || !this.authenticatedUrl) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(
        this.stateFile,
        `${JSON.stringify(
          {
            port: this.port,
            pid: this.child ? this.child.pid : this.recordedPid,
            url: this.authenticatedUrl,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } catch {}
  }

  clearState() {
    if (!this.stateFile) return;
    try {
      fs.rmSync(this.stateFile, { force: true });
    } catch {}
  }

  /** Taskkill the whole tree; DSH spawns shell/tool children of its own. */
  async stop() {
    const pid = this.owned ? (this.child && !this.exited ? this.child.pid : null) : this.recordedPid;
    this.clearState();
    if (!pid) return;
    this.stopping = true;
    await killTree(pid);
    this.exited = true;
  }
}

function isPortTaken(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (taken) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(800);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

function openLog(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return fs.openSync(logFile, "a");
}

/**
 * Read the launch URL the web surface prints once its tree settles:
 *
 *   dsh web: http://127.0.0.1:3080/?token=<launch token>
 *
 * Opening that URL once makes the server answer 303 and set the signed session
 * cookie the browser surface then presents on every later request.
 *
 * @param logFile - this activation's stdout log.
 * @param host - the bind host the URL must belong to.
 * @returns the authenticated URL, or null while it has not been printed yet.
 */
function readLaunchUrl(logFile, host) {
  if (!logFile) return null;
  let text;
  try {
    text = fs.readFileSync(logFile, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/dsh web:\s+(http:\/\/[^\s()]+)/);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.hostname !== host && url.hostname !== "localhost") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Taskkill a process tree, bounded so a wedged call cannot hang the shell. */
function killTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
    setTimeout(resolve, 8000);
  });
}

/**
 * True only while a recorded launch URL is still accepted.
 *
 * The web surface answers a valid tokenized root request with 303 to `/`; an
 * expired token, a cookie-less request, or anything else on that port answers
 * 401 or nothing. Requiring the 303 is what makes re-adoption safe.
 */
function probeAuthenticated(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve(false);
    }
    if (!target.searchParams.get("token")) return resolve(false);
    const request = http.get(
      { host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(response.statusCode === 303);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

module.exports = { DshServer, probe, findFreePort, probeAuthenticated, readLaunchUrl };
