export type UserData = {
  PlaybackPositionTicks?: number;
  PlayedPercentage?: number;
  Played?: boolean;
  UnplayedItemCount?: number;
  IsFavorite?: boolean;
};

export type MediaStream = {
  Index: number;
  Type: "Video" | "Audio" | "Subtitle" | string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  Height?: number;
  Width?: number;
  Channels?: number;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
  /** "External" when the server hands this subtitle over as its own file. */
  DeliveryMethod?: string;
  DeliveryUrl?: string;
};

export type MediaSource = {
  Id: string;
  Name?: string;
  Container?: string;
  Path?: string;
  Size?: number;
  Bitrate?: number;
  SupportsDirectPlay: boolean;
  SupportsDirectStream: boolean;
  SupportsTranscoding: boolean;
  DirectStreamUrl?: string;
  TranscodingUrl?: string;
  DefaultAudioStreamIndex?: number | null;
  DefaultSubtitleStreamIndex?: number | null;
  MediaStreams?: MediaStream[];
  RunTimeTicks?: number;
  LiveStreamId?: string | null;
};

export type Person = {
  Id?: string;
  Name?: string;
  Role?: string;
  Type?: string;
  PrimaryImageTag?: string;
};

export type Studio = {
  Name?: string;
};

export type BaseItem = {
  Id: string;
  Name: string;
  Type: string;
  MediaType?: string;
  Overview?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  CommunityRating?: number;
  CriticRating?: number;
  OfficialRating?: string;
  ChildCount?: number;
  /** Total runtime of a playlist or collection. */
  CumulativeRunTimeTicks?: number;
  /** This entry's place in a playlist; the same title can appear twice. */
  PlaylistItemId?: string;
  Status?: string;
  PremiereDate?: string;
  EndDate?: string;
  /** "Virtual" for episodes Jellyfin knows about but has no file for yet. */
  LocationType?: string;
  ProductionLocations?: string[];
  LocalTrailerCount?: number;
  RemoteTrailers?: { Url?: string; Name?: string }[];
  Taglines?: string[];
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  SeasonName?: string;
  Album?: string;
  AlbumId?: string;
  CollectionType?: string;
  ImageTags?: {
    Primary?: string;
    Logo?: string;
    Thumb?: string;
    Banner?: string;
  };
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  ParentThumbItemId?: string;
  ParentThumbImageTag?: string;
  UserData?: UserData;
  Genres?: string[];
  Studios?: Studio[];
  People?: Person[];
  MediaSources?: MediaSource[];
  ChannelId?: string;
  ChannelName?: string;
  ChannelNumber?: string;
  StartDate?: string;
  CurrentProgram?: BaseItem;
  IsMovie?: boolean;
  IsSeries?: boolean;
  IsNews?: boolean;
  IsSports?: boolean;
  IsKids?: boolean;
  EpisodeTitle?: string;
  /** Media source id, then thumbnail width, to the tile sheet layout. */
  Trickplay?: Record<string, Record<string, TrickplayInfo>>;
};

export type TrickplayInfo = {
  Width: number;
  Height: number;
  TileWidth: number;
  TileHeight: number;
  ThumbnailCount: number;
  Interval: number;
};

export type ItemList = {
  Items: BaseItem[];
  TotalRecordCount?: number;
};

export type PlaybackInfo = {
  PlaySessionId: string;
  MediaSources: MediaSource[];
};

// Seerr media status: 2 pending, 3 processing, 4 partially available, 5 available.
export type SeerrMediaInfo = {
  status?: number;
  jellyfinMediaId?: string | null;
  seasons?: { seasonNumber: number; status: number }[];
};

export type SeerrResult = {
  id: number;
  mediaType: "movie" | "tv" | "person" | string;
  title?: string;
  name?: string;
  overview?: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseDate?: string;
  firstAirDate?: string;
  voteAverage?: number;
  mediaInfo?: SeerrMediaInfo | null;
};

export type SeerrSearch = {
  results: SeerrResult[];
  totalResults: number;
  page?: number;
  totalPages?: number;
};

export type SyncGroup = {
  GroupId: string;
  GroupName: string;
  State: "Idle" | "Waiting" | "Paused" | "Playing" | string;
  Participants: string[];
  LastUpdatedAt?: string;
};

export type SeerrRequest = {
  id: number;
  status: number;
  type: "movie" | "tv";
  createdAt: string;
  is4k?: boolean;
  seasons?: { seasonNumber: number; status: number }[];
  requestedBy?: { jellyfinUserId?: string; jellyfinUsername?: string; displayName?: string };
  media: {
    tmdbId: number;
    status: number;
    jellyfinMediaId?: string | null;
    downloadStatus?: { size: number; sizeLeft: number; status: string; estimatedCompletionTime?: string | null }[];
  };
};

