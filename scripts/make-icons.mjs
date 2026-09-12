// Generate the app/tray icons from the OFFICIAL DSH favicon shipped in the
// @deepseek-ai/dsh-web-frontend dist, so the shell carries no third-party art.
//
// Run: node scripts/make-icons.mjs [path-to-favicon.svg]
//
// sharp is only needed to run this script once; the generated PNG/ICO files are
// checked in, so the app itself has no image dependency.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const assetsDir = join(projectRoot, "assets");

/** Locate the favicon without hardcoding one machine's npx cache. */
function findFavicon() {
  const explicit = process.argv[2] || process.env.DSH_FAVICON;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`favicon not found: ${explicit}`);
    return explicit;
  }
  const roots = [];
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  // npx cache: %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai
  if (localAppData) {
    const npxRoot = join(localAppData, "npm-cache", "_npx");
    if (existsSync(npxRoot)) {
      for (const entry of readdirSync(npxRoot)) {
        roots.push(join(npxRoot, entry, "node_modules", "@deepseek-ai"));
      }
    }
    roots.push(join(localAppData, "npm", "node_modules", "@deepseek-ai"));
  }
  if (appData) roots.push(join(appData, "npm", "node_modules", "@deepseek-ai"));
  roots.push(join(projectRoot, "node_modules", "@deepseek-ai"));
  for (const root of roots) {
    const candidate = join(root, "dsh-web-frontend", "dist", "favicon.svg");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find @deepseek-ai/dsh-web-frontend/dist/favicon.svg; pass the path as the first argument.",
  );
}

/** Resolve sharp from the project or from any npx cache that happens to have it. */
function loadSharp() {
  try {
    return require("sharp");
  } catch {}
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const npxRoot = join(localAppData, "npm-cache", "_npx");
    if (existsSync(npxRoot)) {
      for (const entry of readdirSync(npxRoot)) {
        const candidate = join(npxRoot, entry, "node_modules", "sharp");
        if (existsSync(candidate)) return require(candidate);
      }
    }
  }
  const globalRoot = join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "sharp");
  if (existsSync(globalRoot)) return require(globalRoot);
  throw new Error("sharp is not available; run `npm i -D sharp` in this project or set it up globally.");
}

const BRAND = process.env.DSH_ICON_COLOR || "#4D6BFE";

/**
 * The shipped favicon carries a prefers-color-scheme media query and its own
 * fill attributes. Drop both and pin one brand fill so rasterizing is
 * deterministic (the logo is monochrome, so nothing else is lost).
 */
function brandedSvg(source) {
  return source
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/\sfill="[^"]*"/g, "")
    .replace(/<path\b/, `<path fill="${BRAND}"`);
}

/** Wrap PNG payloads in an ICO container (valid for Windows Vista and later). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 0); // width (0 means 256)
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

async function render(sharp, svg, size) {
  return sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

const favicon = findFavicon();
const sharp = loadSharp();
const svg = brandedSvg(readFileSync(favicon, "utf8"));
mkdirSync(assetsDir, { recursive: true });

const appSizes = [256, 128, 64, 48, 32, 16];
const appImages = [];
for (const size of appSizes) {
  appImages.push({ size, data: await render(sharp, svg, size) });
}
writeFileSync(join(assetsDir, "icon.png"), await render(sharp, svg, 512));
writeFileSync(join(assetsDir, "icon.ico"), buildIco(appImages));

const traySizes = [32, 24, 16];
const trayImages = [];
for (const size of traySizes) {
  trayImages.push({ size, data: await render(sharp, svg, size) });
}
writeFileSync(join(assetsDir, "tray.png"), await render(sharp, svg, 32));
writeFileSync(join(assetsDir, "tray.ico"), buildIco(trayImages));

console.log(`favicon: ${favicon}`);
console.log(`wrote:   ${assetsDir}\\icon.png, icon.ico, tray.png, tray.ico`);
