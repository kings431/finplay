import type { DownloadEntry } from "./downloads";
import { ticksToSeconds } from "./media";

export type SeasonGroup = {
  key: string;
  /** Season number, when known; 0 is Specials. */
  number: number | null;
  label: string;
  entries: DownloadEntry[];
  size: number;
};

export type SeriesGroup = {
  key: string;
  name: string;
  seriesId?: string;
  year?: number;
  /** Every entry of the show, in season and episode order, whatever its state. */
  entries: DownloadEntry[];
  /** Finished episodes, split by season. */
  seasons: SeasonGroup[];
  done: number;
  size: number;
  active: number;
  failed: number;
  added: number;
};

export type GroupedDownloads = {
  series: SeriesGroup[];
  movies: DownloadEntry[];
  /** Queued, downloading and failed entries, newest activity first. */
  pending: DownloadEntry[];
  size: number;
};

export const isActive = (entry: DownloadEntry) => entry.state === "queued" || entry.state === "downloading";

export function isEpisode(entry: DownloadEntry) {
  const { item } = entry;
  return item.Type === "Episode" || Boolean(item.SeriesId || item.SeriesName);
}

export function seasonNumber(entry: DownloadEntry): number | null {
  const { item } = entry;
  if (item.ParentIndexNumber != null) return item.ParentIndexNumber;
  if (item.SeasonName && /special/i.test(item.SeasonName)) return 0;
  const match = item.SeasonName?.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function seasonLabel(number: number | null, entry: DownloadEntry) {
  if (number === 0) return "Specials";
  if (number != null) return `Season ${number}`;
  return entry.item.SeasonName || "Episodes";
}

/** Season, then episode number; Specials after the numbered seasons, unnumbered ones last. */
export function episodeOrder(a: DownloadEntry, b: DownloadEntry) {
  const big = Number.MAX_SAFE_INTEGER;
  const season = (entry: DownloadEntry) => {
    const number = seasonNumber(entry);
    return number == null ? big : number === 0 ? big - 1 : number;
  };
  const episode = (entry: DownloadEntry) => entry.item.IndexNumber ?? big;
  return season(a) - season(b) || episode(a) - episode(b) || a.item.Name.localeCompare(b.item.Name);
}

/** Older downloads may lack a series id; the saved series name still groups them. */
function seriesKey(entry: DownloadEntry) {
  const { item } = entry;
  if (item.SeriesId) return `id:${item.SeriesId}`;
  return `name:${(item.SeriesName || "Unknown show").trim().toLowerCase()}`;
}

/** Offline watch state: local playback wins over what the server said at download time. */
export function watchState(entry: DownloadEntry) {
  const { item } = entry;
  const runtime = ticksToSeconds(item.RunTimeTicks ?? item.MediaSources?.[0]?.RunTimeTicks);
  const local = entry.played || entry.position > 0 || entry.positionDirty;
  const played = local ? entry.played : Boolean(item.UserData?.Played);
  const position = local ? entry.position : ticksToSeconds(item.UserData?.PlaybackPositionTicks);
  const percent = !played && runtime > 0 && position > 0 ? Math.min(100, (position / runtime) * 100) : 0;
  return { played, position, percent };
}

export function groupDownloads(entries: DownloadEntry[]): GroupedDownloads {
  const byKey = new Map<string, DownloadEntry[]>();
  const movies: DownloadEntry[] = [];
  for (const entry of entries) {
    if (!isEpisode(entry)) {
      if (entry.state === "done") movies.push(entry);
      continue;
    }
    const key = seriesKey(entry);
    const list = byKey.get(key);
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  }

  // A show saved under both an id and (from an older download) only its name is one show.
  for (const [key, list] of [...byKey]) {
    if (!key.startsWith("name:")) continue;
    const match = [...byKey].find(([other, items]) => other.startsWith("id:") && items[0].item.SeriesName?.trim().toLowerCase() === key.slice(5));
    if (match) {
      match[1].push(...list);
      byKey.delete(key);
    }
  }

  const series: SeriesGroup[] = [...byKey].map(([key, list]) => {
    list.sort(episodeOrder);
    const named = list.find((entry) => entry.item.SeriesName);
    const seasons = new Map<string, SeasonGroup>();
    for (const entry of list) {
      if (entry.state !== "done") continue;
      const number = seasonNumber(entry);
      const seasonKey = number != null ? `n:${number}` : `s:${entry.item.SeasonId ?? entry.item.SeasonName ?? ""}`;
      let season = seasons.get(seasonKey);
      if (!season) {
        season = { key: seasonKey, number, label: seasonLabel(number, entry), entries: [], size: 0 };
        seasons.set(seasonKey, season);
      }
      season.entries.push(entry);
      season.size += entry.total;
    }
    const done = list.filter((entry) => entry.state === "done");
    return {
      key,
      name: named?.item.SeriesName || "Unknown show",
      seriesId: list.find((entry) => entry.item.SeriesId)?.item.SeriesId,
      year: list.find((entry) => entry.item.ProductionYear)?.item.ProductionYear,
      entries: list,
      seasons: [...seasons.values()],
      done: done.length,
      size: done.reduce((sum, entry) => sum + entry.total, 0),
      active: list.filter(isActive).length,
      failed: list.filter((entry) => entry.state === "failed").length,
      added: Math.max(...list.map((entry) => entry.added)),
    };
  });

  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  series.sort((a, b) => byName(a.name, b.name));
  movies.sort((a, b) => byName(a.item.Name, b.item.Name));

  const rank = (entry: DownloadEntry) => (entry.state === "downloading" ? 0 : entry.state === "queued" ? 1 : 2);
  const pending = entries.filter((entry) => entry.state !== "done").sort((a, b) => rank(a) - rank(b) || b.added - a.added);
  const size = entries.filter((entry) => entry.state === "done").reduce((sum, entry) => sum + entry.total, 0);
  return { series, movies, pending, size };
}

/** What a show's Play button starts: the episode in progress, else the first unwatched one. */
export function nextUp(group: SeriesGroup) {
  const done = group.seasons.flatMap((season) => season.entries);
  return done.find((entry) => watchState(entry).percent > 0) ?? done.find((entry) => !watchState(entry).played) ?? done[0];
}
