"use strict";

/**
 * Locate the OFFICIALLY installed DeepSeek Harness CLI.
 *
 * The shell deliberately never vendors, patches, or forks the runtime: it finds
 * whichever official `@deepseek-ai/dsh` the machine already has (npm global, an
 * npx cache, an app-local dependency, or `dsh` on PATH) and runs that. Upgrading
 * the official package upgrades the desktop app's engine in place.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const RELATIVE_BIN = path.join("lib", "bin.js");

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function mtimeOf(candidate) {
  try {
    return fs.statSync(candidate).mtimeMs;
  } catch {
    return 0;
  }
}

/** `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js`, newest first. */
function npxCacheCandidates() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const npxRoot = path.join(localAppData, "npm-cache", "_npx");
  let entries;
  try {
    entries = fs.readdirSync(npxRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(npxRoot, entry.name, "node_modules", "@deepseek-ai", "dsh", RELATIVE_BIN))
    .filter(isFile)
    .sort((a, b) => mtimeOf(b) - mtimeOf(a));
}

/** Resolve a `dsh` shim found on PATH back to its real CLI entry. */
function pathShimCandidates() {
  let shim = "";
  try {
    const found = execFileSync("where.exe", ["dsh"], { encoding: "utf8", windowsHide: true });
    shim = found.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  } catch {
    return [];
  }
  if (!shim) return [];
  const binDir = path.dirname(shim);
  return [
    path.join(binDir, "..", "@deepseek-ai", "dsh", RELATIVE_BIN),
    path.join(binDir, "..", "..", "node_modules", "@deepseek-ai", "dsh", RELATIVE_BIN),
  ].map((candidate) => path.resolve(candidate));
}

function readVersion(dshBin) {
  try {
    const manifest = path.join(path.dirname(dshBin), "..", "package.json");
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version || "";
  } catch {
    return "";
  }
}

function describeSource(dshBin) {
  if (/[\\/]_npx[\\/]/.test(dshBin)) return "npx cache";
  if (/[\\/]npm[\\/]node_modules[\\/]/.test(dshBin)) return "npm global";
  if (/[\\/]AppData[\\/]Roaming[\\/]npm[\\/]/.test(dshBin)) return "npm global";
  return "local";
}

/**
 * @param {{appRoot: string, override?: string}} options
 * @returns {{dshBin: string, version: string, source: string}}
 */
function findDsh(options) {
  const appRoot = options.appRoot;
  const candidates = [];
  if (options.override) candidates.push(options.override);
  if (process.env.DSH_DESKTOP_DSH_BIN) candidates.push(process.env.DSH_DESKTOP_DSH_BIN);
  candidates.push(path.join(appRoot, "node_modules", "@deepseek-ai", "dsh", RELATIVE_BIN));
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", RELATIVE_BIN));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", RELATIVE_BIN));
  }
  candidates.push(...npxCacheCandidates(), ...pathShimCandidates());

  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) {
      const dshBin = path.resolve(candidate);
      return { dshBin, version: readVersion(dshBin), source: describeSource(dshBin) };
    }
  }
  return null;
}

/** The Node runtime that will host the DSH server (never Electron's own ABI). */
function findNode() {
  const candidates = [];
  if (process.env.DSH_DESKTOP_NODE) candidates.push(process.env.DSH_DESKTOP_NODE);
  try {
    const found = execFileSync("where.exe", ["node"], { encoding: "utf8", windowsHide: true });
    candidates.push(...found.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch {}
  candidates.push(
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
    path.join(os.homedir(), "scoop", "apps", "nodejs", "current", "node.exe"),
  );
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) return path.resolve(candidate);
  }
  return "";
}

module.exports = { findDsh, findNode };
