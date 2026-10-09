import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { seerrPoster } from "../components/RequestSheet";
import type { Jellyfin } from "../jellyfin";
import { tile } from "../media";
import { useClient, useSession } from "../session";
import type { SeerrRequest, SeerrResult } from "../types";
import { useInfiniteScroll } from "../useInfiniteScroll";

const PAGE = 20;
const FILTERS = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting for approval" },
  { id: "active", label: "In progress" },
  { id: "available", label: "Available" },
  { id: "declined", label: "Declined" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];
type State = { label: string; tone: "ok" | "warn" | "info" | "bad"; group: Filter; percent?: number; eta?: string };

const details = new Map<string, Promise<SeerrResult | null>>();

function lookup(client: Jellyfin, request: SeerrRequest) {
  const key = `${request.type}:${request.media.tmdbId}`;
  let found = details.get(key);
  if (!found) {
    found = (request.type === "tv" ? client.seerrTv(request.media.tmdbId) : client.seerrMovie(request.media.tmdbId)).catch(() => null);
    details.set(key, found);
  }
  return found;
}

export function Requests() {
  const client = useClient();
  const { userId, isAdmin, seerr } = useSession();
  const [requests, setRequests] = useState<SeerrRequest[]>([]);
  const [titles, setTitles] = useState<Record<string, SeerrResult | null>>({});
  const [skip, setSkip] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [everyone, setEveryone] = useState(false);
  const busyRef = useRef(false);

  async function load() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const page = await client.seerrRequests(PAGE, skip);
      setRequests((current) => {
        const seen = new Set(current.map((request) => request.id));
        return [...current, ...page.results.filter((request) => !seen.has(request.id))];
      });
      setSkip((value) => value + PAGE);
      setTotal(page.pageInfo.results);
      setError("");
      const found = await Promise.all(page.results.map(async (request) => [`${request.type}:${request.media.tmdbId}`, await lookup(client, request)] as const));
      setTitles((current) => ({ ...current, ...Object.fromEntries(found) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load requests.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (seerr) void load();
  }, [seerr]);

  const more = total === null || skip < total;
  const sentinel = useInfiniteScroll(() => void load(), seerr && total !== null && more && !error, skip);
  const mine = requests.filter((request) => everyone || !request.requestedBy?.jellyfinUserId || request.requestedBy.jellyfinUserId === userId);
  const visible = mine.filter((request) => filter === "all" || requestState(request).group === filter);

  if (!seerr) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Requests</h1>
        </header>
        <p className="empty">Requests need Jellyseerr connected through the Jellyfin Enhanced plugin on your server.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{everyone ? "All requests" : "My requests"}</h1>
          <p>Everything requested through Jellyseerr and where it's at.</p>
        </div>
        {isAdmin ? (
          <div className="chips">
            <button className={everyone ? "" : "on"} onClick={() => setEveryone(false)}>
              Mine
            </button>
            <button className={everyone ? "on" : ""} onClick={() => setEveryone(true)}>
              Everyone
            </button>
          </div>
        ) : null}
      </header>
      <div className="chips">
        {FILTERS.map((option) => (
          <button key={option.id} className={filter === option.id ? "on" : ""} onClick={() => setFilter(option.id)}>
            {option.label}
          </button>
        ))}
      </div>
      {error && requests.length === 0 ? <p className="empty">{error}</p> : null}
      <div className="request-list">
        {visible.map((request) => (
          <RequestRow key={request.id} request={request} title={titles[`${request.type}:${request.media.tmdbId}`]} showUser={everyone} />
        ))}
      </div>
      {!busy && requests.length > 0 && visible.length === 0 && !more ? <p className="empty">No requests match.</p> : null}
      {!busy && total === 0 ? <p className="empty">No requests yet. Find something on the Discover page and request it.</p> : null}
      <div ref={sentinel} className="scroll-sentinel" />
      {busy ? <p className="list-status">Loading…</p> : null}
      {error && requests.length > 0 && !busy ? (
        <button className="btn-ghost load-more" onClick={() => void load()}>
          Couldn't load more. Try again
        </button>
      ) : null}
    </div>
  );
}

function RequestRow({ request, title, showUser }: { request: SeerrRequest; title?: SeerrResult | null; showUser: boolean }) {
  const navigate = useNavigate();
  const state = requestState(request);
  const name = title?.title ?? title?.name ?? (title === undefined ? "Loading…" : `TMDB #${request.media.tmdbId}`);
  const year = (title?.releaseDate ?? title?.firstAirDate ?? "").slice(0, 4);
  const poster = seerrPoster(title?.posterPath, "w185");
  const libraryId = request.media.jellyfinMediaId;
  const playable = Boolean(libraryId) && (request.media.status === 5 || request.media.status === 4);
  const seasons = request.type === "tv" && request.seasons?.length ? `Season${request.seasons.length === 1 ? "" : "s"} ${request.seasons.map((season) => season.seasonNumber).join(", ")}` : "";
  return (
    <button className="request-row" disabled={!playable} onClick={() => playable && navigate(`/item/${libraryId}`)}>
      <span className="request-poster" style={{ background: tile(name) }}>
        {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : null}
      </span>
      <span className="request-copy">
        <strong>
          {name}
          {year ? <small> {year}</small> : null}
        </strong>
        <small>
          {[request.type === "tv" ? "TV" : "Movie", seasons, request.is4k ? "4K" : "", `Requested ${when(request.createdAt)}`, showUser ? `by ${request.requestedBy?.displayName || request.requestedBy?.jellyfinUsername || "someone"}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </small>
        {state.percent !== undefined ? (
          <span className="request-progress">
            <span style={{ width: `${state.percent}%` }} />
          </span>
        ) : null}
      </span>
      <span className={`request-state ${state.tone}`}>
        {state.label}
        {state.eta ? <small>{state.eta}</small> : null}
      </span>
    </button>
  );
}

function requestState(request: SeerrRequest): State {
  if (request.status === 3) return { label: "Declined", tone: "bad", group: "declined" };
  if (request.status === 4) return { label: "Failed", tone: "bad", group: "declined" };
  if (request.media.status === 5) return { label: "Available", tone: "ok", group: "available" };
  if (request.media.status === 4) return { label: "Partly available", tone: "ok", group: "available" };
  const downloads = request.media.downloadStatus ?? [];
  if (downloads.length) {
    const size = downloads.reduce((sum, entry) => sum + (entry.size || 0), 0);
    const left = downloads.reduce((sum, entry) => sum + (entry.sizeLeft || 0), 0);
    const percent = size > 0 ? Math.round(((size - left) / size) * 100) : 0;
    const queued = downloads.every((entry) => entry.status === "queued" || entry.status === "paused");
    const eta = downloads.map((entry) => entry.estimatedCompletionTime).find(Boolean);
    return {
      label: queued && percent === 0 ? "Queued to download" : `Downloading ${percent}%`,
      tone: "info",
      group: "active",
      percent,
      eta: eta ? `Done ${until(eta)}` : undefined,
    };
  }
  if (request.status === 1) return { label: "Waiting for approval", tone: "warn", group: "waiting" };
  return { label: "Approved · finding a release", tone: "info", group: "active" };
}

function when(stamp: string) {
  const date = new Date(stamp);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return "";
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function until(stamp: string) {
  const minutes = Math.round((new Date(stamp).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 1) return "any minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)} days`;
}
