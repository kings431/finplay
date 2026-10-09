import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { inTauri } from "./player";
import { secondsToTicks, ticksToSeconds } from "./media";
import { useSession } from "./session";
import type { BaseItem } from "./types";

export type DownloadState = "queued" | "downloading" | "done" | "failed" | "removed";

export type DownloadEntry = {
  id: string;
  item: BaseItem;
  quality: string;
  file: string;
  state: DownloadState;
  received: number;
  total: number;
  error: string;
  added: number;
  position: number;
  positionDirty: boolean;
  played: boolean;
  images: Record<string, string>;
  /** Smoothed bytes per second while downloading. */
  rate?: number;
  folder: string;
};

export type Quality = { id: string; label: string; height?: number; bitrate?: number };

export const QUALITIES: Quality[] = [
  { id: "Original", label: "Original" },
  { id: "1080p", label: "1080p", height: 1080, bitrate: 8_000_000 },
  { id: "720p", label: "720p", height: 720, bitrate: 4_000_000 },
  { id: "480p", label: "480p", height: 480, bitrate: 1_500_000 },
];

const AUDIO_BITRATE = 192_000;

export function estimateSize(item: BaseItem, quality: Quality, mediaSourceId?: string) {
  const source = item.MediaSources?.find((entry) => entry.Id === mediaSourceId) ?? item.MediaSources?.[0];
  if (!quality.bitrate) return source?.Size ?? 0;
  const seconds = ticksToSeconds(item.RunTimeTicks ?? source?.RunTimeTicks);
  const estimate = ((quality.bitrate + AUDIO_BITRATE) * seconds) / 8;
  return source?.Size ? Math.min(estimate, source.Size) : estimate;
}

