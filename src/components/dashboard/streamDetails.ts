import type { AdminSession, TranscodeInfo } from "../../admin";
import { prettyCodec, resolutionLabel, videoRangeLabel } from "../../media";
import type { MediaStream } from "../../types";

export type Stream = MediaStream & { BitRate?: number; VideoRange?: string; VideoRangeType?: string; ChannelLayout?: string };

/** One chip in the stream summary; `title` is the hover explanation. */
export type Chip = { text: string; title?: string; warn?: boolean };

const REASONS: Record<string, [label: string, detail: string]> = {
  ContainerNotSupported: ["Container not supported", "The app can't open this file format, so it's repackaged."],
  VideoCodecNotSupported: ["Video codec not supported", "The app can't decode this video codec."],
  AudioCodecNotSupported: ["Audio codec not supported", "The app can't decode this audio codec (common with TrueHD and DTS)."],
  SubtitleCodecNotSupported: ["Subtitles burned in", "The app can't show this subtitle format, so it's drawn into the video."],
  AudioIsExternal: ["External audio file", "The audio track is a separate file that has to be merged in."],
  SecondaryAudioNotSupported: ["Extra audio track not supported", "The app can only play the file's first audio track."],
  VideoProfileNotSupported: ["Video profile not supported", "The app doesn't support this codec profile (e.g. HEVC Main 10)."],
  VideoLevelNotSupported: ["Video level not supported", "The codec level is higher than the app allows."],
  VideoResolutionNotSupported: ["Resolution too high", "The video is larger than the app or device allows."],
  VideoBitDepthNotSupported: ["Bit depth not supported", "The app can't play this bit depth (e.g. 10-bit)."],
  VideoFramerateNotSupported: ["Frame rate not supported", "The frame rate is higher than the app allows."],
  RefFramesNotSupported: ["Too many reference frames", "The video uses more reference frames than the app allows."],
  AnamorphicVideoNotSupported: ["Anamorphic video not supported", "The app can't play non-square pixels."],
  InterlacedVideoNotSupported: ["Interlaced video not supported", "The video has to be deinterlaced."],
  AudioChannelsNotSupported: ["Too many audio channels", "The app or device allows fewer channels, so audio is downmixed."],
  AudioProfileNotSupported: ["Audio profile not supported", "The app doesn't support this audio profile."],
  AudioSampleRateNotSupported: ["Audio sample rate not supported", "The app can't play this sample rate."],
  AudioBitDepthNotSupported: ["Audio bit depth not supported", "The app can't play this audio bit depth."],
  ContainerBitrateExceedsLimit: ["Over bitrate limit", "The file's bitrate is above the user's or app's streaming limit."],
  VideoBitrateNotSupported: ["Video bitrate too high", "The video bitrate is above what the app allows."],
  AudioBitrateNotSupported: ["Audio bitrate too high", "The audio bitrate is above what the app allows."],
  UnknownVideoStreamInfo: ["Unknown video details", "The server couldn't read the video's details, so it transcodes to be safe."],
  UnknownAudioStreamInfo: ["Unknown audio details", "The server couldn't read the audio's details, so it transcodes to be safe."],
  DirectPlayError: ["Direct play failed", "The app tried to play the file directly and hit an error."],
  VideoRangeTypeNotSupported: ["HDR type not supported by client", "The app or display can't show this HDR type, so the video is converted to SDR."],
  VideoCodecTagNotSupported: ["Codec tag not supported", "The app rejects how the codec is labelled in the file (e.g. hev1 HEVC on Apple devices), so the video is re-encoded."],
  StreamCountExceedsLimit: ["Too many streams", "The file has more streams than the app allows."],
};

export function reasonChips(reasons: string[] = []): Chip[] {
  return [...new Set(reasons)].map((reason) => {
    const known = REASONS[reason];
    const text = known?.[0] ?? reason.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/ Not /g, " not ").replace(/ Is /g, " is ");
    return { text, title: known?.[1] ?? reason, warn: true };
  });
}

export function bitrate(bits?: number) {
  if (!bits) return "";
  return bits >= 1_000_000 ? `${(bits / 1_000_000).toFixed(bits >= 10_000_000 ? 0 : 1)} Mbps` : `${Math.round(bits / 1000)} kbps`;
}

function channels(count?: number) {
  if (!count) return "";
  if (count === 1) return "Mono";
  if (count === 2) return "Stereo";
  return `${count - 1}.1`;
}

const COPIED = "Passed through unchanged; only the container changes.";

function codecChip(kind: "video" | "audio", source: string, info: TranscodeInfo | undefined, converted: boolean): Chip | null {
  const from = prettyCodec(source);
  if (converted) {
    const to = prettyCodec(info?.[kind === "video" ? "VideoCodec" : "AudioCodec"]) || "?";
    const same = from && from === to;
    return {
      text: `${from || "?"} → ${to} (re-encoded)`,
      title: same ? `The ${kind} is decoded and encoded again in the same codec, because of the reason above.` : `The server converts the ${kind} to ${to}.`,
    };
  }
  if (!from) return null;
  return info ? { text: `${from} (copied)`, title: COPIED } : { text: from };
}

