import { useEffect, useState, type DragEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invalidate, useCached } from "../cache";
import { IconBack, IconClose, IconDown, IconPlay, IconUp } from "../icons";
import { episodeCode, formatRuntime, thumbUrl, tile } from "../media";
import { usePlayback } from "../playback";
import { useSession } from "../session";
import type { BaseItem } from "../types";

export function Playlist() {
  const { id = "" } = useParams();
  const session = useSession();
  const { client } = session;
  const navigate = useNavigate();
  const { play, busy } = usePlayback();
  const info = useCached(client ? `playlist:${id}:info` : null, () => client!.item(id));
  const entries = useCached(client ? `playlist:${id}:items` : null, async () => (await client!.playlistItems(id)).Items ?? []);
  /** Shown while a change is on its way to the server. */
  const [local, setLocal] = useState<BaseItem[] | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [failed, setFailed] = useState("");

  useEffect(() => setLocal(null), [entries.data]);
  useEffect(() => setName(null), [info.data]);

  const list = local ?? entries.data ?? [];
  const title = name ?? info.data?.Name ?? "Playlist";
  const runtime = formatRuntime(list.reduce((sum, item) => sum + (item.RunTimeTicks ?? 0), 0));

  function refresh() {
    invalidate(`playlist:${id}:`);
    invalidate("playlists");
  }

  async function change(next: BaseItem[], send: () => Promise<void>) {
    setFailed("");
    setLocal(next);
    try {
      await send();
      refresh();
    } catch (err) {
      setLocal(null);
      setFailed(err instanceof Error ? err.message : "The server didn't accept that change.");
    }
  }

  function move(from: number, to: number) {
    if (!client || to < 0 || to >= list.length || from === to) return;
    const entry = list[from];
    if (!entry.PlaylistItemId) return;
    const next = [...list];
    next.splice(from, 1);
    next.splice(to, 0, entry);
    void change(next, () => client.movePlaylistItem(id, entry.PlaylistItemId!, to));
  }

  function remove(index: number) {
    const entry = list[index];
    if (!client || !entry.PlaylistItemId) return;
    void change(
      list.filter((_, at) => at !== index),
      () => client.removeFromPlaylist(id, [entry.PlaylistItemId!]),
    );
  }

  async function rename(event: { preventDefault(): void }) {
    event.preventDefault();
    const next = draft.trim();
    setRenaming(false);
    if (!client || !next || next === title) return;
    const previous = title;
    setName(next);
    try {
      await client.renamePlaylist(id, next);
      refresh();
    } catch (err) {
      setName(previous);
      setFailed(err instanceof Error ? err.message : "Could not rename the playlist.");
    }
  }

  async function deletePlaylist() {
    if (!client) return;
    try {
      await client.deletePlaylist(id);
      invalidate("playlists");
      navigate("/playlists", { replace: true });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Could not delete the playlist.");
      setConfirmDelete(false);
    }
  }

  function playFrom(index: number) {
    const [first, ...rest] = list.slice(index);
    if (first) void play(first, { resume: true, queue: rest });
  }

  function onDrop(event: DragEvent, index: number) {
    event.preventDefault();
    if (dragging !== null) move(dragging, index);
    setDragging(null);
  }

  return (
    <div className="page playlist-page">
      <header className="page-head">
        <div className="playlist-title">
          <button className="btn-round" onClick={() => navigate("/playlists")} aria-label="All playlists">
            <IconBack size={18} />
          </button>
          <div>
            {renaming ? (
              <form onSubmit={(event) => void rename(event)}>
                <input
                  className="playlist-name-input"
                  autoFocus
                  value={draft}
                  maxLength={120}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={(event) => {
                    if (document.hasFocus()) void rename(event);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" || event.key === "GoBack") {
                      event.stopPropagation();
                      setRenaming(false);
                    }
                  }}
                />
              </form>
            ) : (
              <h1>
                <button
                  className="playlist-name"
                  title="Rename"
                  onClick={() => {
                    setDraft(title);
                    setRenaming(true);
                  }}
                >
                  {title}
                </button>
              </h1>
            )}
            <p>{[`${list.length} ${list.length === 1 ? "title" : "titles"}`, runtime].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <div className="playlist-actions">
          <button className="btn-play" disabled={busy || list.length === 0} onClick={() => playFrom(0)}>
            <IconPlay size={16} />
            {busy ? "Starting…" : "Play all"}
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              setDraft(title);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          {confirmDelete ? (
            <>
              <button className="btn-ghost danger" onClick={() => void deletePlaylist()}>
                Delete for good
              </button>
              <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn-ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
      </header>
      {failed ? <p className="empty error-text">{failed}</p> : null}
      {entries.error ? <p className="empty">{entries.error}</p> : null}
      {!entries.loading && !entries.error && list.length === 0 ? (
        <p className="empty">This playlist is empty. Open any movie or episode and use the playlist button to add it.</p>
      ) : null}
      <ol className="playlist-list">
        {list.map((item, index) => {
          const art = thumbUrl(session, item);
          const code = episodeCode(item);
          const detail =
            item.Type === "Episode"
              ? [item.SeriesName, code].filter(Boolean).join(" · ")
              : [item.ProductionYear, formatRuntime(item.RunTimeTicks)].filter(Boolean).join(" · ");
          const progress = item.UserData?.PlayedPercentage ?? 0;
          return (
            <li
              key={item.PlaylistItemId ?? `${item.Id}-${index}`}
              className={`playlist-row${dragging === index ? " dragging" : ""}`}
              draggable
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => onDrop(event, index)}
              onDragEnd={() => setDragging(null)}
            >
              <span className="playlist-index">{index + 1}</span>
              <button className="playlist-art" style={{ background: tile(item.Name) }} onClick={() => playFrom(index)} aria-label={`Play ${item.Name}`}>
                {art ? <img src={art} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
                <IconPlay size={22} />
                {progress > 1 && progress < 98 ? (
                  <span className="progress">
                    <span style={{ width: `${progress}%` }} />
                  </span>
                ) : null}
              </button>
              <button className="playlist-copy" onClick={() => navigate(`/item/${item.Id}`)}>
                <strong>{item.Name}</strong>
                <small>{detail}</small>
              </button>
              <div className="playlist-tools">
                <button className="btn-round" disabled={index === 0} onClick={() => move(index, index - 1)} aria-label="Move up" title="Move up">
                  <IconUp size={18} />
                </button>
                <button className="btn-round" disabled={index === list.length - 1} onClick={() => move(index, index + 1)} aria-label="Move down" title="Move down">
                  <IconDown size={18} />
                </button>
                <button className="btn-round" onClick={() => remove(index)} aria-label="Remove from playlist" title="Remove from playlist">
                  <IconClose size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
