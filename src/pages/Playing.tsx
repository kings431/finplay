import { useCallback, useEffect, useRef, useState } from "react";
import { IconBack, IconPause, IconPlay } from "../icons";
import { backdropUrl, formatClock } from "../media";
import { inTauri, playerRequest } from "../player";
import { methodHint, usePlayback, usePlaybackClock } from "../playback";
import { useSession } from "../session";
import { webNextTitle, webPlayNext, webSegment } from "../webplayer";
import type { MpvTrack } from "../types";

export function Playing() {
  return inTauri() ? <MpvPlaying /> : <WebPlaying />;
}

const OSD_IDLE_MS = 5000;
const SEGMENT_LABELS: Record<string, string> = { Intro: "Skip intro", Recap: "Skip recap", Preview: "Skip preview", Outro: "Skip credits" };

/** The browser and TV player: the video fills the screen and these controls
 * sit on top, fading out while it plays untouched. */
function WebPlaying() {
  const { active, stop, togglePause, seek } = usePlayback();
  const { position, duration, paused, finished } = usePlaybackClock();
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [shown, setShown] = useState(true);
  const timer = useRef(0);
  const playButton = useRef<HTMLButtonElement>(null);
  const positionRef = useRef(position);
  positionRef.current = position;

  const wake = useCallback(() => {
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), OSD_IDLE_MS);
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-web-playing", true);
    wake();
    playButton.current?.focus({ preventScroll: true });
    return () => {
      document.documentElement.removeAttribute("data-web-playing");
      window.clearTimeout(timer.current);
    };
  }, [wake]);

  useEffect(() => {
    if (!active) return;
    let cancel = false;
    const load = () =>
      playerRequest(["get_property", "track-list"]).then((value) => {
        if (!cancel && Array.isArray(value)) setTracks(value as MpvTrack[]);
      });
    const first = window.setTimeout(load, 1500);
    return () => {
      cancel = true;
      window.clearTimeout(first);
    };
  }, [active]);

  const shownRef = useRef(shown);
  shownRef.current = shown || paused;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const key = event.key;
      const consume = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (key === "GoBack" || key === "BrowserBack" || key === "Escape" || (key === "Backspace" && !(event.target instanceof HTMLInputElement))) {
        consume();
        void stop();
      } else if (key === "MediaPlayPause" || key === " ") {
        consume();
        void togglePause();
        wake();
      } else if (key === "MediaPlay" || key === "MediaPause") {
        consume();
        void playerRequest(["set_property", "pause", key === "MediaPause"]);
        wake();
      } else if (key === "MediaStop") {
        consume();
        void stop();
      } else if (key === "MediaFastForward" || key === "MediaRewind") {
        consume();
        void seek(Math.max(0, positionRef.current + (key === "MediaFastForward" ? 30 : -10)));
        wake();
      } else if (!shownRef.current && (key === "ArrowLeft" || key === "ArrowRight")) {
        consume();
        void seek(Math.max(0, positionRef.current + (key === "ArrowRight" ? 10 : -10)));
        wake();
      } else if (key === "Enter" && document.activeElement?.closest(".web-osd-skip")) {
        wake();
      } else if (!shownRef.current && (key === "ArrowUp" || key === "ArrowDown" || key === "Enter")) {
        consume();
        wake();
        playButton.current?.focus({ preventScroll: true });
      } else {
        wake();
      }
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointermove", wake);
    };
  }, [stop, togglePause, seek, wake]);

  const segment = webSegment(position);
  const nextTitle = webNextTitle();
  const showNext = Boolean(nextTitle) && (segment?.type === "Outro" || (duration > 0 && duration - position < 30));
  const prompt = showNext ? "next" : segment ? `${segment.type}:${segment.start}` : "";
  const skipRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prompt) skipRow.current?.querySelector("button")?.focus({ preventScroll: true });
    else if (skipRow.current?.contains(document.activeElement) || document.activeElement === document.body) playButton.current?.focus({ preventScroll: true });
  }, [prompt]);

  if (!active) {
    return (
      <div className="page">
        <p className="empty">Nothing is playing.</p>
      </div>
    );
  }

  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const audio = tracks.filter((track) => track.type === "audio");
  const subs = tracks.filter((track) => track.type === "sub");
  return (
    <div className={`web-osd${shown || paused ? " shown" : ""}`}>
      <div className="web-osd-top">
        <button className="btn-round" onClick={() => void stop()} aria-label="Back">
          <IconBack size={20} />
        </button>
        <div>
          <h1>{active.item.SeriesName ?? active.item.Name}</h1>
          {active.item.SeriesName ? <p>{active.item.Name}</p> : null}
        </div>
        <span className="eyebrow">{active.badge}</span>
      </div>
      <div className="web-osd-skip" ref={skipRow}>
        {segment && !showNext ? (
          <button className="btn-ghost" onClick={() => void seek(segment.end)}>
            {SEGMENT_LABELS[segment.type] ?? "Skip"}
          </button>
        ) : null}
        {showNext ? (
          <button className="btn-play" onClick={() => webPlayNext()}>
            Next · {nextTitle}
          </button>
        ) : null}
      </div>
      <div className="web-osd-bottom">
        <div className="web-progress">
          <span>{formatClock(position)}</span>
          <div className="web-bar">
            <div style={{ width: `${percent}%` }} />
          </div>
          <span>{formatClock(duration)}</span>
        </div>
        <div className="transport">
          <button onClick={() => void seek(Math.max(0, position - 10))}>−10</button>
          <button ref={playButton} className="btn-play" onClick={() => void togglePause()}>
            {paused || finished ? <IconPlay size={18} /> : <IconPause size={18} />}
            {paused || finished ? "Play" : "Pause"}
          </button>
          <button onClick={() => void seek(position + 30)}>+30</button>
          {audio.length > 1
            ? audio.map((track) => (
                <button key={`a${track.id}`} className={track.selected ? "on" : ""} onClick={() => void playerRequest(["set_property", "aid", track.id]).then(() => setTracks((list) => list.map((item) => (item.type === "audio" ? { ...item, selected: item.id === track.id } : item))))}>
                  {track.title || track.lang || `Audio ${track.id}`}
                </button>
              ))
            : null}
          {subs.length > 0 ? (
            <button
              onClick={() => {
                const index = subs.findIndex((track) => track.selected);
                const next = index + 1 < subs.length ? subs[index + 1].id : 0;
                void playerRequest(["set_property", "sid", next]).then(() =>
                  setTracks((list) => list.map((item) => (item.type === "sub" ? { ...item, selected: item.id === next } : item))),
                );
              }}
            >
              Subtitles: {subs.find((track) => track.selected)?.title ?? "Off"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MpvPlaying() {
  const session = useSession();
  const { active, stop, togglePause, seek } = usePlayback();
  const { position, duration, paused, finished } = usePlaybackClock();
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
      <button className="btn-round back" onClick={() => void stop()} aria-label="Back">
        <IconBack size={18} />
      </button>
      <div className="playing-copy">
        <p className="eyebrow">{active.badge}</p>
        <h1>{active.item.SeriesName ? `${active.item.SeriesName}` : active.item.Name}</h1>
        {active.item.SeriesName ? <p className="playing-sub">{active.item.Name}</p> : null}
        <p className="fine">{finished ? "Finished" : active.trailer ? "Trailer, streamed from YouTube." : methodHint(active.method)} Picture is in the player window.</p>
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
