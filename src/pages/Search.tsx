import { useEffect, useState } from "react";
import { Poster, Row, WideCard } from "../components/Cards";
import { markRequested, SeerrCard, useSeerrPicker } from "../components/RequestSheet";
import { useCached } from "../cache";
import type { Jellyfin } from "../jellyfin";
import { useClient, useSession } from "../session";
import type { BaseItem, SeerrResult } from "../types";

type Results = { movies: BaseItem[]; shows: BaseItem[]; episodes: BaseItem[]; other: BaseItem[] };

const EMPTY: Results = { movies: [], shows: [], episodes: [], other: [] };
const RECENT_KEY = "finplay.recentSearches";
const RECENT_MAX = 8;
const SUGGEST_MAX_AGE = 20 * 60 * 1000;
const SUGGEST_LIMIT = 18;

function loadRecent(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((value): value is string => typeof value === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/**
 * Random unwatched, well-rated titles. `/Items/Suggestions` picks much the same
 * but can't trim its fields, so it answers several times slower and larger.
 */
async function suggestions(client: Jellyfin) {
  const pick = (includeItemTypes: string) =>
    client
      .items({ slim: true, includeItemTypes, filters: "IsUnplayed", sortBy: "Random", limit: SUGGEST_LIMIT, extra: { MinCommunityRating: "6.5", EnableTotalRecordCount: "false" } })
      .then((list) => list.Items ?? [])
      .catch(() => [] as BaseItem[]);
  const [movies, shows] = await Promise.all([pick("Movie"), pick("Series")]);
  return { movies, shows };
}

export function Search() {
  const client = useClient();
  const session = useSession();
  const [term, setTerm] = useState(() => sessionStorage.getItem("finplay.search") ?? "");
  const [results, setResults] = useState<Results>(EMPTY);
  const [remote, setRemote] = useState<SeerrResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const picker = useSeerrPicker((mediaType, id) => setRemote((current) => markRequested(current, mediaType, id)));
  const [recent, setRecent] = useState(loadRecent);
  const suggested = useCached(`search-suggest:${session.userId}`, () => suggestions(client), { maxAge: SUGGEST_MAX_AGE, persist: true });
  const idle = term.trim().length < 2;

  const saveRecent = (next: string[]) => {
    setRecent(next);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  };
  const remember = () => {
    const query = term.trim();
    if (query.length >= 2) saveRecent([query, ...recent.filter((value) => value.toLowerCase() !== query.toLowerCase())].slice(0, RECENT_MAX));
  };

  useEffect(() => {
    const query = term.trim();
    sessionStorage.setItem("finplay.search", term);
    if (query.length < 2) {
      setResults(EMPTY);
      setRemote([]);
      setSearching(false);
      return;
    }
    let cancel = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      const list = (types: string, limit?: number) => client.search(query, types, limit).then((found) => found.Items ?? []);
      Promise.all([list("Movie"), list("Series"), list("Episode", 30), list("BoxSet,MusicAlbum,Audio", 18)])
        .then(([movies, shows, episodes, other]) => {
          if (cancel) return;
          setResults({ movies, shows, episodes, other });
          setError("");
        })
        .catch((err: unknown) => {
          if (!cancel) setError(err instanceof Error ? err.message : "Search failed.");
        })
        .finally(() => {
          if (!cancel) setSearching(false);
        });
      if (session.seerr) {
        client
          .seerrSearch(query)
          .then((found) => {
            if (!cancel) setRemote((found.results ?? []).filter((result) => result.mediaType === "movie" || result.mediaType === "tv"));
          })
          .catch(() => {
            if (!cancel) setRemote([]);
          });
      }
    }, 260);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [client, session.seerr, term]);

  const { movies, shows, episodes, other } = idle ? EMPTY : results;
  const requestable = idle ? [] : remote;
  const nothing = movies.length + shows.length + episodes.length + other.length + requestable.length === 0;

  return (
    <div
      className="page search-page"
      onClickCapture={(event) => {
        if (!idle && event.target instanceof Element && event.target.closest(".row")) remember();
      }}
    >
      <input
        className="search-input"
        autoFocus
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => {
          // The box spans the page, so spatial focus would land mid-row; start rows at their first card.
          if (event.key !== "ArrowDown" || !document.documentElement.hasAttribute("data-couch")) return;
          const first = document.querySelector<HTMLElement>(".search-page .row .chips button, .search-page .row .row-track button");
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        placeholder="Search movies, shows and episodes"
      />
      {idle ? (
        <>
          {recent.length > 0 ? (
            <section className="row search-recent">
              <div className="row-head">
                <div>
                  <h2>Recent searches</h2>
                </div>
                <button onClick={() => saveRecent([])} className="text-btn">
                  Clear
                </button>
              </div>
              <div className="chips">
                {recent.map((value) => (
                  <button key={value} onClick={() => setTerm(value)}>
                    {value}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {suggested.data?.movies.length ? (
            <Row title="Movies to try" subtitle="Highly rated movies you haven't seen">
              {suggested.data.movies.map((item) => (
                <Poster key={item.Id} item={item} subtitle={item.ProductionYear ? String(item.ProductionYear) : undefined} />
              ))}
            </Row>
          ) : null}
          {suggested.data?.shows.length ? (
            <Row title="Shows to try" subtitle="Highly rated series you haven't finished">
              {suggested.data.shows.map((item) => (
                <Poster key={item.Id} item={item} subtitle={item.ProductionYear ? String(item.ProductionYear) : undefined} />
              ))}
            </Row>
          ) : null}
        </>
      ) : null}
      {error ? <p className="empty">{error}</p> : null}
      {term.trim().length >= 2 && nothing && !searching && !error ? <p className="empty">No matches.</p> : null}
      {movies.length > 0 ? (
        <Row title="Movies">
          {movies.map((item) => (
            <Poster key={item.Id} item={item} subtitle={item.ProductionYear ? String(item.ProductionYear) : undefined} />
          ))}
        </Row>
      ) : null}
      {shows.length > 0 ? (
        <Row title="Shows">
          {shows.map((item) => (
            <Poster key={item.Id} item={item} subtitle={item.ProductionYear ? String(item.ProductionYear) : undefined} />
          ))}
        </Row>
      ) : null}
      {episodes.length > 0 ? (
        <Row title="Episodes">
          {episodes.map((item) => (
            <WideCard key={item.Id} item={item} />
          ))}
        </Row>
      ) : null}
      {other.length > 0 ? (
        <Row title="Collections & music">
          {other.map((item) => (
            <Poster key={item.Id} item={item} subtitle={item.ProductionYear ? String(item.ProductionYear) : undefined} />
          ))}
        </Row>
      ) : null}
      {requestable.length > 0 ? (
        <Row title="From Jellyseerr">
          {requestable.map((result) => (
            <SeerrCard key={`${result.mediaType}-${result.id}`} result={result} onOpen={picker.open} />
          ))}
        </Row>
      ) : null}
      {picker.sheet}
    </div>
  );
}
