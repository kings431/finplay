import { useEffect, useState } from "react";
import { downloadImage, formatBytes, formatEta, QUALITIES, useDownloads, type DownloadEntry } from "../downloads";
import { IconPlay } from "../icons";
import { episodeCode, formatRuntime, tile } from "../media";
import { usePlayback } from "../playback";

function useLocalImage(entry: DownloadEntry, kinds: string[]) {
  const [src, setSrc] = useState<string>();
  const kind = kinds.find((candidate) => entry.images?.[candidate]);
  useEffect(() => {
    let cancel = false;
    setSrc(undefined);
    if (kind) {
      void downloadImage(entry, kind).then((url) => {
        if (!cancel) setSrc(url);
      });
    }
    return () => {
      cancel = true;
    };
  }, [entry.folder, entry.id, kind]);
  return src;
}

function DownloadRow({ entry }: { entry: DownloadEntry }) {
  const { start, remove } = useDownloads();
  const { play, busy } = usePlayback();
  const [error, setError] = useState("");
  const art = useLocalImage(entry, ["still", "backdrop", "poster"]);
  const { item } = entry;
  const active = entry.state === "queued" || entry.state === "downloading";
  const progress = entry.state === "done" ? 100 : entry.total > 0 ? Math.min(99, (entry.received / entry.total) * 100) : 0;
  const runtime = formatRuntime(item.RunTimeTicks);
  const watched = item.RunTimeTicks ? (entry.position / (item.RunTimeTicks / 10_000_000)) * 100 : 0;

  async function retry() {
    setError("");
    try {
      await start(item, QUALITIES.find((quality) => quality.id === entry.quality) ?? QUALITIES[0], true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const status =
    entry.state === "done"
      ? [entry.quality, formatBytes(entry.total), runtime].filter(Boolean).join(" · ")
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
        {entry.state === "done" && watched > 1 && !entry.played ? (
          <span className="download-watched">
            <span style={{ width: `${Math.min(100, watched)}%` }} />
          </span>
        ) : null}
      </button>
      <div className="download-copy">
        {item.SeriesName ? <p className="eyebrow">{[item.SeriesName, episodeCode(item)].filter(Boolean).join(" · ")}</p> : null}
        <strong>{item.Name}</strong>
        <small className={entry.state === "failed" ? "error-text" : ""}>{error || status}</small>
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

export function Downloads() {
  const { entries, folder } = useDownloads();
  const sorted = [...entries].sort((a, b) => {
    const rank = (entry: DownloadEntry) => (entry.state === "downloading" ? 0 : entry.state === "queued" ? 1 : entry.state === "failed" ? 2 : 3);
    return rank(a) - rank(b) || b.added - a.added;
  });
  const used = entries.filter((entry) => entry.state === "done").reduce((sum, entry) => sum + entry.total, 0);

  return (
    <div className="page downloads-page">
      <header className="page-head">
        <div>
          <h1>Downloads</h1>
          <p>
            {entries.length ? `${entries.length} title${entries.length === 1 ? "" : "s"} · ${formatBytes(used) || "0 B"} on this computer` : "Watch without a connection."}
          </p>
        </div>
      </header>
      {sorted.length === 0 ? (
        <p className="empty">Nothing downloaded yet. Use the download button on a movie, an episode or a season.</p>
      ) : (
        <div className="download-list">
          {sorted.map((entry) => (
            <DownloadRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
      {folder ? <p className="fine downloads-folder">Saved in {folder}</p> : null}
    </div>
  );
}
