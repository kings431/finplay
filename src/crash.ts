/**
 * Sends crashes and player failures to the desktop app, which posts them to the
 * crash webhook. Tokens, server addresses and item ids are stripped first.
 */
import { inTauri } from "./player";
import { loadSettings } from "./settings";

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

export function reportCrash(kind: string, error: unknown, context = "") {
  if (!inTauri() || !loadSettings().crashReports) return;
  const { message, stack } = describe(error);
  if (!message || NOISE.test(message)) return;
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
