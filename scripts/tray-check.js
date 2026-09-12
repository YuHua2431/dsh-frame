"use strict";

/**
 * Does the tray icon actually decode?
 *
 * A shell whose window is closed keeps running by design, and the tray icon is
 * the only way to reach it. If `nativeImage` cannot decode the icon, the Tray is
 * created invisible and the process becomes a zombie. This prints the real
 * decode result for both the project assets and the packaged asar copy.
 *
 *   electron scripts/tray-check.js
 */

const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(() => {
  const project = path.resolve(__dirname, "..");
  const dirs = [
    ["project", path.join(project, "assets")],
    ["asar   ", path.join(project, "dist", "win-unpacked", "resources", "app.asar", "assets")],
  ];
  for (const [label, dir] of dirs) {
    for (const name of ["tray.ico", "tray.png", "icon.ico"]) {
      const file = path.join(dir, name);
      const exists = fs.existsSync(file);
      let info = "n/a";
      if (exists) {
        try {
          const image = nativeImage.createFromPath(file);
          info = `empty=${image.isEmpty()} size=${JSON.stringify(image.getSize())}`;
        } catch (error) {
          info = `THREW ${error.message}`;
        }
      }
      console.log(`${label} ${name.padEnd(9)} exists=${String(exists).padEnd(5)} ${info}`);
    }
  }
  app.exit(0);
});
