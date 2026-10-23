import { useMemo, useState } from "react";
import { useCached } from "../cache";
import { IconPlay } from "../icons";
import { usePlayback } from "../playback";
import { dayKey, isLive, isOver, nhlSchedule, parseDay, watchOptions, type NhlGame } from "../sports";
import type { BaseItem } from "../types";

const clock = (stamp: string) => new Date(stamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "12 CA EN: ROGERS SPORTSNET ONE HD" is a lot for a chip. */
function shortName(channel: BaseItem) {
  const name = channel.Name.replace(/^[A-Za-z]{2} ?[A-Za-z]{2}:\s*/, "").replace(/\bHD\b/i, "").replace(/\s+/g, " ").trim();
  return `${channel.ChannelNumber ? `${channel.ChannelNumber} ` : ""}${name}`.trim();
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** The NHL's games for a week, a day at a time, with the channels each is on. */
export function Hockey({
  channels,
  initial,
  back,
}: {
  channels: BaseItem[];
  /** The week and day to open on, from where a stream was left. */
  initial: { week: string | null; day: string | null };
  /** Where leaving a stream returns to, so it lands on this day again. */
  back: (view: Record<string, string>) => string;
}) {
  const { play, busy } = usePlayback();
  const today = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }, []);
  const [weekStart, setWeekStart] = useState(() => parseDay(initial.week) ?? today);
  const [selected, setSelected] = useState(() => (parseDay(initial.day) ? (initial.day as string) : dayKey(parseDay(initial.week) ?? today)));
  const days = useMemo(() => Array.from({ length: 7 }, (_, at) => addDays(weekStart, at)), [weekStart]);
  // The API files games under US Eastern days, so a local day can start in the one before and end in the one after.
  const first = useCached(`nhl:${dayKey(addDays(weekStart, -1))}`, () => nhlSchedule(dayKey(addDays(weekStart, -1))), { maxAge: 60_000 });
  const last = useCached(`nhl:${dayKey(addDays(weekStart, 6))}`, () => nhlSchedule(dayKey(addDays(weekStart, 6))), { maxAge: 60_000 });
  const loading = (first.loading && !first.data) || (last.loading && !last.data);
  const error = first.error || last.error;

  const byDay = useMemo(() => {
    const games = new Map<number, NhlGame>();
    for (const game of [...(first.data ?? []), ...(last.data ?? [])]) games.set(game.id, game);
    const grouped = new Map<string, NhlGame[]>();
    for (const game of games.values()) {
      const key = dayKey(new Date(game.startTimeUTC));
      grouped.set(key, [...(grouped.get(key) ?? []), game]);
    }
    for (const list of grouped.values()) list.sort((a, b) => Date.parse(a.startTimeUTC) - Date.parse(b.startTimeUTC));
    return grouped;
  }, [first.data, last.data]);

  const games = byDay.get(selected) ?? [];

  const move = (weeks: number) => {
    const start = addDays(weekStart, weeks * 7);
    setWeekStart(start);
    setSelected(dayKey(start));
  };

  return (
    <div className="hky">
      <div className="guide-nav">
        <button className="btn-ghost" onClick={() => move(-1)}>
          ‹ Earlier
        </button>
        <span>{`${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}</span>
        <button className="btn-ghost" onClick={() => move(1)}>
          Later ›
        </button>
      </div>
      <div className="chips hky-days">
        {days.map((date) => {
          const key = dayKey(date);
          const count = byDay.get(key)?.length ?? 0;
          return (
            <button key={key} className={key === selected ? "on" : ""} onClick={() => setSelected(key)}>
              {key === dayKey(today) ? "Today" : date.toLocaleDateString(undefined, { weekday: "short" })}
              <small className="chip-count">{count ? `${count} ${count === 1 ? "game" : "games"}` : ""}</small>
            </button>
          );
        })}
      </div>
      {error ? <p className="empty">{error}</p> : null}
      {loading ? <p className="empty">Loading the schedule…</p> : null}
      {!loading && !error && games.length === 0 ? <p className="empty">No NHL games this day.</p> : null}
      <div className="hky-games">
        {games.map((game) => {
          const options = watchOptions(game, channels);
          const live = isLive(game);
          const over = isOver(game);
          const best = options[0]?.channel;
          const watch = (channel: BaseItem) => void play(channel, { fromStart: true, returnTo: back({ week: dayKey(weekStart), day: selected }) });
          return (
            <div key={game.id} className={`hky-game${live ? " live" : ""}${over ? " over" : ""}`}>
              <button className="hky-main" disabled={busy || over || !best} onClick={() => best && watch(best)} title={best ? `Watch on ${best.Name}` : over ? "" : "Not on any of your channels"}>
                <span className="hky-team">
                  {game.awayTeam.logo ? <img src={game.awayTeam.logo} alt="" loading="lazy" /> : null}
                  <strong>{game.awayTeam.commonName.default}</strong>
                  <small>{game.awayTeam.placeName.default}</small>
                </span>
                <span className="hky-mid">
                  {live || over ? (
                    <b className="hky-score">
                      {game.awayTeam.score ?? 0} – {game.homeTeam.score ?? 0}
                    </b>
                  ) : (
                    <b>{clock(game.startTimeUTC)}</b>
                  )}
                  <small>{live ? "LIVE" : over ? "Final" : "at"}</small>
                </span>
                <span className="hky-team home">
                  {game.homeTeam.logo ? <img src={game.homeTeam.logo} alt="" loading="lazy" /> : null}
                  <strong>{game.homeTeam.commonName.default}</strong>
                  <small>{game.homeTeam.placeName.default}</small>
                </span>
                {best ? (
                  <span className="hky-play">
                    <IconPlay size={16} />
                  </span>
                ) : null}
              </button>
              <div className="hky-watch">
                {over ? (
                  <small>{game.venue?.default ?? ""}</small>
                ) : options.length ? (
                  <>
                    <small>{live ? "Watch" : "On"}</small>
                    {options.slice(0, 4).map((entry) => (
                      <button key={entry.channel.Id} className="hky-chip" disabled={busy} onClick={() => watch(entry.channel)}>
                        {shortName(entry.channel)}
                      </button>
                    ))}
                    {options.length > 4 ? <small>+{options.length - 4}</small> : null}
                  </>
                ) : (
                  <small>Not on your channels{game.tvBroadcasts?.length ? ` · ${[...new Set(game.tvBroadcasts.filter((entry) => entry.countryCode === "CA").map((entry) => entry.network))].join(", ") || game.tvBroadcasts[0].network}` : ""}</small>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
