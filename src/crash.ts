/**
 * Sends crashes and player failures to the desktop app, which posts them to the
 * crash webhook. Tokens, server addresses and item ids are stripped first.
 */
import { inTauri } from "./player";
import { loadSettings } from "./settings";
import type { PlayerEvent } from "./types";

/** Offline servers and cancelled requests are not bugs. */
const NOISE = /Failed to fetch|NetworkError|Load failed|AbortError|aborted|ResizeObserver loop|The user aborted/i;

function scrub(text: string) {
  return text
    .replace(/(ApiKey|api_key|api-key|Token|token)=("[^"]*"|[^&\s"',)]+)/g, "$1=…")
    .replace(/https?:\/\/[^\s/"')]+/g, (match) => (/^https?:\/\/(127\.0\.0\.1|localhost|tauri\.localhost)/.test(match) ? match : "<server>"))
    .replace(/\b[0-9a-f]{32}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/(\/Users\/|\/home\/|\\Users\\)[^/\\\s"]+/g, "$1…");
}

function describe(error: unknown) {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack ?? "" };
  if (typeof error === "string") return { message: error, stack: "" };
  try {
    return { message: JSON.stringify(error), stack: "" };
  } catch {
    return { message: String(error), stack: "" };
  }
}

export function reportCrash(kind: string, error: unknown, context = "", details = "") {
  if (!inTauri() || !loadSettings().crashReports) return;
  const described = describe(error);
  const { message } = described;
  const stack = details || described.stack;
  if (!message || (!details && NOISE.test(message))) return;
  const where = window.location.hash.split("?")[0] || "#/";
  const report = {
    kind,
    message: scrub(message).slice(0, 500),
    stack: scrub(stack).slice(0, 6000),
    context: scrub([context, `screen ${where}`].filter(Boolean).join(" · ")).slice(0, 900),
  };
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("crash_report", { report }))
    .catch(() => {});
}

/** The last thing that changed what plays, to tell what a failure followed. */
export type PlaybackAction = { kind: "start" | "seek" | "auto-next" | "stop"; at: number };

export type FailedPlayback = {
  method: string;
  badge: string;
  videoCodec?: string;
  audioCodec?: string;
  /** Episode, Movie, … — never the title. */
  itemType?: string;
  /** Times the stream was reopened before giving up. */
  retries?: number;
};

/** The server's 5xx answer for a failed stream, e.g. "502 Bad Gateway", or "". */
export function serverError(event: PlayerEvent) {
  const status = event.diagnostics?.httpStatus || /\bHTTP (5\d\d)\b/.exec(event.detail)?.[1] || "";
  return /^5\d\d\b/.test(status) ? status : "";
}

/** The stream could not be opened at all, without a status that says why. */
export function openFailed(event: PlayerEvent) {
  if (event.diagnostics) return event.diagnostics.fileError === "loading failed";
  return /LoadError|LoadTimeOut|network error/i.test(event.detail);
}

const NETWORK = /\b(http|tcp|tls|ssl|connection|connect|timed? ?out|resolve|network|stream_callback)\b/i;

function clock(seconds: number) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function trigger(event: PlayerEvent, action: PlaybackAction, now: number) {
  const info = event.diagnostics;
  const ago = (now - action.at) / 1000;
  const position = info?.position ?? event.time;
  const duration = info?.duration || event.duration;
  if (info?.restart) return "stream restart (fullscreen switch)";
  if (info?.seeking || (action.kind === "seek" && ago < 10)) return "seek";
  if (action.kind === "auto-next" && ago < 30) return "auto-next";
  if (duration > 0 && position > duration - 20) return "end of file";
  if ((info?.sinceLoad ?? ago) < 15 || position < 3) return "start";
  return "mid-playback";
}

/** A desktop player failure, with mpv's reason, recent log and playback state. */
export function reportPlaybackFailure(event: PlayerEvent, playback: FailedPlayback, action: PlaybackAction) {
  const now = Date.now();
  // Ending playback is not a failure, whatever mpv logs while it shuts down.
  if (action.kind === "stop" && now - action.at < 5000) return;
  const info = event.diagnostics;
  const log = info?.log ?? [];
  const lastError = [...log].reverse().find((line) => /\] (error|fatal):/.test(line));
  const message = info?.fileError || lastError || event.detail || "mpv ended playback with an error but gave no reason";
  const network = info?.httpStatus ? `HTTP ${info.httpStatus}` : log.some((line) => NETWORK.test(line) && /\] (error|fatal):/.test(line)) ? "network error in log" : "";
  const context = [
    playback.method,
    playback.badge,
    `${playback.videoCodec ?? "?"}/${playback.audioCodec ?? "?"}`,
    playback.itemType ?? "item",
    `trigger ${trigger(event, action, now)}`,
    `at ${clock(info?.position ?? event.time)} of ${clock(info?.duration || event.duration)}`,
    info ? `${Math.round(info.sinceLoad)}s after load` : "",
    network,
    info ? `hwdec ${info.hwdec || "none"}` : "",
    info?.videoCodec ? `decoder ${info.videoCodec}` : "",
    info?.fileFormat ? `demuxer ${info.fileFormat}` : "",
    info ? `${info.engine}${info.handoff ? " fullscreen window" : info.embedded ? " embedded" : ""}` : "",
    info?.restart ? "stream restart" : "",
    playback.retries ? `after ${playback.retries} ${playback.retries === 1 ? "retry" : "retries"}` : "",
    info ? `uptime ${clock(info.uptime)}` : "",
  ].filter(Boolean).join(" · ");
  // The webhook keeps the start of this text, so keep the newest lines that fit.
  const lines: string[] = [];
  let size = 0;
  for (const line of [...log].reverse()) {
    size += line.length + 1;
    if (size > 2600) break;
    lines.unshift(line);
  }
  const details = [`end-file reason=${info?.endReason || event.reason}${info?.fileError ? ` error="${info.fileError}"` : ""}`, ...(lines.length ? ["mpv log (warn+):", ...lines] : ["mpv log: (nothing at warn level)"])].join("\n");
  // A 5xx is the server's (or its tuner's) failure, not Finplay's: a separate,
  // lower-priority kind whose title stays the same so repeats are deduplicated.
  const server = serverError(event);
  if (server) reportCrash("Server error", `HTTP ${server}${playback.itemType === "TvChannel" ? " (Live TV)" : ""}`, context, details);
  else reportCrash("Playback failed", message, context, details);
}

export function setCrashReporting(enabled: boolean) {
  if (!inTauri()) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("crash_reporting", { enabled }))
    .catch(() => {});
}

export function installCrashReporting() {
  setCrashReporting(loadSettings().crashReports);
  window.addEventListener("error", (event) => reportCrash("Error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportCrash("Unhandled promise rejection", event.reason));
}
