import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useCached } from "../cache";
import { IconChart } from "../icons";
import type { Jellyfin } from "../jellyfin";
import { backdropUrl, episodeCode, primaryUrl, tile } from "../media";
import { useClient, useSession } from "../session";
import { loadSettings } from "../settings";
import { openStats } from "../stats";
import type { ActiveSession, BaseItem } from "../types";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "All time" },
];

type Ranked = { id: string; name: string; plays: number; seconds: number; users: number; item?: BaseItem };
type Slice = { label: string; plays: number; seconds: number };
type Play = { at: string; user: string; itemId: string; type: string; name: string; method: string; client: string; device: string; seconds: number };

type Report = {
  plays: number;
  seconds: number;
  users: number;
  titles: number;
  days: number;
  movieTitles: number;
  episodeTitles: number;
  timeline: Slice[];
  monthly: boolean;
  hours: number[];
  people: Slice[];
  movies: Ranked[];
  shows: Ranked[];
  clients: Slice[];
  methods: Slice[];
  recent: Play[];
};

export function Stats() {
  const client = useClient();
  const { isAdmin, userId } = useSession();
  const [days, setDays] = useState(30);
  const [statsError, setStatsError] = useState("");
  const streamystats = loadSettings().streamystatsUrl;
  const report = useCached(isAdmin ? `stats:${userId}:${days}` : null, () => buildReport(client, days), { maxAge: 60_000 });
  const live = useNowPlaying(isAdmin);

  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Stats</h1>
        </header>
        <p className="empty">Stats are only available to server administrators.</p>
      </div>
    );
  }

  const data = report.data;
  return (
    <div className="page stats-page">
      <header className="page-head">
        <div>
          <h1>Stats</h1>
          <p>What everyone is watching on your server.</p>
        </div>
        <div className="stats-head-actions">
          <div className="chips">
            {RANGES.map((range) => (
              <button key={range.days} className={range.days === days ? "on" : ""} onClick={() => setDays(range.days)}>
                {range.label}
              </button>
            ))}
          </div>
          {streamystats ? (
            <button
              className="btn-ghost"
              onClick={() => {
                setStatsError("");
                openStats(streamystats).catch((err: unknown) => setStatsError(err instanceof Error ? err.message : String(err)));
              }}
            >
              <IconChart size={15} />
              Streamystats
            </button>
          ) : null}
        </div>
      </header>
      {statsError ? <p className="empty error-text">{statsError}</p> : null}

      <NowPlaying sessions={live} />

      {report.error && !data ? (
        <p className="empty">
          Couldn't read playback history. Stats need the Playback Reporting plugin on your Jellyfin server. ({report.error})
        </p>
      ) : null}
      {!data && report.loading ? <p className="empty">Crunching the numbers…</p> : null}

      {data ? (
        <>
          <div className="stat-tiles">
            <Tile label="Plays" value={data.plays.toLocaleString()} detail={perDay(data)} />
            <Tile label="Watch time" value={hours(data.seconds)} detail={data.plays ? `${duration(Math.round(data.seconds / data.plays))} per play` : undefined} />
            <Tile label="Viewers" value={data.users.toLocaleString()} detail={data.people[0] ? `Most active: ${data.people[0].label}` : undefined} />
            <Tile label="Titles watched" value={data.titles.toLocaleString()} detail={`${data.movieTitles.toLocaleString()} movies · ${data.episodeTitles.toLocaleString()} episodes`} />
            <Tile label="Direct play" value={directShare(data.methods)} detail={transcodes(data.methods)} />
          </div>

          <section className="stat-card wide-card">
            <div className="stat-card-head">
              <h2>{data.monthly ? "Plays by month" : "Plays by day"}</h2>
              <small>{data.timeline.length ? `${data.timeline[0].label} to ${data.timeline[data.timeline.length - 1].label}` : ""}</small>
            </div>
            <Timeline slices={data.timeline} monthly={data.monthly} />
          </section>

          <RankedRow title="Most watched movies" items={data.movies} />
          <RankedRow title="Most watched shows" items={data.shows} />

          <div className="stat-grid">
            <section className="stat-card">
              <div className="stat-card-head">
                <h2>Top viewers</h2>
                <small>by watch time</small>
              </div>
              <Bars slices={data.people} measure="seconds" />
            </section>
            <section className="stat-card">
              <div className="stat-card-head">
                <h2>When people watch</h2>
                <small>plays by hour</small>
              </div>
              <HourChart hours={data.hours} />
            </section>
            <section className="stat-card">
              <div className="stat-card-head">
                <h2>Apps</h2>
                <small>by plays</small>
              </div>
              <Bars slices={data.clients} measure="plays" />
            </section>
            <section className="stat-card">
              <div className="stat-card-head">
                <h2>How it played</h2>
                <small>by plays</small>
              </div>
              <Bars slices={data.methods} measure="plays" />
            </section>
          </div>

          <section className="stat-card wide-card">
            <div className="stat-card-head">
              <h2>Recent activity</h2>
            </div>
            <History plays={data.recent} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function useNowPlaying(enabled: boolean) {
  const client = useClient();
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancel = false;
    const load = () =>
      client
        .nowPlaying()
        .then((list) => {
          if (!cancel) setSessions(list);
        })
        .catch(() => {});
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [client, enabled]);
  return sessions;
}

function NowPlaying({ sessions }: { sessions: ActiveSession[] }) {
  const session = useSession();
  const navigate = useNavigate();
  return (
    <section className="stat-section">
      <div className="row-head">
        <div>
          <h2>
            Now playing <span className="count-pill">{sessions.length}</span>
          </h2>
        </div>
      </div>
      {sessions.length === 0 ? (
        <p className="empty">Nobody is watching right now.</p>
      ) : (
        <div className="live-grid">
          {sessions.map((entry) => {
            const item = entry.NowPlayingItem!;
            const art = backdropUrl(session, item);
            const position = (entry.PlayState?.PositionTicks ?? 0) / 10_000_000;
            const total = (item.RunTimeTicks ?? 0) / 10_000_000;
            const percent = total ? Math.min(100, (position / total) * 100) : 0;
            return (
              <button key={entry.Id} className="live-card" onClick={() => navigate(`/item/${item.Id}`)}>
                <span className="live-art" style={{ background: tile(item.Name) }}>
                  {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
                  <span className="live-shade" />
                  <span className="live-user">
                    <b>{(entry.UserName ?? "?").slice(0, 1).toUpperCase()}</b>
                    {entry.UserName}
                    {entry.PlayState?.IsPaused ? <em>Paused</em> : null}
                  </span>
                  <span className="live-copy">
                    {item.SeriesName ? <small>{[item.SeriesName, episodeCode(item)].filter(Boolean).join(" · ")}</small> : null}
                    <strong>{item.Name}</strong>
                  </span>
                </span>
                <span className="live-meta">
                  <span>{[entry.Client, entry.DeviceName].filter(Boolean).join(" · ")}</span>
                  <span className={entry.TranscodingInfo && !entry.TranscodingInfo.IsVideoDirect ? "method transcode" : "method"}>{methodLabel(entry)}</span>
                </span>
                <span className="live-progress">
                  <span style={{ width: `${percent}%` }} />
                </span>
                <span className="live-time">
                  {clock(position)} / {clock(total)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="stat-tile">
      <small>{label}</small>
      <strong>{value}</strong>
      {detail ? <em>{detail}</em> : null}
    </div>
  );
}

function ChartTip({ index, count, lift, children }: { index: number; count: number; lift: number; children: ReactNode }) {
  const left = ((index + 0.5) / count) * 100;
  const edge = left < 12 ? " start" : left > 88 ? " end" : "";
  return (
    <div className={`chart-tip${edge}`} style={{ left: `${left}%`, bottom: `calc(${lift}% + 8px)` }}>
      {children}
    </div>
  );
}

function Timeline({ slices, monthly }: { slices: Slice[]; monthly: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  if (slices.length === 0) return <p className="stat-empty">No plays in this range.</p>;
  const max = Math.max(...slices.map((slice) => slice.plays), 1);
  const height = (plays: number) => Math.max(2, (plays / max) * 100);
  const shown = hover === null ? undefined : slices[hover];
  return (
    <div className="timeline" onMouseLeave={() => setHover(null)}>
      {slices.map((slice, index) => (
        <div key={slice.label} className={`timeline-bar${index === hover ? " on" : ""}`} onMouseEnter={() => setHover(index)}>
          <span style={{ height: `${height(slice.plays)}%` }} />
        </div>
      ))}
      {shown && hover !== null ? (
        <ChartTip index={hover} count={slices.length} lift={height(shown.plays)}>
          <b>{bucketLabel(shown.label, monthly)}</b>
          <span>
            {shown.plays.toLocaleString()} {shown.plays === 1 ? "play" : "plays"} · {hours(shown.seconds)}
          </span>
          {shown.plays ? <small>{duration(Math.round(shown.seconds / shown.plays))} per play</small> : null}
        </ChartTip>
      ) : null}
    </div>
  );
}

function HourChart({ hours: counts }: { hours: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...counts, 1);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const peak = counts.indexOf(Math.max(...counts));
  const height = (count: number) => Math.max(3, (count / max) * 100);
  return (
    <>
      <div className="hour-chart" onMouseLeave={() => setHover(null)}>
        {counts.map((count, hour) => (
          <div key={hour} className={`hour-bar${hour === peak && count > 0 ? " peak" : ""}${hour === hover ? " on" : ""}`} onMouseEnter={() => setHover(hour)}>
            <span style={{ height: `${height(count)}%` }} />
          </div>
        ))}
        {hover !== null ? (
          <ChartTip index={hover} count={24} lift={height(counts[hover])}>
            <b>
              {hourLabel(hover)} – {hourLabel((hover + 1) % 24)}
            </b>
            <span>
              {counts[hover].toLocaleString()} {counts[hover] === 1 ? "play" : "plays"}
            </span>
            {total ? <small>{share(counts[hover], total)} of all plays</small> : null}
          </ChartTip>
        ) : null}
      </div>
      <div className="hour-axis">
        <span>12am</span>
        <span>6am</span>
        <span>12pm</span>
        <span>6pm</span>
        <span>12am</span>
      </div>
      {counts.some(Boolean) ? <p className="stat-note">Busiest around {hourLabel(peak)}.</p> : null}
    </>
  );
}

function Bars({ slices, measure }: { slices: Slice[]; measure: "plays" | "seconds" }) {
  if (slices.length === 0) return <p className="stat-empty">Nothing yet.</p>;
  const max = Math.max(...slices.map((slice) => slice[measure]), 1);
  const total = slices.reduce((sum, slice) => sum + slice[measure], 0);
  return (
    <div className="bars">
      {slices.map((slice) => (
        <div key={slice.label} className="bar-row">
          <span className="bar-tip">
            {slice.plays.toLocaleString()} {slice.plays === 1 ? "play" : "plays"} · {hours(slice.seconds)} · {share(slice[measure], total)}
          </span>
          <span className="bar-label">{slice.label}</span>
          <span className="bar-track">
            <span style={{ width: `${(slice[measure] / max) * 100}%` }} />
          </span>
          <span className="bar-value">{measure === "plays" ? slice.plays.toLocaleString() : hours(slice.seconds)}</span>
        </div>
      ))}
    </div>
  );
}

function RankedRow({ title, items }: { title: string; items: Ranked[] }) {
  const session = useSession();
  const navigate = useNavigate();
  if (items.length === 0) return null;
  return (
    <section className="row">
      <div className="row-head">
        <h2>{title}</h2>
      </div>
      <div className="row-track stat-ranked">
        {items.map((entry, index) => {
          const art = entry.item ? primaryUrl(session, entry.item) : undefined;
          return (
            <button key={entry.id} className="poster" disabled={!entry.item} onClick={() => entry.item && navigate(`/item/${entry.item.Id}`)}>
              <span className="poster-art" style={{ background: tile(entry.name) }}>
                {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : <span className="poster-fallback">{entry.name}</span>}
                <em className="rank-badge">#{index + 1}</em>
              </span>
              <span className="poster-title">
                {entry.item?.Name ?? entry.name}
                <small>
                  {" "}
                  {entry.plays} plays · {hours(entry.seconds)}
                  {entry.users > 1 ? ` · ${entry.users} viewers` : ""}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function History({ plays }: { plays: Play[] }) {
  const navigate = useNavigate();
  if (plays.length === 0) return <p className="stat-empty">No plays yet.</p>;
  return (
    <div className="history">
      {plays.map((play, index) => (
        <button key={`${play.at}-${index}`} className="history-row" onClick={() => navigate(`/item/${play.itemId}`)}>
          <span className="history-user">
            <b>{play.user.slice(0, 1).toUpperCase()}</b>
            {play.user}
          </span>
          <span className="history-item">
            <strong>{play.name}</strong>
            <small>{[play.client, play.device].filter(Boolean).join(" · ")}</small>
          </span>
          <span className={`method${play.method.startsWith("Transcode") ? " transcode" : ""}`}>{play.method.startsWith("Transcode") ? "Transcode" : spaced(play.method)}</span>
          <span className="history-duration">{duration(play.seconds)}</span>
          <span className="history-when">{ago(play.at)}</span>
        </button>
      ))}
    </div>
  );
}

async function buildReport(client: Jellyfin, days: number): Promise<Report> {
  const where = days > 0 ? `WHERE DateCreated >= datetime('now', 'localtime', '-${Math.floor(days)} days')` : "WHERE 1 = 1";
  const monthly = days === 0 || days > 120;
  const bucket = monthly ? "strftime('%Y-%m', DateCreated)" : "date(DateCreated)";
  const seconds = "SUM(CASE WHEN PlayDuration BETWEEN 0 AND 172800 THEN PlayDuration ELSE 0 END)";
  const sum = `CAST(${seconds} AS TEXT)`;
  const query = (sql: string) => client.playbackQuery(sql);
  const [totals, timeline, hourly, people, movies, shows, clients, methods, recent] = await Promise.all([
    query(`SELECT COUNT(*), ${sum}, COUNT(DISTINCT UserId), COUNT(DISTINCT ItemId), COUNT(DISTINCT CASE WHEN ItemType = 'Movie' THEN ItemId END), COUNT(DISTINCT CASE WHEN ItemType = 'Episode' THEN ItemId END) FROM PlaybackActivity ${where}`),
    query(`SELECT ${bucket} AS bucket, COUNT(*), ${sum} FROM PlaybackActivity ${where} GROUP BY bucket ORDER BY bucket`),
    query(`SELECT strftime('%H', DateCreated) AS hour, COUNT(*) FROM PlaybackActivity ${where} GROUP BY hour`),
    query(`SELECT UserId, COUNT(*), ${sum} FROM PlaybackActivity ${where} GROUP BY UserId ORDER BY ${seconds} DESC LIMIT 8`),
    query(
      `SELECT ItemId, ItemName, COUNT(*) AS plays, ${sum}, COUNT(DISTINCT UserId) FROM PlaybackActivity ${where} AND ItemType = 'Movie' GROUP BY ItemId ORDER BY plays DESC, ${seconds} DESC LIMIT 15`,
    ),
    query(
      `SELECT MAX(ItemId), substr(ItemName, 1, instr(ItemName, ' - s') - 1) AS series, COUNT(*) AS plays, ${sum}, COUNT(DISTINCT UserId) FROM PlaybackActivity ${where} AND ItemType = 'Episode' AND instr(ItemName, ' - s') > 1 GROUP BY series ORDER BY plays DESC, ${seconds} DESC LIMIT 15`,
    ),
    query(`SELECT ClientName, COUNT(*) AS plays, ${sum} FROM PlaybackActivity ${where} GROUP BY ClientName ORDER BY plays DESC LIMIT 8`),
    query(
      `SELECT CASE WHEN PlaybackMethod LIKE 'Transcode%' THEN 'Transcode' ELSE PlaybackMethod END AS method, COUNT(*) AS plays, ${sum} FROM PlaybackActivity ${where} GROUP BY method ORDER BY plays DESC`,
    ),
    query(
      `SELECT DateCreated, UserId, ItemId, ItemType, ItemName, PlaybackMethod, ClientName, DeviceName, PlayDuration FROM PlaybackActivity ${where} ORDER BY DateCreated DESC LIMIT 30`,
    ),
  ]);

  const movieRanks = movies.map(ranked);
  const showRanks = shows.map(ranked);
  const [movieItems, episodeItems] = await Promise.all([
    client.itemsByIds(movieRanks.map((entry) => entry.id)).catch(() => [] as BaseItem[]),
    client.itemsByIds(showRanks.map((entry) => entry.id)).catch(() => [] as BaseItem[]),
  ]);
  const seriesIds = [...new Set(episodeItems.map((episode) => episode.SeriesId).filter((id): id is string => Boolean(id)))];
  const seriesItems = await client.itemsByIds(seriesIds).catch(() => [] as BaseItem[]);
  const byId = new Map([...movieItems, ...seriesItems].map((item) => [item.Id, item]));
  const episodeSeries = new Map(episodeItems.map((episode) => [episode.Id, episode.SeriesId ? byId.get(episode.SeriesId) : undefined]));
  for (const entry of movieRanks) entry.item = byId.get(entry.id);
  for (const entry of showRanks) entry.item = episodeSeries.get(entry.id);

  const hours = Array.from({ length: 24 }, () => 0);
  for (const [hour, count] of hourly) {
    const index = Number(hour);
    if (index >= 0 && index < 24) hours[index] = Number(count) || 0;
  }

  const [total] = totals;
  return {
    plays: Number(total?.[0]) || 0,
    seconds: Number(total?.[1]) || 0,
    users: Number(total?.[2]) || 0,
    titles: Number(total?.[3]) || 0,
    days,
    movieTitles: Number(total?.[4]) || 0,
    episodeTitles: Number(total?.[5]) || 0,
    timeline: timeline.map(([label, plays, seconds]) => ({ label: label ?? "", plays: Number(plays) || 0, seconds: Number(seconds) || 0 })),
    monthly,
    hours,
    people: people.map(slice),
    movies: movieRanks,
    shows: showRanks,
    clients: clients.map(slice),
    methods: methods.map(([label, plays, seconds]) => ({ label: spaced(label ?? "Unknown"), plays: Number(plays) || 0, seconds: Number(seconds) || 0 })),
    recent: recent.map(([at, user, itemId, type, name, method, clientName, device, seconds]) => ({
      at: at ?? "",
      user: user || "Unknown",
      itemId: itemId ?? "",
      type: type ?? "",
      name: name ?? "",
      method: method ?? "",
      client: clientName ?? "",
      device: device ?? "",
      seconds: Number(seconds) || 0,
    })),
  };
}

function ranked([id, name, plays, seconds, users]: string[]): Ranked {
  return { id: id ?? "", name: name ?? "", plays: Number(plays) || 0, seconds: Number(seconds) || 0, users: Number(users) || 0 };
}

function slice([label, plays, seconds]: string[]): Slice {
  return { label: label || "Unknown", plays: Number(plays) || 0, seconds: Number(seconds) || 0 };
}

function methodLabel(session: ActiveSession) {
  const info = session.TranscodingInfo;
  if (!info || (info.IsVideoDirect && info.IsAudioDirect)) return session.PlayState?.PlayMethod === "DirectStream" ? "Direct stream" : "Direct play";
  const video = info.IsVideoDirect ? "video direct" : (info.VideoCodec ?? "").toUpperCase();
  const rate = info.Bitrate ? `${(info.Bitrate / 1_000_000).toFixed(1)} Mbps` : "";
  return ["Transcode", [video, rate].filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
}

function directShare(methods: Slice[]) {
  const total = methods.reduce((sum, method) => sum + method.plays, 0);
  if (!total) return "–";
  const direct = methods.filter((method) => !method.label.startsWith("Transcode")).reduce((sum, method) => sum + method.plays, 0);
  return `${Math.round((direct / total) * 100)}%`;
}

function transcodes(methods: Slice[]) {
  const count = methods.filter((method) => method.label.startsWith("Transcode")).reduce((sum, method) => sum + method.plays, 0);
  return count ? `${count.toLocaleString()} ${count === 1 ? "play" : "plays"} transcoded` : "Nothing transcoded";
}

function perDay(report: Report) {
  const span = report.days || report.timeline.length * 30.4;
  if (!report.plays || !span) return undefined;
  const rate = report.plays / span;
  return `About ${rate >= 10 ? Math.round(rate).toLocaleString() : rate.toFixed(1)} a day`;
}

function share(part: number, total: number) {
  if (!total) return "0%";
  const percent = (part / total) * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function bucketLabel(label: string, monthly: boolean) {
  const [year, month, day] = label.split("-").map(Number);
  if (!year || !month) return label;
  const date = new Date(year, month - 1, day || 1);
  return monthly
    ? date.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function spaced(label: string) {
  return label.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());
}

function hours(seconds: number) {
  if (seconds >= 3600 * 100) return `${Math.round(seconds / 3600).toLocaleString()} h`;
  if (seconds >= 3600) {
    const whole = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes ? `${whole}h ${minutes}m` : `${whole}h`;
  }
  return `${Math.max(0, Math.round(seconds / 60))}m`;
}

function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return hours(seconds);
}

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function hourLabel(hour: number) {
  const suffix = hour < 12 ? "am" : "pm";
  return `${hour % 12 || 12}${suffix}`;
}

function ago(stamp: string) {
  const when = new Date(stamp.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
  const seconds = (Date.now() - when.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.round(seconds / 86400)}d ago`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
