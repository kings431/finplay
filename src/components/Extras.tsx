import { memo } from "react";
import { IconCheck, IconPlay } from "../icons";
import { formatClock, imageUrl, thumbUrl, ticksToSeconds, tile } from "../media";
import { useSession } from "../session";
import { tv } from "../tv";
import type { BaseItem } from "../types";
import { Scroller } from "./Cards";

/** Jellyfin's ExtraType values in the order they are shown: singular label, then plural for the summary. */
const KINDS: [string, string, string][] = [
  ["BehindTheScenes", "Behind the scenes", "behind the scenes"],
  ["Featurette", "Featurette", "featurettes"],
  ["Interview", "Interview", "interviews"],
  ["Scene", "Scene", "scenes"],
  ["DeletedScene", "Deleted scene", "deleted scenes"],
  ["Short", "Short", "shorts"],
  ["Clip", "Clip", "clips"],
  ["Sample", "Sample", "samples"],
];
/** Trailers have their own button; theme media plays in the background. */
const ELSEWHERE = new Set(["Trailer", "ThemeSong", "ThemeVideo"]);

function kindOf(extra: BaseItem) {
  const index = KINDS.findIndex(([type]) => type === extra.ExtraType);
  return index < 0 ? KINDS.length : index;
}

export function extraLabel(extra: BaseItem) {
  return KINDS[kindOf(extra)]?.[1] ?? "Extra";
}

/** Extras worth a card, grouped by kind and then by name. */
export function sortExtras(extras: BaseItem[]) {
  return extras
    .filter((extra) => !ELSEWHERE.has(extra.ExtraType ?? ""))
    .sort((a, b) => kindOf(a) - kindOf(b) || a.Name.localeCompare(b.Name, undefined, { numeric: true, sensitivity: "base" }));
}

function summaryOf(extras: BaseItem[]) {
  const counts = new Map<number, number>();
  for (const extra of extras) counts.set(kindOf(extra), (counts.get(kindOf(extra)) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => {
      const entry = KINDS[kind];
      if (!entry) return `${count} ${count === 1 ? "extra" : "extras"}`;
      return `${count} ${count === 1 ? entry[1].toLowerCase() : entry[2]}`;
    })
    .join("  ·  ");
}

const ExtraCard = memo(function ExtraCard({ extra, onPlay }: { extra: BaseItem; onPlay: (extra: BaseItem) => void }) {
  const session = useSession();
  // Extras' Primary image is usually a frame from the video, already landscape.
  const art = extra.ImageTags?.Primary ? imageUrl(session, extra.Id, "Primary", extra.ImageTags.Primary, 0, tv ? 440 : 640) : thumbUrl(session, extra);
  const seconds = ticksToSeconds(extra.RunTimeTicks);
  const label = extraLabel(extra);
  return (
    <button className="wide extra-card" onClick={() => onPlay(extra)} aria-label={`Play ${extra.Name}, ${label}`} title={extra.Name}>
      <span className="wide-art" style={{ background: tile(extra.Name) }}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        <span className="thumb-play">
          <IconPlay size={20} />
        </span>
        <span className="extra-kind">{label}</span>
        {seconds >= 1 ? <span className="extra-time">{formatClock(seconds)}</span> : null}
        {extra.UserData?.Played ? (
          <i className="badge-check">
            <IconCheck size={13} />
          </i>
        ) : null}
      </span>
      <span className="extra-title">{extra.Name}</span>
    </button>
  );
});

/** A title's behind-the-scenes, deleted scenes and other extras. Nothing when there are none. */
export function ExtrasRow({ title, extras, onPlay }: { title: string; extras: BaseItem[]; onPlay: (extra: BaseItem) => void }) {
  if (extras.length === 0) return null;
  return (
    <section className="detail-section extras">
      <h2>
        {title}
        <small>{summaryOf(extras)}</small>
      </h2>
      <Scroller>
        {extras.map((extra) => (
          <ExtraCard key={extra.Id} extra={extra} onPlay={onPlay} />
        ))}
      </Scroller>
    </section>
  );
}
