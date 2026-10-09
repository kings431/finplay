import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconBack, IconPause, IconPlay } from "../icons";
import { backdropUrl, formatClock } from "../media";
import { playerRequest } from "../player";
import { methodHint, usePlayback } from "../playback";
import { useSession } from "../session";
import type { MpvTrack } from "../types";

export function Playing() {
  const session = useSession();
  const { active, position, duration, paused, finished, stop, togglePause, seek } = usePlayback();
  const navigate = useNavigate();
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [scrub, setScrub] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancel = false;
    const timer = window.setTimeout(() => {
      playerRequest(["get_property", "track-list"])
        .then((value) => {
          if (!cancel && Array.isArray(value)) setTracks(value as MpvTrack[]);
        })
        .catch(() => {
          if (!cancel) setTracks([]);
        });
    }, 700);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [active]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === " ") {
        event.preventDefault();
        void togglePause();
      } else if (event.key === "ArrowRight") void seek(Math.min(duration || position + 10, position + 10));
      else if (event.key === "ArrowLeft") void seek(Math.max(0, position - 10));
      else if (event.key === "Escape") void playerRequest(["script-message", "finplay-escape"]).catch(() => stop());
      else if (event.key === "f" || event.key === "F") void playerRequest(["script-message", "finplay-fullscreen"]).catch(() => {});
      else if (event.key === "Backspace") void stop();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duration, position, seek, stop, togglePause]);

  if (!active) {
    return (
      <div className="page">
        <p className="empty">Nothing is playing.</p>
      </div>
    );
  }

  const backdrop = backdropUrl(session, active.item);
  const shown = scrub ?? position;
  const percent = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const audio = tracks.filter((track) => track.type === "audio");
  const subs = tracks.filter((track) => track.type === "sub");

  return (
    <div className="playing">
      {backdrop ? <img src={backdrop} alt="" /> : null}
      <div className="hero-shade" />
      <button className="btn-round back" onClick={() => navigate(`/item/${active.item.Id}`)} aria-label="Back">
        <IconBack size={18} />
      </button>
      <div className="playing-copy">
        <p className="eyebrow">{active.badge}</p>
        <h1>{active.item.SeriesName ? `${active.item.SeriesName}` : active.item.Name}</h1>
        {active.item.SeriesName ? <p className="playing-sub">{active.item.Name}</p> : null}
        <p className="fine">{finished ? "Finished" : methodHint(active.method)} Picture is in the player window.</p>
        <div className="scrub-row">
          <span>{formatClock(shown)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={shown}
            style={{ ["--p" as string]: `${percent}%` }}
            onInput={(event) => setScrub(Number(event.currentTarget.value))}
            onPointerUp={(event) => {
              const next = Number(event.currentTarget.value);
              setScrub(null);
              void seek(next);
            }}
            onKeyUp={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              const next = Number(event.currentTarget.value);
              setScrub(null);
              void seek(next);
            }}
          />
          <span>{formatClock(duration)}</span>
        </div>
        <div className="transport">
          <button onClick={() => void seek(Math.max(0, position - 10))}>−10</button>
          <button className="btn-play" onClick={() => void togglePause()}>
            {paused || finished ? <IconPlay size={16} /> : <IconPause size={16} />}
            {paused || finished ? "Play" : "Pause"}
          </button>
          <button onClick={() => void seek(position + 10)}>+10</button>
          <button onClick={() => void stop()}>Stop</button>
        </div>
        <div className="track-row">
          {audio.length > 0 ? (
            <label>
              Audio
              <select
                value={audio.find((track) => track.selected)?.id ?? ""}
                onChange={(event) => void playerRequest(["set_property", "aid", Number(event.target.value)])}
              >
                {audio.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.title || track.lang || `Track ${track.id}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Subtitles
            <select
              value={subs.find((track) => track.selected)?.id ?? "no"}
              onChange={(event) => void playerRequest(["set_property", "sid", event.target.value === "no" ? "no" : Number(event.target.value)])}
            >
              <option value="no">Off</option>
              {subs.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.title || track.lang || `Track ${track.id}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="keys">Space pause · arrows seek · ↑↓ volume · A audio · S subtitles · C chapters · [ ] speed · F fullscreen · Backspace close</p>
      </div>
    </div>
  );
}
