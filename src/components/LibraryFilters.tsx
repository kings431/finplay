import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCached } from "../cache";
import { filterCount, NO_FILTERS, type Filters, type Resolution, type Status } from "../library";
import { useClient } from "../session";
import { Popover } from "./Popover";

/** Searches show at most this many matches, so a library's thousands of tags never become thousands of buttons. */
const MATCHES = 24;

const STATUSES: { id: Status; label: string }[] = [
  { id: "", label: "Any" },
  { id: "unplayed", label: "Unwatched" },
  { id: "resumable", label: "In progress" },
  { id: "played", label: "Watched" },
];

const RESOLUTIONS: { id: Resolution; label: string }[] = [
  { id: "", label: "Any" },
  { id: "4k", label: "4K" },
  { id: "hd", label: "HD" },
  { id: "sd", label: "SD" },
];

function toggle(list: string[], value: string) {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="lf-group">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={on ? "on" : ""} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

/** A search over a long list: what is picked stays shown, and matches follow it. A match
 * that gets picked keeps its place, so focus on it isn't lost to a moved button. */
function Search({
  label,
  picked,
  matches,
  term,
  onTerm,
  onToggle,
}: {
  label: string;
  picked: string[];
  matches: string[] | undefined;
  term: string;
  onTerm: (term: string) => void;
  onToggle: (value: string) => void;
}) {
  const shown = [...picked.filter((name) => !matches?.includes(name)), ...(matches ?? [])];
  return (
    <>
      <input className="lf-search" type="search" value={term} onChange={(event) => onTerm(event.target.value)} placeholder={`Search ${label}`} aria-label={`Search ${label}`} />
      {shown.length ? (
        <div className="chips">
          {shown.map((name) => (
            <Chip key={name} on={picked.includes(name)} onClick={() => onToggle(name)}>
              {name}
            </Chip>
          ))}
        </div>
      ) : term.trim() && matches ? (
        <p className="lf-none">No {label} match.</p>
      ) : null}
    </>
  );
}

export function LibraryFilters({
  libraryId,
  include,
  video,
  filters,
  onChange,
  total,
}: {
  libraryId: string;
  include: string;
  /** Resolution and subtitles only mean something for movies and shows. */
  video: boolean;
  filters: Filters;
  onChange: (filters: Filters) => void;
  total: number | undefined;
}) {
  const client = useClient();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [studioTerm, setStudioTerm] = useState("");
  const [studioQuery, setStudioQuery] = useState("");
  const [tagTerm, setTagTerm] = useState("");
  const count = filterCount(filters);

  const genres = useCached(open ? `genres:${libraryId}:${include}` : null, () => client.genres(libraryId, include));
  const options = useCached(open ? `item-filters:${libraryId}:${include}` : null, () => client.itemFilters(libraryId, include), { maxAge: 10 * 60_000 });
  const studios = useCached(open && studioQuery ? `studios:${libraryId}:${include}:${studioQuery}` : null, () => client.studios(libraryId, include, studioQuery, MATCHES));

  useEffect(() => {
    const timer = window.setTimeout(() => setStudioQuery(studioTerm.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [studioTerm]);

  const tagNeedle = tagTerm.trim().toLowerCase();
  const tagMatches = tagNeedle ? (options.data?.Tags ?? []).filter((tag) => tag.toLowerCase().includes(tagNeedle)).slice(0, MATCHES) : [];
  const years = [...(options.data?.Years ?? [])].sort((a, b) => a - b);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  function close() {
    setOpen(false);
    // Focus was inside the menu, which is gone; a remote carries on from the button.
    window.setTimeout(() => anchor.current?.focus({ preventScroll: true }));
  }

  return (
    <>
      <button ref={anchor} className={`lf-button ${count ? "on" : ""}`} onClick={() => setOpen(true)} aria-haspopup="dialog">
        Filters
        {count ? <b className="lf-badge">{count}</b> : null}
      </button>
      {open ? (
        <Popover anchorRef={anchor} onClose={close}>
          <div className="lib-filters">
            <div className="lf-head">
              <strong>Filters</strong>
              {count ? (
                <button className="text-btn" onClick={() => onChange(NO_FILTERS)}>
                  Clear all
                </button>
              ) : null}
            </div>
            <Group title="Watched">
              <div className="chips">
                {STATUSES.map((status) => (
                  <Chip key={status.id || "any"} on={filters.status === status.id} onClick={() => set({ status: status.id })}>
                    {status.label}
                  </Chip>
                ))}
              </div>
            </Group>
            <Group title="Only">
              <div className="chips">
                <Chip on={filters.favorites} onClick={() => set({ favorites: !filters.favorites })}>
                  Favorites
                </Chip>
                {video ? (
                  <Chip on={filters.subtitles} onClick={() => set({ subtitles: !filters.subtitles })}>
                    Has subtitles
                  </Chip>
                ) : null}
              </div>
            </Group>
            {video ? (
              <Group title="Resolution">
                <div className="chips">
                  {RESOLUTIONS.map((resolution) => (
                    <Chip key={resolution.id || "any"} on={filters.resolution === resolution.id} onClick={() => set({ resolution: resolution.id })}>
                      {resolution.label}
                    </Chip>
                  ))}
                </div>
              </Group>
            ) : null}
            <Group title="Genres">
              <div className="chips">
                {(genres.data?.Items ?? []).map((genre) => (
                  <Chip key={genre.Id} on={filters.genres.includes(genre.Name)} onClick={() => set({ genres: toggle(filters.genres, genre.Name) })}>
                    {genre.Name}
                  </Chip>
                ))}
                {genres.loading ? <span className="lf-none">Loading…</span> : null}
              </div>
            </Group>
            {options.data?.OfficialRatings?.length ? (
              <Group title="Parental rating">
                <div className="chips">
                  {options.data.OfficialRatings.map((rating) => (
                    <Chip key={rating} on={filters.ratings.includes(rating)} onClick={() => set({ ratings: toggle(filters.ratings, rating) })}>
                      {rating}
                    </Chip>
                  ))}
                </div>
              </Group>
            ) : null}
            {years.length ? (
              <Group title="Year">
                <div className="lf-years">
                  <select value={filters.yearFrom} onChange={(event) => set({ yearFrom: Number(event.target.value) })} aria-label="From year">
                    <option value={0}>Earliest</option>
                    {years.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                  <span>to</span>
                  <select value={filters.yearTo} onChange={(event) => set({ yearTo: Number(event.target.value) })} aria-label="To year">
                    <option value={0}>Latest</option>
                    {[...years].reverse().map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </div>
              </Group>
            ) : null}
            <Group title="Studios">
              <Search
                label="studios"
                picked={filters.studios}
                matches={studioQuery ? studios.data?.Items.map((studio) => studio.Name) : undefined}
                term={studioTerm}
                onTerm={setStudioTerm}
                onToggle={(name) => set({ studios: toggle(filters.studios, name) })}
              />
            </Group>
            {options.data?.Tags?.length || filters.tags.length ? (
              <Group title="Tags">
                <Search
                  label="tags"
                  picked={filters.tags}
                  matches={tagNeedle ? tagMatches : undefined}
                  term={tagTerm}
                  onTerm={setTagTerm}
                  onToggle={(name) => set({ tags: toggle(filters.tags, name) })}
                />
              </Group>
            ) : null}
            <button className="btn-primary lf-done" onClick={close}>
              {total === undefined ? "Done" : total === 0 ? "No matches" : `Show ${total.toLocaleString()} ${total === 1 ? "title" : "titles"}`}
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
