import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { invalidate, useCached } from "../cache";
import { IconPlus } from "../icons";
import { formatRuntime, thumbUrl, tile } from "../media";
import { useSession } from "../session";

export function Playlists() {
  const session = useSession();
  const { client } = session;
  const navigate = useNavigate();
  const { data, error, loading } = useCached(client ? "playlists" : null, async () => (await client!.playlists()).Items ?? []);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const playlists = data ?? [];

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!client || !name.trim()) return;
    setBusy(true);
    setFailed("");
    try {
      const { Id } = await client.createPlaylist(name.trim(), []);
      invalidate("playlists");
      navigate(`/playlist/${Id}`);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Could not create the playlist.");
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Playlists</h1>
          <p>Your own lists of movies and episodes. Only you can see them.</p>
        </div>
        {naming ? (
          <form className="playlist-new" onSubmit={(event) => void create(event)}>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Playlist name" maxLength={120} />
            <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>
              Create
            </button>
            <button className="btn-ghost" type="button" onClick={() => setNaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="btn-ghost" onClick={() => setNaming(true)}>
            <IconPlus size={16} />
            New playlist
          </button>
        )}
      </header>
      {failed ? <p className="empty error-text">{failed}</p> : null}
      {error ? <p className="empty">{error}</p> : null}
      {!loading && !error && playlists.length === 0 ? (
        <p className="empty">No playlists yet. Make one here, or use the playlist button on any movie or episode.</p>
      ) : null}
      <div className="library-grid">
        {playlists.map((playlist) => {
          const art = thumbUrl(session, playlist);
          const count = playlist.ChildCount ?? 0;
          const runtime = formatRuntime(playlist.CumulativeRunTimeTicks);
          return (
            <button key={playlist.Id} className="library-card" onClick={() => navigate(`/playlist/${playlist.Id}`)}>
              <span style={{ background: tile(playlist.Name) }}>{art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}</span>
              <strong>{playlist.Name}</strong>
              <small className="playlist-meta">{[`${count} ${count === 1 ? "title" : "titles"}`, runtime].filter(Boolean).join(" · ")}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
