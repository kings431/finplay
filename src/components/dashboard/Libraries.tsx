import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { REFRESH_MODES, admin, libraryImage, type RefreshMode, type ScheduledTask, type StorageInfo, type VirtualFolder } from "../../admin";
import { tile } from "../../media";
import { useClient } from "../../session";
import { IconRefresh, ago, bytes, errorText, usePoll } from "./ui";

const KINDS: Record<string, string> = {
  movies: "Movies",
  tvshows: "Shows",
  music: "Music",
  musicvideos: "Music videos",
  homevideos: "Home videos",
  books: "Books",
  boxsets: "Collections",
  playlists: "Playlists",
  livetv: "Live TV",
};

const COUNT_NOUN: Record<string, [string, string]> = {
  movies: ["movie", "movies"],
  tvshows: ["show", "shows"],
  music: ["album", "albums"],
  books: ["book", "books"],
  boxsets: ["collection", "collections"],
};

type Snapshot = { folders: VirtualFolder[]; scan?: ScheduledTask };

export function LibrariesSection() {
  const client = useClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [fast, setFast] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState<VirtualFolder | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  const { data, error, loading, reload } = usePoll<Snapshot>(
    async () => {
      const [folders, tasks] = await Promise.all([admin.libraries(client), admin.tasks(client).catch(() => [] as ScheduledTask[])]);
      return { folders, scan: tasks.find((task) => task.Key === "RefreshLibrary") };
    },
    fast ? 2000 : 15000,
    "libraries",
  );

  const scanning = data?.scan?.State === "Running" || data?.scan?.State === "Cancelling";
  const anyRefreshing = data?.folders.some((folder) => folder.RefreshStatus && folder.RefreshStatus !== "Idle");
  useEffect(() => setFast(Boolean(scanning || anyRefreshing)), [scanning, anyRefreshing]);

  const folderIds = data?.folders.map((folder) => folder.ItemId).join(",") ?? "";
  useEffect(() => {
    if (!data?.folders.length) return;
    let cancel = false;
    void Promise.all(data.folders.map(async (folder) => [folder.ItemId, await admin.libraryCount(client, folder).catch(() => -1)] as const)).then((entries) => {
      if (!cancel) setCounts(Object.fromEntries(entries));
    });
    admin
      .storage(client)
      .then((info) => !cancel && setStorage(info))
      .catch(() => {});
    return () => {
      cancel = true;
    };
    // Counts only change after scans, so they reload when the set of libraries changes or a scan ends.
  }, [client, folderIds, scanning]);

  const scanAll = () => {
    setBusy(true);
    setNotice(null);
    admin
      .scanAll(client)
      .then(() => {
        setNotice({ tone: "ok", text: "Library scan started." });
        setFast(true);
        window.setTimeout(() => void reload(), 800);
      })
      .catch((err: unknown) => setNotice({ tone: "error", text: `Couldn't start the scan: ${errorText(err)}` }))
      .finally(() => setBusy(false));
  };

  const lastScan = data?.scan?.LastExecutionResult;
  const scanPercent = Math.round(data?.scan?.CurrentProgressPercentage ?? 0);

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <div>
          <h2>Libraries</h2>
          <p>
            {lastScan?.EndTimeUtc ? `Last full scan ${ago(lastScan.EndTimeUtc)}${lastScan.Status && lastScan.Status !== "Completed" ? ` (${lastScan.Status.toLowerCase()})` : ""}.` : "Scan to pick up new files."}
          </p>
        </div>
        <button className="btn-primary dash-small" disabled={busy || scanning} onClick={scanAll}>
          <IconRefresh size={16} />
          {scanning ? "Scanning…" : "Scan all libraries"}
        </button>
      </div>

      {scanning ? (
        <div className="dash-card dash-scan">
          <div className="dash-scan-head">
            <strong>Scanning media libraries</strong>
            <span>{scanPercent}%</span>
          </div>
          <div className="dash-bar">
            <span style={{ width: `${scanPercent}%` }} />
          </div>
        </div>
      ) : null}
      {notice ? <p className={`dash-inline-note ${notice.tone === "ok" ? "ok-text" : "error-text"}`}>{notice.text}</p> : null}
      {error && !data ? <p className="dash-empty error-text">Couldn't load libraries. {error}</p> : null}
      {!data && loading ? <p className="dash-empty">Loading libraries…</p> : null}

      <div className="dash-libraries">
        {data?.folders.map((folder) => {
          const kind = folder.CollectionType ? KINDS[folder.CollectionType] ?? folder.CollectionType : "Mixed";
          const count = counts[folder.ItemId];
          const noun = (folder.CollectionType && COUNT_NOUN[folder.CollectionType]) || ["item", "items"];
          const running = folder.RefreshStatus && folder.RefreshStatus !== "Idle";
          const space = storage?.Libraries?.find((entry) => entry.Id === folder.ItemId)?.Folders ?? [];
          return (
            <article key={folder.ItemId} className="dash-card dash-library">
              <button className="dash-library-art" style={{ background: tile(folder.Name) }} onClick={() => navigate(`/library/${folder.ItemId}`)} aria-label={`Open ${folder.Name}`}>
                {folder.PrimaryImageItemId ? (
                  <img src={libraryImage(client.auth.server, client.auth.token, folder.PrimaryImageItemId)} alt="" loading="lazy" onError={(event) => (event.currentTarget.style.display = "none")} />
                ) : (
                  <span className="dash-library-fallback">{folder.Name}</span>
                )}
              </button>
              <div className="dash-library-body">
                <div className="dash-library-meta">
                  <h3>{folder.Name}</h3>
                  <span className="dash-chip">{kind}</span>
                  <span>{count === undefined ? "Counting…" : count < 0 ? "Your account can't browse this library" : `${count.toLocaleString()} ${count === 1 ? noun[0] : noun[1]}`}</span>
                </div>
                <ul className="dash-paths">
                  {(folder.Locations ?? []).map((path) => {
                    const disk = space.find((entry) => entry.Path === path);
                    const total = (disk?.FreeSpace ?? 0) + (disk?.UsedSpace ?? 0);
                    return (
                      <li key={path}>
                        <code title={path}>{path}</code>
                        {disk && total > 0 ? (
                          <span className="dash-disk" title={`${bytes(disk.UsedSpace)} used, ${bytes(disk.FreeSpace)} free`}>
                            <span className="dash-bar small">
                              <span style={{ width: `${((disk.UsedSpace ?? 0) / total) * 100}%` }} />
                            </span>
                            {bytes(disk.FreeSpace)} free
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {running ? (
                  <div className="dash-library-progress">
                    <span>Refreshing… {Math.round(folder.RefreshProgress ?? 0)}%</span>
                    <div className="dash-bar small">
                      <span style={{ width: `${folder.RefreshProgress ?? 0}%` }} />
                    </div>
                  </div>
                ) : null}
                <div className="dash-library-actions">
                  <button className="btn-ghost dash-small" disabled={Boolean(running) || scanning} onClick={() => setRefreshing(folder)}>
                    <IconRefresh size={15} />
                    Refresh…
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {refreshing ? (
        <RefreshDialog
          folder={refreshing}
          onClose={() => setRefreshing(null)}
          onStarted={(text) => {
            setRefreshing(null);
            setNotice({ tone: "ok", text });
            setFast(true);
            window.setTimeout(() => void reload(), 800);
          }}
        />
      ) : null}
    </section>
  );
}

function RefreshDialog({ folder, onClose, onStarted }: { folder: VirtualFolder; onClose: () => void; onStarted: (text: string) => void }) {
  const client = useClient();
  const [mode, setMode] = useState<RefreshMode>("scan");
  const [images, setImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = () => {
    setBusy(true);
    setError("");
    admin
      .refreshLibrary(client, folder.ItemId, mode, images)
      .then(() => onStarted(`Refreshing ${folder.Name}: ${REFRESH_MODES.find((entry) => entry.id === mode)?.label.toLowerCase()}.`))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="resume-card dash-confirm" role="dialog" aria-modal="true" aria-label={`Refresh ${folder.Name}`} onClick={(event) => event.stopPropagation()}>
        <h2>Refresh {folder.Name}</h2>
        <div className="dash-options">
          {REFRESH_MODES.map((option) => (
            <label key={option.id} className={`dash-option${mode === option.id ? " on" : ""}`}>
              <input type="radio" name="refresh-mode" checked={mode === option.id} onChange={() => setMode(option.id)} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
          {mode === "replace" ? (
            <label className="dash-check">
              <input type="checkbox" checked={images} onChange={(event) => setImages(event.target.checked)} />
              Replace existing images too
            </label>
          ) : null}
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="dash-confirm-actions">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`btn-primary${mode === "replace" ? " dash-danger" : ""}`} onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Refresh"}
          </button>
        </div>
      </div>
    </div>
  );
}
