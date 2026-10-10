import type { Jellyfin } from "./jellyfin";
import { useSession } from "./session";
import type { BaseItem, MediaStream } from "./types";

/** Server administration: everything here needs an administrator's sign-in. */

const DEV_NON_ADMIN = "finplay.dev.nonAdmin";

/** Admin tools are shown only to administrators. In `vite` dev runs,
 * `localStorage["finplay.dev.nonAdmin"] = "1"` previews the non-admin view;
 * production builds drop the check. */
export function useIsAdmin() {
  const { isAdmin } = useSession();
  if (import.meta.env.DEV && localStorage.getItem(DEV_NON_ADMIN) === "1") return false;
  return isAdmin;
}

export type SessionItem = BaseItem & { MediaStreams?: MediaStream[]; SeriesPrimaryImageTag?: string };

export type TranscodeInfo = {
  VideoCodec?: string;
  AudioCodec?: string;
  Container?: string;
  Bitrate?: number;
  Framerate?: number;
  CompletionPercentage?: number;
  Width?: number;
  Height?: number;
  AudioChannels?: number;
  IsVideoDirect?: boolean;
  IsAudioDirect?: boolean;
  HardwareAccelerationType?: string;
  TranscodeReasons?: string[];
};

export type AdminSession = {
  Id: string;
  UserId?: string;
  UserName?: string;
  Client?: string;
  ApplicationVersion?: string;
  DeviceId?: string;
  DeviceName?: string;
  RemoteEndPoint?: string;
  LastActivityDate?: string;
  SupportsRemoteControl?: boolean;
  SupportsMediaControl?: boolean;
  SupportedCommands?: string[];
  Capabilities?: { SupportedCommands?: string[] };
  NowPlayingItem?: SessionItem;
  PlayState?: {
    PositionTicks?: number;
    CanSeek?: boolean;
    IsPaused?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
    PlayMethod?: string;
    AudioStreamIndex?: number;
    SubtitleStreamIndex?: number;
    MediaSourceId?: string;
  };
  TranscodingInfo?: TranscodeInfo;
  NowPlayingQueue?: unknown[];
};

export type SystemInfo = {
  ServerName?: string;
  Version?: string;
  ProductName?: string;
  OperatingSystem?: string;
  OperatingSystemDisplayName?: string;
  SystemArchitecture?: string;
  HasPendingRestart?: boolean;
  HasUpdateAvailable?: boolean;
  IsShuttingDown?: boolean;
  CanSelfRestart?: boolean;
  LocalAddress?: string;
  ProgramDataPath?: string;
  CachePath?: string;
  LogPath?: string;
  TranscodingTempPath?: string;
  InternalMetadataPath?: string;
  EncoderLocation?: string;
};

export type StorageFolder = { Path?: string; FreeSpace?: number; UsedSpace?: number; StorageType?: string; DeviceId?: string };
export type StorageInfo = {
  ProgramDataFolder?: StorageFolder;
  CacheFolder?: StorageFolder;
  LogFolder?: StorageFolder;
  InternalMetadataFolder?: StorageFolder;
  TranscodingTempFolder?: StorageFolder;
  Libraries?: { Id: string; Name: string; Folders?: StorageFolder[] }[];
};

export type VirtualFolder = {
  Name: string;
  ItemId: string;
  CollectionType?: string;
  Locations?: string[];
  RefreshStatus?: string;
  RefreshProgress?: number | null;
  PrimaryImageItemId?: string;
};

export type ItemCounts = { MovieCount?: number; SeriesCount?: number; EpisodeCount?: number; SongCount?: number; AlbumCount?: number; BookCount?: number; BoxSetCount?: number; ItemCount?: number };

export type TaskResult = { StartTimeUtc?: string; EndTimeUtc?: string; Status?: string; ErrorMessage?: string };
export type ScheduledTask = {
  Id: string;
  Name: string;
  Key?: string;
  Category?: string;
  Description?: string;
  State: "Idle" | "Running" | "Cancelling" | string;
  CurrentProgressPercentage?: number | null;
  IsHidden?: boolean;
  LastExecutionResult?: TaskResult;
};

export type ActivityEntry = {
  Id: number;
  Name: string;
  ShortOverview?: string;
  Overview?: string;
  Type?: string;
  ItemId?: string;
  Date: string;
  UserId?: string;
  Severity?: string;
};

export type AdminUser = {
  Id: string;
  Name: string;
  PrimaryImageTag?: string;
  HasPassword?: boolean;
  LastLoginDate?: string;
  LastActivityDate?: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean; IsHidden?: boolean; EnableRemoteControlOfOtherUsers?: boolean };
};

export type DeviceInfo = {
  Id: string;
  Name?: string;
  CustomName?: string;
  AppName?: string;
  AppVersion?: string;
  LastUserName?: string;
  LastUserId?: string;
  DateLastActivity?: string;
};

export type PluginInfo = { Id: string; Name: string; Version?: string; Description?: string; Status?: string; CanUninstall?: boolean; HasImage?: boolean };

export type LogFile = { Name: string; Size?: number; DateCreated?: string; DateModified?: string };

/** What Jellyfin's "Refresh metadata" dialog offers. */
export type RefreshMode = "scan" | "missing" | "replace";

export const REFRESH_MODES: { id: RefreshMode; label: string; hint: string }[] = [
  { id: "scan", label: "Scan for new and updated files", hint: "Picks up added, changed, and removed files." },
  { id: "missing", label: "Search for missing metadata", hint: "Also fills in details and artwork that are missing." },
  { id: "replace", label: "Replace all metadata", hint: "Downloads every title's details again. Slow on big libraries." },
];

