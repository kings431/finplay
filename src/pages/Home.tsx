import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Poster, RankCard, Row, WideCard } from "../components/Cards";
import { markRequested, SeerrCard, useSeerrPicker } from "../components/RequestSheet";
import { IconInfo, IconPlay } from "../icons";
import { backdropUrl, episodeCode, formatRuntime, logoUrl } from "../media";
import { usePlayback } from "../playback";
import { useCached } from "../cache";
import { useClient, useSession } from "../session";
import type { Jellyfin } from "../jellyfin";
import type { BaseItem, ItemList, SeerrResult } from "../types";

const BROWSE = "Movie,Series";
const DECADES = [1970, 1980, 1990, 2000, 2010];
const GENRE_ROWS = 6;
const DISCOVERY_MAX_AGE = 20 * 60 * 1000;
const HERO_INTERVAL = 7000;

type HomeRow = {
  key: string;
  title: string;
  subtitle?: string;
  kind?: "poster" | "rank";
  items: BaseItem[];
  min?: number;
};

export function Home() {
  const client = useClient();
  const session = useSession();
  const { play, busy } = usePlayback();
  const navigate = useNavigate();
  const [heroIndex, setHeroIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const { data, error, loading } = useCached(`home:${session.userId}`, async () => {
    const [resumeList, nextList, latestMovies, latestShows, picks] = await Promise.all([
      client.resume(),
      client.nextUp(),
      client.latest(undefined, "Movie"),
      client.latest(undefined, "Series"),
      items(
        client.items({
          includeItemTypes: BROWSE,
          filters: "IsUnplayed",
          sortBy: "Random",
          limit: 10,
          extra: { ImageTypes: "Backdrop", MinCommunityRating: "6.5" },
        }),
      ),
    ]);
    return {
      resume: resumeList.Items ?? [],
      nextUp: nextList.Items ?? [],
      movies: latestMovies ?? [],
      shows: latestShows ?? [],
      picks,
    };
  });
  const resume = data?.resume ?? [];
  const nextUp = data?.nextUp ?? [];
  const movies = data?.movies ?? [];
  const shows = data?.shows ?? [];
  const more = useCached(`home-more:${session.userId}`, () => discoveryRows(client), { maxAge: DISCOVERY_MAX_AGE });
  const discover = useCached(session.seerr ? `home-discover:${session.userId}` : null, () =>
    client.seerrDiscover("trending").then((found) => (found.results ?? []).filter((result) => result.mediaType === "movie" || result.mediaType === "tv")),
  );
  const [requested, setRequested] = useState<SeerrResult[] | null>(null);
  useEffect(() => setRequested(null), [discover.data]);
  const trending = requested ?? discover.data ?? [];
  const picker = useSeerrPicker((mediaType, id) => setRequested(markRequested(trending, mediaType, id)));

  const candidates = dedupe([...resume.slice(0, 2), ...nextUp.slice(0, 1), ...(data?.picks ?? []), ...movies])
    .filter((item) => item.BackdropImageTags?.length || item.ParentBackdropImageTags?.length)
    .slice(0, 8);
  const [heroes, setHeroes] = useState<BaseItem[]>([]);
  useEffect(() => {
    if (heroes.length === 0 && candidates.length > 0) setHeroes(candidates);
  }, [heroes.length, candidates.length]);
  const hero = heroes[heroIndex] ?? heroes[0];
  const stepHero = (delta: number) => {
    if (heroes.length <= 1) return;
    setHeroIndex((current) => (current + delta + heroes.length) % heroes.length);
    setPaused(true);
  };

  const movieLibrary = session.views.find((view) => view.CollectionType === "movies");
  const showLibrary = session.views.find((view) => view.CollectionType === "tvshows");
  const top = more.data?.find((row) => row.key === "top");
  const rows = (more.data ?? []).filter((row) => row !== top);

  return (
    <div className="home">
      <div
        className={`hero-carousel${paused ? " paused" : ""}`}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onWheel={(event) => {
          if (heroes.length <= 1) return;
          const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) && Math.abs(event.deltaX) > 8;
          if (!horizontal) return;
          event.preventDefault();
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
                {index === heroIndex ? (
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
      {error ? <p className="empty">{error}</p> : null}
      {resume.length > 0 ? (
        <Row title="Continue watching">
          {resume.map((item) => (
            <WideCard key={item.Id} item={item} />
          ))}
        </Row>
      ) : null}
      {top ? <HomeRowView row={top} /> : null}
      {nextUp.length > 0 ? (
        <Row title="Next up">
          {nextUp.map((item) => (
            <WideCard key={item.Id} item={item} />
          ))}
        </Row>
      ) : null}
      {movies.length > 0 ? (
        <Row title="Recently added movies" action={movieLibrary ? { label: "See all", to: `/library/${movieLibrary.Id}` } : undefined}>
          {movies.map((item) => (
            <Poster key={item.Id} item={item} />
          ))}
        </Row>
      ) : null}
      {shows.length > 0 ? (
        <Row title="Recently added shows" action={showLibrary ? { label: "See all", to: `/library/${showLibrary.Id}` } : undefined}>
          {shows.map((item) => (
            <Poster key={item.Id} item={item} />
          ))}
        </Row>
      ) : null}
      {rows.slice(0, 4).map((row) => (
        <HomeRowView key={row.key} row={row} />
      ))}
      {trending.length > 0 ? (
        <Row title="Discover" subtitle="Not on your server yet. Request it." action={{ label: "See all", to: "/discover" }}>
          {trending.map((result) => (
            <SeerrCard key={`${result.mediaType}-${result.id}`} result={result} onOpen={picker.open} />
          ))}
        </Row>
      ) : null}
      {rows.slice(4).map((row) => (
        <HomeRowView key={row.key} row={row} />
      ))}
      {picker.sheet}
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
  const [serverName, history, top, unseen, fresh, binge, acclaimed, collections, favorites, era, genreList] = await Promise.all([
    client.serverName().catch(() => ""),
    items(client.items({ includeItemTypes: "Movie,Episode", sortBy: "DatePlayed", sortOrder: "Descending", filters: "IsPlayed", limit: 40 })),
    items(client.items({ includeItemTypes: BROWSE, sortBy: "CommunityRating,SortName", sortOrder: "Descending", limit: 10, extra: { MinCommunityRating: "1" } })),
    items(client.items({ includeItemTypes: "Movie", filters: "IsUnplayed", sortBy: "Random", limit: 24 })),
    items(client.items({ includeItemTypes: BROWSE, sortBy: "PremiereDate", sortOrder: "Descending", limit: 24, extra: { MinPremiereDate: recentCutoff, MaxPremiereDate: today.toISOString() } })),
    items(client.items({ includeItemTypes: "Series", filters: "IsUnplayed", sortBy: "Random", limit: 24, extra: { MinCommunityRating: "7.5" } })),
    items(client.items({ includeItemTypes: "Movie", sortBy: "Random", limit: 24, extra: { MinCriticRating: "85" } })),
    items(client.items({ includeItemTypes: "BoxSet", sortBy: "Random", limit: 24 })),
    items(client.items({ includeItemTypes: BROWSE, filters: "IsFavorite", sortBy: "Random", limit: 24 })),
    items(client.items({ includeItemTypes: BROWSE, sortBy: "Random", limit: 24, years: decadeYears(decade) })),
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
    Promise.all(genres.map((name) => items(client.items({ includeItemTypes: BROWSE, genres: name, sortBy: "Random", limit: 24 })))),
  ]);

  const genre = (index: number): HomeRow | undefined =>
    genres[index] ? { key: `genre-${genres[index]}`, title: genres[index], items: genreRows[index] ?? [] } : undefined;
  const because = (index: number, title: string): HomeRow | undefined =>
    seeds[index] ? { key: `similar-${seeds[index].id}`, title: `${title} ${seeds[index].name}`, items: similar[index] ?? [] } : undefined;

  const rows: (HomeRow | undefined)[] = [
    { key: "top", title: serverName ? `Top 10 on ${serverName}` : "Top 10 on your server", subtitle: "Highest rated", kind: "rank", items: top },
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

function items(request: Promise<ItemList>) {
  return request.then((list) => list.Items ?? []).catch(() => [] as BaseItem[]);
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
  return (
    <section className="hero">
      {items.map((slide, slideIndex) => {
        const backdrop = backdropUrl(session, slide);
        return backdrop ? <img key={slide.Id} className={`hero-media${slideIndex === index ? " on" : ""}`} src={backdrop} alt="" decoding="async" /> : null;
      })}
      <div className="hero-shade" />
      <div className="hero-copy" key={item.Id}>
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
