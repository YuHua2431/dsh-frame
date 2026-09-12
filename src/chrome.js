"use strict";

/**
 * Frame document behaviour: follow the state sampled from the DSH page below
 * (theme, fill colour, page title) and offer the shell's restart affordance.
 * No framework, no build step.
 */

const bridge = window.dshShell;

function applyFrameState(state) {
  if (!state) return;
  if (typeof state.dark === "boolean") {
    document.body.dataset.theme = state.dark ? "dark" : "light";
  }
  if (typeof state.background === "string" && state.background) {
    document.body.style.setProperty("--frame-fill", state.background);
  }
  if (typeof state.title === "string" && state.title) {
    document.getElementById("title").textContent = state.title;
  }
  // The sidebar's colour continues up into the title row.
  if (typeof state.sidebarFill === "string" && state.sidebarFill) {
    document.body.style.setProperty("--sidebar-fill", state.sidebarFill);
  }
  if (typeof state.sidebarWidth === "number") {
    document.body.style.setProperty("--sidebar-width", `${Math.max(0, Math.round(state.sidebarWidth))}px`);
  }
  if (typeof state.sidebarBorder === "string") {
    document.body.style.setProperty("--sidebar-border", state.sidebarBorder || "none");
  }
}

function render(state) {
  document.body.dataset.platform = (state && state.platform) || "win32";
  if (state && state.product) {
    document.getElementById("product").textContent = state.product;
  }
  if (state && typeof state.padding === "string" && state.padding) {
    document.body.style.setProperty("--frame-padding", state.padding);
  }
  if (state && typeof state.captionReserve === "number") {
    document.body.style.setProperty("--caption-reserve", `${state.captionReserve}px`);
  }
}

function wireRestart() {
  const button = document.getElementById("restart");
  if (!button) return;
  if (!bridge) {
    button.disabled = true;
    return;
  }
  button.addEventListener("click", () => {
    if (button.dataset.busy === "1") return;
    button.dataset.busy = "1";
    Promise.resolve(bridge.invoke("restart"))
      .catch(() => {})
      .finally(() => {
        delete button.dataset.busy;
      });
  });
}

(async () => {
  let state = null;
  try {
    if (bridge) state = await bridge.invoke("state");
  } catch {}
  render(state);
  applyFrameState(state);
  wireRestart();
  if (bridge) bridge.onFrameState(applyFrameState);
})();
