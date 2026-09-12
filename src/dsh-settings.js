"use strict";

/**
 * The one DSH setting this shell owns.
 *
 * `dshmarket` restarts the harness process it runs in to make pending plugin
 * changes take effect: `scheduleRestart` spawns a replacement and then SIGTERMs
 * itself (`dshmarket/lib/restart.js`). Under a shell that owns the process that
 * is wrong twice over — it launches a second server, and it hands us a process
 * we did not start.
 *
 * The market already documents the answer: `allowRestart: false` is "the
 * documented answer for a host owned by systemd, launchd or pm2 — a supervisor
 * restarts it, so the market's one-click restart must not launch a second one".
 * The restart route enforces it (`dshmarket/lib/routes.js` answers 403
 * "self-restart is disabled for this host"), and every route reads the value per
 * request, so no restart is needed to apply it.
 *
 * The value lives in the DSH settings store under the market's own namespace,
 * which is the same door its settings-page switch writes through. The shell
 * edits the file directly because it must assert the value *before* the harness
 * starts — a running harness rewrites this file from memory.
 *
 * A targeted line edit rather than a YAML round-trip: the shell carries no YAML
 * dependency, and a round-trip would discard the file's comments.
 */

const fs = require("node:fs");
const path = require("node:path");

/** The market's settings namespace (`dshmarket/lib/settings.js`). */
const MARKET_NAMESPACE = "dsh-market";
const MARKET_KEY = "allowRestart";
const BACKUP_SUFFIX = ".dsh-desktop-backup";

function settingsFile(dshHome) {
  return path.join(dshHome, "settings.yaml");
}

/** The namespace's block as `{ header, end }` line indexes, or null. */
function findBlock(lines, namespace) {
  const header = new RegExp(`^${namespace}:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/** True when the line already states exactly this key/value. */
function statesValue(line, key, value) {
  return new RegExp(`^\\s+${key}:\\s*${value}\\s*(?:#.*)?$`).test(line);
}

function writeAtomic(file, text) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One backup, taken once, so a bad edit is always recoverable by hand.
    if (!fs.existsSync(`${file}${BACKUP_SUFFIX}`) && fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
    }
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
    return { ok: true, changed: true };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    return { ok: false, changed: false, reason: error.message };
  }
}

/**
 * Ensure `<namespace>.<key> = <value>` in the DSH settings store.
 *
 * @param dshHome - the DSH home directory holding `settings.yaml`.
 * @returns `{ok, changed}`; `changed` is false when the file already said so.
 */
function setSetting(dshHome, namespace, key, value) {
  const file = settingsFile(dshHome);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, changed: false, reason: error.message };
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const settingLine = `  ${key}: ${value}`;

  const block = findBlock(lines, namespace);
  if (!block) {
    if (lines.length) lines.push("");
    lines.push(`${namespace}:`, settingLine);
    return writeAtomic(file, `${lines.join(eol)}${eol}`);
  }

  const keyLine = new RegExp(`^\\s+${key}:`);
  const at = lines.findIndex((line, index) => index > block.start && index < block.end && keyLine.test(line));
  if (at !== -1) {
    if (statesValue(lines[at], key, value)) return { ok: true, changed: false };
    lines[at] = settingLine;
  } else {
    lines.splice(block.start + 1, 0, settingLine);
  }
  return writeAtomic(file, `${lines.join(eol)}${eol}`);
}

module.exports = { MARKET_NAMESPACE, MARKET_KEY, setSetting, settingsFile };
