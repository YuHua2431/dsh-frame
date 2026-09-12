"use strict";

/**
 * Headless self-check for the shell's non-Electron half. Run it when the
 * desktop window misbehaves: it reports which official runtime the shell would
 * pick, whether a server is already answering, and whether the web profile
 * accepts the flag family the shell passes.
 *
 *   node scripts/selftest.js [port]
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { findDsh, findNode } = require("../src/runtime-locator");
const { probe } = require("../src/server-manager");

const port = Number(process.argv[2] || 3080);
const appRoot = path.resolve(__dirname, "..");
const outFile = path.join(appRoot, ".selftest", "web-help.txt");

/** Run a command with file-backed stdio (never pipes) and return its output. */
function runToFile(command, args) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, "w");
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", fd, fd], windowsHide: true });
    child.on("error", (error) => resolve({ error }));
    child.on("exit", (code) => resolve({ code, output: fs.readFileSync(outFile, "utf8") }));
  });
}

(async () => {
  const runtime = findDsh({ appRoot });
  console.log(runtime ? `dsh CLI : ${runtime.dshBin}\nversion: ${runtime.version}\nsource : ${runtime.source}` : "dsh CLI: NOT FOUND");
  const nodeBin = findNode();
  console.log(nodeBin ? `node    : ${nodeBin}` : "node    : NOT FOUND");
  console.log(`probe   : 127.0.0.1:${port} -> ${(await probe("127.0.0.1", port)) ? "already serving" : "free / not DSH"}`);

  if (!runtime || !nodeBin) {
    process.exitCode = 1;
    return;
  }
  // `--help` on the web profile provides no services, so no server binds; it is
  // the cheapest way to confirm the launcher flags reach the web app.
  const result = await runToFile(nodeBin, [runtime.dshBin, "--profile", "web", "--help"]);
  if (result.error) {
    console.log(`web     : could not run (${result.error.message})`);
    process.exitCode = 1;
    return;
  }
  const first = (result.output || "").split(/\r?\n/).find((line) => line.trim());
  const sandboxed = /EPERM|EPROFS/.test(result.output || "") && /\.dsh[\\/]/.test(result.output || "");
  if (sandboxed) {
    // Running inside DSH's own workspace-only file sandbox: the official CLI
    // cannot rewrite ~/.dsh/profiles/*/cordis.yml, which it does on every boot.
    console.log("web     : skipped — this check must run outside DSH's workspace-only sandbox");
    return;
  }
  console.log(`web     : exit ${result.code} | ${first ? first.trim() : "no output"}`);
  if (result.code !== 0) process.exitCode = 1;
})();
