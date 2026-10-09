import { inTauri } from "./player";
import { loadSettings } from "./settings";

/** The address to play a web trailer in Finplay's own player, or null if mpv can't stream it. */
export async function trailerStream(url: string): Promise<string | null> {
  if (!inTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("trailer_stream", { url });
}

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
