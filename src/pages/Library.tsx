import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Poster } from "../components/Cards";
import { LibraryFilters } from "../components/LibraryFilters";
import { FolderCard, GenreTile, isFolder, ItemRow, LetterRail } from "../components/LibraryViews";
import { useCached } from "../cache";
import { filterCount, filterQuery, letterIndex, loadPrefs, NO_FILTERS, savePrefs, SORTS, type Filters, type Prefs, type Tab } from "../library";
import { useClient, useSession } from "../session";
import { tv } from "../tv";
import type { BaseItem, ItemList } from "../types";
import { useInfiniteScroll } from "../useInfiniteScroll";

const PAGE = 80;
/** Shorter lists scroll faster than a letter can be picked. */
const RAIL_MIN = 40;

type Query = Parameters<ReturnType<typeof useClient>["items"]>[0];

export function Library() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const link = { genre: params.get("genre") || "", studio: params.get("studio") || "" };
  // Each library keeps its own choices, so moving between two starts afresh; so does following another link.
  return <LibraryPage key={`${id}|${link.genre}|${link.studio}`} id={id} link={link} />;
}

/** A genre or studio link (from a title's page) shows just that, without replacing the filters the library remembers. */
function linkedPrefs(saved: Prefs, link: { genre: string; studio: string }): Prefs {
  if (!link.genre && !link.studio) return saved;
  return { ...saved, tab: "items", filters: { ...NO_FILTERS, genres: link.genre ? [link.genre] : [], studios: link.studio ? [link.studio] : [] } };
}

