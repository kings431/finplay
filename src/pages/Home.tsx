import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Poster, RankCard, Row, WideCard } from "../components/Cards";
import { markRequested, SeerrCard, useSeerrPicker } from "../components/RequestSheet";
import { IconInfo, IconPlay } from "../icons";
import { backdropUrl, episodeCode, formatRuntime, logoUrl } from "../media";
import { usePlayback } from "../playback";
import { useCached } from "../cache";
import { useClient, useSession } from "../session";
import type { Jellyfin } from "../jellyfin";
import { loadSettings } from "../settings";
import { tv } from "../tv";
import type { BaseItem, HeroSource, ItemList, SeerrResult, Settings } from "../types";

const BROWSE = "Movie,Series";
/** Rows never page, and counting matches can double a query's time on a big library. */
const NO_COUNT = { EnableTotalRecordCount: "false" };
const DECADES = [1970, 1980, 1990, 2000, 2010];
const GENRE_ROWS = 6;
const DISCOVERY_MAX_AGE = 20 * 60 * 1000;
/** Ratings barely move, and sorting the whole library by them is the slowest query on Home. */
const TOP_MAX_AGE = 6 * 60 * 60 * 1000;
const HERO_INTERVAL = 7000;
const HERO_COUNT = 8;
const HERO_LEAD: Partial<Record<HeroSource, number>> = { resume: 2, nextUp: 1 };
/** Quiet time after the last wheel event that ends a swipe gesture. */
const SWIPE_SETTLE = 150;
/** Shortest time between two swipe steps. */
const SWIPE_MIN_GAP = 180;

type HomeRow = {
  key: string;
  title: string;
  subtitle?: string;
  kind?: "poster" | "rank";
  items: BaseItem[];
  min?: number;
};

/** Remounting Home (coming back from another page) keeps the same highlights and position. */
let heroMemory: { key: string; heroes: BaseItem[]; index: number } | null = null;

