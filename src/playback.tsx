import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Jellyfin } from "./jellyfin";
import { useSession } from "./session";
import { loadSettings } from "./settings";
import { invalidate, markStale } from "./cache";
import { listenMiniExit, listenMiniToggle, listenNext, listenPlayer, listenThumbRequests, playerFocus, playerMini, playerPlay, playerRequest, playerStop, inTauri } from "./player";
import { TrickplayRenderer, trickplaySource } from "./trickplay";
import { IconPlay } from "./icons";
import { nextDownloaded, useDownloads, type DownloadEntry } from "./downloads";
import {
  audioStreams,
  burnsIn,
  episodeCode,
  formatClock,
  initialStreams,
  mediaUrl,
  methodLabel,
  needsServerStream,
  playMethodOf,
  playbackTitle,
  secondsToTicks,
  streamBadge,
  subtitleFile,
  ticksToSeconds,
  withStreams,
  type StreamChoice,
} from "./media";
import type { PlayRequest } from "./player";
import { webAudioTrack, webSubtitle } from "./webplayer";
import { reportPlaybackFailure, type PlaybackAction } from "./crash";
import type { BaseItem, MediaSegment, MediaSource, MediaStream, PlayMethod, PlayerEvent, PlaybackInfo } from "./types";

export type ActivePlayback = {
  item: BaseItem;
  playSessionId: string;
  mediaSourceId: string;
  method: PlayMethod;
  badge: string;
  baseTicks: number;
  videoCodec?: string;
  audioCodec?: string;
  height?: number;
  /** Playing a downloaded file. */
  local?: boolean;
  duration?: number;
  /** Where to land when playback ends, instead of the item's own page. */
  returnTo?: string;
  /** Live TV tuner stream, closed by the server when the stop report names it. */
  liveStreamId?: string;
  /** A remote trailer for `item`; nothing is reported to Jellyfin. */
  trailer?: boolean;
  /** Browser player only: the source's streams and which are playing (-1 none). */
  streams?: MediaStream[];
  audioIndex?: number;
  subtitleIndex?: number;
  /** The subtitle is burned into the video by the server. */
  burnIn?: boolean;
  maxBitrate?: number;
};

/** What the browser player's menus change; anything left out stays as it is. */
export type StreamChange = { audio?: number; subtitle?: number; maxBitrate?: number; mediaSourceId?: string };

type PlaybackContextValue = {
  active: ActivePlayback | null;
  busy: boolean;
  error: string;
  clearError: () => void;
  play: (item: BaseItem, options?: PlayOptions) => Promise<void>;
  stop: () => Promise<void>;
  togglePause: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  /** While set, `play` hands titles to this instead of the local player. */
  setRemote: (send: RemoteSend | null) => void;
  /** The picture sits in a corner while the rest of the app stays usable. */
  mini: boolean;
  setMini: (on: boolean) => Promise<boolean>;
  /** Browser player: switches audio, subtitles, quality or version, restarting
   * the stream at the same spot when it can't be done in place. */
  changeStreams: (change: StreamChange) => Promise<void>;
};

export type RemoteSend = (item: BaseItem, startTicks: number, mediaSourceId?: string) => Promise<void>;

/** `resume` means the caller already chose to resume, so no prompt is shown. */
export type PlayOptions = {
  fromStart?: boolean;
  resume?: boolean;
  mediaSourceId?: string;
  returnTo?: string;
  /** Starts exactly here, in seconds, with no resume prompt. */
  startAt?: number;
  /** Plays this remote trailer (a `trailerStream` address) for the item instead. */
  trailerUrl?: string;
  /** Plays here even while another device is chosen to play on. */
  local?: boolean;
  /** What plays after this, in order, instead of the next episode (a playlist). */
  queue?: BaseItem[];
};

type ResumeAsk = { item: BaseItem; seconds: number; resolve: (choice: "resume" | "start" | null) => void };

/** Changes several times a second while playing, so it has its own context:
 * only views that show the clock re-render on every tick. */
type PlaybackClock = { position: number; duration: number; paused: boolean; finished: boolean };

const PlaybackContext = createContext<PlaybackContextValue | null>(null);
const PlaybackClockContext = createContext<PlaybackClock>({ position: 0, duration: 0, paused: false, finished: false });

function segmentsFor(segments: MediaSegment[], offsetSeconds: number) {
  return segments
    .map((segment) => ({
      type: segment.Type,
      start: Math.max(0, ticksToSeconds(segment.StartTicks) - offsetSeconds),
      end: ticksToSeconds(segment.EndTicks) - offsetSeconds,
    }))
    .filter((segment) => segment.end > segment.start + 1 && /^[A-Za-z]+$/.test(segment.type))
    .map((segment) => `${segment.type}:${segment.start.toFixed(2)}:${segment.end.toFixed(2)}`)
    .join(";");
}

