import type { Auth } from "./jellyfin";
import type { BaseItem, MediaSource, MediaStream, PlayMethod } from "./types";

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

/** Pixels to request for something shown `css` points large: 1x screens need
 * far less than Retina. Rounded so URLs (and Jellyfin's image cache) stay few. */
function devicePixels(css: number, cap: number) {
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  return Math.min(cap, Math.ceil((css * ratio) / 40) * 40);
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
    params.set("maxWidth", String(devicePixels(window.screen?.width || 1920, 1920)));
    params.set("quality", "70");
    return `${auth.server}/Items/${itemId}/Images/Backdrop/${index}?${params}`;
  }
  if (kind === "Logo") {
    params.set("maxHeight", String(devicePixels(160, 280)));
    params.set("quality", "90");
  } else if (kind === "Thumb") {
    params.set("maxWidth", String(devicePixels(400, 800)));
    params.set("quality", "75");
  } else {
    params.set("maxHeight", String(devicePixels(400, 520)));
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

/** Audio and subtitle stream indexes; -1 is none. */
export type StreamChoice = { audio: number; subtitle: number };

export function audioStreams(streams: MediaStream[] = []) {
  return streams.filter((stream) => stream.Type === "Audio");
}

export function subtitleStreams(streams: MediaStream[] = []) {
  return streams.filter((stream) => stream.Type === "Subtitle");
}

/** Text subtitles convert to WebVTT; picture ones (PGS, VobSub, DVB) have to be burned in. */
export function isTextSubtitle(stream: MediaStream) {
  if (typeof stream.IsTextSubtitleStream === "boolean") return stream.IsTextSubtitleStream;
  return !/pgs|dvd|dvb|vobsub|xsub/i.test(stream.Codec ?? "");
}

export function streamLabel(stream: MediaStream) {
  return stream.DisplayTitle || stream.Title || stream.Language || `${stream.Type} ${stream.Index}`;
}

/** The audio a direct-played file starts with: the browser can't pick another. */
function fileAudio(streams: MediaStream[]) {
  const audio = audioStreams(streams).filter((stream) => !stream.IsExternal);
  return (audio.find((stream) => stream.IsDefault) ?? audio[0])?.Index ?? -1;
}

/** Audio in the preferred language, else the server's pick for this user; subtitles
 * only when turned on in Settings, except forced ones in the language being heard. */
export function initialStreams(source: MediaSource, settings: { audioLanguage: string; subtitleLanguage: string; subtitlesEnabled: boolean }): StreamChoice {
  const streams = source.MediaStreams ?? [];
  const audio = audioStreams(streams);
  const serverAudio = audio.find((stream) => stream.Index === source.DefaultAudioStreamIndex) ?? audio.find((stream) => stream.IsDefault) ?? audio[0];
  const inLanguage = settings.audioLanguage ? audio.filter((stream) => stream.Language === settings.audioLanguage) : [];
  const chosenAudio = inLanguage.length && !(serverAudio && inLanguage.includes(serverAudio)) ? inLanguage[0] : serverAudio;
  const subs = subtitleStreams(streams);
  let subtitle: MediaStream | undefined;
  if (settings.subtitlesEnabled) {
    const wanted = settings.subtitleLanguage ? subs.filter((stream) => stream.Language === settings.subtitleLanguage) : [];
    subtitle =
      wanted.find((stream) => !stream.IsForced && isTextSubtitle(stream)) ??
      wanted.find((stream) => !stream.IsForced) ??
      wanted[0] ??
      subs.find((stream) => stream.Index === source.DefaultSubtitleStreamIndex) ??
      subs.find((stream) => stream.IsDefault) ??
      subs[0];
  } else if (chosenAudio?.Language) {
    subtitle = subs.find((stream) => stream.IsForced && stream.Language === chosenAudio.Language);
  }
  return { audio: chosenAudio?.Index ?? -1, subtitle: subtitle?.Index ?? -1 };
}

/** Picture subtitles can only be shown by burning them into the video. */
export function burnsIn(streams: MediaStream[] = [], subtitle: number) {
  const stream = streams.find((candidate) => candidate.Type === "Subtitle" && candidate.Index === subtitle);
  return Boolean(stream && !isTextSubtitle(stream));
}

/** Direct play can't switch audio or burn in subtitles; the server has to stream it. */
export function needsServerStream(streams: MediaStream[] = [], choice: StreamChoice) {
  return burnsIn(streams, choice.subtitle) || (choice.audio >= 0 && choice.audio !== fileAudio(streams));
}

/** Points a Jellyfin HLS address at the chosen audio, and burns in subtitles only when
 * asked: some servers ignore the indexes sent to PlaybackInfo and burn in the default
 * text subtitle, which the player shows itself as WebVTT. */
export function withStreams(url: string, choice: StreamChoice, burn: boolean) {
  const parsed = new URL(url);
  if (choice.audio >= 0) parsed.searchParams.set("AudioStreamIndex", String(choice.audio));
  if (burn) {
    parsed.searchParams.set("SubtitleStreamIndex", String(choice.subtitle));
    parsed.searchParams.set("SubtitleMethod", "Encode");
  } else {
    parsed.searchParams.delete("SubtitleStreamIndex");
    parsed.searchParams.delete("SubtitleMethod");
  }
  return parsed.toString();
}

/** A text subtitle as WebVTT. This server refuses `api_key`, so the token goes in `ApiKey`. */
export function subtitleFile(auth: Auth, itemId: string, mediaSourceId: string, stream: MediaStream) {
  const params = new URLSearchParams({ ApiKey: auth.token });
  return {
    url: `${auth.server}/Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}/0/Stream.vtt?${params}`,
    label: streamLabel(stream),
    lang: stream.Language,
    selected: true,
  };
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
