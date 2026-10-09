import { DEFAULT_SETTINGS, type Settings } from "./types";

const KEY = "finplay.settings";

export function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