export type StreamSummary = {
  method: Chip & { transcode: boolean };
  container?: Chip;
  reasons: Chip[];
  video: Chip[];
  audio: Chip[];
};

/** How a session is being played. Jellyfin reports a remux as "Transcode" too, so the copy flags decide. */
export function sessionMethod(session: AdminSession): StreamSummary["method"] {
  const info = session.TranscodingInfo;
  const method = session.PlayState?.PlayMethod;
  if (info && !info.IsVideoDirect) return { text: "Transcode", transcode: true, title: "The server is re-encoding the video." };
  if (info && !info.IsAudioDirect) return { text: "Audio transcode", transcode: true, title: "Video is copied; only the audio is re-encoded." };
  if (info) return { text: "Remux", transcode: false, title: "Audio and video are copied into a new container; no re-encoding." };
  if (method === "DirectStream") return { text: "Direct stream", transcode: false, title: "The server streams the file without re-encoding." };
  if (method === "Transcode") return { text: "Transcode", transcode: true };
  return { text: "Direct play", transcode: false, title: "The app plays the original file." };
}

/** What the server is doing to a session's media, in words an admin can act on. */
export function streamSummary(session: AdminSession, streams: Stream[]): StreamSummary {
  const info = session.TranscodingInfo;
  const state = session.PlayState ?? {};
  const video = streams.find((stream) => stream.Type === "Video");
  const audio =
    streams.find((stream) => stream.Type === "Audio" && stream.Index === state.AudioStreamIndex) ??
    streams.find((stream) => stream.Type === "Audio" && stream.IsDefault) ??
    streams.find((stream) => stream.Type === "Audio");
  const videoConverted = Boolean(info && !info.IsVideoDirect);
  const audioConverted = Boolean(info && !info.IsAudioDirect);
  const reasons = info?.TranscodeReasons ?? [];
  const method = sessionMethod(session);

  const videoChips: Chip[] = [];
  const sourceRes = resolutionLabel(video);
  const outputRes = resolutionLabel(info);
  if (videoConverted && outputRes && sourceRes && outputRes !== sourceRes) {
    videoChips.push({ text: `${sourceRes} → ${outputRes}`, title: "Scaled down by the server." });
  } else if (sourceRes || outputRes) {
    videoChips.push({ text: sourceRes || outputRes });
  }
  const vcodec = codecChip("video", video?.Codec ?? "", info, videoConverted);
  if (vcodec) videoChips.push(vcodec);
  const rate = bitrate(videoConverted ? info?.Bitrate : video?.BitRate ?? info?.Bitrate);
  if (rate) videoChips.push({ text: rate, title: videoConverted ? "Bitrate of the transcoded stream." : undefined });
  const range = videoRangeLabel(video);
  if (range) {
    if (!videoConverted) {
      videoChips.push(info ? { text: `${range} (kept)`, title: "The video is copied, so HDR is preserved." } : { text: range });
    } else if (reasons.includes("VideoRangeTypeNotSupported")) {
      videoChips.push({ text: `${range} → SDR (tone-mapped)`, title: "The app can't show this HDR type, so the server converts it to SDR. Colours look washed out if tone mapping is turned off on the server." });
    } else {
      videoChips.push({ text: `Source ${range}`, title: "The server doesn't report the output range; HDR is usually kept when the app supports it." });
    }
  }
  if (videoConverted && info?.HardwareAccelerationType) {
    const hw = info.HardwareAccelerationType;
    videoChips.push(
      hw.toLowerCase() === "none"
        ? { text: "Software encode", title: "Encoded on the CPU; no hardware acceleration." }
        : { text: `HW ${hw.toUpperCase()}`, title: `Hardware-accelerated with ${hw.toUpperCase()}.` },
    );
  }

  const audioChips: Chip[] = [];
  if (audio?.Language) audioChips.push({ text: audio.Language.toUpperCase() });
  const acodec = codecChip("audio", audio?.Codec ?? "", info, audioConverted);
  if (acodec) audioChips.push(acodec);
  const sourceCh = channels(audio?.Channels);
  const outputCh = channels(info?.AudioChannels);
  if (audioConverted && sourceCh && outputCh && sourceCh !== outputCh) audioChips.push({ text: `${sourceCh} → ${outputCh}`, title: "Downmixed by the server." });
  else if (sourceCh || (audioConverted && outputCh)) audioChips.push({ text: sourceCh || outputCh });

  return {
    method,
    container: info?.Container && (method.transcode || method.text === "Remux") ? { text: info.Container.toUpperCase(), title: "Container the server sends." } : undefined,
    reasons: reasonChips(reasons),
    video: videoChips,
    audio: audioChips,
  };
}
