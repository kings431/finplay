import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { downloadImage, formatBytes, formatEta, QUALITIES, useDownloads, type DownloadEntry } from "../downloads";
import { groupDownloads, isActive, nextUp, watchState, type SeasonGroup, type SeriesGroup } from "../downloadGroups";
import { IconCheck, IconDown, IconPlay } from "../icons";
import { episodeCode, formatRuntime, tile } from "../media";
import { usePlayback } from "../playback";

const OPEN_KEY = "finplay.downloads.open";
type Filter = "all" | "shows" | "movies";

function useLocalImage(entry: DownloadEntry | undefined, kinds: string[]) {
  const [src, setSrc] = useState<string>();
  const kind = entry ? kinds.find((candidate) => entry.images?.[candidate]) : undefined;
  useEffect(() => {
    let cancel = false;
    setSrc(undefined);
    if (entry && kind) {
      void downloadImage(entry, kind).then((url) => {
        if (!cancel) setSrc(url);
      });
    }
    return () => {
      cancel = true;
    };
  }, [entry?.folder, entry?.id, kind]);
  return src;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function minutesLeft(entry: DownloadEntry, position: number) {
  const runtime = (entry.item.RunTimeTicks ?? 0) / 10_000_000;
  const left = Math.round((runtime - position) / 60);
  return left > 0 ? `${left} min left` : "";
}

type ConfirmRequest = { title: string; body: ReactNode; action: string; run: () => Promise<void> };

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="resume-card dl-confirm" role="dialog" aria-modal="true" aria-label={request.title} onClick={(event) => event.stopPropagation()}>
        <h2>{request.title}</h2>
        <p className="resume-where">{request.body}</p>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="hero-actions">
          <button className="btn-ghost" autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary dl-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              request
                .run()
                .then(onClose)
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                  setBusy(false);
                });
            }}
          >
            {busy ? "Deleting…" : request.action}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A movie, or a download that is still running or failed. */
