import { useEffect, useRef, useState } from "react";
import { IconCast, IconCheck, IconClose, IconPause, IconPlay, IconStop } from "../icons";
import { episodeCode, formatClock, thumbUrl, ticksToSeconds } from "../media";
import { useRemote } from "../remote";
import { useClient } from "../session";
import type { RemoteSession } from "../types";
import { Popover } from "./Popover";

/** Sidebar button that picks where titles play: here, or another Jellyfin app. */
export function CastButton() {
  const remote = useRemote();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<RemoteSession[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    setDevices(null);
    setFailed(false);
    remote
      .devices()
      .then((found) => !cancel && setDevices(found))
      .catch(() => !cancel && setFailed(true));
    return () => {
      cancel = true;
    };
  }, [open]);

  const pick = (session: RemoteSession | null) => {
    remote.choose(session);
    setOpen(false);
  };
  const chosen = remote.target?.DeviceId;

  return (
    <>
      <button
        ref={anchor}
        className={`nav-btn${chosen ? " active" : ""}`}
        title={chosen ? `Playing on ${remote.target?.DeviceName}` : "Play on another device"}
        onClick={() => setOpen((value) => !value)}
      >
        <IconCast />
        <span>{chosen ? "Casting" : "Play on"}</span>
      </button>
      {open ? (
        <Popover anchorRef={anchor} onClose={() => setOpen(false)} side="right">
          <div className="menu-head">
            <strong>Play on</strong>
            <small>Other Jellyfin apps signed in as you</small>
          </div>
          <button className="menu-row cast-row" onClick={() => pick(null)}>
            <span>This computer</span>
            {chosen ? null : <IconCheck size={16} />}
          </button>
          {devices === null && !failed ? <div className="menu-label">Looking for devices…</div> : null}
          {failed ? <div className="menu-label">Couldn't reach the server.</div> : null}
          {devices?.length === 0 ? <div className="menu-label cast-empty">No other devices. Open Jellyfin on your TV, phone, or browser with this account.</div> : null}
          {devices?.map((session) => (
            <button key={session.Id} className="menu-row cast-row" onClick={() => pick(session)}>
              <span>
                {session.DeviceName ?? "Unknown device"}
                <small>
                  {session.Client}
                  {session.NowPlayingItem ? ` · ${session.NowPlayingItem.Name}` : ""}
                </small>
              </span>
              {session.DeviceId === chosen ? <IconCheck size={16} /> : null}
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}

/** Remote control for the chosen device, floating above the page. */
export function RemoteBar() {
  const remote = useRemote();
  const client = useClient();
  const [, setTick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const target = remote.target;
  const item = target?.NowPlayingItem;
  const state = target?.PlayState;
  const paused = state?.IsPaused ?? false;

  useEffect(() => {
    if (!item || paused) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [item, paused]);

  if (!target) return remote.notice ? <div className="toast">{remote.notice}</div> : null;

  const duration = ticksToSeconds(item?.RunTimeTicks);
  const reported = ticksToSeconds(state?.PositionTicks);
  const position = Math.min(duration || Infinity, reported + (paused ? 0 : (Date.now() - remote.seenAt) / 1000));
  const shown = drag ?? position;
  const art = item ? thumbUrl(client.auth, item) : undefined;
  const run = (action: () => Promise<void>) => void action().catch(() => {});
  const commit = () => {
    if (drag === null) return;
    run(() => remote.seek(drag));
    setDrag(null);
  };

  return (
    <>
      {remote.notice ? <div className="toast">{remote.notice}</div> : null}
      <div className="remote-bar" role="region" aria-label={`Remote control for ${target.DeviceName}`}>
        {item ? (
          <>
            {art ? <img className="remote-art" src={art} alt="" /> : <span className="remote-art" />}
            <div className="remote-main">
              <div className="remote-title">
                <strong>{item.SeriesName ?? item.Name}</strong>
                <small>
                  {item.SeriesName ? `${episodeCode(item)} · ${item.Name} · ` : ""}
                  <IconCast size={12} /> {target.DeviceName}
                </small>
              </div>
              <div className="remote-seek">
                <span>{formatClock(shown)}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, duration)}
                  step={1}
                  value={Math.min(shown, Math.max(1, duration))}
                  aria-label="Position"
                  onChange={(event) => setDrag(Number(event.target.value))}
                  onPointerUp={commit}
                  onKeyUp={commit}
                />
                <span>{formatClock(duration)}</span>
              </div>
            </div>
            <div className="remote-controls">
              <button className="remote-skip" onClick={() => run(() => remote.seek(Math.max(0, position - 10)))} aria-label="Back 10 seconds">
                −10
              </button>
              <button className="remote-play" onClick={() => run(remote.playPause)} aria-label={paused ? "Play" : "Pause"}>
                {paused ? <IconPlay size={22} /> : <IconPause size={22} />}
              </button>
              <button className="remote-skip" onClick={() => run(() => remote.seek(position + 10))} aria-label="Forward 10 seconds">
                +10
              </button>
              <button className="remote-icon" onClick={() => run(remote.stop)} aria-label="Stop" title="Stop">
                <IconStop size={18} />
              </button>
              <input
                className="remote-volume"
                type="range"
                min={0}
                max={100}
                step={5}
                value={state?.IsMuted ? 0 : state?.VolumeLevel ?? 100}
                aria-label="Volume"
                onChange={(event) => run(() => remote.setVolume(Number(event.target.value)))}
              />
            </div>
          </>
        ) : (
          <div className="remote-idle">
            <IconCast size={20} />
            <span>
              Connected to <strong>{target.DeviceName}</strong>. Press Play on anything to watch it there.
            </span>
          </div>
        )}
        <button className="remote-icon remote-close" onClick={() => remote.choose(null)} aria-label="Stop casting" title="Stop casting">
          <IconClose size={18} />
        </button>
      </div>
    </>
  );
}
