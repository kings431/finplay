import { useCallback, useRef, useState } from "react";
import { estimateSize, formatBytes, QUALITIES, useDownloads, type Quality } from "../downloads";
import { IconDownload, IconDownloaded } from "../icons";
import type { BaseItem } from "../types";
import { Popover } from "./Popover";

function percent(received: number, total: number) {
  return total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0;
}

function QualityList({ item, onPick }: { item?: BaseItem; onPick: (quality: Quality) => void }) {
  return (
    <>
      {QUALITIES.map((quality) => {
        const size = item ? estimateSize(item, quality) : 0;
        return (
          <button key={quality.id} className="menu-row" onClick={() => onPick(quality)}>
            <span>{quality.label}</span>
            <small>{size ? `${quality.bitrate ? "~" : ""}${formatBytes(size)}` : quality.bitrate ? "Smaller copy" : "As stored"}</small>
          </button>
        );
      })}
    </>
  );
}

/** Download control for one movie or episode. */
export function DownloadButton({ item }: { item: BaseItem }) {
  const { find, start, remove } = useDownloads();
  const entry = find(item.Id);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const [error, setError] = useState("");
  const active = entry?.state === "queued" || entry?.state === "downloading";
  const done = entry?.state === "done";

  async function pick(quality: Quality, retry = false) {
    setOpen(false);
    setError("");
    try {
      await start(item, quality, retry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOpen(true);
    }
  }

  const title = done ? "Downloaded" : active ? "Downloading" : "Download";
  return (
    <>
      <button ref={anchor} className={`btn-round ${done ? "on-check" : ""}`} onClick={() => setOpen((value) => !value)} aria-label={title} title={title}>
        {done ? <IconDownloaded size={19} /> : active ? <span className="ring-text">{percent(entry.received, entry.total)}%</span> : <IconDownload size={19} />}
      </button>
      {open ? (
        <Popover anchorRef={anchor} onClose={close}>
          {error ? <p className="menu-error">{error}</p> : null}
          {done ? (
            <>
              <p className="menu-head">
                Downloaded · {entry.quality} · {formatBytes(entry.total)}
              </p>
              <button className="menu-row danger" onClick={() => void remove(item.Id).then(() => setOpen(false))}>
                Delete download
              </button>
            </>
          ) : active ? (
            <>
              <p className="menu-head">
                {entry.state === "queued" ? "Waiting to download" : `Downloading · ${formatBytes(entry.received)}${entry.total ? ` of ${formatBytes(entry.total)}` : ""}`}
              </p>
              <button className="menu-row danger" onClick={() => void remove(item.Id).then(() => setOpen(false))}>
                Cancel download
              </button>
            </>
          ) : (
            <>
              {entry?.state === "failed" ? (
                <>
                  <p className="menu-error">{entry.error || "The download failed."}</p>
                  <button className="menu-row" onClick={() => void pick(QUALITIES.find((quality) => quality.id === entry.quality) ?? QUALITIES[0], true)}>
                    <span>Retry</span>
                    <small>{entry.quality}</small>
                  </button>
                </>
              ) : null}
              <p className="menu-head">Download for offline</p>
              <QualityList item={item} onPick={(quality) => void pick(quality)} />
            </>
          )}
        </Popover>
      ) : null}
    </>
  );
}

/** Queues every episode of a season that is not downloaded yet. */
export function SeasonDownload({ episodes }: { episodes: BaseItem[] }) {
  const { find, start, remove } = useDownloads();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const [error, setError] = useState("");
  const entries = episodes.map((episode) => find(episode.Id));
  const doneCount = entries.filter((entry) => entry?.state === "done").length;
  const activeCount = entries.filter((entry) => entry?.state === "queued" || entry?.state === "downloading").length;
  const missing = episodes.filter((_, index) => !entries[index] || entries[index]?.state === "failed");
  if (episodes.length === 0) return null;

  async function pick(quality: Quality) {
    setOpen(false);
    setError("");
    for (const episode of missing) {
      try {
        await start(episode, quality);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setOpen(true);
        return;
      }
    }
  }

  async function removeAll() {
    setOpen(false);
    for (const episode of episodes) {
      if (find(episode.Id)) await remove(episode.Id);
    }
  }

  const label =
    activeCount > 0
      ? `Downloading ${doneCount}/${episodes.length}`
      : doneCount === episodes.length
        ? "Season downloaded"
        : doneCount > 0
          ? `Downloaded ${doneCount}/${episodes.length}`
          : "Download season";
  return (
    <>
      <button ref={anchor} className="btn-ghost" onClick={() => setOpen((value) => !value)}>
        {doneCount === episodes.length ? <IconDownloaded size={15} /> : <IconDownload size={15} />}
        {label}
      </button>
      {open ? (
        <Popover anchorRef={anchor} align="end" onClose={close}>
          {error ? <p className="menu-error">{error}</p> : null}
          {missing.length > 0 ? (
            <>
              <p className="menu-head">
                Download {missing.length} episode{missing.length === 1 ? "" : "s"}
              </p>
              <QualityList onPick={(quality) => void pick(quality)} />
            </>
          ) : null}
          {doneCount + activeCount > 0 ? (
            <button className="menu-row danger" onClick={() => void removeAll()}>
              {activeCount > 0 ? "Cancel and delete season downloads" : "Delete season downloads"}
            </button>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
