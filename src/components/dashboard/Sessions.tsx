import { useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { admin, sessionCommands, type AdminSession, type SessionItem } from "../../admin";
import { IconPause, IconPlay, IconStop } from "../../icons";
import { episodeCode, imageUrl, prettyCodec, resolutionLabel, thumbUrl, tile, videoRangeLabel } from "../../media";
import { useClient, useSession } from "../../session";
import type { MediaStream } from "../../types";
import { IconMessage, IconMute, IconNext, IconPrev, IconVolumeDown, IconVolumeUp, ago, clock, errorText, spaced, usePoll, useTicker } from "./ui";

type Stream = MediaStream & { BitRate?: number; VideoRange?: string; VideoRangeType?: string; ChannelLayout?: string };

const POLL_MS = 3000;

/** Fetches every session the server knows; playing ones are what the dashboard shows first. */
export function useSessions(ms = POLL_MS) {
  const client = useClient();
  const seenAt = useRef(Date.now());
  const poll = usePoll(
    async () => {
      const list = await admin.sessions(client);
      seenAt.current = Date.now();
      return list;
    },
    ms,
    "sessions",
  );
  return { ...poll, seenAt: seenAt.current };
}

export function playing(sessions: AdminSession[] = []) {
  return sessions.filter((session) => session.NowPlayingItem);
}

export function isTranscoding(session: AdminSession) {
  const info = session.TranscodingInfo;
  return Boolean(info && !(info.IsVideoDirect && info.IsAudioDirect)) || session.PlayState?.PlayMethod === "Transcode";
}

export function SessionsSection() {
  const { data, error, loading, reload, seenAt } = useSessions();
  const [showIdle, setShowIdle] = useState(false);
  const active = playing(data);
  const idle = (data ?? []).filter((session) => !session.NowPlayingItem);
  useTicker(active.some((session) => !session.PlayState?.IsPaused));

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <div>
          <h2>
            Now playing <span className="count-pill">{active.length}</span>
          </h2>
          <p>Live from the server every few seconds. Controls appear for apps that accept remote control.</p>
        </div>
        <button className={`btn-ghost dash-small${showIdle ? " on" : ""}`} onClick={() => setShowIdle((value) => !value)}>
          {showIdle ? "Hide" : "Show"} idle sessions ({idle.length})
        </button>
      </div>
      {error && !data ? <p className="dash-empty error-text">Couldn't load sessions. {error}</p> : null}
      {!data && loading ? <p className="dash-empty">Loading sessions…</p> : null}
      {data && active.length === 0 ? <p className="dash-empty">Nobody is watching right now.</p> : null}
      <div className="dash-sessions">
        {active.map((session) => (
          <SessionCard key={session.Id} session={session} seenAt={seenAt} refresh={reload} />
        ))}
      </div>
      {showIdle && idle.length ? (
        <div className="dash-card dash-list">
          {idle.map((session) => (
            <IdleRow key={session.Id} session={session} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function sessionArt(auth: { server: string; token: string; userId: string; deviceId: string }, item: SessionItem) {
  if (item.SeriesId && item.SeriesPrimaryImageTag) return imageUrl(auth, item.SeriesId, "Primary", item.SeriesPrimaryImageTag);
  if (item.ImageTags?.Primary && item.Type !== "Episode") return imageUrl(auth, item.Id, "Primary", item.ImageTags.Primary);
  return thumbUrl(auth, item);
}

function SessionCard({ session, seenAt, refresh }: { session: AdminSession; seenAt: number; refresh: () => Promise<void> }) {
  const client = useClient();
  const { deviceId } = useSession();
  const navigate = useNavigate();
  const item = session.NowPlayingItem!;
  const state = session.PlayState ?? {};
  const commands = sessionCommands(session);
  const remote = Boolean(session.SupportsRemoteControl || session.SupportsMediaControl);
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [paused, setPaused] = useState<boolean | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const isPaused = paused ?? state.IsPaused ?? false;
  const duration = (item.RunTimeTicks ?? 0) / 10_000_000;
  const reported = (state.PositionTicks ?? 0) / 10_000_000;
  const position = Math.min(duration || Infinity, reported + (isPaused ? 0 : Math.max(0, (Date.now() - seenAt) / 1000)));
  const percent = duration ? Math.min(100, (position / duration) * 100) : 0;
  const art = sessionArt(client.auth, item);
  const canSeek = remote && state.CanSeek !== false && duration > 0;
  const streams = (item.MediaStreams ?? []) as Stream[];
  const audioTracks = streams.filter((stream) => stream.Type === "Audio");
  const subtitleTracks = streams.filter((stream) => stream.Type === "Subtitle");

  const run = (label: string, action: () => Promise<void>, done?: string) => {
    setPending(label);
    setNotice(null);
    action()
      .then(() => {
        if (done) setNotice({ tone: "ok", text: done });
        window.setTimeout(() => void refresh(), 700);
      })
      .catch((err: unknown) => setNotice({ tone: "error", text: `${label} didn't go through: ${errorText(err)}` }))
      .finally(() => setPending(""));
  };

  const playstate = (label: string, command: Parameters<typeof admin.playstate>[2], seekTicks?: number) =>
    run(label, () => admin.playstate(client, session.Id, command, seekTicks));
  const general = (label: string, name: string, args?: Record<string, string>) => run(label, () => admin.command(client, session.Id, name, args));

  const seekAt = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration;
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    run("Message", () => admin.message(client, session.Id, text), "Message sent.");
    setMessage("");
    setComposing(false);
  };

  const left = duration ? Math.max(0, duration - position) : 0;
  const subtitle = item.SeriesName ? [episodeCode(item), item.SeriesName].filter(Boolean).join(" · ") : item.ProductionYear ? String(item.ProductionYear) : item.Type;

  return (
    <article className="dash-card dash-session">
      <div className="dash-session-top">
        <button className="dash-session-art" style={{ background: tile(item.Name) }} onClick={() => navigate(`/item/${item.Id}`)} aria-label={`Open ${item.Name}`}>
          {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        </button>
        <div className="dash-session-main">
          <div className="dash-session-head">
            <div className="dash-session-title">
              <strong title={item.Name}>{item.Name}</strong>
              <small>{subtitle}</small>
              <span className="dash-session-state">
                {isPaused ? <IconPause size={13} /> : <IconPlay size={13} />}
                {isPaused ? "Paused" : "Playing"}
                {session.DeviceId === deviceId ? <em className="dash-badge">This app</em> : null}
              </span>
            </div>
            <div className="dash-session-who">
              <span className="dash-session-user">{session.UserName ?? "Unknown"}</span>
              <span>{[session.Client, session.ApplicationVersion].filter(Boolean).join(" ")}</span>
              <span>{session.DeviceName}</span>
              <span>{duration ? `${clock(left)} left` : ""}</span>
            </div>
          </div>

          <div
            className={`dash-progress${canSeek ? " seekable" : ""}`}
            role={canSeek ? "slider" : undefined}
            aria-label={canSeek ? "Seek" : undefined}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(position)}
            onMouseMove={canSeek ? (event) => setHover(seekAt(event)) : undefined}
            onMouseLeave={() => setHover(null)}
            onClick={canSeek ? (event) => playstate("Seek", "Seek", seekAt(event) * 10_000_000) : undefined}
          >
            <span className="dash-progress-fill" style={{ width: `${percent}%` }} />
            {session.TranscodingInfo?.CompletionPercentage ? (
              <span className="dash-progress-buffer" style={{ width: `${Math.min(100, session.TranscodingInfo.CompletionPercentage)}%` }} />
            ) : null}
            {hover !== null && duration ? (
              <span className="dash-progress-tip" style={{ left: `${(hover / duration) * 100}%` }}>
                {clock(hover)}
              </span>
            ) : null}
          </div>
          <div className="dash-progress-times">
            <span>{clock(position)}</span>
            <span>{clock(duration)}</span>
          </div>

          {remote || commands.size ? (
            <div className="dash-controls">
              <ControlButton label="Previous" disabled={!remote || Boolean(pending)} onClick={() => playstate("Previous", "PreviousTrack")}>
                <IconPrev />
              </ControlButton>
              <ControlButton
                label={isPaused ? "Play" : "Pause"}
                big
                disabled={!remote || Boolean(pending)}
                onClick={() => {
                  setPaused(!isPaused);
                  run(isPaused ? "Play" : "Pause", () => admin.playstate(client, session.Id, isPaused ? "Unpause" : "Pause"));
                  window.setTimeout(() => setPaused(null), 4000);
                }}
              >
                {isPaused ? <IconPlay size={20} /> : <IconPause size={20} />}
              </ControlButton>
              <ControlButton label="Stop" disabled={!remote || Boolean(pending)} onClick={() => playstate("Stop", "Stop")}>
                <IconStop size={17} />
              </ControlButton>
              <ControlButton label="Next" disabled={!remote || Boolean(pending)} onClick={() => playstate("Next", "NextTrack")}>
                <IconNext />
              </ControlButton>
              <span className="dash-controls-gap" />
              <ControlButton label="Volume down" disabled={!commands.has("VolumeDown") || Boolean(pending)} onClick={() => general("Volume down", "VolumeDown")}>
                <IconVolumeDown />
              </ControlButton>
              <ControlButton
                label={state.IsMuted ? "Unmute" : "Mute"}
                on={state.IsMuted}
                disabled={!commands.has("ToggleMute") || Boolean(pending)}
                onClick={() => general("Mute", "ToggleMute")}
              >
                <IconMute />
              </ControlButton>
              <ControlButton label="Volume up" disabled={!commands.has("VolumeUp") || Boolean(pending)} onClick={() => general("Volume up", "VolumeUp")}>
                <IconVolumeUp />
              </ControlButton>
              {typeof state.VolumeLevel === "number" ? <span className="dash-volume">{state.IsMuted ? "Muted" : `${state.VolumeLevel}%`}</span> : null}
              <span className="dash-controls-gap" />
              <ControlButton label="Send a message" on={composing} disabled={!commands.has("DisplayMessage")} onClick={() => setComposing((value) => !value)}>
                <IconMessage />
              </ControlButton>
            </div>
          ) : (
            <p className="dash-note">{session.Client ?? "This app"} doesn't accept remote control.</p>
          )}
        </div>
      </div>

      {composing ? (
        <form className="dash-message" onSubmit={send}>
          <input autoFocus value={message} maxLength={200} placeholder={`Message to ${session.UserName ?? "this viewer"} on ${session.DeviceName ?? "their device"}`} onChange={(event) => setMessage(event.target.value)} />
          <button className="btn-primary dash-small" type="submit" disabled={!message.trim() || Boolean(pending)}>
            Send
          </button>
        </form>
      ) : null}
      {notice ? <p className={`dash-notice ${notice.tone === "ok" ? "ok-text" : "error-text"}`}>{notice.text}</p> : null}

      <StreamInfo session={session} streams={streams} />

      {(commands.has("SetAudioStreamIndex") && audioTracks.length > 1) || (commands.has("SetSubtitleStreamIndex") && subtitleTracks.length > 0) ? (
        <div className="dash-tracks">
          {commands.has("SetAudioStreamIndex") && audioTracks.length > 1 ? (
            <label>
              Audio
              <select
                value={state.AudioStreamIndex ?? audioTracks.find((track) => track.IsDefault)?.Index ?? audioTracks[0].Index}
                disabled={Boolean(pending)}
                onChange={(event) => general("Audio track", "SetAudioStreamIndex", { Index: event.target.value })}
              >
                {audioTracks.map((track) => (
                  <option key={track.Index} value={track.Index}>
                    {track.DisplayTitle ?? track.Language ?? `Track ${track.Index}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {commands.has("SetSubtitleStreamIndex") && subtitleTracks.length > 0 ? (
            <label>
              Subtitles
              <select value={state.SubtitleStreamIndex ?? -1} disabled={Boolean(pending)} onChange={(event) => general("Subtitles", "SetSubtitleStreamIndex", { Index: event.target.value })}>
                <option value={-1}>Off</option>
                {subtitleTracks.map((track) => (
                  <option key={track.Index} value={track.Index}>
                    {track.DisplayTitle ?? track.Language ?? `Track ${track.Index}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ControlButton({ label, children, onClick, disabled, big, on }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; big?: boolean; on?: boolean }) {
  return (
    <button className={`dash-control${big ? " big" : ""}${on ? " on" : ""}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function bitrate(bits?: number) {
  if (!bits) return "";
  return bits >= 1_000_000 ? `${(bits / 1_000_000).toFixed(bits >= 10_000_000 ? 0 : 1)} Mbps` : `${Math.round(bits / 1000)} kbps`;
}

function channels(count?: number) {
  if (!count) return "";
  if (count === 1) return "Mono";
  if (count === 2) return "Stereo";
  return `${count - 1}.1`;
}

function StreamInfo({ session, streams }: { session: AdminSession; streams: Stream[] }) {
  const info = session.TranscodingInfo;
  const state = session.PlayState ?? {};
  const video = streams.find((stream) => stream.Type === "Video");
  const audio = streams.find((stream) => stream.Type === "Audio" && stream.Index === state.AudioStreamIndex) ?? streams.find((stream) => stream.Type === "Audio" && stream.IsDefault) ?? streams.find((stream) => stream.Type === "Audio");
  const subtitle = streams.find((stream) => stream.Type === "Subtitle" && stream.Index === state.SubtitleStreamIndex);
  const transcoding = isTranscoding(session);
  const videoConverted = transcoding && info && !info.IsVideoDirect;
  const audioConverted = transcoding && info && !info.IsAudioDirect;
  const method = transcoding ? "Transcode" : state.PlayMethod === "DirectStream" ? "Direct stream" : "Direct play";
  const reasons = info?.TranscodeReasons?.map((reason) => spaced(reason).replace(/ Not /g, " not ").replace(/ Is /g, " is ")) ?? [];

  const videoChips = [
    resolutionLabel(videoConverted || !video ? info : video),
    videoConverted ? `${prettyCodec(video?.Codec)} → ${prettyCodec(info?.VideoCodec)}` : prettyCodec(video?.Codec),
    bitrate(videoConverted ? info?.Bitrate : video?.BitRate ?? info?.Bitrate),
    videoRangeLabel(video),
    videoConverted && info?.HardwareAccelerationType ? `HW ${info.HardwareAccelerationType.toUpperCase()}` : "",
  ].filter(Boolean);
  const audioChips = [
    audio?.Language ? audio.Language.toUpperCase() : "",
    audioConverted ? `${prettyCodec(audio?.Codec)} → ${prettyCodec(info?.AudioCodec)}` : prettyCodec(audio?.Codec),
    channels(audioConverted ? info?.AudioChannels : audio?.Channels),
  ].filter(Boolean);

  return (
    <div className="dash-streams">
      <div className="dash-stream-row">
        <span className="dash-stream-label">Method</span>
        <span className="dash-chips">
          <span className={`method${transcoding ? " transcode" : ""}`}>{method}</span>
          {info?.Container && transcoding ? <span className="dash-chip">{info.Container.toUpperCase()}</span> : null}
          {reasons.map((reason) => (
            <span key={reason} className="dash-chip warn">
              {reason}
            </span>
          ))}
        </span>
      </div>
      {videoChips.length ? (
        <div className="dash-stream-row">
          <span className="dash-stream-label">Video</span>
          <span className="dash-chips">
            {videoChips.map((chip) => (
              <span key={chip} className="dash-chip">
                {chip}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      {audioChips.length ? (
        <div className="dash-stream-row">
          <span className="dash-stream-label">Audio</span>
          <span className="dash-chips">
            {audioChips.map((chip) => (
              <span key={chip} className="dash-chip">
                {chip}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      {subtitle ? (
        <div className="dash-stream-row">
          <span className="dash-stream-label">Subtitles</span>
          <span className="dash-chips">
            <span className="dash-chip">{subtitle.DisplayTitle ?? subtitle.Language ?? "On"}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function IdleRow({ session }: { session: AdminSession }) {
  const client = useClient();
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const canMessage = sessionCommands(session).has("DisplayMessage");

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    admin
      .message(client, session.Id, text)
      .then(() => setState({ tone: "ok", text: "Message sent." }))
      .catch((err: unknown) => setState({ tone: "error", text: errorText(err) }));
    setMessage("");
    setComposing(false);
  };

  return (
    <div className="dash-row">
      <span className="dash-avatar">{(session.UserName ?? "?").slice(0, 1).toUpperCase()}</span>
      <span className="dash-row-main">
        <strong>{session.UserName ?? "Unknown user"}</strong>
        <small>{[session.Client, session.ApplicationVersion, session.DeviceName].filter(Boolean).join(" · ")}</small>
        {composing ? (
          <form className="dash-message inline" onSubmit={send}>
            <input autoFocus value={message} maxLength={200} placeholder="Message" onChange={(event) => setMessage(event.target.value)} />
            <button className="btn-primary dash-small" type="submit" disabled={!message.trim()}>
              Send
            </button>
          </form>
        ) : null}
        {state ? <small className={state.tone === "ok" ? "ok-text" : "error-text"}>{state.text}</small> : null}
      </span>
      <span className="dash-row-side">{ago(session.LastActivityDate)}</span>
      {canMessage ? (
        <button className="dash-control" aria-label="Send a message" title="Send a message" onClick={() => setComposing((value) => !value)}>
          <IconMessage />
        </button>
      ) : (
        <span className="dash-control-spacer" />
      )}
    </div>
  );
}
