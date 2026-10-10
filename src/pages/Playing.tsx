import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { IconBack, IconPause, IconPlay } from "../icons";
import { audioStreams, backdropUrl, formatClock, isTextSubtitle, streamLabel, subtitleStreams, ticksToSeconds } from "../media";
import { inTauri, playerRequest } from "../player";
import { methodHint, usePlayback, usePlaybackClock, type ActivePlayback, type StreamChange } from "../playback";
import { useSession } from "../session";
import { QUALITY_RATES, loadSettings } from "../settings";
import { trickplayFrame, trickplaySource, trickplayTileUrl, type TrickplaySource } from "../trickplay";
import { webNextTitle, webPlayNext, webSegment } from "../webplayer";
import type { Auth } from "../jellyfin";
import type { BaseItem, MpvTrack } from "../types";

export function Playing() {
  return inTauri() ? <MpvPlaying /> : <WebPlaying />;
}

const OSD_IDLE_MS = 5000;
const SEGMENT_LABELS: Record<string, string> = { Intro: "Skip intro", Recap: "Skip recap", Preview: "Skip preview", Outro: "Skip credits" };
/** Scrubbing waits this long after the last press before it seeks. */
const SCRUB_COMMIT_MS = 700;
/** A tile sheet decodes to about 23 MB, too much to keep many on a TV. */
const MAX_TILES = 3;
const PREVIEW_WIDTH = 320;

/** Seconds per press: holding or repeating a key speeds up, like a TV's own player. */
function scrubStep(presses: number, base: number) {
  if (presses < 4) return base;
  if (presses < 12) return base * 3;
  return base * 6;
}

