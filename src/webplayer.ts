/**
 * Plays through an HTML video element, for the TV app and plain browser tabs.
 * Mirrors the desktop player's surface (events, mpv-style requests) so the
 * playback provider drives both the same way.
 */
import type { PlayerEvent } from "./types";
import type { PlayRequest } from "./player";

type Segment = { type: string; start: number; end: number };
type Cue = { from: number; to: number; text: string };
type HlsInstance = { destroy(): void; audioTracks: unknown[]; audioTrack: number };

const playerHandlers = new Set<(event: PlayerEvent) => void>();
const nextHandlers = new Set<() => void>();

let video: HTMLVideoElement | null = null;
let captions: HTMLDivElement | null = null;
let hls: HlsInstance | null = null;
let request: PlayRequest | null = null;
let segments: Segment[] = [];
let ended = false;
let skipped = new Set<string>();
/** Where a stream is starting, reported until the video gets there so the clock doesn't flash 0:00. */
let pendingStart: number | null = null;
let cues: Cue[] = [];
let shownCue = "";
let subtitleLoad: AbortController | null = null;

function emit(kind: PlayerEvent["kind"], reason = "", detail = "") {
  const element = video;
  if (!element) return;
  const event: PlayerEvent = {
    kind,
    time: pendingStart ?? (element.currentTime || 0),
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
  const overlay = document.createElement("div");
  overlay.className = "web-subs";
  overlay.setAttribute("aria-live", "off");
  host.appendChild(overlay);
  document.body.appendChild(host);
  for (const name of ["play", "pause", "ratechange", "volumechange", "loadedmetadata"]) {
    created.addEventListener(name, () => emit("status"));
  }
  created.addEventListener("seeked", () => {
    showCue();
    emit("status");
  });
  created.addEventListener("timeupdate", () => {
    if (pendingStart !== null && Math.abs(created.currentTime - pendingStart) < 3) pendingStart = null;
    autoSkip();
    showCue();
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
  captions = overlay;
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

function seconds(stamp: string) {
  const parts = stamp.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseVtt(text: string): Cue[] {
  const list: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [start, end] = lines[at].split("-->");
    const from = seconds(start.trim());
    const to = seconds(end.trim().split(/\s+/)[0]);
    const body = lines
      .slice(at + 1)
      .join("\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .trim();
    if (body && to > from) list.push({ from, to, text: body });
  }
  return list.sort((a, b) => a.from - b.from);
}

/** Drawn by the app rather than as a text track: TVs style `::cue` unreliably,
 * and this follows the subtitle size and colour settings everywhere. */
function showCue() {
  if (!captions || !video) return;
  const now = video.currentTime;
  let text = "";
  for (const cue of cues) {
    if (cue.from > now) break;
    if (cue.to > now) text = text ? `${text}\n${cue.text}` : cue.text;
  }
  if (text === shownCue) return;
  shownCue = text;
  captions.textContent = "";
  if (!text) return;
  const line = document.createElement("span");
  line.textContent = text;
  captions.appendChild(line);
}

/** Shows this WebVTT file, or no subtitles. */
export async function webSubtitle(file: { url: string } | null) {
  subtitleLoad?.abort();
  subtitleLoad = null;
  cues = [];
  showCue();
  if (!file) return;
  const load = new AbortController();
  subtitleLoad = load;
  const response = await fetch(file.url, { signal: load.signal });
  if (!response.ok) throw new Error(`Subtitles could not load (${response.status}).`);
  const parsed = parseVtt(await response.text());
  if (subtitleLoad !== load) return;
  cues = parsed;
  showCue();
}

/** Switches audio inside the current stream when it carries every track, as
 * direct-played files can. `ordinal` counts the file's audio tracks from zero. */
export function webAudioTrack(ordinal: number, count: number) {
  if (hls && hls.audioTracks.length === count && count > 1) {
    hls.audioTrack = ordinal;
    return true;
  }
  const audio = (video as (HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }) | null)?.audioTracks;
  if (hls || !audio || audio.length !== count || count < 2) return false;
  for (let index = 0; index < audio.length; index++) audio[index].enabled = index === ordinal;
  return true;
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
  if (next.subtitleFont) document.documentElement.style.setProperty("--sub-font", next.subtitleFont);
  else document.documentElement.style.removeProperty("--sub-font");
  const chosen = (next.subtitles ?? []).find((subtitle) => subtitle.selected);
  void webSubtitle(chosen ?? null).catch(() => {});
  const start = next.startSeconds;
  pendingStart = start > 0 ? start : null;
  target.addEventListener(
    "loadedmetadata",
    () => {
      if (start > 0 && Math.abs(target.currentTime - start) > 1) target.currentTime = start;
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
  pendingStart = null;
  subtitleLoad?.abort();
  subtitleLoad = null;
  cues = [];
  showCue();
  document.documentElement.removeAttribute("data-web-video");
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
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
    pendingStart = null;
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
  } else if (name === "set_property" && a === "speed" && typeof b === "number") {
    target.playbackRate = b;
  } else if (name === "get_property" && a === "speed") {
    return target.playbackRate;
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
