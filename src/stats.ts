import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./player";

export function normalizeStatsUrl(input: string) {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Opens the Streamystats dashboard in its own window. */
export async function openStats(address: string) {
  const url = normalizeStatsUrl(address);
  if (!url) throw new Error("Add your Streamystats address in Settings first.");
  if (!inTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  try {
    await invoke("open_stats", { url });
  } catch (err) {
    throw new Error(typeof err === "string" ? err : err instanceof Error ? err.message : "Could not open Streamystats.");
  }
}
