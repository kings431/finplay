import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCached } from "../cache";
import { seerrPoster, seerrStatus, useSeerrPicker } from "../components/RequestSheet";
import { imageUrl, tile } from "../media";
import { useClient, useSession } from "../session";
import type { BaseItem, SeerrResult } from "../types";

type Kind = "all" | "shows" | "movies";

type Entry = {
  key: string;
  day: string;
  kind: "show" | "movie";
  title: string;
  detail: string;
  art?: string;
  badge?: { label: string; tone: string };
  watching: boolean;
  open: () => void;
};

type Upcoming = { episodes: BaseItem[]; series: BaseItem[]; movies: SeerrResult[]; premieres: SeerrResult[] };

const SEERR_PAGES = 2;

export function Calendar() {
  const client = useClient();
  const session = useSession();
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>("all");
  const [mine, setMine] = useState(false);
  const [requested, setRequested] = useState<Record<string, boolean>>({});
  const picker = useSeerrPicker((mediaType, id) => setRequested((current) => ({ ...current, [`${mediaType}-${id}`]: true })));

  const { data, error, loading } = useCached(
    `calendar:${session.userId}`,
    async (): Promise<Upcoming> => {
      const seerrList = (path: string) =>
        session.seerr
          ? Promise.all(Array.from({ length: SEERR_PAGES }, (_, page) => client.seerrDiscover(path, page + 1).then((found) => found.results ?? [])))
              .then((pages) => pages.flat())
              .catch(() => [] as SeerrResult[])
          : Promise.resolve([] as SeerrResult[]);
      const [episodes, movies, premieres] = await Promise.all([
        client.upcoming().then((list) => list.Items ?? []),
        seerrList("movies/upcoming"),
        seerrList("tv/upcoming"),
      ]);
      const seriesIds = [...new Set(episodes.map((episode) => episode.SeriesId).filter((id): id is string => Boolean(id)))];
      const series = await client.itemsByIds(seriesIds).catch(() => [] as BaseItem[]);
      return { episodes, series, movies, premieres };
    },
    { maxAge: 10 * 60_000 },
  );

  const entries = data ? buildEntries(data, session, navigate, picker.open, requested) : [];
  const visible = entries.filter(
    (entry) => (kind === "all" || (kind === "shows" ? entry.kind === "show" : entry.kind === "movie")) && (!mine || entry.watching),
  );
  const days = groupByDay(visible);

  return (
    <div className="calendar">
      <div className="calendar-filters">
        <div className="chips">
          {(["all", "shows", "movies"] as const).map((option) => (
            <button key={option} className={kind === option ? "on" : ""} onClick={() => setKind(option)}>
              {option === "all" ? "Everything" : option === "shows" ? "Shows" : "Movies"}
            </button>
          ))}
          <span className="chip-gap" />
          <button className={mine ? "on" : ""} onClick={() => setMine((current) => !current)} aria-pressed={mine}>
            Shows I watch
          </button>
        </div>
      </div>
      {error && !data ? <p className="empty">Couldn't load what's coming up. ({error})</p> : null}
      {loading && !data ? <p className="empty">Checking what's coming up…</p> : null}
      {data && days.length === 0 ? (
        <p className="empty">{mine ? "Nothing new coming for the shows you watch." : "Nothing on the calendar yet."}</p>
      ) : null}
      {days.map(([day, list]) => (
        <section key={day} className="cal-day">
          <h2 className="cal-day-head">
            {dayLabel(day)}
            <small>{list.length === 1 ? "1 release" : `${list.length} releases`}</small>
          </h2>
          <div className="cal-grid">
            {list.map((entry) => (
              <button key={entry.key} className={`cal-card ${entry.kind}`} onClick={entry.open}>
                <span className="cal-art" style={{ background: tile(entry.title) }}>
                  {entry.art ? <img src={entry.art} alt="" loading="lazy" decoding="async" /> : null}
                </span>
                <span className="cal-copy">
                  <strong>{entry.title}</strong>
                  <small>{entry.detail}</small>
                  <span className="cal-tags">
                    <em className="cal-kind">{entry.kind === "show" ? "TV" : "Movie"}</em>
                    {entry.badge ? <em className={`seerr-badge ${entry.badge.tone}`}>{entry.badge.label}</em> : null}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {picker.sheet}
    </div>
  );
}

function buildEntries(
  data: Upcoming,
  auth: Parameters<typeof imageUrl>[0],
  navigate: (to: string) => void,
  request: (result: SeerrResult) => void,
  requested: Record<string, boolean>,
): Entry[] {
  const today = dayKey(new Date());
  const yesterday = shiftDay(today, -1);
  const seriesById = new Map(data.series.map((series) => [series.Id, series]));
  const entries: Entry[] = [];

  // A season drop lands as many episodes on one day; show it as one card.
  const drops = new Map<string, BaseItem[]>();
  for (const episode of data.episodes) {
    if (!episode.PremiereDate) continue;
    const day = dayKey(new Date(episode.PremiereDate));
    if (day < yesterday) continue;
    const key = `${episode.SeriesId ?? episode.Id}|${day}`;
    drops.set(key, [...(drops.get(key) ?? []), episode]);
  }
  for (const [key, episodes] of drops) {
    episodes.sort((a, b) => (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
    const first = episodes[0];
    const series = first.SeriesId ? seriesById.get(first.SeriesId) : undefined;
    const onServer = episodes.filter((episode) => episode.LocationType !== "Virtual").length;
    const art = first.ParentBackdropItemId && first.ParentBackdropImageTags?.[0]
      ? imageUrl(auth, first.ParentBackdropItemId, "Backdrop", first.ParentBackdropImageTags[0], 0, 560)
      : first.ImageTags?.Primary
        ? imageUrl(auth, first.Id, "Primary", first.ImageTags.Primary, 0, 560)
        : undefined;
    const target = episodes.length === 1 && onServer ? `/item/${first.Id}` : `/item/${first.SeriesId ?? first.Id}`;
    entries.push({
      key,
      day: key.split("|")[1],
      kind: "show",
      title: first.SeriesName ?? first.Name,
      detail: episodeSummary(episodes),
      art,
      badge:
        onServer === episodes.length
          ? { label: "On server", tone: "ok" }
          : onServer > 0
            ? { label: `${onServer} of ${episodes.length} on server`, tone: "ok" }
            : undefined,
      watching: Boolean(series && ((series.UserData?.PlayedPercentage ?? 0) > 0 || series.UserData?.IsFavorite)),
      open: () => navigate(target),
    });
  }

  const seerrEntry = (result: SeerrResult, kind: "show" | "movie", detail: string) => {
    const date = kind === "movie" ? result.releaseDate : result.firstAirDate;
    if (!date || date.slice(0, 10) < today) return;
    const status = requested[`${result.mediaType}-${result.id}`] ? { label: "Requested", tone: "wait" } : seerrStatus(result.mediaInfo?.status);
    entries.push({
      key: `${result.mediaType}-${result.id}`,
      day: date.slice(0, 10),
      kind,
      title: result.title ?? result.name ?? "",
      detail,
      art: seerrPoster(result.backdropPath, "w780") ?? seerrPoster(result.posterPath),
      badge: status ?? undefined,
      watching: false,
      open: () => request(result),
    });
  };
  const seen = new Set<string>();
  for (const result of [...data.movies, ...data.premieres]) {
    const id = `${result.mediaType}-${result.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (result.mediaType === "movie") seerrEntry(result, "movie", "In theaters");
    else if (result.mediaType === "tv") seerrEntry(result, "show", "Series premiere");
  }

  return entries.sort((a, b) => a.day.localeCompare(b.day) || Number(b.watching) - Number(a.watching) || a.title.localeCompare(b.title));
}

function episodeSummary(episodes: BaseItem[]) {
  const first = episodes[0];
  const last = episodes[episodes.length - 1];
  const season = first.ParentIndexNumber;
  if (episodes.length === 1) {
    const code = [season != null ? `S${season}` : "", first.IndexNumber != null ? `E${first.IndexNumber}` : ""].filter(Boolean).join(" · ");
    return [code, first.Name].filter(Boolean).join(" · ");
  }
  if (season != null && last.ParentIndexNumber === season && first.IndexNumber != null && last.IndexNumber != null) {
    return `S${season} · E${first.IndexNumber}–${last.IndexNumber} · ${episodes.length} episodes`;
  }
  return `${episodes.length} episodes`;
}

function groupByDay(entries: Entry[]) {
  const days = new Map<string, Entry[]>();
  for (const entry of entries) days.set(entry.day, [...(days.get(entry.day) ?? []), entry]);
  return [...days.entries()];
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDay(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function shiftDay(day: string, delta: number) {
  const date = parseDay(day);
  date.setDate(date.getDate() + delta);
  return dayKey(date);
}

function dayLabel(day: string) {
  const today = dayKey(new Date());
  if (day === today) return "Today";
  if (day === shiftDay(today, 1)) return "Tomorrow";
  if (day === shiftDay(today, -1)) return "Yesterday";
  const date = parseDay(day);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
