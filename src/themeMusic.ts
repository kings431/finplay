import type { Auth } from "./jellyfin";
import type { BaseItem } from "./types";

/** Theme songs play under the page, well below anything the user starts. */
const VOLUME = 0.22;
const FADE_IN_MS = 1800;
const FADE_OUT_MS = 700;
const MUTE_KEY = "finplay.themeMuted";

let audio: HTMLAudioElement | null = null;
let songId = "";
let fadeTimer = 0;
let muted = sessionStorage.getItem(MUTE_KEY) === "1";
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Steps the volume on a timer: Chromium 85 and WebKit ignore volume ramps on media elements. */
function fade(target: number, ms: number, done?: () => void) {
  window.clearInterval(fadeTimer);
  const element = audio;
  if (!element) return;
  const from = element.volume;
  const started = Date.now();
  fadeTimer = window.setInterval(() => {
    const progress = Math.min(1, (Date.now() - started) / ms);
    element.volume = Math.max(0, Math.min(1, from + (target - from) * progress));
    if (progress < 1) return;
    window.clearInterval(fadeTimer);
    done?.();
  }, 50);
}

function release() {
  window.clearInterval(fadeTimer);
  const element = audio;
  audio = null;
  songId = "";
  if (element) {
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
  changed();
}

/** The server's universal audio address. Takes the token as ApiKey; some servers refuse api_key. */
export function themeSongUrl(auth: Auth, song: BaseItem) {
  const params = new URLSearchParams({
    UserId: auth.userId,
    DeviceId: auth.deviceId,
    ApiKey: auth.token,
    Container: "opus,webm|opus,mp3,aac,m4a|aac,m4b|aac,flac,webma,webm|webma,wav,ogg",
    TranscodingContainer: "mp3",
    TranscodingProtocol: "http",
    AudioCodec: "mp3",
    MaxStreamingBitrate: "400000",
  });
  return `${auth.server}/Audio/${song.Id}/universal?${params}`;
}

/** Fades `song` in, or back in when it is already the one playing. */
export function playThemeSong(auth: Auth, song: BaseItem) {
  if (audio && songId === song.Id) {
    if (audio.paused) void audio.play().catch(() => release());
    fade(VOLUME, FADE_IN_MS);
    return;
  }
  if (audio) release();
  const element = new Audio();
  element.preload = "auto";
  element.volume = 0;
  element.muted = muted;
  element.addEventListener("ended", () => audio === element && release());
  element.addEventListener("error", () => audio === element && release());
  element.src = themeSongUrl(auth, song);
  audio = element;
  songId = song.Id;
  changed();
  // Refused when the webview hasn't seen a click or key press yet.
  element
    .play()
    .then(() => audio === element && fade(VOLUME, FADE_IN_MS))
    .catch(() => audio === element && release());
}

/** Fades out and stops. `quick` is for when something else starts playing. */
export function stopThemeSong(quick = false) {
  if (!audio) return;
  fade(0, quick ? 150 : FADE_OUT_MS, release);
}

export function themeSongMuted() {
  return muted;
}

export function setThemeSongMuted(next: boolean) {
  muted = next;
  sessionStorage.setItem(MUTE_KEY, next ? "1" : "0");
  if (audio) audio.muted = next;
  changed();
}

/** The song playing now, or "" when nothing is. */
export function themeSongPlaying() {
  return songId;
}

export function onThemeSongChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