function DownloadRow({ entry }: { entry: DownloadEntry }) {
  const { start, remove } = useDownloads();
  const { play, busy } = usePlayback();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const episode = Boolean(entry.item.SeriesName);
  const art = useLocalImage(entry, episode ? ["still", "backdrop", "poster"] : ["backdrop", "still", "poster"]);
  const { item } = entry;
  const active = isActive(entry);
  const progress = entry.state === "done" ? 100 : entry.total > 0 ? Math.min(99, (entry.received / entry.total) * 100) : 0;
  const runtime = formatRuntime(item.RunTimeTicks);
  const watch = watchState(entry);

  async function retry() {
    setError("");
    try {
      await start(item, QUALITIES.find((quality) => quality.id === entry.quality) ?? QUALITIES[0], { retry: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const status =
    entry.state === "done"
      ? [item.ProductionYear, runtime, formatBytes(entry.total), entry.quality].filter(Boolean).join(" · ")
      : entry.state === "queued"
        ? "Waiting…"
        : entry.state === "downloading"
          ? [
              `${formatBytes(entry.received)}${entry.total ? ` of ${entry.quality === "Original" ? "" : "~"}${formatBytes(entry.total)}` : ""}`,
              entry.quality,
              formatEta(entry),
            ]
              .filter(Boolean)
              .join(" · ")
          : entry.error || "Download failed.";

  return (
    <div className={`download-row ${entry.state}`}>
      <button
        className="download-art"
        style={{ background: tile(item.Name) }}
        disabled={entry.state !== "done" || busy}
        onClick={() => void play(item)}
        aria-label={`Play ${item.Name}`}
      >
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        {entry.state === "done" ? (
          <span className="download-play">
            <IconPlay size={18} />
          </span>
        ) : null}
        {entry.state === "done" && watch.played ? (
          <span className="dl-check" title="Watched">
            <IconCheck size={13} />
          </span>
        ) : null}
        {entry.state === "done" && watch.percent > 1 ? (
          <span className="download-watched">
            <span style={{ width: `${watch.percent}%` }} />
          </span>
        ) : null}
      </button>
      <div className="download-copy" role="button" tabIndex={0} onClick={() => navigate(`/item/${item.Id}`)} onKeyDown={(event) => event.key === "Enter" && navigate(`/item/${item.Id}`)}>
        {item.SeriesName ? <p className="eyebrow">{[item.SeriesName, episodeCode(item)].filter(Boolean).join(" · ")}</p> : null}
        <strong>{item.Name}</strong>
        <small className={entry.state === "failed" || error ? "error-text" : ""}>{error || status}</small>
        {entry.state === "done" && watch.percent > 1 ? <small>{minutesLeft(entry, watch.position)}</small> : null}
        {active ? (
          <div className="download-bar">
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </div>
      <div className="download-actions">
        {entry.state === "failed" ? (
          <button className="btn-ghost" onClick={() => void retry()}>
            Retry
          </button>
        ) : null}
        <button className="btn-ghost" onClick={() => void remove(entry.id)}>
          {active ? "Cancel" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function EpisodeRow({ entry }: { entry: DownloadEntry }) {
  const { remove } = useDownloads();
  const { play, busy } = usePlayback();
  const navigate = useNavigate();
  const art = useLocalImage(entry, ["still", "backdrop"]);
  const { item } = entry;
  const watch = watchState(entry);
  const number = item.IndexNumber != null ? `E${item.IndexNumber}` : "";
  const detail = watch.played ? "Watched" : watch.percent > 1 ? minutesLeft(entry, watch.position) : "";

  return (
    <li className={`dl-episode${watch.played ? " watched" : ""}`}>
      <button className="download-art" style={{ background: tile(item.Name) }} disabled={busy} onClick={() => void play(item)} aria-label={`Play ${item.Name}`}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        <span className="download-play">
          <IconPlay size={16} />
        </span>
        {watch.played ? (
          <span className="dl-check" title="Watched">
            <IconCheck size={12} />
          </span>
        ) : null}
        {watch.percent > 1 ? (
          <span className="download-watched">
            <span style={{ width: `${watch.percent}%` }} />
          </span>
        ) : null}
      </button>
      <div className="download-copy" role="button" tabIndex={0} onClick={() => navigate(`/item/${item.Id}`)} onKeyDown={(event) => event.key === "Enter" && navigate(`/item/${item.Id}`)}>
        <strong>
          {number ? <span className="dl-number">{number}</span> : null}
          {item.Name}
        </strong>
        <small>
          {[formatRuntime(item.RunTimeTicks), formatBytes(entry.total), entry.quality].filter(Boolean).join(" · ")}
          {detail ? <span className={watch.played ? "dl-watched-label" : ""}> · {detail}</span> : null}
        </small>
      </div>
      <div className="download-actions">
        <button className="btn-ghost" onClick={() => void remove(entry.id)} aria-label={`Delete ${item.Name}`}>
          Delete
        </button>
      </div>
    </li>
  );
}

function SeasonBlock({ group, season, ask }: { group: SeriesGroup; season: SeasonGroup; ask: (request: ConfirmRequest) => void }) {
  const { remove } = useDownloads();
  const watched = season.entries.filter((entry) => watchState(entry).played).length;
  return (
    <section className="dl-season">
      <div className="dl-season-head">
        <h3>{season.label}</h3>
        <span>{[plural(season.entries.length, "episode"), formatBytes(season.size), watched ? `${watched} watched` : ""].filter(Boolean).join(" · ")}</span>
        <button
          className="btn-ghost danger"
          onClick={() =>
            ask({
              title: `Delete ${season.label}?`,
              body: `${plural(season.entries.length, "episode")} of ${group.name} (${formatBytes(season.size)}) will be removed from this computer.`,
              action: "Delete season",
              run: async () => {
                for (const entry of season.entries) await remove(entry.id);
              },
            })
          }
        >
          Delete season
        </button>
      </div>
      <ul className="dl-episodes">
        {season.entries.map((entry) => (
          <EpisodeRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function SeriesCard({ group, open, onToggle, ask }: { group: SeriesGroup; open: boolean; onToggle: () => void; ask: (request: ConfirmRequest) => void }) {
  const { remove } = useDownloads();
  const { play, busy } = usePlayback();
  const artEntry = group.entries.find((entry) => entry.images?.poster) ?? group.entries.find((entry) => entry.images?.backdrop);
  const poster = useLocalImage(artEntry, ["poster", "backdrop"]);
  const done = group.seasons.flatMap((season) => season.entries);
  const watched = done.filter((entry) => watchState(entry).played).length;
  const next = nextUp(group);
  const resume = next ? watchState(next).percent > 1 : false;
  const seasonCount = group.seasons.length;

  const meta = [
    group.year,
    seasonCount > 1 ? plural(seasonCount, "season") : group.seasons[0]?.label,
    group.done ? plural(group.done, "episode") : "",
    formatBytes(group.size),
  ].filter(Boolean);

  function deleteShow() {
    const extra = group.entries.length - group.done;
    ask({
      title: `Delete ${group.name}?`,
      body: [
        group.done ? `${plural(group.done, "episode")} (${formatBytes(group.size)}) will be removed from this computer.` : "",
        extra ? `${plural(extra, "unfinished download")} will be cancelled.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      action: "Delete show",
      run: async () => {
        for (const entry of group.entries) await remove(entry.id);
      },
    });
  }

  return (
    <article className={`dl-series${open ? " open" : ""}`}>
      <div className="dl-series-head">
        <button className="dl-series-toggle" onClick={onToggle} aria-expanded={open}>
          <span className="dl-poster" style={{ background: tile(group.name) }}>
            {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : <span>{group.name.slice(0, 1)}</span>}
          </span>
          <span className="dl-series-copy">
            <strong>{group.name}</strong>
            <small>{meta.join(" · ")}</small>
            <span className="dl-series-status">
              {group.done ? (
                <span className="dl-watch-meter">
                  <span style={{ width: `${(watched / group.done) * 100}%` }} />
                </span>
              ) : null}
              {group.done ? <small>{watched === group.done ? "All watched" : `${watched} of ${group.done} watched`}</small> : null}
              {group.active ? <span className="dl-badge">{group.active} downloading</span> : null}
              {group.failed ? <span className="dl-badge bad">{group.failed} failed</span> : null}
            </span>
          </span>
          <span className="dl-chevron" aria-hidden>
            <IconDown size={18} />
          </span>
        </button>
        <div className="dl-series-actions">
          {next ? (
            <button className="btn-play" disabled={busy} onClick={() => void play(next.item)}>
              <IconPlay size={15} />
              {resume ? "Resume" : "Play"} {episodeCode(next.item)}
            </button>
          ) : null}
          <button className="btn-ghost danger" onClick={deleteShow}>
            Delete show
          </button>
        </div>
      </div>
      {open && group.seasons.length ? (
        <div className="dl-series-body">
          {group.seasons.map((season) => (
            <SeasonBlock key={season.key} group={group} season={season} ask={ask} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** Shows opened or closed by hand this session; the rest follow the default. */
function loadOpen(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(OPEN_KEY) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function Downloads() {
  const { entries, folder } = useDownloads();
  const groups = useMemo(() => groupDownloads(entries), [entries]);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState(loadOpen);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const shows = groups.series.filter((group) => group.done > 0);
  const both = shows.length > 0 && groups.movies.length > 0;
  const showShows = filter !== "movies" && shows.length > 0;
  const showMovies = filter !== "shows" && groups.movies.length > 0;
  const failed = groups.pending.filter((entry) => entry.state === "failed").length;
  const running = groups.pending.length - failed;

  // A single show starts open; with several, the list stays scannable.
  const isOpen = (key: string) => open[key] ?? shows.length === 1;

  function toggle(key: string) {
    const next = { ...open, [key]: !isOpen(key) };
    setOpen(next);
    sessionStorage.setItem(OPEN_KEY, JSON.stringify(next));
  }

  const summary = [
    plural(entries.length, "title"),
    shows.length ? plural(shows.length, "show") : "",
    groups.movies.length ? plural(groups.movies.length, "movie") : "",
    `${formatBytes(groups.size) || "0 B"} on this computer`,
  ].filter(Boolean);

  return (
    <div className="page downloads-page">
      <header className="page-head">
        <div>
          <h1>Downloads</h1>
          <p>{entries.length ? summary.join(" · ") : "Watch without a connection."}</p>
        </div>
        {both ? (
          <div className="chips" role="group" aria-label="Show">
            {(
              [
                ["all", "All"],
                ["shows", "Shows"],
                ["movies", "Movies"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={filter === id ? "on" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {entries.length === 0 ? (
        <p className="empty">Nothing downloaded yet. Use the download button on a movie, an episode or a season.</p>
      ) : null}
      {groups.pending.length ? (
        <section className="dl-section">
          <h2 className="dl-section-title">
            {running ? `Downloading · ${running}` : "Downloads that need attention"}
            {running && failed ? <span className="dl-badge bad">{failed} failed</span> : null}
          </h2>
          <div className="download-list compact">
            {groups.pending.map((entry) => (
              <DownloadRow key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}
      {showShows ? (
        <section className="dl-section">
          {both || groups.pending.length ? <h2 className="dl-section-title">Shows</h2> : null}
          <div className="dl-series-list">
            {shows.map((group) => (
              <SeriesCard key={group.key} group={group} open={isOpen(group.key)} onToggle={() => toggle(group.key)} ask={setConfirm} />
            ))}
          </div>
        </section>
      ) : null}
      {showMovies ? (
        <section className="dl-section">
          {both || groups.pending.length ? <h2 className="dl-section-title">Movies</h2> : null}
          <div className="download-list">
            {groups.movies.map((entry) => (
              <DownloadRow key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}
      {folder ? <p className="fine downloads-folder">Saved in {folder}</p> : null}
      {confirm ? <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  );
}
