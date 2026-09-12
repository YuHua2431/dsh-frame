"use strict";

/**
 * Read and repair a DSH profile from outside DSH.
 *
 * A bundle named in `dsh.profile.bundles` that cannot be imported takes the
 * whole profile down with it. `dshmarket` is one of those bundles, so the market
 * page is unreachable in exactly this state — its own source says so
 * (`dshmarket/lib/install.js`: "the whole profile, not just this plugin, refuses
 * to start, with the market's own page unreachable").
 *
 * So recovery cannot call the market. It repeats the edit the market makes,
 * which is a filter and a push over one array (`dshmarket/lib/profile.js`:
 * `removeProfileBundle` / `addProfileBundle`). Disabling means dropping the name
 * from the bundle stack while leaving the package installed as a dependency:
 * reversible, and neither pnpm nor network is involved.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Bundles that ship with the host and must stay in the stack (`dshmarket/lib/order.js`). */
const INBOX_BUNDLES = new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
]);

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** @param explicit - overrides the profile directory entirely (used by tests). */
function resolveProfileDir(name, explicit) {
  if (explicit) return explicit;
  return path.join(dshHome(), "profiles", name || "web");
}

function manifestPath(profileDir) {
  return path.join(profileDir, "package.json");
}

/**
 * Same-directory replace, mirroring the market: a crash mid-write can never
 * leave the manifest truncated, which would break every later pnpm run.
 */
function writeManifestAtomic(file, manifest) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function readManifest(profileDir) {
  return JSON.parse(fs.readFileSync(manifestPath(profileDir), "utf8"));
}

function readBundles(manifest) {
  const bundles = manifest.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles.filter((entry) => typeof entry === "string") : [];
}

/**
 * Every package the profile knows about, with whether it is currently composed.
 * @returns {{name: string, version: string|null, enabled: boolean, official: boolean}[]}
 */
function listPlugins(profileDir) {
  const manifest = readManifest(profileDir);
  const dependencies = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
  const bundles = readBundles(manifest);
  const names = new Set([...bundles, ...Object.keys(dependencies)]);
  return [...names]
    .map((name) => ({
      name,
      version: typeof dependencies[name] === "string" ? dependencies[name] : null,
      // Installed but absent from the stack is exactly the "disabled" state.
      enabled: bundles.includes(name),
      official: INBOX_BUNDLES.has(name),
    }))
    .sort((a, b) => Number(a.official) - Number(b.official) || a.name.localeCompare(b.name));
}

/**
 * Add or drop one bundle from the stack, leaving the dependency installed.
 * @returns {{ok: boolean, changed?: boolean, reason?: string}}
 */
function setEnabled(profileDir, name, enabled) {
  if (INBOX_BUNDLES.has(name)) {
    return { ok: false, reason: `${name} 是随宿主发布的官方 bundle，不能移除` };
  }
  const file = manifestPath(profileDir);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const bundles = readBundles(manifest);
  const isEnabled = bundles.includes(name);
  if (enabled === isEnabled) return { ok: true, changed: false };
  manifest.dsh.profile.bundles = enabled ? [...bundles, name] : bundles.filter((entry) => entry !== name);
  writeManifestAtomic(file, manifest);
  return { ok: true, changed: true };
}

/**
 * The names the server log blames.
 *
 * The loader's own message is the reliable signal:
 *
 *   failed to import loader entry neu-theme (dsh-neu-theme): ...
 *
 * Both the entry id and the package name are collected. As a fallback, a known
 * package name standing on a line that mentions a failure is also collected —
 * a plugin can fail in ways that never reach the loader's import message.
 *
 * @param text - the server's stdout/stderr.
 * @param knownNames - package names to look for on failure lines.
 */
function suspectsFromLog(text, knownNames = []) {
  const found = new Set();
  const source = String(text || "");
  if (!source) return found;
  // The strict loader message first, then a looser one. The loose form also
  // matches the loader's own directive — "failed to apply loader entry include
  // (cordis:include)" — which is machinery, not a plugin, so it is filtered out.
  const patterns = [
    { pattern: /failed to import loader entry\s+(\S+)\s+\(([^)]+)\)/g, keep: () => true },
    {
      pattern: /loader entry\s+(\S+)\s+\(([^)]+)\)/g,
      keep: (entry, pkg) => entry !== "include" && !pkg.startsWith("cordis:"),
    },
  ];
  for (const { pattern, keep } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const entry = match[1] || "";
      const pkg = match[2] || "";
      if (!keep(entry, pkg)) continue;
      if (entry) found.add(entry);
      if (pkg) found.add(pkg);
    }
  }
  for (const line of source.split(/\r?\n/)) {
    if (!/error|failed|cannot|does not provide/i.test(line)) continue;
    for (const name of knownNames) {
      if (name && line.includes(name)) found.add(name);
    }
  }
  return found;
}

/**
 * Is the community plugin market installed *and* composed?
 *
 * Only a market that is actually in the bundle stack can restart the harness, so
 * only then does the shell's restart policy have anything to act on.
 */
function hasPluginMarket(profileDir) {
  try {
    return listPlugins(profileDir).some((plugin) => plugin.name === "dshmarket" && plugin.enabled);
  } catch {
    return false;
  }
}

module.exports = {
  INBOX_BUNDLES,
  dshHome,
  hasPluginMarket,
  resolveProfileDir,
  listPlugins,
  setEnabled,
  suspectsFromLog,
  readBundles,
};
