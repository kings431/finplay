/**
 * Plays through an HTML video element, for the TV app and plain browser tabs.
 * Mirrors the desktop player's surface (events, mpv-style requests) so the
 * playback provider drives both the same way.
 */
import type { MpvTrack, PlayerEvent } from "./types";
import type { PlayRequest } from "./player";

type Segment = { type: string; start: number; end: number };

const playerHandlers = new Set<(event: PlayerEvent) => void>();
const nextHandlers = new Set<() => void>();

let video: HTMLVideoElement | null = null;
let hls: { destroy(): void } | null = null;
let request: PlayRequest | null = null;
let segments: Segment[] = [];
let ended = false;
let skipped = new Set<string>();

function emit(kind: PlayerEvent["kind"], reason = "", detail = "") {
  const element = video;
  if (!element) return;
  const event: PlayerEvent = {
    kind,
    time: element.currentTime || 0,
    duration: Number.isFinite(element.duration) ? element.duration : 0,
    paused: element.paused,
    ended,
    reason,
    detail,
    embedded: true,
    volume: Math.round(element.volume * 100),
    muted: element.muted,
    rate: element.playbackRate,
  };
  for (const handler of playerHandlers) handler(event);
}

function element() {
  if (video) return video;
  const host = document.createElement("div");
  host.className = "web-player";
  const created = document.createElement("video");
  created.autoplay = true;
  created.playsInline = true;
  created.preload = "auto";
  host.appendChild(created);
  document.body.appendChild(host);
  for (const name of ["play", "pause", "seeked", "ratechange", "volumechange", "loadedmetadata"]) {
    created.addEventListener(name, () => emit("status"));
  }
  created.addEventListener("timeupdate", () => {
    autoSkip();
    emit("status");
  });
  created.addEventListener("ended", () => {
    if (!request || ended) return;
    ended = true;
    emit("status");
    if (request.nextTitle) for (const handler of nextHandlers) handler();
    else emit("closed");
  });
  created.addEventListener("error", () => {
    if (!request) return;
    const code = created.error?.code;
    const detail = code === 4 ? "this TV can't decode the format" : code === 2 ? "network error" : created.error?.message ?? "";
    emit("status", "error", detail);
  });
  video = created;
  return created;
}

function parseSegments(value: string): Segment[] {
  return value
    .split(";")
    .map((part) => part.split(":"))
    .filter((part) => part.length === 3)
    .map(([type, start, end]) => ({ type, start: Number(start), end: Number(end) }));
}

/** Intro or credits segment under `time` that can be skipped, if any. */
export function webSegment(time: number) {
  return segments.find((segment) => /^(Intro|Outro|Recap|Preview)$/.test(segment.type) && time >= segment.start && time < segment.end - 1) ?? null;
}

export function webHasNext() {
  return Boolean(request?.nextTitle);
}

export function webNextTitle() {
  return request?.nextTitle ?? "";
}

export function webPlayNext() {
  for (const handler of nextHandlers) handler();
}

function autoSkip() {
  if (!request?.autoSkip || !video) return;
  const segment = webSegment(video.currentTime);
  if (!segment || segment.type === "Outro" || skipped.has(`${segment.start}`)) return;
  skipped.add(`${segment.start}`);
  video.currentTime = segment.end;
}

function clearTracks(target: HTMLVideoElement) {
  for (const track of [...target.querySelectorAll("track")]) track.remove();
}

