import { inTauri } from "./player";
import { loadSettings } from "./settings";

/** Plays a YouTube or other web trailer. Resolves to where it opened. */
export async function playRemoteTrailer(url: string, title: string): Promise<"mpv" | "window" | "browser"> {
  if (!inTauri()) {
    window.open(url, "_blank", "noopener");
    return "browser";
  }
  const settings = loadSettings();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<"mpv" | "window">("play_trailer", { url, title, mpvPath: settings.mpvPath, fullscreen: settings.fullscreen });
}