export function Home() {
  const client = useClient();
  const session = useSession();
  const [{ heroSources, heroTypes, heroAutoAdvance }] = useState(loadSettings);
  const wantPicks = heroSources.includes("picks");
  const wantFavorites = heroSources.includes("favorites");
  const heroKey = `${session.userId}:${heroSources.join(",")}:${heroTypes}`;
  const { data, error, loading } = useCached(`home:${session.userId}:${heroTypes}:${wantPicks ? "p" : ""}${wantFavorites ? "f" : ""}`, async () => {
    const [resumeList, nextList, latestMovies, latestShows, picks, favorites] = await Promise.all([
      client.resume(),
      client.nextUp(),
      client.latest(undefined, "Movie"),
      client.latest(undefined, "Series"),
      wantPicks ? heroPicks(client, heroTypes) : Promise.resolve([]),
      wantFavorites ? heroFavorites(client, heroTypes) : Promise.resolve([]),
    ]);
    return {
      resume: resumeList.Items ?? [],
      nextUp: nextList.Items ?? [],
      movies: latestMovies ?? [],
      shows: latestShows ?? [],
      picks,
      favorites,
    };
  }, { persist: true });
  const resume = data?.resume ?? [];
  const nextUp = data?.nextUp ?? [];
  const movies = data?.movies ?? [];
  const shows = data?.shows ?? [];
  const more = useCached(`home-more:${session.userId}`, () => discoveryRows(client), { maxAge: DISCOVERY_MAX_AGE, persist: true });
  const topTen = useCached(`home-top:${session.userId}`, () => topRow(client), { maxAge: TOP_MAX_AGE, persist: true });
  const discover = useCached(session.seerr ? `home-discover:${session.userId}` : null, () =>
    client.seerrDiscover("trending").then((found) => (found.results ?? []).filter((result) => result.mediaType === "movie" || result.mediaType === "tv")),
  );
  const [requested, setRequested] = useState<SeerrResult[] | null>(null);
  useEffect(() => setRequested(null), [discover.data]);
  const trending = requested ?? discover.data ?? [];
  const picker = useSeerrPicker((mediaType, id) => setRequested(markRequested(trending, mediaType, id)));

  const heroFrom: Record<HeroSource, BaseItem[]> = {
    resume,
    nextUp,
    picks: data?.picks ?? [],
    latest: interleave(movies, shows),
    favorites: data?.favorites ?? [],
  };
  // Alone, a source may fill the hero; mixed, watching rows only lead it off.
  const heroCap = (source: HeroSource) => (heroSources.length === 1 ? HERO_COUNT : HERO_LEAD[source] ?? HERO_COUNT);
  const candidates = dedupe(heroSources.flatMap((source) => heroFrom[source].filter((item) => heroType(item, heroTypes)).slice(0, heroCap(source))))
    .filter((item) => item.BackdropImageTags?.length || item.ParentBackdropImageTags?.length)
    .slice(0, HERO_COUNT);

  const movieLibrary = session.views.find((view) => view.CollectionType === "movies");
  const showLibrary = session.views.find((view) => view.CollectionType === "tvshows");
  const top = topTen.data && topTen.data.items.length >= 5 ? topTen.data : undefined;
  const rows = (more.data ?? []).filter((row) => row.key !== "top");

  const sections = [
    resume.length > 0 ? (
      <Row key="home-resume" title="Continue watching">
        {resume.map((item) => (
          <WideCard key={item.Id} item={item} />
        ))}
      </Row>
    ) : null,
    top ? <HomeRowView key="home-top" row={top} /> : null,
    nextUp.length > 0 ? (
      <Row key="home-next" title="Next up">
        {nextUp.map((item) => (
          <WideCard key={item.Id} item={item} />
        ))}
      </Row>
    ) : null,
    movies.length > 0 ? (
      <Row key="home-movies" title="Recently added movies" action={movieLibrary ? { label: "See all", to: `/library/${movieLibrary.Id}` } : undefined}>
        {movies.map((item) => (
          <Poster key={item.Id} item={item} />
        ))}
      </Row>
    ) : null,
    shows.length > 0 ? (
      <Row key="home-shows" title="Recently added shows" action={showLibrary ? { label: "See all", to: `/library/${showLibrary.Id}` } : undefined}>
        {shows.map((item) => (
          <Poster key={item.Id} item={item} />
        ))}
      </Row>
    ) : null,
    ...rows.slice(0, 4).map((row) => <HomeRowView key={row.key} row={row} />),
    trending.length > 0 ? (
      <Row key="home-discover" title="Discover" subtitle="Not on your server yet. Request it." action={{ label: "See all", to: "/discover" }}>
        {trending.map((result) => (
          <SeerrCard key={`${result.mediaType}-${result.id}`} result={result} onOpen={picker.open} />
        ))}
      </Row>
    ) : null,
    ...rows.slice(4).map((row) => <HomeRowView key={row.key} row={row} />),
  ].filter(Boolean);

  return (
    <div className="home">
      <HeroCarousel heroKey={heroKey} candidates={candidates} loading={loading} autoAdvance={heroAutoAdvance} />
      {error ? <p className="empty">{error}</p> : null}
      {tv ? <LaterRows>{sections}</LaterRows> : sections}
      {picker.sheet}
    </div>
  );
}

/** Rows mounted on a TV before any more wait for the page to scroll near them. */
const TV_ROWS = 4;
const TV_ROWS_STEP = 3;

/** A TV styles and keeps every card on the page, and Home has hundreds, so
 * there rows mount a few at a time as the page scrolls toward them. */
function LaterRows({ children }: { children: ReactNode[] }) {
  const [count, setCount] = useState(TV_ROWS);
  const grow = useCallback(() => setCount((current) => current + TV_ROWS_STEP), []);
  return (
    <>
      {children.slice(0, count)}
      {children.length > count ? <NearEnd key={count} onNear={grow} /> : null}
    </>
  );
}

