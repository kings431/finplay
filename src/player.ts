import type { PlayerEvent } from "./types";

export type PlayRequest = {
  url: string;
  /** Plays this item's downloaded file instead of `url`. */
  downloadId?: string;
  title: string;
  startSeconds: number;
  fullscreen: boolean;
  audioLang: string;
  subtitleLang: string;
  subtitlesEnabled: boolean;
  subtitleScale: number;
  subtitleColor: string;
  subtitleFont: string;
  playbackSpeed: number;
  mpvPath: string;
  badge: string;
  trickplay: boolean;
  /** `Type:start:end` triples joined by `;`, in player seconds. */
  segments: string;
  nextTitle: string;
  autoSkip: boolean;
  /** Cheaper scaling and no dithering, for weak GPUs. */
  lowPower?: boolean;
  artist: string;
  /** Shown by desktop media widgets, so it must never carry the access token. */
  artUrl: string;
  /** A remote trailer streamed through yt-dlp. */
  trailer?: boolean;
};

export async function listenNext(handler: () => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("player-next", () => handler());
}

export function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function playerPlay(request: PlayRequest) {
  if (!inTauri()) {
    throw new Error("Playback runs in the Finplay desktop app, which uses mpv. A browser tab cannot direct-play these files.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("player_play", { request });
}

export async function playerRequest(command: unknown[]) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<unknown>("player_request", { command });
}

export async function playerStop() {
  if (!inTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("player_stop");
}

export async function playerFocus() {
  if (!inTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("player_focus");
}

/** False when there is no embedded player to shrink (only macOS has one). */
export async function playerMini(on: boolean) {
  if (!inTauri()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("player_mini", { on });
}

/** The player left mini mode on its own, e.g. for fullscreen. */
export async function listenMiniExit(handler: () => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("player-mini", () => handler());
}

/** The player's picture-in-picture button or the P key. */
export async function listenMiniToggle(handler: () => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("player-mini-toggle", () => handler());
}

export async function listenThumbRequests(handler: (request: { time: number; width: number }) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ time: number; width: number }>("player-thumb", (event) => handler(event.payload));
}

export async function sendThumb(pixels: Uint8Array, width: number, height: number) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("player_thumb", pixels, { headers: { "x-width": String(width), "x-height": String(height) } });
}

export async function listenPlayer(handler: (event: PlayerEvent) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PlayerEvent>("player", (event) => handler(event.payload));
}