function sourceOf(sources: MediaSource[], preferred?: string) {
  return sources.find((source) => source.Id === preferred) ?? sources[0];
}

type WebStream = { info: PlaybackInfo; source: MediaSource; method: PlayMethod; url: string; burn: boolean };

/** The browser player's address for `choice`. Direct play is kept when the file
 * already starts with that audio and the subtitle can be shown as WebVTT;
 * otherwise the server streams it with those tracks. */
async function webStream(client: Jellyfin, item: BaseItem, info: PlaybackInfo, source: MediaSource, choice: StreamChoice, maxBitrate: number, startTicks: number): Promise<WebStream> {
  if (playMethodOf(source) !== "Transcode" && needsServerStream(source.MediaStreams, choice)) {
    const served = await client.playbackInfo(item.Id, {
      startTicks,
      mediaSourceId: source.Id,
      audioIndex: choice.audio,
      subtitleIndex: choice.subtitle,
      maxBitrate,
      direct: false,
    });
    const servedSource = sourceOf(served.MediaSources ?? [], source.Id);
    if (servedSource) {
      info = served;
      source = servedSource;
    }
  }
  const method = playMethodOf(source);
  const burn = method === "Transcode" && burnsIn(source.MediaStreams, choice.subtitle);
  let url = mediaUrl(client.auth, item.Id, source, info.PlaySessionId, item.MediaType);
  if (method === "Transcode") url = withStreams(url, choice, burn);
  return { info, source, method, url, burn };
}

/** The WebVTT file for a text subtitle the player draws itself. */
function textSubtitle(client: Jellyfin, itemId: string, source: MediaSource, index: number, burn: boolean) {
  const stream = source.MediaStreams?.find((candidate) => candidate.Type === "Subtitle" && candidate.Index === index);
  return stream && !burn ? subtitleFile(client.auth, itemId, source.Id, stream) : undefined;
}