function formatDelta(seconds: number) {
  return `${seconds < 0 ? "−" : "+"}${formatClock(Math.abs(seconds))}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

type MenuKind = "audio" | "subtitles" | "speed" | "quality" | "version";
type MenuOption = { key: string; label: string; detail?: string; selected: boolean; change?: StreamChange; speed?: number };
type TrackMenu = { kind: MenuKind; title: string; button: string; value: string; options: MenuOption[] };

/** The player's choices for this title. Each needs more than one option, except
 * subtitles, which always offer Off. */
function trackMenus(active: ActivePlayback, speed: number): TrackMenu[] {
  const menus: TrackMenu[] = [];
  const valueOf = (options: MenuOption[]) => options.find((option) => option.selected)?.label ?? "";
  if (active.streams) {
    const audio = audioStreams(active.streams).map<MenuOption>((stream) => ({
      key: `a${stream.Index}`,
      label: streamLabel(stream),
      detail: stream.IsExternal ? "External file" : undefined,
      selected: stream.Index === active.audioIndex,
      change: { audio: stream.Index },
    }));
    if (audio.length > 1) menus.push({ kind: "audio", title: "Audio", button: "Audio", value: valueOf(audio), options: audio });
    const subs = subtitleStreams(active.streams);
    if (subs.length) {
      const options: MenuOption[] = [
        { key: "s-off", label: "Off", selected: (active.subtitleIndex ?? -1) < 0, change: { subtitle: -1 } },
        ...subs.map<MenuOption>((stream) => ({
          key: `s${stream.Index}`,
          label: streamLabel(stream),
          detail: [stream.IsForced ? "Forced" : "", stream.IsExternal ? "External file" : "", isTextSubtitle(stream) ? "" : "Picture subtitles, restarts the stream"]
            .filter(Boolean)
            .join(" · "),
          selected: stream.Index === active.subtitleIndex,
          change: { subtitle: stream.Index },
        })),
      ];
      menus.push({ kind: "subtitles", title: "Subtitles", button: "Subtitles", value: valueOf(options), options });
    }
  }
  const speeds = SPEEDS.map<MenuOption>((rate) => ({ key: `r${rate}`, label: rate === 1 ? "Normal" : `${rate}×`, selected: rate === speed, speed: rate }));
  menus.push({ kind: "speed", title: "Playback speed", button: "Speed", value: speed === 1 ? "1×" : `${speed}×`, options: speeds });
  if (active.streams && !active.local && !active.trailer) {
    const quality = QUALITY_RATES.map<MenuOption>((rate) => ({
      key: `q${rate.value}`,
      label: rate.label,
      selected: rate.value === active.maxBitrate,
      change: { maxBitrate: rate.value },
    }));
    menus.push({ kind: "quality", title: "Quality", button: "Quality", value: valueOf(quality) || "Custom", options: quality });
    const versions = active.item.MediaSources ?? [];
    if (versions.length > 1) {
      const options = versions.map<MenuOption>((source, index) => ({
        key: `v${source.Id}`,
        label: source.Name || `Version ${index + 1}`,
        selected: source.Id === active.mediaSourceId,
        change: { mediaSourceId: source.Id },
      }));
      menus.push({ kind: "version", title: "Version", button: "Version", value: valueOf(options), options });
    }
  }
  return menus;
}

const SWITCHING: Record<MenuKind, string> = {
  audio: "Switching audio…",
  subtitles: "Switching subtitles…",
  speed: "",
  quality: "Changing quality…",
  version: "Switching version…",
};

/** Loads trickplay tile sheets as images and keeps the last few, so the
 * preview can be drawn as a CSS sprite. */
function useTrickplayTiles(auth: Auth | undefined, source: TrickplaySource | null) {
  const tiles = useRef(new Map<number, HTMLImageElement>());
  const [, setLoaded] = useState(0);

  useEffect(() => {
    const cache = tiles.current;
    return () => {
      for (const image of cache.values()) {
        image.onload = image.onerror = null;
        image.removeAttribute("src");
      }
      cache.clear();
    };
  }, [auth, source]);

  const load = useCallback(
    (index: number) => {
      if (!auth || !source || index < 0 || index * source.info.TileWidth * source.info.TileHeight >= source.info.ThumbnailCount) return;
      const cache = tiles.current;
      const cached = cache.get(index);
      if (cached) {
        cache.delete(index);
        cache.set(index, cached);
        return;
      }
      const image = new Image();
      image.onload = () => setLoaded((count) => count + 1);
      image.onerror = () => {
        if (cache.get(index) === image) cache.delete(index);
      };
      image.src = trickplayTileUrl(auth, source, index);
      cache.set(index, image);
      while (cache.size > MAX_TILES) {
        const [oldest, stale] = cache.entries().next().value as [number, HTMLImageElement];
        stale.onload = stale.onerror = null;
        stale.removeAttribute("src");
        cache.delete(oldest);
      }
    },
    [auth, source],
  );

  const ready = useCallback((index: number) => {
    const image = tiles.current.get(index);
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }, []);

  return { load, ready };
}

/** The browser and TV player: the video fills the screen and these controls
 * sit on top, fading out while it plays untouched. */
function WebPlaying() {
  const { client } = useSession();
  const { active, stop, togglePause, seek, changeStreams } = usePlayback();
  const { position, duration, paused, finished } = usePlaybackClock();
  const [shown, setShown] = useState(true);
  const timer = useRef(0);
  const bar = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const menuList = useRef<HTMLDivElement>(null);
  /** The transport button a menu opened from, where focus goes back to. */
  const opener = useRef<HTMLButtonElement | null>(null);
  const [speed, setSpeed] = useState(() => loadSettings().playbackSpeed || 1);
  /** "Switching audio…" while a change is under way, or why it failed. */
  const [note, setNote] = useState("");
  const noteTimer = useRef(0);
  const positionRef = useRef(position);
  positionRef.current = position;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  /** Where Left/Right, FF/RW or the pointer would seek to, shown before it happens. */
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const scrubRef = useRef<{ target: number; presses: number; direction: number } | null>(null);
  const commitTimer = useRef(0);

  const wake = useCallback(() => {
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), OSD_IDLE_MS);
  }, []);

  const focusBar = useCallback(() => bar.current?.focus({ preventScroll: true }), []);

  const commit = useCallback(() => {
    window.clearTimeout(commitTimer.current);
    const current = scrubRef.current;
    if (!current) return;
    scrubRef.current = null;
    void seek(current.target);
    setScrub(null);
  }, [seek]);

  const cancelScrub = useCallback(() => {
    window.clearTimeout(commitTimer.current);
    scrubRef.current = null;
    setScrub(null);
  }, []);

  const nudge = useCallback(
    (direction: number, base: number) => {
      const current = scrubRef.current;
      const presses = current && current.direction === direction ? current.presses + 1 : 0;
      const from = current ? current.target : positionRef.current;
      const end = durationRef.current > 0 ? durationRef.current - 1 : Number.POSITIVE_INFINITY;
      const target = Math.max(0, Math.min(end, from + direction * scrubStep(presses, base)));
      scrubRef.current = { target, presses, direction };
      setScrub(target);
      window.clearTimeout(commitTimer.current);
      commitTimer.current = window.setTimeout(commit, SCRUB_COMMIT_MS);
      wake();
    },
    [commit, wake],
  );

  useEffect(() => {
    document.documentElement.toggleAttribute("data-web-playing", true);
    wake();
    focusBar();
    return () => {
      document.documentElement.removeAttribute("data-web-playing");
      window.clearTimeout(timer.current);
      window.clearTimeout(commitTimer.current);
    };
  }, [wake, focusBar]);

  // Items opened from lists come without trickplay details.
  const [detailed, setDetailed] = useState<BaseItem | null>(null);
  const activeItem = active?.item;
  useEffect(() => {
    setDetailed(null);
    if (!client || !activeItem || active?.trailer || activeItem.Trickplay !== undefined) return;
    let cancel = false;
    client
      .item(activeItem.Id)
      .then((full) => {
        if (!cancel) setDetailed(full);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [client, activeItem, active?.trailer]);
  const preview = useMemo(() => {
    if (!active || active.trailer) return null;
    return trickplaySource(detailed?.Id === active.item.Id ? detailed : active.item, active.mediaSourceId, ticksToSeconds(active.baseTicks));
  }, [active, detailed]);
  const tiles = useTrickplayTiles(client?.auth, preview);
  const previewTime = scrub ?? hover;
  const previewTile = preview && previewTime !== null ? trickplayFrame(preview, previewTime).tile : null;
  const heading = scrubRef.current?.direction ?? 1;
  useEffect(() => {
    if (previewTile === null) return;
    tiles.load(previewTile);
    tiles.load(previewTile + heading);
  }, [tiles, previewTile, heading]);
  // Have the sheet for "now" ready before the first press.
  const nowTile = preview && shown ? trickplayFrame(preview, position).tile : null;
  useEffect(() => {
    if (nowTile !== null) tiles.load(nowTile);
  }, [tiles, nowTile]);

  const closeMenu = useCallback(() => {
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    else focusBar();
    setMenu(null);
  }, [focusBar]);

  // Land on the current choice when a menu opens.
  useEffect(() => {
    const list = menuList.current;
    if (!menu || !list) return;
    const current = list.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? list.querySelector("button");
    current?.focus({ preventScroll: true });
    current?.scrollIntoView({ block: "nearest" });
  }, [menu]);

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const pick = useCallback(
    async (kind: MenuKind, option: MenuOption) => {
      closeMenu();
      wake();
      if (option.selected) return;
      if (option.speed !== undefined) {
        setSpeed(option.speed);
        await playerRequest(["set_property", "speed", option.speed]);
        return;
      }
      if (!option.change) return;
      window.clearTimeout(noteTimer.current);
      setNote(SWITCHING[kind]);
      try {
        await changeStreams(option.change);
        setNote("");
      } catch (err) {
        setNote(err instanceof Error ? err.message : "That change didn't work.");
        noteTimer.current = window.setTimeout(() => setNote(""), 5000);
      }
    },
    [closeMenu, wake, changeStreams],
  );

  const shownRef = useRef(shown);
  shownRef.current = shown || paused || menu !== null;
  const visible = shown || paused || menu !== null;
  // Subtitles move up out of the way of the controls.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-osd-shown", visible);
    return () => document.documentElement.removeAttribute("data-osd-shown");
  }, [visible]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const key = event.key;
      const consume = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const back = key === "GoBack" || key === "BrowserBack" || key === "Escape" || (key === "Backspace" && !(event.target instanceof HTMLInputElement));
      const list = menuList.current;
      if (list && (back || key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight" || key === "Enter")) {
        // An open menu keeps the remote to itself; Back closes it, not the player.
        consume();
        wake();
        const items = [...list.querySelectorAll<HTMLButtonElement>("button")];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (back) closeMenu();
        else if (key === "Enter") (items[at] ?? items[0])?.click();
        else if (key === "ArrowUp" || key === "ArrowDown") {
          const next = items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + (key === "ArrowDown" ? 1 : -1)))];
          next?.focus({ preventScroll: true });
          next?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      const onBar = document.activeElement === bar.current;
      if (back) {
        consume();
        if (scrubRef.current) cancelScrub();
        else void stop();
      } else if (key === "MediaPlayPause" || key === " ") {
        consume();
        commit();
        void togglePause();
        wake();
      } else if (key === "MediaPlay" || key === "MediaPause") {
        consume();
        commit();
        void playerRequest(["set_property", "pause", key === "MediaPause"]);
        wake();
      } else if (key === "MediaStop") {
        consume();
        void stop();
      } else if (key === "MediaFastForward" || key === "MediaRewind") {
        consume();
        nudge(key === "MediaFastForward" ? 1 : -1, 30);
      } else if ((key === "ArrowLeft" || key === "ArrowRight") && (onBar || !shownRef.current)) {
        // The bar is where the remote rests, so Left and Right scrub; with the
        // controls hidden they scrub from wherever focus was.
        consume();
        if (!onBar) focusBar();
        nudge(key === "ArrowRight" ? 1 : -1, 10);
      } else if (key === "ArrowDown" && onBar && shownRef.current) {
        // The transport row is wider than the bar, so pick Play/Pause rather
        // than whichever button sits nearest.
        consume();
        playButton.current?.focus({ preventScroll: true });
        wake();
      } else if (key === "ArrowUp" && shownRef.current && document.activeElement?.closest(".web-osd .transport")) {
        consume();
        focusBar();
        wake();
      } else if (key === "Enter" && onBar) {
        consume();
        if (scrubRef.current) commit();
        else void togglePause();
        wake();
      } else if (key === "Enter" && document.activeElement?.closest(".web-osd-skip")) {
        wake();
      } else if (key === "Enter" && shownRef.current && document.activeElement instanceof HTMLButtonElement && document.activeElement.closest(".web-osd")) {
        consume();
        document.activeElement.click();
        wake();
      } else if (!shownRef.current && (key === "ArrowUp" || key === "ArrowDown" || key === "Enter")) {
        consume();
        wake();
        focusBar();
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
  }, [stop, togglePause, wake, commit, cancelScrub, nudge, focusBar, closeMenu]);

  const segment = webSegment(position);
  const nextTitle = webNextTitle();
  const showNext = Boolean(nextTitle) && (segment?.type === "Outro" || (duration > 0 && duration - position < 30));
  const prompt = showNext ? "next" : segment ? `${segment.type}:${segment.start}` : "";
  const skipRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prompt) skipRow.current?.querySelector("button")?.focus({ preventScroll: true });
    else if (skipRow.current?.contains(document.activeElement) || document.activeElement === document.body) focusBar();
  }, [prompt, focusBar]);

  if (!active) {
    return (
      <div className="page">
        <p className="empty">Nothing is playing.</p>
      </div>
    );
  }

  const head = scrub ?? position;
  const percentOf = (seconds: number) => (duration > 0 ? Math.max(0, Math.min(100, (seconds / duration) * 100)) : 0);
  const percent = percentOf(head);
  const menus = trackMenus(active, speed);
  const open = menus.find((entry) => entry.kind === menu) ?? null;

  const timeAt = (clientX: number) => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || duration <= 0) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };

  let thumb: CSSProperties | null = null;
  if (client && preview && previewTime !== null) {
    const { info } = preview;
    const frame = trickplayFrame(preview, previewTime);
    if (tiles.ready(frame.tile)) {
      const scale = Math.min(1, PREVIEW_WIDTH / info.Width);
      const width = Math.round(info.Width * scale);
      const height = Math.round(info.Height * scale);
      thumb = {
        width,
        height,
        backgroundImage: `url("${trickplayTileUrl(client.auth, preview, frame.tile)}")`,
        backgroundSize: `${width * info.TileWidth}px ${height * info.TileHeight}px`,
        backgroundPosition: `${-frame.column * width}px ${-frame.row * height}px`,
      };
    }
  }
  const half = PREVIEW_WIDTH / 2;

  return (
    <div className={`web-osd${visible ? " shown" : ""}`}>
      <div className="web-osd-top">
        <button className="btn-round" onClick={() => void stop()} aria-label="Back">
          <IconBack size={20} />
        </button>
        <div>
          <h1>{active.item.SeriesName ?? active.item.Name}</h1>
          {active.item.SeriesName ? <p>{active.item.Name}</p> : null}
        </div>
        <span className="eyebrow">{note || active.badge}</span>
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
          <span>{formatClock(head)}</span>
          <div
            ref={bar}
            className={`web-bar${scrub !== null ? " scrubbing" : ""}`}
            tabIndex={0}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(head)}
            aria-valuetext={formatClock(head)}
            onPointerMove={(event) => setHover(timeAt(event.clientX))}
            onPointerLeave={() => setHover(null)}
            onClick={(event) => {
              const to = event.detail > 0 ? timeAt(event.clientX) : null;
              if (to === null) return;
              cancelScrub();
              void seek(to);
            }}
          >
            <div className="web-bar-track">
              <div style={{ width: `${percent}%` }} />
            </div>
            <i className="web-bar-head" style={{ left: `${percent}%` }} />
            {previewTime !== null ? (
              <div className="web-preview" style={{ left: `clamp(${half}px, ${percentOf(previewTime)}%, calc(100% - ${half}px))` }}>
                {thumb ? <div className="web-preview-thumb" style={thumb} /> : null}
                <strong>{formatClock(previewTime)}</strong>
                {scrub !== null ? <span>{formatDelta(scrub - position)}</span> : null}
              </div>
            ) : null}
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
          <span className="web-transport-gap" />
          {menus.map((entry) => (
            <button
              key={entry.kind}
              className={`web-track-btn${menu === entry.kind ? " on" : ""}`}
              aria-haspopup="menu"
              aria-expanded={menu === entry.kind}
              onClick={(event) => {
                if (menu === entry.kind) return closeMenu();
                opener.current = event.currentTarget;
                setMenu(entry.kind);
                wake();
              }}
            >
              <small>{entry.button}</small>
              <span>{entry.value}</span>
            </button>
          ))}
        </div>
        {open ? (
          <>
            <div className="web-menu-scrim" onClick={closeMenu} />
            <div className="web-menu" ref={menuList} role="menu" aria-label={open.title}>
              <p className="web-menu-title">{open.title}</p>
              <div className="web-menu-list">
                {open.options.map((option) => (
                  <button key={option.key} role="menuitemradio" aria-checked={option.selected} className={option.selected ? "on" : ""} onClick={() => void pick(open.kind, option)}>
                    <i aria-hidden="true">{option.selected ? "✓" : ""}</i>
                    <span>
                      {option.label}
                      {option.detail ? <small>{option.detail}</small> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
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
