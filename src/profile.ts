import { inTauri } from "./player";

export function deviceProfile(maxBitrate: number) {
  return inTauri() ? mpvProfile(maxBitrate) : webProfile(maxBitrate);
}

/** What this browser or TV says its video element decodes; the server
 * remuxes or transcodes the rest to HLS. Samsung TVs report their hardware
 * decoders through `canPlayType`, so this covers HEVC and Dolby audio there. */
function webProfile(maxBitrate: number) {
  const probe = document.createElement("video");
  const can = (type: string) => probe.canPlayType(type) !== "";
  const tizen = "tizen" in window;

  const video = ["h264"];
  if (tizen || can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) video.push("hevc");
  if (can('video/webm; codecs="vp9"') || can('video/mp4; codecs="vp09.00.10.08"')) video.push("vp9");
  if (can('video/mp4; codecs="av01.0.05M.08"')) video.push("av1");
  if (tizen) video.push("mpeg2video", "mpeg4");

  const audio = ["aac", "mp3"];
  if (tizen || can('audio/mp4; codecs="ac-3"')) audio.push("ac3");
  if (tizen || can('audio/mp4; codecs="ec-3"')) audio.push("eac3");
  if (can('audio/mp4; codecs="opus"') || can('audio/webm; codecs="opus"')) audio.push("opus");
  if (can('audio/mp4; codecs="flac"') || can("audio/flac")) audio.push("flac");
  if (can('audio/ogg; codecs="vorbis"')) audio.push("vorbis");

  const containers = ["mp4", "m4v", "mov"];
  if (tizen || can("video/x-matroska") || can('video/webm; codecs="vp9"')) containers.push("mkv");
  if (can("video/webm")) containers.push("webm");
  if (tizen) containers.push("ts", "mpegts", "m2ts");

  // Desktop browsers decode HEVC from MP4 files but not inside HLS segments.
  const hlsVideo = video.filter((codec) => codec === "h264" || (codec === "hevc" && tizen));
  const hlsAudio = audio.filter((codec) => codec === "aac" || codec === "mp3" || codec === "ac3" || codec === "eac3");

  return {
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: [
      { Container: containers.join(","), Type: "Video", VideoCodec: video.join(","), AudioCodec: audio.join(",") },
      { Container: "mp3,aac,m4a,flac,ogg,oga,opus,wav,webm", Type: "Audio" },
    ],
    TranscodingProfiles: [
      {
        Container: "ts",
        Type: "Video",
        VideoCodec: hlsVideo.join(","),
        AudioCodec: hlsAudio.join(","),
        Protocol: "hls",
        Context: "Streaming",
        MaxAudioChannels: tizen ? "6" : "2",
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
      { Container: "mp3", Type: "Audio", AudioCodec: "mp3", Protocol: "http", Context: "Streaming" },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    // Text subtitles come over as WebVTT files; picture subtitles are burned in.
    SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
    ResponseProfiles: [],
  };
}

// Permissive on purpose. The browser profile Firefox sends is why Jellyfin
// transcodes HEVC, AV1, Hi10P, DTS, TrueHD, and image subtitles. mpv can
// play those as stored, so the profile must not rule them out.
function mpvProfile(maxBitrate: number) {
  const containers = [
    "mkv",
    "matroska",
    "mp4",
    "m4v",
    "mov",
    "avi",
    "mpeg",
    "mpg",
    "ts",
    "m2ts",
    "mts",
    "m2t",
    "mpegts",
    "wmv",
    "asf",
    "flv",
    "webm",
    "ogv",
    "ogm",
    "3gp",
    "vob",
    "divx",
    "xvid",
    "rmvb",
    "wtv",
    "iso",
  ].join(",");

  const subtitles = [
    "srt",
    "subrip",
    "ass",
    "ssa",
    "vtt",
    "webvtt",
    "pgs",
    "pgssub",
    "dvdsub",
    "dvbsub",
    "sub",
    "idx",
    "mov_text",
    "text",
    "microdvd",
    "ttml",
    "smi",
  ];

  return {
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: [
      { Container: containers, Type: "Video" },
      { Container: "mp3,aac,flac,alac,m4a,ogg,oga,opus,wav,wma,aiff", Type: "Audio" },
    ],
    TranscodingProfiles: [
      {
        Container: "ts",
        Type: "Video",
        VideoCodec: "h264",
        AudioCodec: "aac",
        Protocol: "hls",
        Context: "Streaming",
        MaxAudioChannels: "8",
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
      {
        Container: "mp3",
        Type: "Audio",
        AudioCodec: "mp3",
        Protocol: "http",
        Context: "Streaming",
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: subtitles.flatMap((format) => [
      { Format: format, Method: "Embed" },
      { Format: format, Method: "External" },
    ]),
    ResponseProfiles: [],
  };
}
