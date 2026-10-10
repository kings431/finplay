import type { Update } from "@tauri-apps/plugin-updater";
import { VERSION } from "./jellyfin";
import { inTauri } from "./player";

export type { Update };

export async function appVersion() {
  if (!inTauri()) return VERSION;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function findUpdate(): Promise<Update | null> {
  if (!inTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: 20_000 });
}

/** Downloads, installs, and restarts. `onProgress` gets 0–100, or -1 when the size is unknown. */
export async function installUpdate(update: Update, onProgress: (percent: number) => void) {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : -1);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : -1);
    } else {
      onProgress(100);
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
