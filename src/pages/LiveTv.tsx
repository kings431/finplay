import { useEffect, useMemo, useRef, useState } from "react";
import { useCached } from "../cache";
import { IconPlay } from "../icons";
import { primaryUrl, thumbUrl, tile } from "../media";
import { usePlayback } from "../playback";
import { useClient, useSession } from "../session";
import type { BaseItem } from "../types";

const PX_PER_MINUTE = 6;
const GUIDE_HOURS = 6;
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
  const [tab, setTab] = useState<"now" | "guide">("now");
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
          <button className={tab === "now" ? "on" : ""} onClick={() => setTab("now")}>
            On now
          </button>
          <button className={tab === "guide" ? "on" : ""} onClick={() => setTab("guide")}>
            Guide
          </button>
        </div>
      </header>
      {error ? <p className="empty">{error}</p> : null}
      {loading && !data ? <p className="empty">Loading channels…</p> : null}
      {data && channels.length === 0 ? <p className="empty">No channels yet. An admin can add a tuner and guide data under Dashboard → Live TV.</p> : null}
      {channels.length && tab === "now" ? (
        <>
          <div className="chips">
            {CATEGORIES.map((entry) => (
              <button key={entry.id} className={category === entry.id ? "on" : ""} onClick={() => setCategory(entry.id)}>
                {entry.label}
              </button>
            ))}
          </div>
          <OnNow channels={channels.filter((channel) => matcher(channel.CurrentProgram))} />
        </>
      ) : null}
      {channels.length && tab === "guide" ? <Guide channels={channels} /> : null}
    </div>
  );
}

function OnNow({ channels }: { channels: BaseItem[] }) {
  const session = useSession();
  const { play, busy } = usePlayback();
  const now = useNow(30_000);
  if (!channels.length) return <p className="empty">Nothing in this category is on right now.</p>;
  return (
    <div className="channel-grid">
      {channels.map((channel) => {
        const program = channel.CurrentProgram;
        const art = program ? thumbUrl(session, program) ?? primaryUrl(session, program) : undefined;
        const logo = primaryUrl(session, channel);
        return (
          <button key={channel.Id} className="channel-card" disabled={busy} onClick={() => void play(channel, { fromStart: true, returnTo: "/livetv" })}>
            <span className="channel-art" style={{ background: tile(channel.Name) }}>
              {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
              <span className="channel-badge">
                {logo ? <img src={logo} alt="" loading="lazy" /> : <b>{channel.ChannelNumber ?? channel.Name.slice(0, 3)}</b>}
              </span>
              <span className="channel-play">
                <IconPlay size={20} />
              </span>
              {program ? (
                <span className="channel-progress">
                  <span style={{ width: `${progressOf(program, now)}%` }} />
                </span>
              ) : null}
            </span>
            <span className="channel-copy">
              <strong>{program?.Name ?? channel.Name}</strong>
              <small>
                {[channel.ChannelNumber ? `${channel.ChannelNumber} ${channel.Name}` : channel.Name, program ? `${clock(program.StartDate)} – ${clock(program.EndDate)}` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
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
          {channels.map((channel) => {
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
          {nowLeft > 0 && nowLeft < width ? <span className="guide-now" style={{ left: 180 + nowLeft }} /> : null}
        </div>
      </div>
    </div>
  );
}
