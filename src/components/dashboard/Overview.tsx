import { useState } from "react";
import { admin, type ActivityEntry, type ItemCounts, type StorageFolder, type StorageInfo, type SystemInfo } from "../../admin";
import { episodeCode } from "../../media";
import { useClient } from "../../session";
import { isTranscoding, playing, useSessions } from "./Sessions";
import { TaskRow, useTasks } from "./Tasks";
import { IconServer, ago, bytes, errorText, fullDate, usePoll, useConfirm } from "./ui";

type Snapshot = { info: SystemInfo; counts?: ItemCounts; users?: number; storage?: StorageInfo };

export function useSystemInfo() {
  const client = useClient();
  return usePoll<Snapshot>(
    async () => {
      const [info, counts, users, storage] = await Promise.all([
        admin.systemInfo(client),
        admin.counts(client).catch(() => undefined),
        admin
          .users(client)
          .then((list) => list.length)
          .catch(() => undefined),
        admin.storage(client).catch(() => undefined),
      ]);
      return { info, counts, users, storage };
    },
    30000,
    "system",
  );
}

export function OverviewSection({ go }: { go: (section: string) => void }) {
  const client = useClient();
  const system = useSystemInfo();
  const sessions = useSessions(5000);
  const tasks = useTasks();
  const activity = usePoll(async () => (await admin.activity(client, 25)).Items ?? [], 20000, "activity");
  const confirm = useConfirm();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const info = system.data?.info;
  const counts = system.data?.counts;
  const active = playing(sessions.data);
  const transcodes = active.filter(isTranscoding);
  const running = (tasks.data ?? []).filter((task) => task.State !== "Idle" && !task.IsHidden);

  const power = (kind: "restart" | "shutdown") =>
    confirm.ask({
      title: kind === "restart" ? "Restart the server?" : "Shut down the server?",
      body: (
        <p>
          {active.length ? `${active.length} ${active.length === 1 ? "person is" : "people are"} watching right now and will be interrupted. ` : ""}
          {kind === "restart"
            ? "Jellyfin will be unavailable for a minute while it restarts."
            : "Jellyfin will stay offline until someone starts it again on the server machine. You won't be able to start it from Finplay."}
        </p>
      ),
      action: kind === "restart" ? "Restart" : "Shut down",
      danger: true,
      run: async () => {
        await (kind === "restart" ? admin.restart(client) : admin.shutdown(client));
        setNotice({ tone: "ok", text: kind === "restart" ? "The server is restarting." : "The server is shutting down." });
      },
    });

  return (
    <>
      {info?.HasPendingRestart ? (
        <div className="dash-alert">
          <p>
            <strong>Restart pending.</strong> The server needs a restart to finish applying updates or settings.
          </p>
          <button className="btn-ghost dash-small" disabled={!info.CanSelfRestart} onClick={() => power("restart")}>
            Restart now
          </button>
        </div>
      ) : null}
      {info?.HasUpdateAvailable ? (
        <div className="dash-alert soft">
          <p>
            <strong>A Jellyfin update is available.</strong> Install it on the server machine or through your container manager.
          </p>
        </div>
      ) : null}

      <section className="dash-section">
        <div className="dash-card dash-server">
          <span className="dash-server-icon">
            <IconServer size={26} />
          </span>
          <div className="dash-server-main">
            <h2>{info?.ServerName || "Jellyfin server"}</h2>
            <p>
              {info
                ? [
                    `${info.ProductName ?? "Jellyfin Server"} ${info.Version ?? ""}`.trim(),
                    info.OperatingSystemDisplayName || info.OperatingSystem,
                    info.SystemArchitecture,
                    info.LocalAddress,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : system.error
                  ? `Couldn't read server info. ${system.error}`
                  : "Loading…"}
            </p>
            {notice ? <p className={notice.tone === "ok" ? "ok-text" : "error-text"}>{notice.text}</p> : null}
          </div>
          <div className="dash-server-actions">
            <button className="btn-ghost dash-small" disabled={!info?.CanSelfRestart || info?.IsShuttingDown} title={info && !info.CanSelfRestart ? "This server can't restart itself" : undefined} onClick={() => power("restart")}>
              Restart
            </button>
            <button className="btn-ghost dash-small dash-danger-ghost" disabled={!info || info.IsShuttingDown} onClick={() => power("shutdown")}>
              Shut down
            </button>
          </div>
        </div>

        <div className="stat-tiles dash-tiles">
          <button className="stat-tile dash-tile-link" onClick={() => go("sessions")}>
            <small>Watching now</small>
            <strong>{sessions.data ? active.length : "–"}</strong>
            <em>{sessions.data ? (transcodes.length ? `${transcodes.length} transcoding` : active.length ? "All direct" : "Nothing playing") : ""}</em>
          </button>
          <button className="stat-tile dash-tile-link" onClick={() => go("libraries")}>
            <small>Movies</small>
            <strong>{counts?.MovieCount?.toLocaleString() ?? "–"}</strong>
            <em>{counts?.BoxSetCount ? `${counts.BoxSetCount.toLocaleString()} collections` : ""}</em>
          </button>
          <button className="stat-tile dash-tile-link" onClick={() => go("libraries")}>
            <small>Shows</small>
            <strong>{counts?.SeriesCount?.toLocaleString() ?? "–"}</strong>
            <em>{counts?.EpisodeCount ? `${counts.EpisodeCount.toLocaleString()} episodes` : ""}</em>
          </button>
          <button className="stat-tile dash-tile-link" onClick={() => go("users")}>
            <small>Users</small>
            <strong>{system.data?.users?.toLocaleString() ?? "–"}</strong>
            <em>{sessions.data ? `${new Set(sessions.data.map((session) => session.UserId)).size} active recently` : ""}</em>
          </button>
          <button className="stat-tile dash-tile-link" onClick={() => go("tasks")}>
            <small>Tasks running</small>
            <strong>{tasks.data ? running.length : "–"}</strong>
            <em>{running[0]?.Name ?? (tasks.data ? "All idle" : "")}</em>
          </button>
        </div>
      </section>

      <div className="dash-grid">
        <div className="dash-col">
          <section className="dash-card">
            <div className="stat-card-head">
              <h2>Active streams</h2>
              <button className="text-btn" onClick={() => go("sessions")}>
                Manage
              </button>
            </div>
            {!sessions.data ? <p className="stat-empty">{sessions.error ? `Couldn't load sessions. ${sessions.error}` : "Loading…"}</p> : null}
            {sessions.data && active.length === 0 ? <p className="stat-empty">Nobody is watching right now.</p> : null}
            <div className="dash-list compact">
              {active.map((session) => {
                const item = session.NowPlayingItem!;
                const position = (session.PlayState?.PositionTicks ?? 0) / 10_000_000;
                const total = (item.RunTimeTicks ?? 0) / 10_000_000;
                return (
                  <button key={session.Id} className="dash-row" onClick={() => go("sessions")}>
                    <span className="dash-avatar">{(session.UserName ?? "?").slice(0, 1).toUpperCase()}</span>
                    <span className="dash-row-main">
                      <strong>{item.SeriesName ? `${item.SeriesName} · ${episodeCode(item)}` : item.Name}</strong>
                      <small>
                        {session.UserName} · {[session.Client, session.DeviceName].filter(Boolean).join(" · ")}
                      </small>
                      <span className="dash-bar small">
                        <span style={{ width: `${total ? Math.min(100, (position / total) * 100) : 0}%` }} />
                      </span>
                    </span>
                    <span className={`method${isTranscoding(session) ? " transcode" : ""}`}>{isTranscoding(session) ? "Transcode" : session.PlayState?.PlayMethod === "DirectStream" ? "Direct stream" : "Direct play"}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="dash-card">
            <div className="stat-card-head">
              <h2>Recent activity</h2>
              <small>from the server's activity log</small>
            </div>
            {!activity.data ? <p className="stat-empty">{activity.error ? `Couldn't load the activity log. ${activity.error}` : "Loading…"}</p> : null}
            <ActivityList entries={activity.data ?? []} />
          </section>
        </div>

        <div className="dash-col">
          <section className="dash-card">
            <div className="stat-card-head">
              <h2>Running tasks</h2>
              <button className="text-btn" onClick={() => go("tasks")}>
                All tasks
              </button>
            </div>
            {tasks.data && running.length === 0 ? <p className="stat-empty">Nothing running. Library scans and maintenance show up here while they work.</p> : null}
            {!tasks.data ? <p className="stat-empty">{tasks.error ? `Couldn't load tasks. ${tasks.error}` : "Loading…"}</p> : null}
            <div className="dash-list compact">
              {running.map((task) => (
                <TaskRow
                  key={task.Id}
                  task={task}
                  pending={false}
                  onRun={() => {}}
                  onStop={() => void admin.stopTask(client, task.Id).then(() => tasks.reload()).catch((err: unknown) => setNotice({ tone: "error", text: errorText(err) }))}
                />
              ))}
            </div>
          </section>

          <section className="dash-card">
            <div className="stat-card-head">
              <h2>Storage</h2>
              <small>free space</small>
            </div>
            <Storage storage={system.data?.storage} info={info} />
          </section>
        </div>
      </div>
      {confirm.dialog}
    </>
  );
}

function Storage({ storage, info }: { storage?: StorageInfo; info?: SystemInfo }) {
  const rows: { label: string; folder?: StorageFolder; path?: string }[] = [
    { label: "Server data", folder: storage?.ProgramDataFolder, path: info?.ProgramDataPath },
    { label: "Metadata", folder: storage?.InternalMetadataFolder, path: info?.InternalMetadataPath },
    { label: "Cache", folder: storage?.CacheFolder, path: info?.CachePath },
    { label: "Transcodes", folder: storage?.TranscodingTempFolder, path: info?.TranscodingTempPath },
    { label: "Logs", folder: storage?.LogFolder, path: info?.LogPath },
  ].filter((row) => row.folder || row.path);
  if (!rows.length) return <p className="stat-empty">{info ? "This server doesn't report storage." : "Loading…"}</p>;
  return (
    <div className="dash-storage">
      {rows.map(({ label, folder, path }) => {
        const total = (folder?.FreeSpace ?? 0) + (folder?.UsedSpace ?? 0);
        const used = total ? ((folder?.UsedSpace ?? 0) / total) * 100 : 0;
        return (
          <div key={label} className="dash-storage-row">
            <span className="dash-storage-label">
              <strong>{label}</strong>
              <code title={folder?.Path ?? path}>{folder?.Path ?? path}</code>
            </span>
            {total ? (
              <span className="dash-storage-space">
                <span className={`dash-bar small${used > 90 ? " bad" : ""}`}>
                  <span style={{ width: `${used}%` }} />
                </span>
                <small>
                  {bytes(folder?.FreeSpace)} free of {bytes(total)}
                </small>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const SEVERITY: Record<string, string> = { Error: "bad", Critical: "bad", Warning: "warn" };

export function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  if (!entries.length) return null;
  return (
    <div className="dash-activity">
      {entries.map((entry) => (
        <div key={entry.Id} className="dash-activity-row">
          <i className={`dash-dot ${entry.Severity ? SEVERITY[entry.Severity] ?? "" : ""}`} />
          <span className="dash-row-main">
            <strong>{entry.Name}</strong>
            {entry.ShortOverview ? <small>{entry.ShortOverview}</small> : null}
          </span>
          <span className="dash-row-side" title={fullDate(entry.Date)}>
            {ago(entry.Date)}
          </span>
        </div>
      ))}
    </div>
  );
}
