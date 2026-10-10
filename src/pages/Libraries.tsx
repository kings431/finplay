import { useNavigate } from "react-router-dom";
import { tile, primaryUrl } from "../media";
import { useSession } from "../session";

export function Libraries() {
  const { views } = useSession();
  const session = useSession();
  const navigate = useNavigate();
  return (
    <div className="page">
      <header className="page-head">
        <h1>Libraries</h1>
      </header>
      <div className="library-grid">
        {views.map((view) => {
          const art = primaryUrl(session, view);
          return (
            <button key={view.Id} className="library-card" onClick={() => navigate(view.CollectionType === "livetv" ? "/livetv" : view.CollectionType === "playlists" ? "/playlists" : `/library/${view.Id}`)}>
              <span style={{ background: tile(view.Name) }}>{art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}</span>
              <strong>{view.Name}</strong>
            </button>
          );
        })}
      </div>
      {views.length === 0 ? <p className="empty">No libraries are visible for this user.</p> : null}
    </div>
  );
}
