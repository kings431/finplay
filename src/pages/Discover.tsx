import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteScroll } from "../useInfiniteScroll";
import { Row } from "../components/Cards";
import { markRequested, SeerrCard, useSeerrPicker } from "../components/RequestSheet";
import { useCached } from "../cache";
import { useClient, useSession } from "../session";
import type { SeerrResult } from "../types";
import { Calendar } from "./Calendar";

export const DISCOVER_LISTS = [
  { slug: "trending", path: "trending", title: "Trending" },
  { slug: "movies", path: "movies", title: "Popular movies" },
  { slug: "upcoming-movies", path: "movies/upcoming", title: "Upcoming movies" },
  { slug: "shows", path: "tv", title: "Popular shows" },
  { slug: "upcoming-shows", path: "tv/upcoming", title: "Upcoming shows" },
];

function playable(results: SeerrResult[] | undefined) {
  return (results ?? []).filter((result) => result.mediaType === "movie" || result.mediaType === "tv");
}

export function Discover() {
  const client = useClient();
  const session = useSession();
  const [patched, setPatched] = useState<Record<string, SeerrResult[]>>({});
  const { data, error, loading } = useCached(session.seerr ? `discover:${session.userId}` : null, async () => {
    const lists = await Promise.all(
      DISCOVER_LISTS.map((list) =>
        client
          .seerrDiscover(list.path)
          .then((found) => playable(found.results))
          .catch(() => [] as SeerrResult[]),
      ),
    );
    if (lists.every((list) => list.length === 0)) throw new Error("Jellyseerr did not return anything to discover.");
    return Object.fromEntries(DISCOVER_LISTS.map((list, index) => [list.slug, lists[index]]));
  });
  useEffect(() => setPatched({}), [data]);
  const rows = { ...data, ...patched };
  const picker = useSeerrPicker((mediaType, id) =>
    setPatched((current) =>
      Object.fromEntries(Object.entries({ ...data, ...current }).map(([slug, list]) => [slug, markRequested(list, mediaType, id)])),
    ),
  );

  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "calendar" || !session.seerr ? "calendar" : "browse";
  const show = (next: "browse" | "calendar") => setParams(next === "calendar" ? { view: "calendar" } : {}, { replace: true });

  return (
    <div className="page discover-page">
      <header className="page-head">
        <div>
          <h1>Discover</h1>
          <p>{view === "calendar" ? "New episodes and movies on the way." : "Find something new and request it."}</p>
        </div>
        <div className="discover-head-actions">
          <div className="chips segmented">
            <button className={view === "browse" ? "on" : ""} onClick={() => show("browse")} disabled={!session.seerr}>
              Browse
            </button>
            <button className={view === "calendar" ? "on" : ""} onClick={() => show("calendar")}>
              Calendar
            </button>
          </div>
          {session.seerr ? (
            <Link className="btn-ghost" to="/requests">
              My requests
            </Link>
          ) : null}
        </div>
      </header>
      {view === "calendar" ? <Calendar /> : <Browse rows={rows} error={error} loading={loading && !data} onOpen={picker.open} />}
      {picker.sheet}
    </div>
  );
}

function Browse({ rows, error, loading, onOpen }: { rows: Record<string, SeerrResult[]>; error?: string; loading: boolean; onOpen: (result: SeerrResult) => void }) {
  return (
    <>
      {error ? <p className="empty">{error}</p> : null}
      {loading ? <p className="empty">Loading…</p> : null}
      {DISCOVER_LISTS.map((list) =>
        rows[list.slug]?.length ? (
          <Row key={list.slug} title={list.title} action={{ label: "See all", to: `/discover/${list.slug}` }}>
            {rows[list.slug].map((result) => (
              <SeerrCard key={`${result.mediaType}-${result.id}`} result={result} onOpen={onOpen} />
            ))}
          </Row>
        ) : null,
      )}
    </>
  );
}

export function DiscoverList() {
  const { slug = "" } = useParams();
  const client = useClient();
  const list = DISCOVER_LISTS.find((entry) => entry.slug === slug) ?? DISCOVER_LISTS[0];
  const [results, setResults] = useState<SeerrResult[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const picker = useSeerrPicker((mediaType, id) => setResults((current) => markRequested(current, mediaType, id)));

  async function load(next: number, reset: boolean) {
    busyRef.current = true;
    setBusy(true);
    try {
      const found = await client.seerrDiscover(list.path, next);
      setResults((current) => {
        const merged = reset ? [] : current;
        const seen = new Set(merged.map((result) => `${result.mediaType}-${result.id}`));
        return [...merged, ...playable(found.results).filter((result) => !seen.has(`${result.mediaType}-${result.id}`))];
      });
      setPage(next);
      setPages(found.totalPages ?? next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this list.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    setResults([]);
    setPage(0);
    void load(1, true);
  }, [list.path]);

  const sentinel = useInfiniteScroll(
    () => {
      if (!busyRef.current && !error) void load(page + 1, false);
    },
    page > 0 && page < pages && !error,
    page,
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{list.title}</h1>
          <p>From Jellyseerr</p>
        </div>
      </header>
      {error && results.length === 0 ? <p className="empty">{error}</p> : null}
      <div className="poster-grid">
        {results.map((result) => (
          <SeerrCard key={`${result.mediaType}-${result.id}`} result={result} onOpen={picker.open} />
        ))}
      </div>
      <div ref={sentinel} className="scroll-sentinel" />
      {busy ? <p className="list-status">Loading…</p> : null}
      {error && results.length > 0 && !busy ? (
        <button className="btn-ghost load-more" onClick={() => void load(page + 1, false)}>
          Couldn't load more. Try again
        </button>
      ) : null}
      {!busy && page > 0 && page >= pages && results.length > 0 ? <p className="list-status">That's everything.</p> : null}
      {picker.sheet}
    </div>
  );
}