export async function webPlay(next: PlayRequest) {
  if (next.downloadId) throw new Error("Downloads play in the Finplay desktop app.");
  const target = element();
  webStop();
  request = next;
  ended = false;
  skipped = new Set();
  segments = parseSegments(next.segments);
  target.playbackRate = next.playbackSpeed || 1;
  document.documentElement.style.setProperty("--sub-scale", String(next.subtitleScale || 1));
  document.documentElement.style.setProperty("--sub-color", next.subtitleColor || "#ffffff");
  for (const subtitle of next.subtitles ?? []) {
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = subtitle.url;
    track.label = subtitle.label;
    if (subtitle.lang) track.srclang = subtitle.lang;
    target.appendChild(track);
  }
  const start = next.startSeconds;
  target.addEventListener(
    "loadedmetadata",
    () => {
      if (start > 0) target.currentTime = start;
      const chosen = (next.subtitles ?? []).findIndex((subtitle) => subtitle.selected);
      [...target.textTracks].forEach((track, index) => {
        track.mode = index === chosen ? "showing" : "disabled";
      });
    },
    { once: true },
  );
  const hlsUrl = /\.m3u8(\?|$)/i.test(next.url);
  // The TV's own HLS player uses its hardware decoders; desktop browsers that
  // claim HLS support are patchier than hls.js.
  const Hls = hlsUrl && !("tizen" in window) ? (await import("hls.js")).default : null;
  if (Hls?.isSupported()) {
    const instance = new Hls({ startPosition: start > 0 ? start : -1 });
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) emit("status", "error", data.details);
    });
    instance.loadSource(next.url);
    instance.attachMedia(target);
    hls = instance;
  } else {
    target.src = next.url;
  }
  document.documentElement.toggleAttribute("data-web-video", true);
  await target.play().catch(() => {
    // Autoplay can be refused before the first remote press; the play button still works.
  });
}

export function webStop() {
  hls?.destroy();
  hls = null;
  request = null;
  segments = [];
  document.documentElement.removeAttribute("data-web-video");
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  clearTracks(video);
  video.load();
}

function tracks(): MpvTrack[] {
  if (!video) return [];
  const list: MpvTrack[] = [];
  const audio = (video as HTMLVideoElement & { audioTracks?: ArrayLike<{ label: string; language: string; enabled: boolean }> }).audioTracks;
  if (audio && audio.length > 1) {
    for (let index = 0; index < audio.length; index++) {
      const track = audio[index];
      list.push({ id: index + 1, type: "audio", title: track.label, lang: track.language, selected: track.enabled });
    }
  }
  [...video.textTracks].forEach((track, index) => {
    list.push({ id: index + 1, type: "sub", title: track.label, lang: track.language, selected: track.mode === "showing" });
  });
  return list;
}

/** The subset of mpv commands the app sends. */
export async function webRequest(command: unknown[]): Promise<unknown> {
  const target = video;
  if (!target) return null;
  const [name, a, b] = command;
  if (name === "cycle" && a === "pause") {
    if (target.paused) await target.play().catch(() => {});
    else target.pause();
  } else if (name === "seek" && typeof a === "number") {
    const duration = Number.isFinite(target.duration) ? target.duration : Infinity;
    const to = b === "absolute" ? a : target.currentTime + a;
    target.currentTime = Math.max(0, Math.min(duration - 0.5, to));
  } else if (name === "set_property" && a === "pause") {
    if (b) target.pause();
    else await target.play().catch(() => {});
  } else if (name === "set_property" && a === "volume" && typeof b === "number") {
    target.volume = Math.max(0, Math.min(1, b / 100));
  } else if (name === "get_property" && a === "volume") {
    return Math.round(target.volume * 100);
  } else if (name === "get_property" && a === "track-list") {
    return tracks();
  } else if (name === "set_property" && a === "sid") {
    [...target.textTracks].forEach((track, index) => {
      track.mode = index + 1 === b ? "showing" : "disabled";
    });
    emit("status");
  } else if (name === "set_property" && a === "aid" && typeof b === "number") {
    const audio = (target as HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }).audioTracks;
    if (audio) for (let index = 0; index < audio.length; index++) audio[index].enabled = index + 1 === b;
  }
  return null;
}

export function webListenPlayer(handler: (event: PlayerEvent) => void) {
  playerHandlers.add(handler);
  return Promise.resolve(() => void playerHandlers.delete(handler));
}

export function webListenNext(handler: () => void) {
  nextHandlers.add(handler);
  return Promise.resolve(() => void nextHandlers.delete(handler));
}
