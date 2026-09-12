"use strict";

/**
 * Geometry and window options for the immersive desktop frame.
 *
 * The frame is a *sibling* `WebContentsView` occupying a fixed top band; the
 * official DSH page gets its own viewport below it. The official layout is
 * never padded, injected into, or covered — it simply starts 36px lower.
 *
 * The numbers mirror the community DSH Desktop shell so the frame keeps clear of
 * the native window controls by exactly the amount they occupy.
 */

/** Height of the immersive title band, in DIPs. */
const DESKTOP_FRAME_HEIGHT = 36;

/** Width the Windows caption buttons occupy inside that band. */
const WINDOWS_CAPTION_CONTROLS_WIDTH = 138;

/** Width the macOS traffic lights occupy. */
const MACOS_TRAFFIC_LIGHT_SAFE_WIDTH = 80;

/** Gap between the reserved control area and our own content. */
const FRAME_EDGE_PADDING = 8;

/**
 * The DSH page's viewport: everything below the frame.
 * @param width - window content width.
 * @param height - window content height.
 */
function contentBounds(width, height) {
  return { x: 0, y: DESKTOP_FRAME_HEIGHT, width, height: Math.max(0, height - DESKTOP_FRAME_HEIGHT) };
}

/**
 * The frame's viewport: the top band, or the whole window while it is expanded.
 * @param width - window content width.
 * @param height - window content height.
 * @param expanded - true while an in-frame popup needs to overflow the band.
 */
function chromeBounds(width, height, expanded = false) {
  return { x: 0, y: 0, width, height: expanded ? height : Math.min(height, DESKTOP_FRAME_HEIGHT) };
}

/**
 * CSS padding keeping frame content clear of the native window controls.
 * @param platform - `process.platform` of the host.
 */
function framePadding(platform) {
  switch (platform) {
    case "darwin":
      return `0 ${FRAME_EDGE_PADDING}px 0 ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH + FRAME_EDGE_PADDING}px`;
    case "win32":
      return `0 ${WINDOWS_CAPTION_CONTROLS_WIDTH + FRAME_EDGE_PADDING}px 0 ${FRAME_EDGE_PADDING}px`;
    default:
      return `0 ${FRAME_EDGE_PADDING}px`;
  }
}

/**
 * Space the native window controls occupy at the right edge of the band.
 *
 * Anything the frame draws just left of them is positioned by this, so a shell
 * button lands flush against them instead of floating in the middle.
 * @param platform - `process.platform` of the host.
 */
function captionReserve(platform) {
  switch (platform) {
    case "darwin":
      // Traffic lights sit at the left, so nothing is reserved on the right.
      return FRAME_EDGE_PADDING;
    case "win32":
      return WINDOWS_CAPTION_CONTROLS_WIDTH;
    default:
      return FRAME_EDGE_PADDING;
  }
}

/**
 * Window options that hide the native title bar while keeping its buttons.
 *
 * Deliberately omits `backgroundMaterial`: Mica needs Windows 11 (NT build
 * 22621+), and on Windows 10 it is a no-op, so the window keeps an opaque
 * background there instead of asking for a backdrop that cannot exist.
 */
function frameWindowOptions() {
  return {
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#7f858f",
      height: DESKTOP_FRAME_HEIGHT,
    },
    hasShadow: true,
    roundedCorners: true,
    thickFrame: true,
  };
}

module.exports = {
  DESKTOP_FRAME_HEIGHT,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  FRAME_EDGE_PADDING,
  contentBounds,
  chromeBounds,
  framePadding,
  captionReserve,
  frameWindowOptions,
};
