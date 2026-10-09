import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Poster } from "../components/Cards";
import { useCached } from "../cache";
import { useClient, useSession } from "../session";
import type { BaseItem } from "../types";
import { useInfiniteScroll } from "../useInfiniteScroll";

const SORTS = [
  { id: "title", label: "Title", sortBy: "SortName", sortOrder: "Ascending" },
  { id: "added", label: "Date added", sortBy: "DateCreated", sortOrder: "Descending" },
  { id: "released", label: "Release date", sortBy: "PremiereDate,ProductionYear", sortOrder: "Descending" },
  { id: "rating", label: "Rating", sortBy: "CommunityRating", sortOrder: "Descending" },
  { id: "random", label: "Random", sortBy: "Random", sortOrder: "Ascending" },
];

const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950];

function decadeYears(decade: number) {
  return Array.from({ length: 10 }, (_, index) => decade + index).join(",");
}

export function Library() {
  const { id = "" } = useParams();
  const client = useClient();
  const { views } = useSession();
  const library = views.find((view) => view.Id === id);
  const [sort, setSort] = useState(SORTS[0]);
  const [unplayed, setUnplayed] = useState(false);
  const [favorites, setFavorites] = useState(false);
  const [genre, setGenre] = useState("");
  const [decade, setDecade] = useState(0);
  const [shuffle, setShuffle] = useState(0);
  const [more, setMore] = useState<BaseItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [ended, setEnded] = useState(false);
  const loadingRef = useRef(false);

  const include = typesFor(library?.CollectionType);
  const genreList = useCached(`genres:${id}:${include}`, () => client.genres(id, include));
  const filters = [unplayed ? "IsUnplayed" : "", favorites ? "IsFavorite" : ""].filter(Boolean).join(",") || undefined;
  const query = {
    parentId: id,
    includeItemTypes: include,
    sortBy: sort.sortBy,
    sortOrder: sort.sortOrder,
    filters,
    genres: genre || undefined,
    years: decade ? decadeYears(decade) : undefined,
  };
  const key = `library:${id}:${include}:${sort.id}:${filters}:${genre}:${decade}:${sort.id === "random" ? shuffle : ""}`;
  const { data, error, loading } = useCached(key, () => client.items({ ...query, limit: 80, slim: true }));
  useEffect(() => {
    setMore([]);
    setMoreError(false);
    setEnded(false);
  }, [key]);
  const items = [...(data?.Items ?? []), ...more];
  const total = data?.TotalRecordCount ?? items.length;
  const filtered = Boolean(filters || genre || decade);

  async function loadMore() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const requestKey = key;
    try {
      const list = await client.items({ ...query, startIndex: items.length, limit: 80, slim: true });
      if (requestKey !== keyRef.current) return;
      const seen = new Set(items.map((item) => item.Id));
      const fresh = (list.Items ?? []).filter((item) => !seen.has(item.Id));
      if (fresh.length === 0) setEnded(true);
      setMore((current) => [...current, ...fresh]);
    } catch {
      setMoreError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }

  const keyRef = useRef(key);
  keyRef.current = key;
  const sentinel = useInfiniteScroll(() => void loadMore(), Boolean(data) && items.length < total && !moreError && !ended, items.length);

  function pickSort(option: (typeof SORTS)[number]) {
    if (option.id === "random") setShuffle((value) => value + 1);
    setSort(option);
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{library?.Name ?? "Library"}</h1>
          <p>{total ? `${total} titles` : ""}</p>
        </div>
        <div className="chips">
          {SORTS.map((option) => (
            <button key={option.id} className={option.id === sort.id ? "on" : ""} onClick={() => pickSort(option)}>
              {option.label}
            </button>
          ))}
        </div>
      </header>
      <div className="filter-bar">
        <div className="chips">
          <button className={unplayed ? "on" : ""} onClick={() => setUnplayed((value) => !value)}>
            Unwatched
          </button>
          <button className={favorites ? "on" : ""} onClick={() => setFavorites((value) => !value)}>
            Favorites
          </button>
        </div>
        <select value={genre} onChange={(event) => setGenre(event.target.value)} aria-label="Genre">
          <option value="">All genres</option>
          {(genreList.data?.Items ?? []).map((entry) => (
            <option key={entry.Id} value={entry.Name}>
              {entry.Name}
            </option>
          ))}
        </select>
        <select value={decade} onChange={(event) => setDecade(Number(event.target.value))} aria-label="Decade">
          <option value={0}>Any year</option>
          {DECADES.map((value) => (
            <option key={value} value={value}>
              {value}s
            </option>
          ))}
        </select>
        {filtered ? (
          <button
            className="text-btn"
            onClick={() => {
              setUnplayed(false);
              setFavorites(false);
              setGenre("");
              setDecade(0);
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      {error ? <p className="empty">{error}</p> : null}
      <div className="poster-grid">
        {items.map((item) => (
          <Poster key={item.Id} item={item} />
        ))}
      </div>
      {loading && items.length === 0 ? <p className="empty">Loading…</p> : null}
      {!loading && items.length === 0 && !error ? <p className="empty">Nothing in this library matches.</p> : null}
      <div ref={sentinel} className="scroll-sentinel" />
      {loadingMore ? <p className="list-status">Loading…</p> : null}
      {moreError && items.length < total ? (
        <button
          className="btn-ghost load-more"
          onClick={() => {
            setMoreError(false);
            void loadMore();
          }}
        >
          Couldn't load more. Try again
        </button>
      ) : null}
    </div>
  );
}

function typesFor(collectionType?: string) {
  if (collectionType === "movies") return "Movie";
  if (collectionType === "tvshows") return "Series";
  if (collectionType === "music") return "MusicAlbum,Audio";
  return "Movie,Series,Video";
}
