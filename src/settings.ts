import { DEFAULT_SETTINGS, type Settings } from "./types";

const KEY = "finplay.settings";

/** Streaming caps, in bits per second. */
export const QUALITY_RATES = [
  { value: 1_000_000_000, label: "Original" },
  { value: 80_000_000, label: "80 Mbps" },
  { value: 40_000_000, label: "40 Mbps" },
  { value: 20_000_000, label: "20 Mbps" },
  { value: 8_000_000, label: "8 Mbps" },
];

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