/** Calls `onNear` once the page has scrolled within a screen of this point. */
function NearEnd({ onNear }: { onNear: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        onNear();
      },
      { root: element.closest(".main"), rootMargin: "0px 0px 100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onNear]);
  return <div ref={ref} style={{ height: 1 }} aria-hidden />;
}

/** Its own component so a highlight changing, or scrolling out of view,
 * doesn't re-render every row of cards below it. */
function HeroCarousel({ heroKey, candidates, loading, autoAdvance }: { heroKey: string; candidates: BaseItem[]; loading: boolean; autoAdvance: boolean }) {
  const { play, busy } = usePlayback();
  const navigate = useNavigate();
  const [paused, setPaused] = useState(false);
  const remembered = heroMemory?.key === heroKey ? heroMemory : null;
  const [heroIndex, setHeroIndex] = useState(remembered?.index ?? 0);
  const [heroes, setHeroes] = useState<BaseItem[]>(() => remembered?.heroes ?? candidates);
  useEffect(() => {
    if (heroes.length === 0 && candidates.length > 0) setHeroes(candidates);
  }, [heroes.length, candidates.length]);
  useEffect(() => {
    if (heroes.length) heroMemory = { key: heroKey, heroes, index: heroIndex };
  }, [heroKey, heroes, heroIndex]);
  const hero = heroes[heroIndex] ?? heroes[0];
  const stepHero = (delta: number) => {
    if (heroes.length <= 1) return;
    setHeroIndex((current) => (current + delta + heroes.length) % heroes.length);
    setPaused(true);
  };
  // A trackpad swipe sends dozens of wheel events plus momentum; step once per gesture.
  const swipe = useRef<{ locked: boolean; peak: number; floor: number; at: number; timer?: number }>({
    locked: false,
    peak: 0,
    floor: Infinity,
    at: 0,
  });
  useEffect(() => () => window.clearTimeout(swipe.current.timer), []);
  // Swapping in the next full-size backdrop stalls a TV for a moment, which is
  // only worth it while the hero is on screen.
  const carousel = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const element = carousel.current;
    if (!tv || !element) return;
    const observer = new IntersectionObserver(([entry]) => setOffscreen(!entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A TV redraws the whole screen for every frame of the dot's progress bar,
  // so there a plain timer moves the highlights on instead.
  useEffect(() => {
    if (!tv || !autoAdvance || paused || offscreen || heroes.length <= 1) return;
    const timer = window.setTimeout(() => setHeroIndex((current) => (current + 1) % heroes.length), HERO_INTERVAL);
    return () => window.clearTimeout(timer);
  }, [autoAdvance, paused, offscreen, heroes.length, heroIndex]);

  return (
    <div
      ref={carousel}
      className={`hero-carousel${paused || offscreen ? " paused" : ""}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onWheel={(event) => {
        if (heroes.length <= 1) return;
        const state = swipe.current;
        const speed = Math.abs(event.deltaX);
        const horizontal = speed > Math.abs(event.deltaY) && speed > 8;
        const now = performance.now();
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(() => (state.locked = false), SWIPE_SETTLE);
        if (state.locked) {
          // Momentum only slows down, and WebKit's merged events jitter, so a
          // new flick must climb well above the slowest speed since the peak.
          if (speed === 0) return;
          if (state.floor === Infinity) {
            if (speed >= state.peak) state.peak = speed;
            else state.floor = speed;
            return;
          }
          if (speed < state.floor) state.floor = speed;
          const fresh = horizontal && speed >= Math.max(16, state.floor * 3) && now - state.at > SWIPE_MIN_GAP;
          if (!fresh) return;
        } else if (!horizontal) {
          return;
        }
        state.locked = true;
        state.peak = speed;
        state.floor = Infinity;
        state.at = now;
        stepHero(event.deltaX > 0 ? 1 : -1);
      }}
    >
      {heroes.length > 1 ? (
        <>
          <button type="button" className="hero-nav hero-prev" onClick={() => stepHero(-1)} aria-label="Previous highlight">
            ‹
          </button>
          <button type="button" className="hero-nav hero-next" onClick={() => stepHero(1)} aria-label="Next highlight">
            ›
          </button>
        </>
      ) : null}
      {hero ? (
        <Hero
          items={heroes}
          index={heroIndex}
          busy={busy}
          onPlay={() => void play(hero, { resume: true })}
          onOpen={() => navigate(`/item/${hero.Id}`)}
        />
      ) : (
        <div className="hero hero-empty">{loading ? <div className="hero-skeleton" /> : <h1>Nothing here yet</h1>}</div>
      )}
      {heroes.length > 1 ? (
        <div className="hero-dots">
          {heroes.map((item, index) => (
            <button key={item.Id} className={index === heroIndex ? "on" : ""} onClick={() => setHeroIndex(index)} aria-label={item.Name}>
              {index === heroIndex && autoAdvance && !tv ? (
                <span
                  key={heroIndex}
                  style={{ animationDuration: `${HERO_INTERVAL}ms` }}
                  onAnimationEnd={() => setHeroIndex((current) => (current + 1) % heroes.length)}
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HomeRowView({ row }: { row: HomeRow }) {
  return (
    <Row title={row.title} subtitle={row.subtitle}>
      {row.kind === "rank"
        ? row.items.map((item, index) => <RankCard key={item.Id} item={item} rank={index + 1} />)
        : row.items.map((item) => <Poster key={item.Id} item={item} />)}
    </Row>
  );
}

/** Rows for browsing what is already on the server, interleaved so the page never feels samey. */
async function discoveryRows(client: Jellyfin): Promise<HomeRow[]> {
  const decade = DECADES[Math.floor(Math.random() * DECADES.length)];
  const today = new Date();
  const recentCutoff = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate()).toISOString();
  const [history, unseen, fresh, binge, acclaimed, collections, favorites, era, genreList] = await Promise.all([
    items(client.items({ slim: true, includeItemTypes: "Movie,Episode", sortBy: "DatePlayed", sortOrder: "Descending", filters: "IsPlayed", limit: 40, extra: NO_COUNT })),
    items(client.items({ slim: true, includeItemTypes: "Movie", filters: "IsUnplayed", sortBy: "Random", limit: 24, extra: NO_COUNT })),
    items(client.items({ slim: true, includeItemTypes: BROWSE, sortBy: "PremiereDate", sortOrder: "Descending", limit: 24, extra: { MinPremiereDate: recentCutoff, MaxPremiereDate: today.toISOString(), ...NO_COUNT } })),
    items(client.items({ slim: true, includeItemTypes: "Series", filters: "IsUnplayed", sortBy: "Random", limit: 24, extra: { MinCommunityRating: "7.5", ...NO_COUNT } })),
    items(client.items({ slim: true, includeItemTypes: "Movie", sortBy: "Random", limit: 24, extra: { MinCriticRating: "85", ...NO_COUNT } })),
    items(client.items({ slim: true, includeItemTypes: "BoxSet", sortBy: "Random", limit: 24, extra: NO_COUNT })),
    items(client.items({ slim: true, includeItemTypes: BROWSE, filters: "IsFavorite", sortBy: "Random", limit: 24, extra: NO_COUNT })),
    items(client.items({ slim: true, includeItemTypes: BROWSE, sortBy: "Random", limit: 24, years: decadeYears(decade), extra: NO_COUNT })),
    items(client.genres(undefined, BROWSE)),
  ]);

  const seeds = dedupeBy(
    history.map((item) => (item.Type === "Episode" && item.SeriesId ? { id: item.SeriesId, name: item.SeriesName ?? item.Name } : { id: item.Id, name: item.Name })),
    (seed) => seed.id,
  ).slice(0, 3);

  const weight = new Map<string, number>();
  for (const item of [...history, ...favorites]) for (const genre of item.Genres ?? []) weight.set(genre, (weight.get(genre) ?? 0) + 1);
  const names = shuffle(genreList.map((genre) => genre.Name)).sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0));
  const liked = names.filter((name) => weight.get(name)).slice(0, 3);
  const genres = [...liked, ...names.filter((name) => !liked.includes(name))].slice(0, GENRE_ROWS);

  const [similar, genreRows] = await Promise.all([
    Promise.all(seeds.map((seed) => items(client.similar(seed.id)).then((found) => found.filter((item) => !item.UserData?.Played)))),
    Promise.all(genres.map((name) => items(client.items({ slim: true, includeItemTypes: BROWSE, genres: name, sortBy: "Random", limit: 24, extra: NO_COUNT })))),
  ]);

  const genre = (index: number): HomeRow | undefined =>
    genres[index] ? { key: `genre-${genres[index]}`, title: genres[index], items: genreRows[index] ?? [] } : undefined;
  const because = (index: number, title: string): HomeRow | undefined =>
    seeds[index] ? { key: `similar-${seeds[index].id}`, title: `${title} ${seeds[index].name}`, items: similar[index] ?? [] } : undefined;

  const rows: (HomeRow | undefined)[] = [
    because(0, "Because you watched"),
    { key: "unseen", title: "Picked for you", subtitle: "Movies you haven't seen yet", items: unseen },
    genre(0),
    because(1, "Because you watched"),
    { key: "fresh", title: "New releases", subtitle: "Out in the last two years", items: fresh },
    genre(1),
    { key: "binge", title: "Binge-worthy shows", subtitle: "Highly rated series you haven't finished", items: binge },
    genre(2),
    because(2, "More like"),
    { key: "acclaimed", title: "Critically acclaimed", items: acclaimed },
    genre(3),
    { key: "era", title: decade >= 2000 ? `The ${decade}s` : `Back to the '${String(decade).slice(2)}s`, items: era },
    genre(4),
    { key: "collections", title: "Collections", items: collections, min: 3 },
    { key: "favorites", title: "Your favorites", items: favorites, min: 1 },
    genre(5),
  ];
  return rows.filter((row): row is HomeRow => Boolean(row && row.items.length >= (row.min ?? 5)));
}

async function topRow(client: Jellyfin): Promise<HomeRow> {
  const [serverName, top] = await Promise.all([
    client.serverName().catch(() => ""),
    items(client.items({ slim: true, includeItemTypes: BROWSE, sortBy: "CommunityRating,SortName", sortOrder: "Descending", limit: 10, extra: { MinCommunityRating: "1", ...NO_COUNT } })),
  ]);
  return { key: "top", title: serverName ? `Top 10 on ${serverName}` : "Top 10 on your server", subtitle: "Highest rated", kind: "rank", items: top };
}

function items(request: Promise<ItemList>) {
  return request.then((list) => dedupe(list.Items ?? [])).catch(() => [] as BaseItem[]);
}

/**
 * Random unwatched, well-rated titles for the hero. Jellyfin answers one
 * Movie+Series random query several times slower than the two apart, so ask
 * separately and mix in proportion to how many of each the library has.
 */
async function heroPicks(client: Jellyfin, types: Settings["heroTypes"], count = 10) {
  const none = Promise.resolve({ Items: [], TotalRecordCount: 0 } as ItemList);
  const query = (includeItemTypes: string) =>
    client
      .items({
        includeItemTypes,
        filters: "IsUnplayed",
        sortBy: "Random",
        limit: count,
        extra: { ImageTypes: "Backdrop", MinCommunityRating: "6.5" },
      })
      .catch(() => ({ Items: [], TotalRecordCount: 0 }) as ItemList);
  const [movies, series] = await Promise.all([
    types === "shows" ? none : query("Movie"),
    types === "movies" ? none : query("Series"),
  ]);
  const movieItems = movies.Items ?? [];
  const seriesItems = series.Items ?? [];
  const total = (movies.TotalRecordCount ?? 0) + (series.TotalRecordCount ?? 0);
  const movieShare = total ? Math.round((count * (movies.TotalRecordCount ?? 0)) / total) : count;
  const takeMovies = Math.min(movieItems.length, Math.max(movieShare, count - seriesItems.length));
  return shuffle([...movieItems.slice(0, takeMovies), ...seriesItems.slice(0, count - takeMovies)]);
}

function heroFavorites(client: Jellyfin, types: Settings["heroTypes"]) {
  const includeItemTypes = types === "movies" ? "Movie" : types === "shows" ? "Series" : "Movie,Series";
  return items(client.items({ includeItemTypes, filters: "IsFavorite", sortBy: "Random", limit: HERO_COUNT, extra: { ImageTypes: "Backdrop" } }));
}

function heroType(item: BaseItem, types: Settings["heroTypes"]) {
  if (types === "movies") return item.Type === "Movie";
  if (types === "shows") return item.Type === "Series" || item.Type === "Episode" || item.Type === "Season";
  return true;
}

function interleave<T>(first: T[], second: T[]) {
  const mixed: T[] = [];
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    if (index < first.length) mixed.push(first[index]);
    if (index < second.length) mixed.push(second[index]);
  }
  return mixed;
}

function decadeYears(decade: number) {
  return Array.from({ length: 10 }, (_, index) => decade + index).join(",");
}

function shuffle<T>(list: T[]) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function Hero({ items, index, busy, onPlay, onOpen }: { items: BaseItem[]; index: number; busy: boolean; onPlay: () => void; onOpen: () => void }) {
  const session = useSession();
  const item = items[index] ?? items[0];
  const [brokenLogos, setBrokenLogos] = useState<Record<string, boolean>>({});
  const logo = logoUrl(session, item);
  const code = episodeCode(item);
  const progress = item.UserData?.PlayedPercentage ?? 0;
  const label = progress > 1 && progress < 97 ? "Resume" : "Play";
  // Only the outgoing and incoming backdrops are mounted; each full-size image
  // costs several megabytes of decoded memory.
  const shownRef = useRef(index);
  const [outgoing, setOutgoing] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    const from = shownRef.current;
    shownRef.current = index;
    if (from !== index) setOutgoing({ from, to: index });
    const next = items[(index + 1) % items.length];
    const upcoming = next ? backdropUrl(session, next) : undefined;
    if (upcoming) new Image().src = upcoming;
    const timer = window.setTimeout(() => setOutgoing(null), 1300);
    return () => window.clearTimeout(timer);
  }, [index, items, session]);
  const leaving = outgoing && outgoing.to === index ? items[outgoing.from] : undefined;
  const previous = leaving && leaving.Id !== item.Id ? leaving : undefined;
  const previousBackdrop = previous ? backdropUrl(session, previous) : undefined;
  const backdrop = backdropUrl(session, item);
  return (
    <section className="hero">
      {previousBackdrop && previous ? <img key={`art-${previous.Id}`} className="hero-media prev" src={previousBackdrop} alt="" decoding="async" /> : null}
      {backdrop ? <img key={`art-${item.Id}`} className={`hero-media on${previous ? " fade" : ""}`} src={backdrop} alt="" decoding="async" /> : null}
      <div className="hero-shade" />
      <div className="hero-copy" key={`copy-${item.Id}`}>
        {item.SeriesName ? <p className="eyebrow">{item.SeriesName}</p> : null}
        {logo && !brokenLogos[item.Id] ? (
          <img className="hero-logo" src={logo} alt={item.Name} onError={() => setBrokenLogos((current) => ({ ...current, [item.Id]: true }))} />
        ) : (
          <h1>{item.Name}</h1>
        )}
        <p className="hero-meta">
          {[item.ProductionYear, formatRuntime(item.RunTimeTicks), item.OfficialRating, item.CommunityRating ? item.CommunityRating.toFixed(1) : "", code, item.Genres?.slice(0, 3).join(" · ")]
            .filter(Boolean)
            .join("   ·   ")}
        </p>
        {item.Overview ? <p className="hero-overview">{item.Overview}</p> : null}
        <div className="hero-actions">
          <button className="btn-play" onClick={onPlay} disabled={busy}>
            <IconPlay size={16} />
            {busy ? "Starting…" : label}
          </button>
          <button className="btn-round" onClick={onOpen} aria-label="Details">
            <IconInfo size={18} />
          </button>
        </div>
      </div>
    </section>
  );
}

function dedupe(items: BaseItem[]) {
  return dedupeBy(items, (item) => item.Id);
}

function dedupeBy<T>(list: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return list.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
