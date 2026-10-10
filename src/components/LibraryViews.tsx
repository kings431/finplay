import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { LETTERS } from "../library";
import { formatRuntime, imageUrl, primaryUrl, tile } from "../media";
import { useSession } from "../session";
import type { BaseItem } from "../types";

type Counted = BaseItem & { MovieCount?: number; SeriesCount?: number; IsFolder?: boolean };

function yearSpan(item: BaseItem) {
  if (!item.ProductionYear) return "";
  if (item.Type !== "Series") return String(item.ProductionYear);
  const end = item.EndDate ? new Date(item.EndDate).getFullYear() : 0;
  if (item.Status === "Continuing") return `${item.ProductionYear}–`;
  return end && end !== item.ProductionYear ? `${item.ProductionYear}–${end}` : String(item.ProductionYear);
}

function length(item: BaseItem) {
  if (item.Type === "Series" || item.Type === "BoxSet") {
    const count = item.ChildCount ?? 0;
    if (!count) return "";
    const noun = item.Type === "Series" ? "season" : "title";
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }
  return formatRuntime(item.RunTimeTicks);
}

function watched(item: BaseItem) {
  const data = item.UserData;
  if (!data) return "";
  if (data.Played) return "Watched";
  const progress = data.PlayedPercentage ?? 0;
  if (progress > 1 && progress < 98) return `${Math.round(progress)}%`;
  if (item.Type === "Series" && data.UnplayedItemCount) return `${data.UnplayedItemCount} new`;
  return "";
}

/** One title as a line of a list: what a poster grid can't show at a glance. */
export const ItemRow = memo(function ItemRow({ item, onOpen }: { item: BaseItem; onOpen?: () => void }) {
  const navigate = useNavigate();
  const session = useSession();
  const art = imageUrl(session, item.Id, "Primary", item.ImageTags?.Primary, 0, 120);
  const state = watched(item);
  return (
    <button className="lib-row" onClick={onOpen ?? (() => navigate(`/item/${item.Id}`))}>
      <span className="lib-row-art" style={{ background: tile(item.Name) }}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
      </span>
      <strong>{item.Name}</strong>
      <span>{yearSpan(item)}</span>
      <span>{length(item)}</span>
      <span>
        {item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : ""}
        {item.OfficialRating ? <small>{item.OfficialRating}</small> : null}
      </span>
      <span className={`lib-row-state ${item.UserData?.Played ? "done" : ""}`}>{state}</span>
    </button>
  );
});

/** Opens a folder in place rather than on a detail page. */
export const FolderCard = memo(function FolderCard({ item, onOpen }: { item: BaseItem; onOpen: () => void }) {
  const session = useSession();
  const art = primaryUrl(session, item);
  return (
    <button className="poster" onClick={onOpen}>
      <span className="poster-art folder-art" style={{ background: tile(item.Name) }}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : <i aria-hidden>▤</i>}
      </span>
      <span className="poster-title">
        {item.Name}
        {item.ChildCount ? <small> {item.ChildCount}</small> : null}
      </span>
    </button>
  );
});

export function isFolder(item: BaseItem) {
  return (item as Counted).IsFolder === true && (item.Type === "Folder" || item.Type === "CollectionFolder" || item.Type === "PhotoAlbum");
}

export const GenreTile = memo(function GenreTile({ genre, onOpen }: { genre: BaseItem; onOpen: () => void }) {
  const session = useSession();
  const art = imageUrl(session, genre.Id, "Primary", genre.ImageTags?.Primary, 0, 480);
  const counted = genre as Counted;
  const count = counted.MovieCount || counted.SeriesCount || genre.ChildCount || 0;
  return (
    <button className="library-card genre-card" onClick={onOpen}>
      <span style={{ background: tile(genre.Name) }}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        <b>{genre.Name}</b>
      </span>
      {count ? <small>{count.toLocaleString()} titles</small> : null}
    </button>
  );
});

/** # A–Z down the side of a list sorted by title. A remote reaches it with Right from the grid's last column. */
export function LetterRail({ active, onPick }: { active: string; onPick: (letter: string) => void }) {
  return (
    <nav className="letter-rail" aria-label="Jump to letter">
      {LETTERS.map((letter) => (
        <button key={letter} className={letter === active ? "on" : ""} onClick={() => onPick(letter)} aria-label={letter === "#" ? "Numbers and symbols" : letter} title={letter === "#" ? "Numbers and symbols" : `Jump to ${letter}`}>
          {letter}
        </button>
      ))}
    </nav>
  );
}
