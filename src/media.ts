import type { Auth } from "./jellyfin";
import type { BaseItem, MediaSource, PlayMethod } from "./types";

const TICKS = 10_000_000;

export function ticksToSeconds(ticks?: number) {
  return (ticks ?? 0) / TICKS;
}

export function secondsToTicks(seconds: number) {
  return Math.round(seconds * TICKS);
}

export function formatClock(seconds?: number) {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function formatRuntime(ticks?: number) {
  const total = Math.round(ticksToSeconds(ticks));
  if (!total) return "";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function episodeCode(item: BaseItem) {
  if (item.Type !== "Episode") return "";
  if (item.ParentIndexNumber != null && item.IndexNumber != null) {
    return `S${item.ParentIndexNumber}:E${item.IndexNumber}`;
  }
  if (item.IndexNumber != null) return `Episode ${item.IndexNumber}`;
  return "";
}

export function playbackTitle(item: BaseItem) {
  const code = episodeCode(item);
  if (item.Type === "Episode") {
    return [item.SeriesName, code, item.Name].filter(Boolean).join(" · ");
  }
  return item.Name;
}

export function hue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** Placeholder colour behind artwork, tinted per title and toned by the theme. */
export function tile(name: string) {
  return `hsl(${hue(name)} var(--tile-sat) var(--tile-light))`;
}

export function imageUrl(
  auth: Auth,
  itemId: string,
  kind: "Primary" | "Backdrop" | "Logo" | "Thumb",
  tag?: string,
  index = 0,
  maxWidth?: number,
) {
  if (!tag) return undefined;
  const params = new URLSearchParams({ ApiKey: auth.token, tag });
  if (maxWidth) {
    params.set("maxWidth", String(maxWidth));
    params.set("quality", "80");
    const path = kind === "Backdrop" ? `Backdrop/${index}` : kind;
    return `${auth.server}/Items/${itemId}/Images/${path}?${params}`;
  }
  if (kind === "Backdrop") {
    params.set("maxWidth", "1920");
    params.set("quality", "70");
    return `${auth.server}/Items/${itemId}/Images/Backdrop/${index}?${params}`;
  }
  if (kind === "Logo") {
    params.set("maxHeight", "280");
    params.set("quality", "90");
  } else if (kind === "Thumb") {
    params.set("maxWidth", "800");
    params.set("quality", "75");
  } else {
    params.set("maxHeight", "520");
    params.set("quality", "80");
  }
  return `${auth.server}/Items/${itemId}/Images/${kind}?${params}`;
}

export function primaryUrl(auth: Auth, item: BaseItem) {
  return imageUrl(auth, item.Id, "Primary", item.ImageTags?.Primary);
}

export function logoUrl(auth: Auth, item: BaseItem) {
  return imageUrl(auth, item.Id, "Logo", item.ImageTags?.Logo);
}

export function thumbUrl(auth: Auth, item: BaseItem) {
  // An episode's Primary image is its own still; the parent thumb is series art.
  if (item.Type === "Episode" && item.ImageTags?.Primary) {
    return imageUrl(auth, item.Id, "Primary", item.ImageTags.Primary, 0, 800);
  }
  if (item.ImageTags?.Thumb) return imageUrl(auth, item.Id, "Thumb", item.ImageTags.Thumb);
  if (item.ParentThumbItemId && item.ParentThumbImageTag) {
    return imageUrl(auth, item.ParentThumbItemId, "Thumb", item.ParentThumbImageTag);
  }
  if (item.BackdropImageTags?.[0]) return imageUrl(auth, item.Id, "Backdrop", item.BackdropImageTags[0]);
  return primaryUrl(auth, item);
}

export function backdropUrl(auth: Auth, item: BaseItem) {
  if (item.BackdropImageTags?.[0]) return imageUrl(auth, item.Id, "Backdrop", item.BackdropImageTags[0]);
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return imageUrl(auth, item.ParentBackdropItemId, "Backdrop", item.ParentBackdropImageTags[0]);
  }
  return thumbUrl(auth, item);
}

export function userImageUrl(auth: Auth, imageTag?: string) {
  if (!imageTag) return undefined;
  const params = new URLSearchParams({ ApiKey: auth.token, tag: imageTag, maxHeight: "120", quality: "90" });
  return `${auth.server}/Users/${auth.userId}/Images/Primary?${params}`;
}

export function playMethodOf(source: MediaSource): PlayMethod {
  if (source.SupportsDirectPlay) return "DirectPlay";
  if (source.SupportsDirectStream) return "DirectStream";
  return "Transcode";
}

export function methodLabel(method: PlayMethod) {
  if (method === "DirectPlay") return "Direct play";
  if (method === "DirectStream") return "Direct stream";
  return "Transcoding";
}

export function prettyCodec(codec?: string) {
  if (!codec) return "";
  const key = codec.toLowerCase();
  const names: Record<string, string> = {
    hevc: "HEVC",
    h265: "HEVC",
    h264: "H.264",
    av1: "AV1",
    vp9: "VP9",
    mpeg2video: "MPEG-2",
    aac: "AAC",
    ac3: "Dolby Digital",
    eac3: "E-AC3",
    truehd: "TrueHD",
    mlp: "TrueHD",
    dts: "DTS",
    flac: "FLAC",
    opus: "Opus",
    mp3: "MP3",
    vorbis: "Vorbis",
  };
  return names[key] ?? codec.toUpperCase();
}

export function resolutionLabel(height?: number) {
  if (!height) return "";
  if (height >= 2000) return "4K";
  if (height >= 1400) return "1440p";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  return `${height}p`;
}

export function videoStream(source?: MediaSource) {
  return source?.MediaStreams?.find((stream) => stream.Type === "Video");
}

export function audioStream(source?: MediaSource) {
  const streams = source?.MediaStreams?.filter((stream) => stream.Type === "Audio") ?? [];
  return streams.find((stream) => stream.Index === source?.DefaultAudioStreamIndex) ?? streams[0];
}

export function streamBadge(source: MediaSource) {
  const video = videoStream(source);
  const audio = audioStream(source);
  return [methodLabel(playMethodOf(source)), [resolutionLabel(video?.Height), prettyCodec(video?.Codec)].filter(Boolean).join(" "), prettyCodec(audio?.Codec)]
    .filter(Boolean)
    .join(" · ");
}

export function mediaUrl(auth: Auth, itemId: string, source: MediaSource, playSessionId: string, mediaType?: string) {
  if (source.SupportsDirectPlay) {
    const container = (source.Container || "mkv").split(",")[0];
    const params = new URLSearchParams({
      static: "true",
      mediaSourceId: source.Id,
      ApiKey: auth.token,
      DeviceId: auth.deviceId,
      PlaySessionId: playSessionId,
    });
    if (source.LiveStreamId) params.set("LiveStreamId", source.LiveStreamId);
    const root = mediaType === "Audio" ? "Audio" : "Videos";
    return `${auth.server}/${root}/${itemId}/stream.${container}?${params}`;
  }
  const path = source.SupportsDirectStream ? source.DirectStreamUrl : source.TranscodingUrl;
  if (!path) throw new Error("Jellyfin did not return a playable stream.");
  const absolute = path.startsWith("http") ? path : `${auth.server}${path.startsWith("/") ? "" : "/"}${path}`;
  const url = new URL(absolute);
  url.searchParams.delete("api_key");
  url.searchParams.set("ApiKey", auth.token);
  return url.toString();
}