function LibraryPage({ id, link }: { id: string; link: { genre: string; studio: string } }) {
  const client = useClient();
  const navigate = useNavigate();
  const { views } = useSession();
  const library = views.find((view) => view.Id === id);
  const type = library?.CollectionType;
  const include = typesFor(type);
  const video = type !== "music";
  const tabs = tabsFor(type);
  const [saved] = useState(() => loadPrefs(id));
  const linked = Boolean(link.genre || link.studio);
  const [prefs, setPrefs] = useState(() => linkedPrefs(saved, link));
  const [shuffle, setShuffle] = useState(0);
  const [jump, setJump] = useState<{ key: string; letter: string; start: number } | null>(null);
  const [jumping, setJumping] = useState(false);
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder") || "";

  // A linked visit still remembers sort and view, but its filters and tab last only as long as the visit.
  useEffect(() => savePrefs(id, linked ? { ...prefs, filters: saved.filters, tab: saved.tab } : prefs), [id, prefs, linked, saved]);
  const update = (patch: Partial<Prefs>) => setPrefs((current) => ({ ...current, ...patch }));
  const tab: Tab = tabs.some((entry) => entry.id === prefs.tab) ? prefs.tab : "items";
  const sort = SORTS.find((entry) => entry.id === prefs.sort) ?? SORTS[0];
  const descending = sort.id !== "random" && prefs.descending;
  const filters = prefs.filters;
  const filtered = filterCount(filters) > 0;

  let query: Query | null = null;
  if (tab === "items") {
    const extra = filterQuery(filters);
    query = {
      parentId: id,
      includeItemTypes: include,
      sortBy: sort.sortBy,
      sortOrder: descending ? "Descending" : "Ascending",
      filters: extra.filters,
      genres: extra.genres,
      years: extra.years,
      extra: extra.extra,
    };
  } else if (tab === "collections") {
    query = { parentId: id, includeItemTypes: "BoxSet", sortBy: "SortName", sortOrder: "Ascending" };
  } else if (tab === "folders") {
    query = { parentId: folder || id, recursive: false, sortBy: "IsFolder,SortName", sortOrder: "Descending,Ascending" };
  }
  const queryKey = query ? `${id}:${tab}:${JSON.stringify(query)}:${sort.id === "random" && tab === "items" ? shuffle : ""}` : "";
  const start = jump && jump.key === queryKey ? jump.start : 0;
  useEffect(() => {
    // A letter belongs to the list it was picked in; clearing filters later starts from the top.
    setJump((current) => (current && current.key !== queryKey ? null : current));
  }, [queryKey]);
  const list = usePaged(query, queryKey, start, `${tab}:${folder}`);
  const genres = useCached(tab === "genres" ? `genre-tiles:${id}:${include}` : null, () => client.genreTiles(id, include));
  const folderItem = useCached(tab === "folders" && folder ? `folder:${folder}` : null, () => client.item(folder));

  const view = prefs.view;
  const rail = tab === "items" && sort.id === "title" && (list.total ?? 0) > RAIL_MIN;

  function toTop() {
    const main = document.querySelector<HTMLElement>(".main");
    if (main) main.scrollTop = 0;
  }

  function pickSort(next: (typeof SORTS)[number]) {
    if (next.id === "random") {
      setShuffle((value) => value + 1);
      update({ sort: next.id, descending: false });
    } else if (next.id === sort.id) update({ descending: !descending });
    else update({ sort: next.id, descending: next.descending });
  }

  function setFilters(next: Filters) {
    update({ filters: next });
  }

  function openTab(next: Tab) {
    if (next === tab) return;
    update({ tab: next });
    if (folder) setParams({}, { replace: true });
    toTop();
  }

  async function pickLetter(letter: string) {
    if (jumping || !query || list.total === undefined) return;
    const base = query;
    const key = queryKey;
    setJumping(true);
    try {
      const count = async (extra: Record<string, string>) => (await client.items({ ...base, extra: { ...base.extra, ...extra }, limit: 0, slim: true })).TotalRecordCount ?? 0;
      const index = await letterIndex(letter, descending, list.total, count);
      setJump({ key, letter, start: index });
      toTop();
    } catch {
      // The rail stays as it was; picking again retries.
    } finally {
      setJumping(false);
    }
  }

  const noun = nounFor(type, tab);
  const total = list.total;
  let summary = "";
  if (tab === "genres") summary = genres.data ? plural(genres.data.Items.length, "genre") : "";
  else if (total !== undefined) summary = `${plural(total, noun)}${tab === "items" && filtered ? " match" : ""}${start && jump ? ` · from ${jump.letter}` : ""}`;

  const chips = activeFilters(filters, setFilters);

  return (
    <div className="page library-page">
      <header className="page-head">
        <div>
          <h1>{library?.Name ?? "Library"}</h1>
          <p>{summary}</p>
        </div>
        {tabs.length > 1 ? (
          <div className="chips segmented lib-tabs" role="tablist">
            {tabs.map((entry) => (
              <button key={entry.id} role="tab" aria-selected={entry.id === tab} className={entry.id === tab ? "on" : ""} onClick={() => openTab(entry.id)}>
                {entry.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {tab === "items" ? (
        <>
          <div className="filter-bar lib-toolbar">
            <LibraryFilters libraryId={id} include={include} video={video} filters={filters} onChange={setFilters} total={total} />
            <div className="chips lib-sorts">
              {SORTS.map((option) => (
                <button key={option.id} className={option.id === sort.id ? "on" : ""} onClick={() => pickSort(option)} title={option.id === sort.id && option.id !== "random" ? "Reverse the order" : undefined}>
                  {option.label}
                  {option.id === sort.id && option.id !== "random" ? <span className="lib-arrow">{descending ? " ↓" : " ↑"}</span> : null}
                </button>
              ))}
            </div>
            {sort.id !== "random" ? (
              <button className="lib-dir" onClick={() => update({ descending: !descending })} aria-label={`Order: ${descending ? sort.down : sort.up}. Reverse`}>
                {descending ? sort.down : sort.up}
              </button>
            ) : null}
            <span className="lib-spacer" />
            <ViewOptions prefs={prefs} update={update} />
          </div>
          {chips.length ? (
            <div className="chips lib-active">
              {chips.map((chip) => (
                <button
                  key={chip.label}
                  onClick={(event) => {
                    // The pill goes away; a remote carries on from its neighbour, or the Filters button after the last one.
                    const next = chips.length === 1 ? null : event.currentTarget.nextElementSibling;
                    chip.remove();
                    keepFocus(next);
                  }}
                  aria-label={`Remove filter ${chip.label}`}
                >
                  {chip.label} <span aria-hidden>×</span>
                </button>
              ))}
              <button
                className="text-btn"
                onClick={() => {
                  setFilters(NO_FILTERS);
                  keepFocus(null);
                }}
              >
                Clear all
              </button>
            </div>
          ) : null}
        </>
      ) : tab !== "genres" ? (
        <div className="filter-bar lib-toolbar">
          {tab === "folders" && folder ? (
            <button className="lib-up" onClick={() => navigate(-1)}>
              ‹ Back{folderItem.data ? ` · ${folderItem.data.Name}` : ""}
            </button>
          ) : null}
          <span className="lib-spacer" />
          <ViewOptions prefs={prefs} update={update} />
        </div>
      ) : null}

      {tab === "genres" ? (
        <>
          {genres.error ? <p className="empty">{genres.error}</p> : null}
          <div className="library-grid genre-grid">
            {(genres.data?.Items ?? []).map((genre) => (
              <GenreTile
                key={genre.Id}
                genre={genre}
                onOpen={() => {
                  setJump(null);
                  update({ tab: "items", filters: { ...NO_FILTERS, genres: [genre.Name] } });
                  toTop();
                }}
              />
            ))}
          </div>
          {genres.loading && !genres.data ? <p className="empty">Loading…</p> : null}
          {genres.data && genres.data.Items.length === 0 ? <p className="empty">No genres in this library yet.</p> : null}
        </>
      ) : (
        <div className={`lib-body ${rail ? "has-rail" : ""}`}>
          <div className="lib-content">
            {list.error ? <p className="empty">{list.error}</p> : null}
            {view === "list" ? (
              <div className="lib-list">
                {list.items.map((item) => (isFolder(item) ? <ItemRow key={item.Id} item={item} onOpen={() => setParams({ folder: item.Id })} /> : <ItemRow key={item.Id} item={item} />))}
              </div>
            ) : (
              <div className={`poster-grid ${tv ? "" : `size-${prefs.size}`}`}>
                {list.items.map((item) => (isFolder(item) ? <FolderCard key={item.Id} item={item} onOpen={() => setParams({ folder: item.Id })} /> : <Poster key={item.Id} item={item} />))}
              </div>
            )}
            {list.loading && list.items.length === 0 ? <p className="empty">Loading…</p> : null}
            {!list.loading && list.items.length === 0 && !list.error ? (
              <div className="lib-empty">
                <p>{emptyText(tab, filtered, noun)}</p>
                {tab === "items" && filtered ? (
                  <button className="btn-ghost" onClick={() => setFilters(NO_FILTERS)}>
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : null}
            <div ref={list.sentinel} className="scroll-sentinel" />
            {list.loadingMore ? <p className="list-status">Loading…</p> : null}
            {list.moreError ? (
              <button className="btn-ghost load-more" onClick={list.retry}>
                Couldn't load more. Try again
              </button>
            ) : null}
          </div>
          {rail ? <LetterRail active={jump && jump.key === queryKey ? jump.letter : ""} onPick={(letter) => void pickLetter(letter)} /> : null}
        </div>
      )}
    </div>
  );
}

function ViewOptions({ prefs, update }: { prefs: Prefs; update: (patch: Partial<Prefs>) => void }) {
  return (
    <>
      {!tv && prefs.view === "grid" ? (
        <div className="chips segmented lib-size" aria-label="Poster size">
          {(["s", "m", "l"] as const).map((size) => (
            <button key={size} className={prefs.size === size ? "on" : ""} onClick={() => update({ size })} aria-label={`${size === "s" ? "Small" : size === "m" ? "Medium" : "Large"} posters`}>
              {size.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}
      <div className="chips segmented lib-view" aria-label="View">
        <button className={prefs.view === "grid" ? "on" : ""} onClick={() => update({ view: "grid" })}>
          Grid
        </button>
        <button className={prefs.view === "list" ? "on" : ""} onClick={() => update({ view: "list" })}>
          List
        </button>
      </div>
    </>
  );
}

/** The first page comes from the cache like any other screen; later pages load as the end nears. */
function usePaged(query: Query | null, queryKey: string, start: number, group: string) {
  const client = useClient();
  const key = query ? `library:${queryKey}:${start}` : null;
  const { data, error, loading } = useCached(key, () => client.items({ ...query!, startIndex: start, limit: PAGE, slim: true }));
  const [more, setMore] = useState<BaseItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [ended, setEnded] = useState(false);
  const loadingRef = useRef(false);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    setMore([]);
    setMoreError(false);
    setEnded(false);
  }, [key]);

  // Until a new first page arrives the last one stays up, so the grid and the
  // letter rail don't vanish from under a remote's focus on every change.
  const last = useRef<{ group: string; data: ItemList } | null>(null);
  // Recorded only when a page arrives: just after a change `data` is still the previous key's for a render.
  useEffect(() => {
    if (data) last.current = { group, data };
  }, [data]);
  const page = data ?? (loading && last.current?.group === group ? last.current.data : undefined);
  const items = [...(page?.Items ?? []), ...more];
  const total = page ? (page.TotalRecordCount ?? items.length) : undefined;

  async function loadMore() {
    if (loadingRef.current || !query) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const requestKey = key;
    try {
      const page = await client.items({ ...query, startIndex: start + items.length, limit: PAGE, slim: true });
      if (requestKey !== keyRef.current) return;
      const seen = new Set(items.map((item) => item.Id));
      const fresh = (page.Items ?? []).filter((item) => !seen.has(item.Id));
      if (fresh.length === 0) setEnded(true);
      setMore((current) => [...current, ...fresh]);
    } catch {
      if (requestKey === keyRef.current) setMoreError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }

  const sentinel = useInfiniteScroll(() => void loadMore(), Boolean(data) && total !== undefined && start + items.length < total && !moreError && !ended, items.length);
  const retry = () => {
    setMoreError(false);
    void loadMore();
  };
  return { items, total, error, loading, loadingMore, moreError, sentinel, retry };
}

function activeFilters(filters: Filters, set: (next: Filters) => void) {
  const chips: { label: string; remove: () => void }[] = [];
  const patch = (change: Partial<Filters>) => () => set({ ...filters, ...change });
  const status = { unplayed: "Unwatched", played: "Watched", resumable: "In progress", "": "" }[filters.status];
  if (status) chips.push({ label: status, remove: patch({ status: "" }) });
  if (filters.favorites) chips.push({ label: "Favorites", remove: patch({ favorites: false }) });
  if (filters.resolution) chips.push({ label: filters.resolution === "4k" ? "4K" : filters.resolution.toUpperCase(), remove: patch({ resolution: "" }) });
  if (filters.subtitles) chips.push({ label: "Has subtitles", remove: patch({ subtitles: false }) });
  for (const genre of filters.genres) chips.push({ label: genre, remove: patch({ genres: filters.genres.filter((entry) => entry !== genre) }) });
  for (const rating of filters.ratings) chips.push({ label: `Rated ${rating}`, remove: patch({ ratings: filters.ratings.filter((entry) => entry !== rating) }) });
  for (const studio of filters.studios) chips.push({ label: studio, remove: patch({ studios: filters.studios.filter((entry) => entry !== studio) }) });
  for (const tag of filters.tags) chips.push({ label: `Tag: ${tag}`, remove: patch({ tags: filters.tags.filter((entry) => entry !== tag) }) });
  if (filters.yearFrom || filters.yearTo) {
    const label = filters.yearFrom && filters.yearTo ? `${Math.min(filters.yearFrom, filters.yearTo)}–${Math.max(filters.yearFrom, filters.yearTo)}` : filters.yearFrom ? `${filters.yearFrom} and later` : `Up to ${filters.yearTo}`;
    chips.push({ label, remove: patch({ yearFrom: 0, yearTo: 0 }) });
  }
  return chips;
}

function keepFocus(next: Element | null) {
  requestAnimationFrame(() => {
    const target = next instanceof HTMLElement && next.isConnected ? next : document.querySelector<HTMLElement>(".lf-button");
    target?.focus({ preventScroll: true });
  });
}

function plural(count: number, noun: string) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function nounFor(collectionType: string | undefined, tab: Tab) {
  if (tab === "collections") return "collection";
  if (tab === "folders") return "item";
  if (collectionType === "movies") return "movie";
  if (collectionType === "tvshows") return "show";
  return "title";
}

function emptyText(tab: Tab, filtered: boolean, noun: string) {
  if (tab === "collections") return "No collections yet. Collections group related movies, such as a film series, and are made on the server.";
  if (tab === "folders") return "This folder is empty.";
  if (filtered) return `No ${noun}s match these filters.`;
  return `There are no ${noun}s in this library yet.`;
}

function tabsFor(collectionType?: string): { id: Tab; label: string }[] {
  if (collectionType === "movies")
    return [
      { id: "items", label: "Movies" },
      { id: "collections", label: "Collections" },
      { id: "genres", label: "Genres" },
    ];
  if (collectionType === "tvshows")
    return [
      { id: "items", label: "Shows" },
      { id: "genres", label: "Genres" },
    ];
  if (collectionType === "music" || collectionType === "boxsets") return [];
  return [
    { id: "items", label: "All" },
    { id: "folders", label: "Folders" },
  ];
}

function typesFor(collectionType?: string) {
  if (collectionType === "movies") return "Movie";
  if (collectionType === "tvshows") return "Series";
  if (collectionType === "music") return "MusicAlbum,Audio";
  if (collectionType === "boxsets") return "BoxSet";
  return "Movie,Series,Video";
}
