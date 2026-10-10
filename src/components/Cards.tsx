import { Children, memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { IconBack } from "../icons";
import { episodeCode, tile, primaryUrl, thumbUrl } from "../media";
import { useSession } from "../session";
import { tv } from "../tv";
import type { BaseItem } from "../types";

/** A TV styles, lays out and keeps every card it is given, so on a TV a long
 * row starts with this many and grows as focus nears its end. */
const TV_CARDS = 12;

export function Scroller({ children, className = "", grow = false }: { children: ReactNode; className?: string; grow?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const [count, setCount] = useState(TV_CARDS);
  const cards = tv && grow ? Children.toArray(children) : null;
  const more = cards ? cards.length > count : false;

  const update = useCallback(() => {
    const track = ref.current;
    if (!track) return;
    setAtStart(track.scrollLeft <= 4);
    setAtEnd(track.scrollLeft + track.clientWidth >= track.scrollWidth - 4);
  }, []);

  // Couch mode hides the arrows these track, and on a TV re-rendering the row
  // on every frame of a scroll costs more than the scroll.
  useEffect(() => {
    const track = ref.current;
    if (!track || tv) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(track);
    const content = new MutationObserver(update);
    content.observe(track, { childList: true });
    return () => {
      observer.disconnect();
      content.disconnect();
    };
  }, [update]);

  const scroll = (direction: number) => {
    const track = ref.current;
    if (!track) return;
    track.scrollBy({ left: direction * Math.max(320, track.clientWidth - 160), behavior: "smooth" });
  };

  return (
    <div className="row-scroller">
      <button className={`row-nav left ${atStart ? "hidden" : ""}`} onClick={() => scroll(-1)} aria-label="Scroll left" tabIndex={-1}>
        <IconBack size={22} />
      </button>
      <div
        className={`row-track ${className}`}
        ref={ref}
        onScroll={tv ? undefined : update}
        onFocus={
          more
            ? (event) => {
                const index = Array.prototype.indexOf.call(event.currentTarget.children, event.target);
                // After the frame that shows the move, so the press itself stays quick.
                if (index >= count - 4) requestAnimationFrame(() => window.setTimeout(() => setCount((shown) => Math.max(shown, index + 4 + TV_CARDS))));
              }
            : undefined
        }
      >
        {cards ? cards.slice(0, count) : children}
      </div>
      <button className={`row-nav right ${atEnd ? "hidden" : ""}`} onClick={() => scroll(1)} aria-label="Scroll right" tabIndex={-1}>
        <IconBack size={22} />
      </button>
    </div>
  );
}

/** Chromium before 95 (Samsung TVs) lacks `contain-intrinsic-size: auto`, so a
 * row content-visibility skips would shrink to the stylesheet's guess and the
 * page below it shift as rows scroll in and out. This keeps each row's real
 * height instead; while a row is skipped it reports that same height back. */
const rowSizes =
  typeof ResizeObserver !== "undefined" && typeof CSS !== "undefined" && !CSS.supports("contain-intrinsic-size", "auto 1px")
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = Math.round(entry.contentRect.height);
          if (height > 0) (entry.target as HTMLElement).style.setProperty("contain-intrinsic-size", `1px ${height}px`);
        }
      })
    : null;

export function Row({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: { label: string; to: string };
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = ref.current;
    if (!row || !rowSizes) return;
    rowSizes.observe(row);
    return () => rowSizes.unobserve(row);
  }, []);
  return (
    <section className="row" ref={ref}>
      <div className="row-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action ? (
          <button onClick={() => navigate(action.to)} className="text-btn">
            {action.label}
          </button>
        ) : null}
      </div>
      <Scroller grow>{children}</Scroller>
    </section>
  );
}

/** Home holds hundreds of cards; memo keeps a hero change from re-rendering them all. */
export const Poster = memo(function Poster({ item, subtitle }: { item: BaseItem; subtitle?: string }) {
  const navigate = useNavigate();
  const session = useSession();
  const art = primaryUrl(session, item);
  const progress = item.UserData?.PlayedPercentage ?? 0;
  return (
    <button className="poster" onClick={() => navigate(`/item/${item.Id}`)}>
      <span className="poster-art" style={{ background: tile(item.Name) }}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        {item.UserData?.Played ? <i className="played" /> : null}
        {item.Type === "Series" && item.UserData?.UnplayedItemCount ? <em>{item.UserData.UnplayedItemCount}</em> : null}
        {progress > 1 && progress < 98 ? (
          <span className="progress">
            <span style={{ width: `${progress}%` }} />
          </span>
        ) : null}
      </span>
      <span className="poster-title">
        {item.Name}
        {subtitle ? <small> {subtitle}</small> : null}
      </span>
    </button>
  );
});

export const RankCard = memo(function RankCard({ item, rank }: { item: BaseItem; rank: number }) {
  const navigate = useNavigate();
  const session = useSession();
  const art = primaryUrl(session, item);
  return (
    <button className="rank-card" onClick={() => navigate(`/item/${item.Id}`)} aria-label={`${rank}. ${item.Name}`} title={item.Name}>
      <b aria-hidden>{rank}</b>
      <span className="poster-art" style={{ background: tile(item.Name) }}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
      </span>
    </button>
  );
});

export const WideCard = memo(function WideCard({ item }: { item: BaseItem }) {
  const navigate = useNavigate();
  const session = useSession();
  const art = thumbUrl(session, item);
  const progress = item.UserData?.PlayedPercentage ?? 0;
  const code = episodeCode(item);
  return (
    <button className="wide" onClick={() => navigate(`/item/${item.Id}`)}>
      <span className="wide-art" style={{ background: tile(item.Name) }}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        <span className="wide-copy">
          {item.SeriesName ? <small>{item.SeriesName}</small> : null}
          <strong>
            {code ? `${code}  ` : ""}
            {item.Name}
          </strong>
        </span>
        {progress > 0 ? (
          <span className="progress">
            <span style={{ width: `${Math.min(100, progress)}%` }} />
          </span>
        ) : null}
      </span>
    </button>
  );
});
