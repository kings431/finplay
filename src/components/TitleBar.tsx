import { inTauri } from "../player";

export type Platform = "mac" | "windows" | "other";

export function detectPlatform(): Platform {
  if (!inTauri()) return "other";
  const agent = navigator.userAgent;
  if (agent.includes("Mac")) return "mac";
  if (agent.includes("Windows")) return "windows";
  return "other";
}

/** Marks the document so CSS can make room for the hidden system title bar. */
export function applyPlatform() {
  const platform = detectPlatform();
  if (platform !== "other") document.documentElement.classList.add(`platform-${platform}`);
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function TitleBar() {
  const platform = detectPlatform();
  if (platform === "other") return null;
  return (
    <div className="titlebar" data-tauri-drag-region>
      {platform === "windows" ? (
        <div className="titlebar-controls">
          <button aria-label="Minimize" onClick={() => void currentWindow().then((window) => window.minimize())}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button aria-label="Maximize" onClick={() => void currentWindow().then((window) => window.toggleMaximize())}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button className="close" aria-label="Close" onClick={() => void currentWindow().then((window) => window.close())}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
