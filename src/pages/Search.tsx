import { useEffect, useState } from "react";
import { Poster, Row, WideCard } from "../components/Cards";
import { markRequested, SeerrCard, useSeerrPicker } from "../components/RequestSheet";
import { useClient, useSession } from "../session";
import type { BaseItem, SeerrResult } from "../types";

type Results = { movies: BaseItem[]; shows: BaseItem[]; episodes: BaseItem[]; other: BaseItem[] };

const EMPTY: Results = { movies: [], shows: [], episodes: [], other: [] };

export function Search() {
  const client = useClient();
  const session = useSession();
  const [term, setTerm] = useState(() => sessionStorage.getItem("finplay.search") ?? "");
  const [results, setResults] = useState<Results>(EMPTY);
  const [remote, setRemote] = useState<SeerrResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const picker = useSeerrPicker((mediaType, id) => setRemote((current) => markRequested(current, mediaType, id)));

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

  const { movies, shows, episodes, other } = results;
  const nothing = movies.length + shows.length + episodes.length + other.length + remote.length === 0;

  return (
    <div className="page search-page">
      <input className="search-input" autoFocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search movies, shows and episodes" />
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
      {remote.length > 0 ? (
        <Row title="From Jellyseerr">
          {remote.map((result) => (
            <SeerrCard key={`${result.mediaType}-${result.id}`} result={result} onOpen={picker.open} />
          ))}
        </Row>
      ) : null}
      {picker.sheet}
    </div>
  );
}
