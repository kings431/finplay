import { useEffect, useMemo, useRef, useState } from "react";
import { useCached } from "../cache";
import { IconPlay } from "../icons";
import { primaryUrl, tile } from "../media";
import { usePlayback } from "../playback";
import { useClient, useSession } from "../session";
import type { BaseItem } from "../types";

const PX_PER_MINUTE = 6;
const GUIDE_HOURS = 6;
/** Matches `.guide-row` height in styles.css. */
const GUIDE_ROW = 64;
const GUIDE_BUFFER = 8;
const CATEGORIES = [
  { id: "all", label: "All", match: () => true },
  { id: "movies", label: "Movies", match: (program?: BaseItem) => program?.IsMovie === true },
  { id: "series", label: "Shows", match: (program?: BaseItem) => program?.IsSeries === true },
  { id: "sports", label: "Sports", match: (program?: BaseItem) => program?.IsSports === true },
  { id: "news", label: "News", match: (program?: BaseItem) => program?.IsNews === true },
  { id: "kids", label: "Kids", match: (program?: BaseItem) => program?.IsKids === true },
] as const;

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const clock = (stamp?: string) => (stamp ? new Date(stamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");

function progressOf(program: BaseItem | undefined, now: number) {
  if (!program?.StartDate || !program.EndDate) return 0;
  const start = Date.parse(program.StartDate);
  const end = Date.parse(program.EndDate);
  return end > start ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100)) : 0;
}

export function LiveTv() {
  const client = useClient();
  // The guide is the better starting point, and where leaving a stream lands.
  const [tab, setTab] = useState<"now" | "guide">("guide");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["id"]>("all");
  const { data, error, loading } = useCached("livetv:channels", async () => (await client.liveChannels()).Items ?? [], { maxAge: 60_000 });
  const channels = data ?? [];
  const matcher = CATEGORIES.find((entry) => entry.id === category)!.match;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Live TV</h1>
          <p>{channels.length ? `${channels.length} channels` : "Channels from your Jellyfin tuners"}</p>
        </div>
        <div className="chips">
          <button className={tab === "guide" ? "on" : ""} onClick={() => setTab("guide")}>
            Guide
          </button>
          <button className={tab === "now" ? "on" : ""} onClick={() => setTab("now")}>
            On now
          </button>
        </div>
      </header>
      {error ? <p className="empty">{error}</p> : null}
      {loading && !data ? <p className="empty">Loading channels…</p> : null}
      {data && channels.length === 0 ? <p className="empty">No channels yet. An admin can add a tuner and guide data under Dashboard → Live TV.</p> : null}
      {channels.length && tab === "now" ? (
        <>
          <div className="chips">
            {CATEGORIES.map((entry) => {
              const count = channels.filter((channel) => entry.match(channel.CurrentProgram)).length;
              return (
                <button key={entry.id} className={category === entry.id ? "on" : ""} onClick={() => setCategory(entry.id)} disabled={entry.id !== "all" && count === 0}>
                  {entry.label}
                  <small className="chip-count">{count}</small>
                </button>
              );
            })}
          </div>
          <OnNow channels={channels.filter((channel) => matcher(channel.CurrentProgram))} grouped={category === "all"} />
        </>
      ) : null}
      {channels.length && tab === "guide" ? <Guide channels={channels} /> : null}
    </div>
  );
}

/** Where a channel's current programme is shown on "On now", first match wins. */
const GROUPS = [
  { id: "sports", label: "Sports", match: CATEGORIES[3].match },
  { id: "news", label: "News", match: CATEGORIES[4].match },
  { id: "kids", label: "Kids", match: CATEGORIES[5].match },
  { id: "movies", label: "Movies", match: CATEGORIES[1].match },
  { id: "series", label: "Shows", match: CATEGORIES[2].match },
  { id: "other", label: "Everything else", match: () => true },
] as const;