function streamsOf(source: MediaSource, choice: StreamChoice, burn: boolean, maxBitrate: number) {
  const audio = audioStreams(source.MediaStreams).find((stream) => stream.Index === choice.audio);
  return { streams: source.MediaStreams ?? [], audioIndex: choice.audio, subtitleIndex: choice.subtitle, burnIn: burn, maxBitrate, ...(audio ? { audioCodec: audio.Codec } : {}) };
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const { client, status } = useSession();
  const downloads = useDownloads();
  const statusRef = useRef(status);
  statusRef.current = status;
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;
  const saveProgressRef = useRef(downloads.saveProgress);
  saveProgressRef.current = downloads.saveProgress;
  const navigate = useNavigate();
  const [active, setActive] = useState<ActivePlayback | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const [mini, setMiniState] = useState(false);
  const miniRef = useRef(false);

  const activeRef = useRef<ActivePlayback | null>(null);
  const positionRef = useRef(0);
  const volumeRef = useRef({ volume: 100, muted: false, rate: 1 });
  const stopSent = useRef(false);
  const navigateRef = useRef(navigate);
  const trickplayRef = useRef<TrickplayRenderer | null>(null);
  const remoteRef = useRef<RemoteSend | null>(null);
  const pausedRef = useRef(false);
  /** What the server last heard, to report changes as they happen. */
  const sentRef = useRef({ paused: false, position: 0, at: 0, volume: 100, muted: false });
  const nextRef = useRef<BaseItem | null>(null);
  const queueRef = useRef<BaseItem[] | undefined>(undefined);
  /** What the player was last asked to play, replayed when a stream restarts. */
  const requestRef = useRef<PlayRequest | null>(null);
  const actionRef = useRef<PlaybackAction>({ kind: "start", at: 0 });
  /** The play session a failure was already handled for. */
  const failedRef = useRef("");
  const playRef = useRef<(item: BaseItem, options?: PlayOptions) => Promise<void>>(async () => {});
  const [resumeAsk, setResumeAsk] = useState<ResumeAsk | null>(null);
  navigateRef.current = navigate;
  activeRef.current = active;

  const sendReport = useCallback(
    async (playback: ActivePlayback, event: "start" | "progress" | "stop", seconds: number, isPaused: boolean) => {
      if (!client) return false;
      const ticks = playback.baseTicks + secondsToTicks(Math.max(0, seconds));
      const { volume, muted, rate } = volumeRef.current;
      try {
        await client.report(event, {
          ItemId: playback.item.Id,
          PlaySessionId: playback.playSessionId,
          MediaSourceId: playback.mediaSourceId,
          LiveStreamId: playback.liveStreamId,
          PositionTicks: ticks,
          CanSeek: true,
          IsPaused: isPaused,
          IsMuted: muted,
          VolumeLevel: Math.round(Math.min(100, Math.max(0, muted ? 0 : volume))),
          PlaybackRate: rate,
          PlayMethod: playback.method,
          AudioStreamIndex: playback.audioIndex,
          SubtitleStreamIndex: playback.subtitleIndex,
          RepeatMode: "RepeatNone",
          PlaybackOrder: "Default",
          PlaylistItemId: "playlistItem0",
          NowPlayingQueue: [{ Id: playback.item.Id, PlaylistItemId: "playlistItem0" }],
          BufferedRanges: [],
        });
        return true;
      } catch {
        // Progress sync should not interrupt playback.
        return false;
      }
    },
    [client],
  );

  const report = useCallback(
    async (playback: ActivePlayback, event: "start" | "progress" | "stop", seconds: number, isPaused = false) => {
      if (playback.trailer) return;
      const delivered = statusRef.current === "ready" && (await sendReport(playback, event, seconds, isPaused));
      if (playback.local) {
        const total = playback.duration || ticksToSeconds(playback.item.RunTimeTicks);
        const played = event === "stop" && total > 0 && seconds / total > 0.9;
        saveProgressRef.current(playback.item.Id, played ? 0 : seconds, played, !delivered);
      }
    },
    [sendReport],
  );

  const finish = useCallback(
    async (navigateAway: boolean) => {
      const current = activeRef.current;
      if (!current) return;
      activeRef.current = null;
      setActive(null);
      trickplayRef.current?.dispose();
      trickplayRef.current = null;
      if (!stopSent.current) {
        stopSent.current = true;
        await report(current, "stop", positionRef.current, false);
      }
      // Resume/progress just landed on the server. Home keeps painting its last
      // snapshot (the hero stays instant) while Continue Watching refetches.
      markStale("home:");
      invalidate(`item:${current.item.Id}`);
      if (current.item.SeriesId) invalidate(`item:${current.item.SeriesId}`);
      if (navigateAway && miniRef.current) {
        // Leave the viewer on whatever they were browsing.
        miniRef.current = false;
        setMiniState(false);
        void playerMini(false);
      } else if (navigateAway) {
        navigateRef.current(statusRef.current === "ready" ? current.returnTo ?? `/item/${current.item.Id}` : "/downloads", { replace: true });
      }
    },
    [report],
  );

  useEffect(() => {
    let cancel = false;
    let unlisten: (() => void) | undefined;
    const sendProgress = (current: ActivePlayback, isPaused: boolean) => {
      const { volume, muted } = volumeRef.current;
      sentRef.current = { paused: isPaused, position: positionRef.current, at: Date.now(), volume, muted };
      void report(current, "progress", positionRef.current, isPaused);
    };
    listenPlayer((event: PlayerEvent) => {
      const current = activeRef.current;
      if (!current) return;
      if (event.kind === "closed") {
        void finish(true);
        return;
      }
      positionRef.current = event.time || 0;
      if (typeof event.volume === "number") volumeRef.current.volume = event.volume;
      if (typeof event.muted === "boolean") volumeRef.current.muted = event.muted;
      if (typeof event.rate === "number" && event.rate > 0) volumeRef.current.rate = event.rate;
      setPosition(event.time || 0);
      setDuration(event.duration || 0);
      setPaused(event.paused);
      pausedRef.current = event.paused;
      // Remote controls show the server's view, so tell it about pauses, seeks
      // and volume changes now rather than at the next timed report.
      const sent = sentRef.current;
      const expected = sent.position + (sent.paused ? 0 : (Date.now() - sent.at) / 1000);
      const changed =
        event.paused !== sent.paused ||
        Math.abs((event.time || 0) - expected) > 3 ||
        volumeRef.current.volume !== sent.volume ||
        volumeRef.current.muted !== sent.muted;
      if (changed && !event.ended && !stopSent.current && event.reason !== "error") sendProgress(current, event.paused);
      if (event.reason === "error") {
        // mpv repeats the failed state until it is stopped; handle it once.
        if (failedRef.current === current.playSessionId) return;
        failedRef.current = current.playSessionId;
        const player = inTauri() ? "mpv" : "The player";
        reportPlaybackFailure(event, { ...current, itemType: current.item.Type }, actionRef.current);
        setError(event.detail ? `${player} could not play this stream: ${event.detail}` : `${player} could not play this stream.`);
        void playerStop().then(() => finish(true));
      } else if (event.ended && !stopSent.current) {
        stopSent.current = true;
        setFinished(true);
        void report(current, "stop", event.duration || event.time || positionRef.current, false);
      }
    }).then((stopListening) => {
      if (cancel) stopListening();
      else unlisten = stopListening;
    });
    let unlistenNext: (() => void) | undefined;
    listenNext(() => {
      const next = nextRef.current;
      if (!next || !activeRef.current) return;
      nextRef.current = null;
      const queue = queueRef.current;
      actionRef.current = { kind: "auto-next", at: Date.now() };
      void finish(false).then(() => playRef.current(next, { resume: true, queue }));
    }).then((stopListening) => {
      if (cancel) stopListening();
      else unlistenNext = stopListening;
    });
    let unlistenThumbs: (() => void) | undefined;
    listenThumbRequests(({ time, width }) => {
      trickplayRef.current?.show(time, width).catch(() => {});
    }).then((stopListening) => {
      if (cancel) stopListening();
      else unlistenThumbs = stopListening;
    });
    const timer = window.setInterval(() => {
      const current = activeRef.current;
      if (!current || stopSent.current) return;
      sendProgress(current, pausedRef.current);
    }, 8000);
    return () => {
      cancel = true;
      unlisten?.();
      unlistenNext?.();
      unlistenThumbs?.();
      window.clearInterval(timer);
    };
  }, [finish, report]);

  const play = useCallback(
    async (item: BaseItem, options?: PlayOptions) => {
      if (!client) return;
      setError("");
      setBusy(true);
      const settings = loadSettings();

      /** Asks Resume or Start over. Returns the start in seconds, or null if cancelled. */
      const chooseStart = async (subject: BaseItem, seconds: number) => {
        if (seconds <= 0 || options?.resume) return seconds;
        setBusy(false);
        const choice = await new Promise<"resume" | "start" | null>((resolve) => setResumeAsk({ item: subject, seconds, resolve }));
        setResumeAsk(null);
        if (!choice) return null;
        setBusy(true);
        return choice === "start" ? 0 : seconds;
      };

      const launch = async (
        playback: ActivePlayback,
        startSeconds: number,
        media: {
          url: string;
          downloadId?: string;
          trickplay: boolean;
          segments: string;
          next?: BaseItem;
          artUrl: string;
          title?: string;
          subtitles?: PlayRequest["subtitles"];
        },
      ) => {
        nextRef.current = media.next ?? null;
        queueRef.current = options?.queue?.slice(1);
        stopSent.current = false;
        if (actionRef.current.kind !== "auto-next" || Date.now() - actionRef.current.at > 30_000) actionRef.current = { kind: "start", at: Date.now() };
        positionRef.current = startSeconds;
        activeRef.current = playback;
        setActive(playback);
        setPosition(startSeconds);
        setDuration(playback.duration ?? ticksToSeconds(playback.item.RunTimeTicks));
        setPaused(false);
        setFinished(false);
        try {
          volumeRef.current = { volume: 100, muted: false, rate: settings.playbackSpeed || 1 };
          const request: PlayRequest = {
            url: media.url,
            downloadId: media.downloadId,
            title: media.title ?? playbackTitle(playback.item),
            startSeconds,
            fullscreen: settings.fullscreen,
            audioLang: settings.audioLanguage,
            subtitleLang: settings.subtitleLanguage,
            subtitlesEnabled: settings.subtitlesEnabled,
            subtitleScale: settings.subtitleScale,
            subtitleColor: settings.subtitleColor,
            subtitleFont: settings.subtitleFont,
            playbackSpeed: settings.playbackSpeed,
            mpvPath: settings.mpvPath,
            badge: playback.badge,
            trickplay: media.trickplay,
            segments: media.segments,
            nextTitle: media.next ? [episodeCode(media.next), media.next.Name].filter(Boolean).join(" · ") : "",
            autoSkip: settings.autoSkipIntro,
            lowPower: settings.lowPower,
            artist: playback.item.SeriesName ?? (playback.item.ProductionYear ? String(playback.item.ProductionYear) : ""),
            artUrl: media.artUrl,
            trailer: playback.trailer,
            subtitles: media.subtitles,
          };
          requestRef.current = request;
          await playerPlay(request);
          void playerFocus();
        } catch (err) {
          if (activeRef.current?.playSessionId === playback.playSessionId) {
            activeRef.current = null;
            setActive(null);
          }
          throw err;
        }
        if (activeRef.current?.playSessionId !== playback.playSessionId) return;
        pausedRef.current = false;
        sentRef.current = { ...volumeRef.current, paused: false, position: startSeconds, at: Date.now() };
        void report(playback, "start", startSeconds, false);
        if (!miniRef.current) navigate(`/playing/${playback.item.Id}`);
      };

      const playDownload = async (entry: DownloadEntry) => {
        const online = statusRef.current === "ready";
        const fresh = online ? await client.item(entry.id).catch(() => null) : null;
        const subject = fresh ?? entry.item;
        const runtime = ticksToSeconds(subject.RunTimeTicks);
        const saved = entry.positionDirty || !fresh ? entry.position : ticksToSeconds(fresh.UserData?.PlaybackPositionTicks);
        const resumable = saved > 0 && (!runtime || saved / runtime < 0.97);
        const start = options?.startAt ?? (await chooseStart(subject, options?.fromStart || !resumable ? 0 : saved));
        if (start === null) return;
        const sourceId = entry.item.MediaSources?.[0]?.Id ?? entry.id;
        const [segments, serverNext] = online
          ? await Promise.all([
              client.segments(entry.id),
              settings.autoplayNext ? client.nextEpisode(subject).catch(() => undefined) : Promise.resolve(undefined),
            ])
          : [[], undefined];
        const next = settings.autoplayNext ? serverNext ?? nextDownloaded(downloadsRef.current.entries, subject) : undefined;
        const preview = online && fresh ? trickplaySource(fresh, sourceId, 0) : null;
        trickplayRef.current?.dispose();
        trickplayRef.current = preview ? new TrickplayRenderer(client.auth, preview) : null;
        const poster = entry.images.poster ?? entry.images.still;
        const playback: ActivePlayback = {
          item: subject,
          playSessionId: crypto.randomUUID(),
          mediaSourceId: sourceId,
          method: "DirectPlay",
          badge: `Downloaded · ${entry.quality}`,
          baseTicks: 0,
          local: true,
          duration: runtime || undefined,
        };
        await launch(playback, start, {
          url: "",
          downloadId: entry.id,
          trickplay: preview !== null,
          segments: segmentsFor(segments, 0),
          next,
          artUrl: online
            ? `${client.auth.server}/Items/${subject.SeriesId ?? subject.Id}/Images/Primary?maxHeight=400`
            : poster
              ? `file://${entry.folder}/${poster}`
              : "",
        });
      };

      try {
        if (options?.trailerUrl) {
          trickplayRef.current?.dispose();
          trickplayRef.current = null;
          await launch(
            {
              item,
              playSessionId: crypto.randomUUID(),
              mediaSourceId: item.Id,
              method: "DirectStream",
              badge: "Trailer",
              baseTicks: 0,
              duration: 0,
              returnTo: options.returnTo,
              trailer: true,
            },
            0,
            {
              url: options.trailerUrl,
              trickplay: false,
              segments: "",
              artUrl: `${client.auth.server}/Items/${item.Id}/Images/Primary?maxHeight=400`,
              title: `${item.Name} · Trailer`,
            },
          );
          return;
        }
        const remote = remoteRef.current;
        if (remote && !options?.local && statusRef.current === "ready") {
          const target = await resolveTarget(client, item, options?.fromStart ?? false);
          const chosen = options?.startAt ?? (await chooseStart(target.item, options?.fromStart ? 0 : ticksToSeconds(target.ticks)));
          if (chosen === null) return;
          await remote(target.item, secondsToTicks(chosen), options?.mediaSourceId);
          return;
        }
        const download = downloadsRef.current.find(item.Id);
        if (download?.state === "done") {
          await playDownload(download);
          return;
        }
        if (statusRef.current !== "ready") throw new Error("You're offline. Only downloaded titles can play right now.");
        const target = await resolveTarget(client, item, options?.fromStart ?? false);
        const downloadedTarget = downloadsRef.current.find(target.item.Id);
        if (downloadedTarget?.state === "done") {
          await playDownload(downloadedTarget);
          return;
        }
        const chosen = options?.startAt ?? (await chooseStart(target.item, options?.fromStart ? 0 : ticksToSeconds(target.ticks)));
        if (chosen === null) return;
        const startTicks = secondsToTicks(chosen);
        const queued = options?.queue?.[0];
        const extras = Promise.all([
          client.segments(target.item.Id),
          queued ? Promise.resolve(queued) : settings.autoplayNext ? client.nextEpisode(target.item).catch(() => undefined) : Promise.resolve(undefined),
        ]);
        let info = await client.playbackInfo(target.item.Id, {
          startTicks: 0,
          mediaSourceId: options?.mediaSourceId,
          subtitleIndex: settings.subtitlesEnabled ? undefined : -1,
          maxBitrate: settings.maxBitrate,
        });
        let source = sourceOf(info.MediaSources ?? [], options?.mediaSourceId);
        if (!source) throw new Error("Jellyfin did not return a media source.");
        // The browser player picks its own tracks; mpv reads the language settings itself.
        const choice = inTauri() ? null : initialStreams(source, settings);
        let method = playMethodOf(source);
        if (method === "Transcode" && startTicks > 0) {
          info = await client.playbackInfo(target.item.Id, {
            startTicks,
            mediaSourceId: source.Id,
            audioIndex: choice?.audio,
            subtitleIndex: choice ? choice.subtitle : settings.subtitlesEnabled ? undefined : -1,
            maxBitrate: settings.maxBitrate,
          });
          source = sourceOf(info.MediaSources ?? [], source.Id);
          if (!source) throw new Error("Jellyfin did not return a media source.");
          method = playMethodOf(source);
        }
        let url: string;
        let burn = false;
        if (choice) {
          ({ info, source, method, url, burn } = await webStream(client, target.item, info, source, choice, settings.maxBitrate, startTicks));
        } else {
          url = mediaUrl(client.auth, target.item.Id, source, info.PlaySessionId, target.item.MediaType);
        }
        // The HLS playlist spans the whole title; the browser player seeks into it
        // instead of treating the transcode start as zero.
        const offset = method === "Transcode" && inTauri();
        const badge = streamBadge(source);
        const video = source.MediaStreams?.find((stream) => stream.Type === "Video");
        const audio = source.MediaStreams?.find((stream) => stream.Type === "Audio");
        const subtitle = choice ? textSubtitle(client, target.item.Id, source, choice.subtitle, burn) : undefined;
        const playback: ActivePlayback = {
          item: target.item,
          playSessionId: info.PlaySessionId,
          mediaSourceId: source.Id,
          method,
          badge,
          baseTicks: offset ? startTicks : 0,
          videoCodec: video?.Codec,
          audioCodec: audio?.Codec,
          height: video?.Height,
          returnTo: options?.returnTo,
          liveStreamId: source.LiveStreamId ?? undefined,
          ...(choice ? streamsOf(source, choice, burn, settings.maxBitrate) : {}),
        };
        const startSeconds = offset ? 0 : ticksToSeconds(startTicks);
        const preview = trickplaySource(target.item, source.Id, ticksToSeconds(playback.baseTicks));
        trickplayRef.current?.dispose();
        trickplayRef.current = preview ? new TrickplayRenderer(client.auth, preview) : null;
        const [segments, next] = await extras;
        await launch(playback, startSeconds, {
          url,
          trickplay: preview !== null,
          segments: segmentsFor(segments, ticksToSeconds(playback.baseTicks)),
          next,
          artUrl: `${client.auth.server}/Items/${target.item.SeriesId ?? target.item.Id}/Images/Primary?maxHeight=400`,
          subtitles: subtitle ? [subtitle] : undefined,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : typeof err === "string" && err ? err : "Playback failed.");
      } finally {
        setBusy(false);
      }
    },
    [client, navigate, report],
  );
  playRef.current = play;

  const stop = useCallback(async () => {
    actionRef.current = { kind: "stop", at: Date.now() };
    await playerStop();
    await finish(true);
  }, [finish]);

  const togglePause = useCallback(async () => {
    await playerRequest(["cycle", "pause"]);
  }, []);

  const seek = useCallback(async (seconds: number) => {
    actionRef.current = { kind: "seek", at: Date.now() };
    await playerRequest(["seek", seconds, "absolute"]);
    positionRef.current = seconds;
    setPosition(seconds);
  }, []);

  const changeStreams = useCallback(
    async (change: StreamChange) => {
      const current = activeRef.current;
      const request = requestRef.current;
      if (!client || !current?.streams || !request || inTauri()) return;
      const settings = loadSettings();
      const sourceId = change.mediaSourceId ?? current.mediaSourceId;
      const maxBitrate = change.maxBitrate ?? current.maxBitrate ?? settings.maxBitrate;
      const sameStream = sourceId === current.mediaSourceId && maxBitrate === current.maxBitrate;
      let choice: StreamChoice = { audio: change.audio ?? current.audioIndex ?? -1, subtitle: change.subtitle ?? current.subtitleIndex ?? -1 };
      const settle = (next: ActivePlayback) => {
        activeRef.current = next;
        setActive(next);
        void report(next, "progress", positionRef.current, pausedRef.current);
      };

      // Text subtitles are drawn by the player, so they change in place unless
      // a burned-in one has to come out of the video.
      if (sameStream && choice.audio === current.audioIndex && !current.burnIn && !burnsIn(current.streams, choice.subtitle)) {
        const source = { Id: current.mediaSourceId, MediaStreams: current.streams } as MediaSource;
        await webSubtitle(textSubtitle(client, current.item.Id, source, choice.subtitle, false) ?? null);
        settle({ ...current, subtitleIndex: choice.subtitle });
        return;
      }
      // A direct-played file may carry every audio track the browser can switch between.
      if (sameStream && choice.subtitle === current.subtitleIndex && current.method !== "Transcode") {
        const audio = audioStreams(current.streams).filter((stream) => !stream.IsExternal);
        const ordinal = audio.findIndex((stream) => stream.Index === choice.audio);
        if (ordinal >= 0 && webAudioTrack(ordinal, audio.length)) {
          settle({ ...current, audioIndex: choice.audio, audioCodec: audio[ordinal].Codec });
          return;
        }
      }

      // Otherwise the server starts a new stream with those tracks, from here.
      const position = positionRef.current;
      const wasPaused = pausedRef.current;
      const startTicks = secondsToTicks(position);
      const sameSource = sourceId === current.mediaSourceId;
      const info = await client.playbackInfo(current.item.Id, {
        startTicks,
        mediaSourceId: sourceId,
        audioIndex: sameSource ? choice.audio : undefined,
        subtitleIndex: sameSource ? choice.subtitle : undefined,
        maxBitrate,
      });
      const source = sourceOf(info.MediaSources ?? [], sourceId);
      if (!source) throw new Error("Jellyfin did not return a media source.");
      if (!sameSource) choice = initialStreams(source, settings);
      const stream = await webStream(client, current.item, info, source, choice, maxBitrate, startTicks);
      if (activeRef.current !== current) return;
      const video = stream.source.MediaStreams?.find((candidate) => candidate.Type === "Video");
      const next: ActivePlayback = {
        ...current,
        playSessionId: stream.info.PlaySessionId,
        mediaSourceId: stream.source.Id,
        method: stream.method,
        badge: streamBadge(stream.source),
        videoCodec: video?.Codec,
        height: video?.Height,
        liveStreamId: stream.source.LiveStreamId ?? undefined,
        ...streamsOf(stream.source, choice, stream.burn, maxBitrate),
      };
      const subtitle = textSubtitle(client, current.item.Id, stream.source, choice.subtitle, stream.burn);
      const replay: PlayRequest = {
        ...request,
        url: stream.url,
        startSeconds: position,
        playbackSpeed: volumeRef.current.rate,
        badge: next.badge,
        subtitles: subtitle ? [subtitle] : undefined,
      };
      requestRef.current = replay;
      activeRef.current = next;
      setActive(next);
      await playerPlay(replay);
      if (wasPaused) await playerRequest(["set_property", "pause", true]);
      if (current.method === "Transcode" && current.playSessionId !== next.playSessionId) void client.stopEncoding(current.playSessionId).catch(() => {});
      sentRef.current = { ...sentRef.current, paused: wasPaused, position, at: Date.now() };
      void report(next, "progress", position, wasPaused);
    },
    [client, report],
  );

  const pauseTo = useCallback(async (next: boolean) => {
    await playerRequest(["set_property", "pause", next]);
  }, []);

  // Embedded mpv often leaves keyboard focus on the webview. Drive playback
  // through IPC for the whole session so Space/arrows work in and out of fullscreen.
  useEffect(() => {
    if (!active || !inTauri()) return;
    async function nudgeVolume(delta: number) {
      const current = await playerRequest(["get_property", "volume"]);
      const volume = typeof current === "number" ? current : 100;
      await playerRequest(["set_property", "volume", Math.min(130, Math.max(0, volume + delta))]);
    }
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (resumeAsk || miniRef.current) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (tag === "INPUT" && (target as HTMLInputElement).type !== "range");
      if (typing) return;
      if (tag === "INPUT" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
      let handled = false;
      if (event.key === " ") {
        handled = true;
        void playerRequest(["cycle", "pause"]);
      } else if (event.key === "ArrowLeft") {
        handled = true;
        void playerRequest(["seek", -10, "relative", "exact"]);
      } else if (event.key === "ArrowRight") {
        handled = true;
        void playerRequest(["seek", 10, "relative", "exact"]);
      } else if (event.key === "ArrowUp") {
        handled = true;
        void nudgeVolume(5);
      } else if (event.key === "ArrowDown") {
        handled = true;
        void nudgeVolume(-5);
      } else if (event.key === "Escape") {
        handled = true;
        void playerRequest(["script-message", "finplay-escape"]);
      } else if (event.key === "Backspace") {
        handled = true;
        void playerRequest(["script-message", "finplay-back"]);
      } else if (event.key === "f" || event.key === "F") {
        handled = true;
        void playerRequest(["script-message", "finplay-fullscreen"]);
      } else if (event.key === "a" || event.key === "A") {
        handled = true;
        void playerRequest(["keypress", "a"]);
      } else if (event.key === "s" || event.key === "S") {
        handled = true;
        void playerRequest(["keypress", "s"]);
      } else if (event.key === "c" || event.key === "C") {
        handled = true;
        void playerRequest(["keypress", "c"]);
      } else if (event.key === "p" || event.key === "P") {
        handled = true;
        void playerRequest(["script-message", "finplay-mini"]);
      } else if (event.key === "[") {
        handled = true;
        void playerRequest(["keypress", "["]);
      } else if (event.key === "]") {
        handled = true;
        void playerRequest(["keypress", "]"]);
      }
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    }
    function onFocus() {
      void playerFocus();
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, resumeAsk]);

  const setMini = useCallback(async (on: boolean) => {
    const current = activeRef.current;
    if (on === miniRef.current || (on && !current)) return false;
    if (!(await playerMini(on).catch(() => false))) return false;
    miniRef.current = on;
    setMiniState(on);
    if (!current) return true;
    if (on) {
      if (window.history.length > 1) navigateRef.current(-1);
      else navigateRef.current(current.returnTo ?? `/item/${current.item.Id}`);
    } else {
      navigateRef.current(`/playing/${current.item.Id}`);
    }
    return true;
  }, []);

  useEffect(() => {
    if (!inTauri()) return;
    let cancel = false;
    let unlisten: (() => void) | undefined;
    listenMiniExit(() => {
      if (!miniRef.current) return;
      miniRef.current = false;
      setMiniState(false);
      const current = activeRef.current;
      if (current) navigateRef.current(`/playing/${current.item.Id}`);
    }).then((stopListening) => {
      if (cancel) stopListening();
      else unlisten = stopListening;
    });
    let unlistenToggle: (() => void) | undefined;
    listenMiniToggle(() => void setMini(!miniRef.current)).then((stopListening) => {
      if (cancel) stopListening();
      else unlistenToggle = stopListening;
    });
    return () => {
      cancel = true;
      unlisten?.();
      unlistenToggle?.();
    };
  }, [setMini]);

  const value = useMemo<PlaybackContextValue>(
    () => ({
      active,
      busy,
      error,
      clearError: () => setError(""),
      play,
      stop,
      togglePause,
      seek,
      setPaused: pauseTo,
      setRemote: (send) => {
        remoteRef.current = send;
      },
      mini,
      setMini,
      changeStreams,
    }),
    [active, busy, error, play, stop, togglePause, seek, pauseTo, mini, setMini, changeStreams],
  );
  const clock = useMemo<PlaybackClock>(() => ({ position, duration, paused, finished }), [position, duration, paused, finished]);

  return (
    <PlaybackContext.Provider value={value}>
      <PlaybackClockContext.Provider value={clock}>
        {children}
        {resumeAsk ? <ResumePrompt ask={resumeAsk} /> : null}
      </PlaybackClockContext.Provider>
    </PlaybackContext.Provider>
  );
}

function ResumePrompt({ ask }: { ask: ResumeAsk }) {
  const { item, seconds, resolve } = ask;
  const total = ticksToSeconds(item.RunTimeTicks);
  const code = episodeCode(item);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") resolve(null);
      else if (event.key === "Enter") resolve("resume");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resolve]);

  return (
    <div className="sheet-backdrop" onClick={() => resolve(null)}>
      <div className="resume-card" onClick={(event) => event.stopPropagation()}>
        {item.SeriesName ? <p className="eyebrow">{[item.SeriesName, code].filter(Boolean).join(" · ")}</p> : null}
        <h2>{item.Name}</h2>
        <p className="resume-where">
          You stopped at {formatClock(seconds)}
          {total ? ` of ${formatClock(total)}` : ""}
        </p>
        {total ? (
          <div className="resume-bar">
            <span style={{ width: `${Math.min(100, (seconds / total) * 100)}%` }} />
          </div>
        ) : null}
        <div className="hero-actions">
          <button className="btn-play" autoFocus onClick={() => resolve("resume")}>
            <IconPlay size={16} />
            Resume from {formatClock(seconds)}
          </button>
          <button className="btn-ghost" onClick={() => resolve("start")}>
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

async function resolveTarget(client: Jellyfin, item: BaseItem, fromStart: boolean): Promise<{ item: BaseItem; ticks: number }> {
  if (item.Type === "Series") {
    const next = await client.nextUp(item.Id);
    let episode = next.Items?.[0];
    if (!episode) {
      const seasons = await client.seasons(item.Id);
      const season = seasons.Items?.[0];
      if (season) {
        const episodes = await client.episodes(item.Id, season.Id);
        episode = episodes.Items?.[0];
      }
    }
    if (!episode) throw new Error("This series has no episodes yet.");
    const full = await client.item(episode.Id);
    const ticks = fromStart || (full.UserData?.PlayedPercentage ?? 0) > 97 ? 0 : full.UserData?.PlaybackPositionTicks ?? 0;
    return { item: full, ticks };
  }
  const full = item.MediaSources ? item : await client.item(item.Id);
  const ticks = fromStart || (full.UserData?.PlayedPercentage ?? 0) > 97 ? 0 : full.UserData?.PlaybackPositionTicks ?? 0;
  return { item: full, ticks };
}

export function usePlayback() {
  const value = useContext(PlaybackContext);
  if (!value) throw new Error("Playback missing");
  return value;
}

export function usePlaybackClock() {
  return useContext(PlaybackClockContext);
}

export function methodHint(method: PlayMethod) {
  if (method === "DirectPlay") return "Original file, no transcode.";
  if (method === "DirectStream") return "Remuxed without re-encoding.";
  return `${methodLabel(method)}. Raise the bitrate to Original in Settings if you want the file as stored.`;
}