export function formatBytes(bytes: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Rough time left, e.g. "~12 min left". Transcoded sizes are estimates. */
export function formatEta(entry: DownloadEntry) {
  if (entry.state !== "downloading" || !entry.rate || !entry.total) return "";
  const left = (entry.total - entry.received) / entry.rate;
  if (left <= 5) return "Finishing…";
  if (left < 90) return `~${Math.ceil(left / 5) * 5} s left`;
  const minutes = Math.round(left / 60);
  if (minutes < 60) return `~${minutes} min left`;
  return `~${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

/** Local image for a download, through Tauri's asset protocol. */
export async function downloadImage(entry: DownloadEntry, kind: string) {
  const name = entry.images?.[kind];
  if (!name || !inTauri()) return undefined;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(`${entry.folder}/${name}`);
}

/** Keeps what offline screens need and drops bulky fields. */
function slim(item: BaseItem): BaseItem {
  const copy = { ...item } as BaseItem & Record<string, unknown>;
  for (const key of ["People", "Chapters", "Trickplay", "Studios", "ExternalUrls", "RemoteTrailers"]) delete copy[key];
  return copy;
}

type DownloadsValue = {
  entries: DownloadEntry[];
  find: (id: string) => DownloadEntry | undefined;
  start: (item: BaseItem, quality: Quality, options?: { retry?: boolean; mediaSourceId?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  saveProgress: (id: string, position: number, played: boolean, dirty: boolean) => void;
  folder: string;
};

const DownloadsContext = createContext<DownloadsValue | null>(null);

async function call<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { client, status, server, token, deviceId } = useSession();
  const [entries, setEntries] = useState<DownloadEntry[]>([]);
  const [folder, setFolder] = useState("");
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const synced = useRef(false);

  useEffect(() => {
    if (!inTauri()) return;
    let cancel = false;
    let unlisten: (() => void) | undefined;
    void call<DownloadEntry[]>("download_list").then((list) => {
      if (!cancel) setEntries(list);
    });
    void call<string>("download_dir").then((dir) => {
      if (!cancel) setFolder(dir);
    });
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<DownloadEntry>("download", (event) => {
        const entry = event.payload;
        setEntries((current) => {
          if (entry.state === "removed") return current.filter((existing) => existing.id !== entry.id);
          const index = current.findIndex((existing) => existing.id === entry.id);
          if (index === -1) return [...current, entry];
          const next = current.slice();
          next[index] = entry;
          return next;
        });
      }).then((stop) => {
        if (cancel) stop();
        else unlisten = stop;
      }),
    );
    return () => {
      cancel = true;
      unlisten?.();
    };
  }, []);

  const saveProgress = useCallback((id: string, position: number, played: boolean, dirty: boolean) => {
    if (!inTauri()) return;
    void call("download_progress", { id, position, played, dirty }).catch(() => {});
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, position, played, positionDirty: dirty } : entry)));
  }, []);

  // Progress watched offline goes back to the server once it is reachable.
  useEffect(() => {
    if (status !== "ready" || !client || synced.current || entries.length === 0) return;
    synced.current = true;
    for (const entry of entries.filter((candidate) => candidate.positionDirty)) {
      const send = entry.played
        ? client.setPlayed(entry.id, true)
        : client.report("stop", {
            ItemId: entry.id,
            MediaSourceId: entry.item.MediaSources?.[0]?.Id ?? entry.id,
            PlaySessionId: crypto.randomUUID(),
            PositionTicks: secondsToTicks(entry.position),
            PlayMethod: "DirectPlay",
          });
      void send.then(() => saveProgress(entry.id, entry.position, entry.played, false)).catch(() => {});
    }
  }, [client, entries, saveProgress, status]);

  const start = useCallback(
    async (item: BaseItem, quality: Quality, options: { retry?: boolean; mediaSourceId?: string } = {}) => {
      if (!client) throw new Error("Sign in to download.");
      const full = item.MediaSources?.length ? item : await client.item(item.Id);
      const source = full.MediaSources?.find((entry) => entry.Id === options.mediaSourceId) ?? full.MediaSources?.[0];
      if (!source) throw new Error("Jellyfin did not return a file for this item.");
      const slimItem = slim({ ...full, MediaSources: [source] });
      let url: string;
      let extension: string;
      if (!quality.height) {
        const params = new URLSearchParams({ ApiKey: token, mediaSourceId: source.Id });
        url = `${server}/Items/${full.Id}/Download?${params}`;
        extension = (source.Path?.split(".").pop() || source.Container?.split(",")[0] || "mkv").toLowerCase();
      } else {
        const params = new URLSearchParams({
          static: "false",
          MediaSourceId: source.Id,
          Container: "mkv",
          VideoCodec: "h264",
          AudioCodec: "aac",
          MaxHeight: String(quality.height),
          VideoBitrate: String(quality.bitrate),
          AudioBitrate: String(AUDIO_BITRATE),
          MaxAudioChannels: "2",
          DeviceId: deviceId,
          PlaySessionId: crypto.randomUUID(),
          ApiKey: token,
        });
        url = `${server}/Videos/${full.Id}/stream.mkv?${params}`;
        extension = "mkv";
      }
      if (!/^[a-z0-9]{1,5}$/.test(extension)) extension = "mkv";
      const images = [{ kind: "still", url: `${server}/Items/${full.Id}/Images/Primary?maxWidth=800` }];
      if (full.SeriesId) images.push({ kind: "poster", url: `${server}/Items/${full.SeriesId}/Images/Primary?maxHeight=600` });
      const backdropOwner = full.BackdropImageTags?.length ? full.Id : full.ParentBackdropItemId;
      if (backdropOwner) images.push({ kind: "backdrop", url: `${server}/Items/${backdropOwner}/Images/Backdrop?maxWidth=1600` });
      await call("download_start", {
        request: {
          id: full.Id,
          item: slimItem,
          quality: quality.id,
          url,
          extension,
          images,
          expectedSize: Math.round(estimateSize(full, quality, source.Id)),
          resumable: Boolean(options.retry) && !quality.height,
          duration: quality.height ? ticksToSeconds(full.RunTimeTicks ?? source.RunTimeTicks) : 0,
        },
      });
    },
    [client, deviceId, server, token],
  );

  const remove = useCallback(async (id: string) => {
    await call("download_delete", { id });
  }, []);

  const find = useCallback((id: string) => entries.find((entry) => entry.id === id), [entries]);

  const value = useMemo<DownloadsValue>(
    () => ({ entries, find, start, remove, saveProgress, folder }),
    [entries, find, start, remove, saveProgress, folder],
  );

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

export function useDownloads() {
  const value = useContext(DownloadsContext);
  if (!value) throw new Error("Downloads missing");
  return value;
}

/** Next downloaded episode of the same show, for offline binge watching. */
export function nextDownloaded(entries: DownloadEntry[], episode: BaseItem) {
  if (episode.Type !== "Episode" || !episode.SeriesId) return undefined;
  const order = (item: BaseItem) => (item.ParentIndexNumber ?? 0) * 10_000 + (item.IndexNumber ?? 0);
  return entries
    .filter((entry) => entry.state === "done" && entry.item.SeriesId === episode.SeriesId && order(entry.item) > order(episode))
    .sort((a, b) => order(a.item) - order(b.item))[0]?.item;
}
