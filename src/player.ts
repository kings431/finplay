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
  artist: string;
  /** Shown by desktop media widgets, so it must never carry the access token. */
  artUrl: string;
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
