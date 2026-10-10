import { useRef, useState, type FormEvent } from "react";
import { invalidate, useCached } from "../cache";
import { IconCheck, IconPlaylist } from "../icons";
import { useSession } from "../session";
import type { BaseItem } from "../types";
import { Popover } from "./Popover";

/** Adds a movie or episode, or every episode of a series or season, to one of the user's playlists. */
export function AddToPlaylist({ item }: { item: BaseItem }) {
  const { client } = useSession();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [failed, setFailed] = useState("");
  const { data } = useCached(open && client ? "playlists" : null, async () => (await client!.playlists()).Items ?? []);
  const playlists = data ?? [];
  const whole = item.Type === "Series" || item.Type === "Season";

  function close() {
    setOpen(false);
    setNaming(false);
    setName("");
    setFailed("");
  }

  async function run(label: string, action: () => Promise<string>) {
    setBusy(true);
    setFailed("");
    try {
      const playlistId = await action();
      invalidate("playlists");
      invalidate(`playlist:${playlistId}:`);
      setDone(label);
      window.setTimeout(() => {
        setDone("");
        close();
      }, 900);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Could not add it.");
    } finally {
      setBusy(false);
    }
  }

  function addTo(playlist: BaseItem) {
    if (!client) return;
    void run(playlist.Name, async () => {
      await client.addToPlaylist(playlist.Id, [item.Id]);
      return playlist.Id;
    });
  }

  function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!client || !trimmed) return;
    void run(trimmed, async () => (await client.createPlaylist(trimmed, [item.Id])).Id);
  }

  return (
    <>
      <button ref={anchor} className="btn-round" onClick={() => setOpen(true)} aria-label="Add to playlist" title="Add to playlist">
        <IconPlaylist size={19} />
      </button>
      {open ? (
        <Popover anchorRef={anchor} onClose={close}>
          <p className="menu-head">
            <strong>Add to playlist</strong>
            {whole ? "Adds every episode in it" : null}
          </p>
          {done ? (
            <p className="menu-done">
              <IconCheck size={16} /> Added to {done}
            </p>
          ) : (
            <>
              {playlists.map((playlist) => (
                <button key={playlist.Id} className="menu-row" disabled={busy} onClick={() => addTo(playlist)}>
                  {playlist.Name}
                  <small>{playlist.ChildCount ?? 0}</small>
                </button>
              ))}
              {naming ? (
                <form className="menu-form" onSubmit={create}>
                  <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Playlist name" maxLength={120} />
                  <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>
                    Create
                  </button>
                </form>
              ) : (
                <button className="menu-row" onClick={() => setNaming(true)}>
                  New playlist…
                </button>
              )}
              {failed ? <p className="menu-error">{failed}</p> : null}
            </>
          )}
        </Popover>
      ) : null}
    </>
  );
}
