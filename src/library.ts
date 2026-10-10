/** How a library page is sorted, filtered and shown, remembered per library. */

export type SortId = "title" | "added" | "released" | "rating" | "random";

export const SORTS: { id: SortId; label: string; sortBy: string; descending: boolean; up: string; down: string }[] = [
  { id: "title", label: "Title", sortBy: "SortName", descending: false, up: "A–Z", down: "Z–A" },
  { id: "added", label: "Date added", sortBy: "DateCreated,SortName", descending: true, up: "Oldest first", down: "Newest first" },
  { id: "released", label: "Release date", sortBy: "PremiereDate,ProductionYear,SortName", descending: true, up: "Oldest first", down: "Newest first" },
  { id: "rating", label: "Rating", sortBy: "CommunityRating,SortName", descending: true, up: "Lowest first", down: "Highest first" },
  { id: "random", label: "Random", sortBy: "Random", descending: false, up: "", down: "" },
];

export type Status = "" | "unplayed" | "played" | "resumable";
export type Resolution = "" | "4k" | "hd" | "sd";

export type Filters = {
  status: Status;
  favorites: boolean;
  genres: string[];
  ratings: string[];
  studios: string[];
  tags: string[];
  resolution: Resolution;
  subtitles: boolean;
  /** 0 leaves that end of the range open. */
  yearFrom: number;
  yearTo: number;
};

export type Tab = "items" | "collections" | "genres" | "folders";

export type Prefs = {
  sort: SortId;
  descending: boolean;
  filters: Filters;
  view: "grid" | "list";
  size: "s" | "m" | "l";
  tab: Tab;
};

export const NO_FILTERS: Filters = {
  status: "",
  favorites: false,
  genres: [],
  ratings: [],
  studios: [],
  tags: [],
  resolution: "",
  subtitles: false,
  yearFrom: 0,
  yearTo: 0,
};

const DEFAULTS: Prefs = { sort: "title", descending: false, filters: NO_FILTERS, view: "grid", size: "m", tab: "items" };

const KEY = "finplay.library.";

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function loadPrefs(libraryId: string): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + libraryId) || "{}") as Partial<Prefs>;
    const filters = { ...NO_FILTERS, ...saved.filters };
    return {
      ...DEFAULTS,
      ...saved,
      sort: SORTS.some((sort) => sort.id === saved.sort) ? (saved.sort as SortId) : DEFAULTS.sort,
      filters: {
        ...filters,
        genres: strings(filters.genres),
        ratings: strings(filters.ratings),
        studios: strings(filters.studios),
        tags: strings(filters.tags),
      },
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(libraryId: string, prefs: Prefs) {
  try {
    localStorage.setItem(KEY + libraryId, JSON.stringify(prefs));
  } catch {
    // Over quota: the choice still holds until the page is left.
  }
}

/** How many separate filters are on, for the Filters button's badge. */
export function filterCount(filters: Filters) {
  return (
    (filters.status ? 1 : 0) +
    (filters.favorites ? 1 : 0) +
    filters.genres.length +
    filters.ratings.length +
    filters.studios.length +
    filters.tags.length +
    (filters.resolution ? 1 : 0) +
    (filters.subtitles ? 1 : 0) +
    (filters.yearFrom || filters.yearTo ? 1 : 0)
  );
}

const STATUS_FILTER: Record<Status, string> = { "": "", unplayed: "IsUnplayed", played: "IsPlayed", resumable: "IsResumable" };

/** Jellyfin's `/Items` parameters for a set of filters. Lists are ORed with `|`. */
export function filterQuery(filters: Filters) {
  const extra: Record<string, string> = {};
  if (filters.ratings.length) extra.OfficialRatings = filters.ratings.join("|");
  if (filters.studios.length) extra.Studios = filters.studios.join("|");
  if (filters.tags.length) extra.Tags = filters.tags.join("|");
  if (filters.resolution === "4k") extra.Is4K = "true";
  if (filters.resolution === "hd") extra.IsHD = "true";
  if (filters.resolution === "sd") {
    extra.IsHD = "false";
    extra.Is4K = "false";
  }
  if (filters.subtitles) extra.HasSubtitles = "true";
  let yearList: string | undefined;
  if (filters.yearFrom || filters.yearTo) {
    const from = filters.yearFrom || 1900;
    const to = filters.yearTo || new Date().getFullYear() + 1;
    const span: number[] = [];
    for (let year = Math.min(from, to); year <= Math.max(from, to); year++) span.push(year);
    yearList = span.join(",");
  }
  return {
    filters: [STATUS_FILTER[filters.status], filters.favorites ? "IsFavorite" : ""].filter(Boolean).join(",") || undefined,
    genres: filters.genres.join("|") || undefined,
    years: yearList,
    extra,
  };
}

export const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/**
 * Where a letter's titles start in a list sorted by `SortName`, from counts:
 * Jellyfin's `NameLessThan` and `NameStartsWith` compare against the same sort name.
 */
export async function letterIndex(letter: string, descending: boolean, total: number, count: (extra: Record<string, string>) => Promise<number>) {
  let index: number;
  if (letter === "#") index = descending ? total - (await count({ NameLessThan: "A" })) : 0;
  else if (!descending) index = await count({ NameLessThan: letter });
  else {
    const [before, at] = await Promise.all([count({ NameLessThan: letter }), count({ NameStartsWith: letter })]);
    index = total - before - at;
  }
  return Math.max(0, Math.min(index, total - 1));
}
