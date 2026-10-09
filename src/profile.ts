// Permissive on purpose. The browser profile Firefox sends is why Jellyfin
// transcodes HEVC, AV1, Hi10P, DTS, TrueHD, and image subtitles. mpv can
// play those as stored, so the profile must not rule them out.
export function deviceProfile(maxBitrate: number) {
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