export type SeerrRequestPage = {
  pageInfo: { page: number; pages: number; results: number };
  results: SeerrRequest[];
};

export type SeerrTv = SeerrResult & {
  seasons: { seasonNumber: number; episodeCount: number; name: string }[];
};

export type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";

export type PlayerEvent = {
  kind: "status" | "closed";
  time: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  reason: string;
  detail: string;
  embedded: boolean;
  volume: number;
  muted: boolean;
  rate: number;
  /** Desktop player, only with `reason: "error"`. Log lines are already redacted. */
  diagnostics?: PlayerDiagnostics;
};

export type PlayerDiagnostics = {
  endReason: string;
  /** mpv's error string for the end-file event, e.g. "loading failed". */
  fileError: string;
  /** mpv's newest warnings and errors. */
  log: string[];
  hwdec: string;
  videoCodec: string;
  fileFormat: string;
  position: number;
  duration: number;
  /** Seconds since this mpv was started. */
  sinceLoad: number;
  seeking: boolean;
  /** Restarted to enter or leave fullscreen. */
  restart: boolean;
  httpStatus: string;
  /** Seconds since the app started. */
  uptime: number;
  engine: string;
  embedded: boolean;
  handoff: boolean;
};

export type MpvTrack = {
  id: number;
  type: "audio" | "sub" | "video" | string;
  title?: string;
  lang?: string;
  selected?: boolean;
  codec?: string;
};

export type ActiveSession = {
  Id: string;
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  NowPlayingItem?: BaseItem;
  PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string };
  TranscodingInfo?: {
    VideoCodec?: string;
    AudioCodec?: string;
    Bitrate?: number;
    IsVideoDirect?: boolean;
    IsAudioDirect?: boolean;
    Width?: number;
    Height?: number;
  };
};

/** Another Jellyfin client this user can send titles to and control. */
export type RemoteSession = {
  Id: string;
  DeviceId?: string;
  DeviceName?: string;
  Client?: string;
  UserName?: string;
  SupportsRemoteControl?: boolean;
  Capabilities?: { SupportedCommands?: string[] };
  NowPlayingItem?: BaseItem;
  PlayState?: { PositionTicks?: number; IsPaused?: boolean; VolumeLevel?: number; IsMuted?: boolean };
};

export type Theme = "system" | "dark" | "light" | "tv";

export type Settings = {
  theme: Theme;
  fullscreen: boolean;
  audioLanguage: string;
  subtitleLanguage: string;
  subtitlesEnabled: boolean;
  /** mpv sub-scale; 1 is default size. */
  subtitleScale: number;
  /** CSS-like name mapped to an mpv color, e.g. white or yellow. */
  subtitleColor: string;
  /** Empty uses mpv's default font. */
  subtitleFont: string;
  maxBitrate: number;
  mpvPath: string;
  autoplayNext: boolean;
  autoSkipIntro: boolean;
  /** Default playback rate when a title starts. */
  playbackSpeed: number;
  streamystatsUrl: string;
  couchMode: boolean;
  /** What the Home hero shows, in this order. */
  heroSources: HeroSource[];
  heroTypes: "all" | "movies" | "shows";
  heroAutoAdvance: boolean;
  /** No blur effects and cheaper video scaling, for older or low-power machines. */
  lowPower: boolean;
  /** Crashes and player failures are sent to the developer, without account details. */
  crashReports: boolean;
};

export type HeroSource = "resume" | "nextUp" | "picks" | "latest" | "favorites";

export const DEFAULT_SETTINGS: Settings = {
  heroSources: ["resume", "nextUp", "picks", "latest"],
  heroTypes: "all",
  heroAutoAdvance: true,
  lowPower: typeof navigator !== "undefined" && (navigator.hardwareConcurrency || 8) <= 4,
  theme: "dark",
  fullscreen: false,
  audioLanguage: "",
  subtitleLanguage: "eng",
  subtitlesEnabled: false,
  subtitleScale: 1,
  subtitleColor: "white",
  subtitleFont: "",
  maxBitrate: 1_000_000_000,
  mpvPath: "mpv",
  couchMode: false,
  autoplayNext: true,
  autoSkipIntro: false,
  playbackSpeed: 1,
  streamystatsUrl: "",
  crashReports: true,
};

export type MediaSegment = {
  Type: "Intro" | "Outro" | "Recap" | "Preview" | "Commercial" | "Unknown" | string;
  StartTicks: number;
  EndTicks: number;
};
