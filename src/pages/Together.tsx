import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayback } from "../playback";
import { useSession } from "../session";
import { useSyncPlay } from "../syncplay";
import type { SyncGroup } from "../types";

const STATE_LABEL: Record<string, string> = {
  Idle: "Choosing something to watch",
  Waiting: "Waiting for everyone to load",
  Paused: "Paused",
  Playing: "Playing",
};

export function Together() {
  const { username } = useSession();
  const together = useSyncPlay();
  const { active } = usePlayback();
  const navigate = useNavigate();
  const [groups, setGroups] = useState<SyncGroup[] | null>(null);
  const [name, setName] = useState(`${username}'s room`);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (together.group) return;
    let cancel = false;
    const refresh = () =>
      together
        .groups()
        .then((list) => !cancel && setGroups(list))
        .catch(() => !cancel && setGroups([]));
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [together.group]);

  async function attempt(action: () => Promise<void>) {
    setBusy(true);
    setFailure("");
    try {
      await action();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const error = failure || together.error;

  if (together.group) {
    const group = together.group;
    return (
      <div className="page together">
        <header className="page-head">
          <div>
            <h1>{group.GroupName}</h1>
            <p>{STATE_LABEL[together.state] ?? together.state}</p>
          </div>
          <button className="btn-ghost" disabled={busy} onClick={() => void attempt(together.leave)}>
            Leave group
          </button>
        </header>
        {error ? <p className="empty error-text">{error}</p> : null}
        <section className="together-card">
          <h2>In the room</h2>
          <div className="together-people">
            {group.Participants.map((person) => (
              <span key={person} className="together-person">
                <span className="profile-avatar small">{person.slice(0, 1).toUpperCase()}</span>
                {person}
                {person === username ? <small> (you)</small> : null}
              </span>
            ))}
          </div>
        </section>
        <section className="together-card">
          <h2>How it works</h2>
          <p>Open any movie or episode and press Play. It starts for everyone in the room at the same moment. Pausing or seeking in mpv does the same for the whole group.</p>
          <div className="hero-actions">
            {active ? (
              <button className="btn-play" onClick={() => navigate(`/playing/${active.item.Id}`)}>
                Back to {active.item.Name}
              </button>
            ) : (
              <button className="btn-play" onClick={() => navigate("/")}>
                Find something to watch
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page together">
      <header className="page-head">
        <div>
          <h1>Watch together</h1>
          <p>Start a room, have friends join from Finplay or Jellyfin, and everyone's playback stays in sync.</p>
        </div>
      </header>
      {error ? <p className="empty error-text">{error}</p> : null}
      <form
        className="together-card together-create"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void attempt(() => together.create(name));
        }}
      >
        <h2>Start a room</h2>
        <div className="inline-form">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
          <button className="btn-primary" type="submit" disabled={busy}>
            Create
          </button>
        </div>
      </form>
      <section className="together-card">
        <h2>Join a room</h2>
        {groups === null ? <p className="fine">Looking for rooms…</p> : null}
        {groups?.length === 0 ? <p className="fine">No one has a room open right now.</p> : null}
        <div className="together-groups">
          {groups?.map((group) => (
            <div key={group.GroupId} className="together-group">
              <div>
                <strong>{group.GroupName}</strong>
                <small>
                  {group.Participants.join(", ")} · {STATE_LABEL[group.State] ?? group.State}
                </small>
              </div>
              <button className="btn-ghost" disabled={busy} onClick={() => void attempt(() => together.join(group.GroupId))}>
                Join
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