async function json<T>(client: Jellyfin, path: string): Promise<T> {
  const response = await client.request("GET", path);
  return (await response.json()) as T;
}

async function post(client: Jellyfin, path: string, body?: unknown) {
  await client.request("POST", path, body);
}

export const admin = {
  sessions: (client: Jellyfin) => json<AdminSession[]>(client, `/Sessions?${new URLSearchParams({ ActiveWithinSeconds: "960" })}`),

  playstate: (client: Jellyfin, sessionId: string, command: "PlayPause" | "Pause" | "Unpause" | "Stop" | "NextTrack" | "PreviousTrack" | "Seek", seekTicks?: number) => {
    const query = command === "Seek" ? `?${new URLSearchParams({ SeekPositionTicks: String(Math.max(0, Math.round(seekTicks ?? 0))) })}` : "";
    return post(client, `/Sessions/${sessionId}/Playing/${command}${query}`);
  },

  command: (client: Jellyfin, sessionId: string, name: string, args?: Record<string, string>) =>
    args ? post(client, `/Sessions/${sessionId}/Command`, { Name: name, Arguments: args }) : post(client, `/Sessions/${sessionId}/Command/${name}`),

  message: (client: Jellyfin, sessionId: string, text: string, header = "Message from your server") =>
    post(client, `/Sessions/${sessionId}/Message`, { Header: header, Text: text, TimeoutMs: 8000 }),

  systemInfo: (client: Jellyfin) => json<SystemInfo>(client, "/System/Info"),
  storage: (client: Jellyfin) => json<StorageInfo>(client, "/System/Info/Storage"),
  restart: (client: Jellyfin) => post(client, "/System/Restart"),
  shutdown: (client: Jellyfin) => post(client, "/System/Shutdown"),

  activity: (client: Jellyfin, limit = 30) => json<{ Items?: ActivityEntry[] }>(client, `/System/ActivityLog/Entries?${new URLSearchParams({ limit: String(limit) })}`),

  libraries: (client: Jellyfin) => json<VirtualFolder[]>(client, "/Library/VirtualFolders"),
  counts: (client: Jellyfin) => json<ItemCounts>(client, "/Items/Counts"),
  /** How many titles of the library's main kind it holds. */
  async libraryCount(client: Jellyfin, folder: VirtualFolder) {
    const kinds: Record<string, string> = { movies: "Movie", tvshows: "Series", music: "MusicAlbum", books: "Book", musicvideos: "MusicVideo", homevideos: "Video,Photo", boxsets: "BoxSet" };
    const params = new URLSearchParams({ ParentId: folder.ItemId, Recursive: "true", Limit: "0", EnableTotalRecordCount: "true" });
    const kind = folder.CollectionType ? kinds[folder.CollectionType] : undefined;
    if (kind) params.set("IncludeItemTypes", kind);
    else params.set("IsFolder", "false");
    const list = await json<{ TotalRecordCount?: number }>(client, `/Items?${params}`);
    return list.TotalRecordCount ?? 0;
  },
  scanAll: (client: Jellyfin) => post(client, "/Library/Refresh"),
  refreshLibrary: (client: Jellyfin, id: string, mode: RefreshMode, replaceImages = false) => {
    const full = mode !== "scan";
    const params = new URLSearchParams({
      Recursive: "true",
      MetadataRefreshMode: full ? "FullRefresh" : "Default",
      ImageRefreshMode: full ? "FullRefresh" : "Default",
      ReplaceAllMetadata: String(mode === "replace"),
      ReplaceAllImages: String(mode === "replace" && replaceImages),
    });
    return post(client, `/Items/${id}/Refresh?${params}`);
  },

  tasks: (client: Jellyfin) => json<ScheduledTask[]>(client, `/ScheduledTasks?${new URLSearchParams({ IsHidden: "false" })}`),
  startTask: (client: Jellyfin, id: string) => post(client, `/ScheduledTasks/Running/${id}`),
  stopTask: async (client: Jellyfin, id: string) => {
    await client.request("DELETE", `/ScheduledTasks/Running/${id}`);
  },

  users: (client: Jellyfin) => json<AdminUser[]>(client, "/Users"),
  devices: (client: Jellyfin) => json<{ Items?: DeviceInfo[] }>(client, "/Devices"),
  plugins: (client: Jellyfin) => json<PluginInfo[]>(client, "/Plugins"),
  logs: (client: Jellyfin) => json<LogFile[]>(client, "/System/Logs"),
  async log(client: Jellyfin, name: string) {
    const response = await client.request("GET", `/System/Logs/Log?${new URLSearchParams({ name })}`);
    return response.text();
  },
};

export function userImage(server: string, token: string, user: { Id: string; PrimaryImageTag?: string }) {
  if (!user.PrimaryImageTag) return undefined;
  const params = new URLSearchParams({ ApiKey: token, tag: user.PrimaryImageTag, maxHeight: "96", quality: "90" });
  return `${server}/Users/${user.Id}/Images/Primary?${params}`;
}

export function libraryImage(server: string, token: string, itemId: string) {
  const params = new URLSearchParams({ ApiKey: token, maxWidth: "640", quality: "80" });
  return `${server}/Items/${itemId}/Images/Primary?${params}`;
}

export function sessionCommands(session: AdminSession) {
  return new Set(session.Capabilities?.SupportedCommands ?? session.SupportedCommands ?? []);
}
