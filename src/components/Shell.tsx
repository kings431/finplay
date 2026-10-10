import { Suspense, useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useDownloads } from "../downloads";
import { IconChart, IconCompass, IconDownload, IconFilm, IconGrid, IconHome, IconLive, IconPlaylist, IconSearch, IconSettings, IconTv, IconUsers, Mark } from "../icons";
import { userImageUrl } from "../media";
import { usePlayback } from "../playback";
import { useSession } from "../session";
import { useSyncPlay } from "../syncplay";
import { Popover } from "./Popover";
import { UpdateBanner } from "./UpdateBanner";
import { CastButton, RemoteBar } from "./Cast";

const OFFLINE_PATHS = ["/downloads", "/settings", "/playing/", "/item/"];

function ProfileMenu({ avatar }: { avatar?: string }) {
  const { username, accountServer: server, userId, accounts, switchTo, addAccount, logout } = useSession();
  const { active, stop } = usePlayback();
  const navigate = useNavigate();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const others = accounts.filter((account) => !(account.server === server && account.userId === userId));

  async function leave(then: () => void) {
    setOpen(false);
    if (active) await stop().catch(() => {});
    navigate("/", { replace: true });
    then();
  }

  return (
    <>
      <button ref={anchor} className={`user-btn${open ? " active" : ""}`} title={username} onClick={() => setOpen((value) => !value)}>
        {avatar ? <img src={avatar} alt="" /> : <span>{username.slice(0, 1).toUpperCase()}</span>}
      </button>
      {open ? (
        <Popover anchorRef={anchor} onClose={() => setOpen(false)} side="right">
          <div className="menu-head">
            <strong>{username}</strong>
            <small>{server.replace(/^https?:\/\//, "")}</small>
          </div>
          {others.length ? <div className="menu-label">Switch profile</div> : null}
          {others.map((account) => (
            <button key={`${account.server}:${account.userId}`} className="menu-row profile-row" onClick={() => void leave(() => switchTo(account))}>
              <span className="profile-avatar small">{account.username.slice(0, 1).toUpperCase()}</span>
              <span>
                {account.username}
                {account.server !== server ? <small> · {account.server.replace(/^https?:\/\//, "")}</small> : null}
              </span>
            </button>
          ))}
          <button
            className="menu-row"
            onClick={() =>
              void leave(() => {
                addAccount();
                navigate("/login?add=1", { replace: true });
              })
            }
          >
            Add account
          </button>
          <button
            className="menu-row"
            onClick={() => {
              setOpen(false);
              navigate("/settings");
            }}
          >
            Settings
          </button>
          <button className="menu-row danger" onClick={() => void leave(logout)}>
            Sign out
          </button>
        </Popover>
      ) : null}
    </>
  );
}

export function Shell() {
  const { views, imageTag, server, token, userId, deviceId, status, reconnect, isAdmin } = useSession();
  const { active, error, clearError, mini, setMini } = usePlayback();
  const { entries } = useDownloads();
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const [retrying, setRetrying] = useState(false);
  const offline = status === "offline";
  const movies = views.find((view) => view.CollectionType === "movies");
  const shows = views.find((view) => view.CollectionType === "tvshows");
  const liveTv = views.some((view) => view.CollectionType === "livetv");
  const together = useSyncPlay();
  const avatar = offline ? undefined : userImageUrl({ server, token, userId, deviceId }, imageTag);
  const downloading = entries.filter((entry) => entry.state === "queued" || entry.state === "downloading").length;

  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    if (!retrying) return;
    const timer = window.setTimeout(() => setRetrying(false), 1500);
    return () => window.clearTimeout(timer);
  }, [retrying, status]);

  if (offline && !OFFLINE_PATHS.some((path) => location.pathname.startsWith(path))) {
    return <Navigate to="/downloads" replace />;
  }

  const link = ({ isActive }: { isActive: boolean }) => `nav-btn${isActive ? " active" : ""}`;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate(offline ? "/downloads" : "/")} aria-label="Home">
          <Mark size={34} />
        </button>
        <nav>
          {offline ? null : (
            <>
              <NavLink to="/" end className={link}>
                <IconHome />
                <span>Home</span>
              </NavLink>
              {movies ? (
                <NavLink to={`/library/${movies.Id}`} className={link}>
                  <IconFilm />
                  <span>Movies</span>
                </NavLink>
              ) : null}
              {shows ? (
                <NavLink to={`/library/${shows.Id}`} className={link}>
                  <IconTv />
                  <span>Shows</span>
                </NavLink>
              ) : null}
              {liveTv ? (
                <NavLink to="/livetv" className={link}>
                  <IconLive />
                  <span>Live TV</span>
                </NavLink>
              ) : null}
              <NavLink to="/libraries" className={link}>
                <IconGrid />
                <span>Library</span>
              </NavLink>
              <NavLink to="/playlists" className={({ isActive }) => link({ isActive: isActive || location.pathname.startsWith("/playlist/") })}>
                <IconPlaylist />
                <span>Playlists</span>
              </NavLink>
              <NavLink to="/discover" className={link}>
                <IconCompass />
                <span>Discover</span>
              </NavLink>
              <NavLink to="/search" className={link}>
                <IconSearch />
                <span>Search</span>
              </NavLink>
              <NavLink to="/together" className={link}>
                <IconUsers />
                <span>Together</span>
                {together.group ? <i className="nav-count">{together.group.Participants.length}</i> : null}
              </NavLink>
            </>
          )}
          {offline || entries.length > 0 ? (
            <NavLink to="/downloads" className={link}>
              <IconDownload />
              <span>Downloads</span>
              {downloading > 0 ? <i className="nav-count">{downloading}</i> : null}
            </NavLink>
          ) : null}
        </nav>
        <div className="side-foot">
          {isAdmin && !offline ? (
            <NavLink to="/stats" className={link}>
              <IconChart />
              <span>Stats</span>
            </NavLink>
          ) : null}
          {offline ? null : <CastButton />}
          {active ? (
            <button className="now-pill" onClick={() => (mini ? void setMini(false) : navigate(`/playing/${active.item.Id}`))}>
              Playing
            </button>
          ) : null}
          <ProfileMenu avatar={avatar} />
          <NavLink to="/settings" className={link}>
            <IconSettings />
            <span>Settings</span>
          </NavLink>
        </div>
      </aside>
      <main ref={mainRef} className="main">
        {offline ? (
          <div className="banner offline-banner">
            <p>Can't reach {server.replace(/^https?:\/\//, "")}. Your downloads still play, and watch progress will sync when you're back.</p>
            <button
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                reconnect();
              }}
            >
              {retrying ? "Trying…" : "Reconnect"}
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="banner">
            <p>{error}</p>
            <button onClick={clearError}>Dismiss</button>
          </div>
        ) : null}
        <UpdateBanner />
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
      {together.notice ? <div className="toast">{together.notice}</div> : null}
      {offline ? null : <RemoteBar />}
    </div>
  );
}