function timeLeft(program: BaseItem | undefined, now: number) {
  const end = Date.parse(program?.EndDate ?? "");
  if (!Number.isFinite(end) || end <= now) return "";
  const minutes = Math.max(1, Math.round((end - now) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m left` : `${minutes}m left`;
}

function OnNow({ channels, grouped }: { channels: BaseItem[]; grouped: boolean }) {
  const now = useNow(30_000);
  if (!channels.length) return <p className="empty">Nothing in this category is on right now.</p>;
  if (!grouped) return <LiveTiles channels={channels} now={now} />;
  const sections = GROUPS.map((group) => ({ ...group, channels: [] as BaseItem[] }));
  for (const channel of channels) sections.find((group) => group.match(channel.CurrentProgram))?.channels.push(channel);
  return (
    <>
      {sections
        .filter((group) => group.channels.length)
        .map((group) => (
          <section key={group.id} className="onair-group">
            <h2>
              {group.label}
              <small>{group.channels.length}</small>
            </h2>
            {/* Games of one league sit together, so the NHL slate isn't scattered between the NFL's. */}
            <LiveTiles
              channels={group.id === "sports" ? [...group.channels].sort((a, b) => (a.CurrentProgram?.Name ?? "").localeCompare(b.CurrentProgram?.Name ?? "")) : group.channels}
              now={now}
            />
          </section>
        ))}
    </>
  );
}

function LiveTiles({ channels, now }: { channels: BaseItem[]; now: number }) {
  const session = useSession();
  const { play, busy } = usePlayback();
  return (
    <div className="onair-tiles">
      {channels.map((channel) => {
        const program = channel.CurrentProgram;
        const logo = primaryUrl(session, channel);
        const left = timeLeft(program, now);
        return (
          <button key={channel.Id} className="onair-tile" disabled={busy} onClick={() => void play(channel, { fromStart: true, returnTo: "/livetv" })}>
            <span className="onair-logo" style={{ background: tile(channel.Name) }}>
              {logo ? <img src={logo} alt="" loading="lazy" decoding="async" /> : <b>{channel.ChannelNumber ?? channel.Name.slice(0, 3)}</b>}
              <span className="onair-play">
                <IconPlay size={18} />
              </span>
            </span>
            <span className="onair-copy">
              <strong>{program?.Name ?? channel.Name}</strong>
              <small>{[channel.ChannelNumber ? `${channel.ChannelNumber} ${channel.Name}` : channel.Name, program ? `${clock(program.StartDate)} – ${clock(program.EndDate)}` : ""].filter(Boolean).join(" · ")}</small>
              {program ? (
                <span className="onair-progress">
                  <span className="onair-bar">
                    <span style={{ width: `${progressOf(program, now)}%` }} />
                  </span>
                  {left ? <em>{left}</em> : null}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Guide({ channels }: { channels: BaseItem[] }) {
  const client = useClient();
  const session = useSession();
  const { play, busy } = usePlayback();
  const now = useNow(60_000);
  const scroller = useRef<HTMLDivElement>(null);
  const [offsetHours, setOffsetHours] = useState(0);
  const start = useMemo(() => {
    const date = new Date();
    date.setMinutes(date.getMinutes() < 30 ? 0 : 30, 0, 0);
    date.setHours(date.getHours() + offsetHours);
    return date;
  }, [offsetHours]);
  const end = useMemo(() => new Date(start.getTime() + GUIDE_HOURS * 3_600_000), [start]);
  const ids = useMemo(() => channels.map((channel) => channel.Id), [channels]);
  // Only rows near the viewport are rendered; big lineups have hundreds of
  // channels, each with a dozen programme buttons.
  const [view, setView] = useState({ top: 0, height: 900 });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setView((current) =>
        Math.abs(current.top - element.scrollTop) < GUIDE_ROW && current.height === element.clientHeight
          ? current
          : { top: element.scrollTop, height: element.clientHeight },
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  const firstRow = Math.max(0, Math.floor(view.top / GUIDE_ROW) - GUIDE_BUFFER);
  const lastRow = Math.min(channels.length, Math.ceil((view.top + view.height) / GUIDE_ROW) + GUIDE_BUFFER);

  const { data, error } = useCached(`livetv:guide:${start.getTime()}:${ids.length}`, async () => {
    const lists = await Promise.all(
      Array.from({ length: Math.ceil(ids.length / 100) }, (_, at) => client.livePrograms(ids.slice(at * 100, at * 100 + 100), start, end)),
    );
    const byChannel: Record<string, BaseItem[]> = {};
    for (const program of lists.flatMap((list) => list.Items ?? [])) {
      if (program.ChannelId) (byChannel[program.ChannelId] ??= []).push(program);
    }
    return byChannel;
  }, { maxAge: 5 * 60_000 });

  const slots = Array.from({ length: GUIDE_HOURS * 2 }, (_, at) => new Date(start.getTime() + at * 30 * 60_000));
  const width = GUIDE_HOURS * 60 * PX_PER_MINUTE;
  const nowLeft = ((now - start.getTime()) / 60_000) * PX_PER_MINUTE;
  const place = (program: BaseItem) => {
    const from = Math.max(Date.parse(program.StartDate ?? ""), start.getTime());
    const to = Math.min(Date.parse(program.EndDate ?? ""), end.getTime());
    return { left: ((from - start.getTime()) / 60_000) * PX_PER_MINUTE, width: Math.max(0, ((to - from) / 60_000) * PX_PER_MINUTE - 4) };
  };

  return (
    <div className="guide-wrap">
      <div className="guide-nav">
        <button className="btn-ghost" disabled={offsetHours <= 0} onClick={() => setOffsetHours((value) => Math.max(0, value - 3))}>
          ‹ Earlier
        </button>
        <span>{start.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</span>
        <button className="btn-ghost" disabled={offsetHours >= 7 * 24} onClick={() => setOffsetHours((value) => value + 3)}>
          Later ›
        </button>
      </div>
      {error ? <p className="empty">{error}</p> : null}
      <div className="guide" ref={scroller}>
        <div className="guide-grid" style={{ width: width + 180 }}>
          <div className="guide-times">
            <span className="guide-corner" />
            {slots.map((slot) => (
              <span key={slot.getTime()} style={{ width: 30 * PX_PER_MINUTE }}>
                {slot.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </span>
            ))}
          </div>
          {firstRow > 0 ? <div style={{ height: firstRow * GUIDE_ROW }} /> : null}
          {channels.slice(firstRow, lastRow).map((channel) => {
            const logo = primaryUrl(session, channel);
            return (
              <div key={channel.Id} className="guide-row">
                <button className="guide-channel" disabled={busy} onClick={() => void play(channel, { fromStart: true, returnTo: "/livetv" })} title={`Watch ${channel.Name}`}>
                  {logo ? <img src={logo} alt="" loading="lazy" /> : null}
                  <span>
                    <b>{channel.ChannelNumber}</b> {logo ? "" : channel.Name}
                  </span>
                </button>
                <div className="guide-programs" style={{ width }}>
                  {(data?.[channel.Id] ?? []).map((program) => {
                    const box = place(program);
                    if (box.width <= 0) return null;
                    const airing = Date.parse(program.StartDate ?? "") <= now && Date.parse(program.EndDate ?? "") > now;
                    return (
                      <button
                        key={program.Id}
                        className={`guide-program${airing ? " airing" : ""}`}
                        style={{ left: box.left, width: box.width }}
                        disabled={!airing || busy}
                        onClick={() => airing && void play(channel, { fromStart: true, returnTo: "/livetv" })}
                        title={[program.Name, program.EpisodeTitle, program.Overview].filter(Boolean).join("\n\n")}
                      >
                        <strong>{program.Name}</strong>
                        <small>
                          {clock(program.StartDate)} – {clock(program.EndDate)}
                          {program.EpisodeTitle ? ` · ${program.EpisodeTitle}` : ""}
                        </small>
                      </button>
                    );
                  })}
                  {!data ? <span className="guide-loading" /> : null}
                </div>
              </div>
            );
          })}
          {lastRow < channels.length ? <div style={{ height: (channels.length - lastRow) * GUIDE_ROW }} /> : null}
          {nowLeft > 0 && nowLeft < width ? <span className="guide-now" style={{ left: 180 + nowLeft }} /> : null}
        </div>
      </div>
    </div>
  );
}
