import { inTauri } from "./player";
import type { BaseItem } from "./types";

type Named = { default: string };
type Team = { abbrev: string; commonName: Named; placeName: Named; logo?: string; darkLogo?: string; score?: number };
type Broadcast = { network: string; countryCode: string };

/** One game, as the NHL's schedule API describes it. */
export type NhlGame = {
  id: number;
  startTimeUTC: string;
  gameState: string;
  venue?: Named;
  awayTeam: Team;
  homeTeam: Team;
  tvBroadcasts?: Broadcast[];
};

type Schedule = { gameWeek?: { date: string; games: NhlGame[] }[] };

/** Local calendar day as YYYY-MM-DD, which is also how the API takes a date. */
export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** A YYYY-MM-DD day key back to a local date, or null if it isn't one. */
export function parseDay(key: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The week of games starting at `date`. The desktop app asks through its backend (the API sends no CORS
 * headers); the TV app's package may call out freely. */
export async function nhlSchedule(date: string): Promise<NhlGame[]> {
  let text: string;
  if (inTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    text = await invoke<string>("sports_schedule", { date });
  } else {
    const response = await fetch(`https://api-web.nhle.com/v1/schedule/${date}`);
    if (!response.ok) throw new Error(`The schedule is unavailable (${response.status}).`);
    text = await response.text();
  }
  const schedule = JSON.parse(text) as Schedule;
  return (schedule.gameWeek ?? []).flatMap((day) => day.games ?? []);
}

export const isLive = (game: NhlGame) => game.gameState === "LIVE" || game.gameState === "CRIT";
export const isOver = (game: NhlGame) => game.gameState === "FINAL" || game.gameState === "OFF";

/** Broadcaster codes in the schedule, and what their channels are called (as `plain` reads them). */
const NETWORKS: Record<string, RegExp> = {
  // Canada
  SN: /sportsnet (east|west|pacific|ontario|one)\b/,
  SNE: /sportsnet east/,
  SNW: /sportsnet west/,
  SNP: /sportsnet pacific/,
  SNO: /sportsnet ontario/,
  SN1: /sportsnet one/,
  SN360: /sportsn ?et (et )?360/,
  TSN: /\btsn ?[1-5]\b/,
  TSN1: /\btsn ?1\b/,
  TSN2: /\btsn ?2\b/,
  TSN3: /\btsn ?3\b/,
  TSN4: /\btsn ?4\b/,
  TSN5: /\btsn ?5\b/,
  TVAS: /tva sports?(?![a-z])(?! ?2)/,
  "TVAS-D": /tva sports?(?![a-z])/,
  TVAS2: /tva sports?(?![a-z]) ?2/,
  RDS: /\brds\b(?! ?(info|2))/,
  RDSI: /rds ?(info|2)/,
  RDS2: /rds ?2/,
  CBC: /\bcbc\b(?! (news|kids))/,
  CITY: /\bcity ?tv\b|\bcity\b/,
  // United States, national
  NHLN: /nhl network/,
  ESPN: /^(us:? )?espn( usa)?$/,
  ESPN2: /\bespn ?2\b/,
  ABC: /^(us:? )?abc$/,
  TNT: /^(us:? )?tnt\b/,
  TRUTV: /\btru ?tv\b/,
  // United States, regional
  MSG: /^(us:? )?msg\b(?! ?(2|plus|sportsnet|sn))/,
  "MSG 2": /^(us:? )?msg ?2\b/,
  "MSG-B": /msg.*buffalo|msg ?b\b/,
  MSGSN: /msg ?(sn|sportsnet)\b(?! ?2)/,
  MSGSN2: /msg ?(sn|sportsnet) ?2\b/,
  NESN: /\bnesn\b/,
  ALT: /\baltitude\b/,
  CHSN: /chicago sports network|\bchsn\b/,
  "CHSN+": /chicago sports network (plus|\+)|\bchsn ?\+/,
  NBCSCA: /nbc ?sports (california|bay)/,
  NBCSP: /nbc ?sports philadelphia/,
  MNMT: /monumental/,
  "SN-PIT": /sportsnet pittsburgh/,
  DSN: /(fanduel|bally) sports( network)? detroit/,
  FDSN: /(fanduel|bally) sports/,
};

/** Networks that broadcast in French, offered only when nothing in English is. */
const FRENCH = new Set(["TVAS", "TVAS-D", "TVAS2", "RDS", "RDSI", "RDS2"]);

/** A channel's name the way matching reads it: lower case, no lineup prefix or "HD". */
function plain(name: string) {
  return name
    .toLowerCase()
    .replace(/^[a-z]{2} ?[a-z]{2}:\s*/, "")
    .replace(/\brogers\b/g, "")
    .replace(/\b(hd|fhd|uhd|4k)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function said(item: BaseItem | undefined) {
  return [item?.Name, item?.EpisodeTitle, item?.Overview].filter(Boolean).join(" ").toLowerCase();
}

/** The names a guide entry might use for a team, longest first: "maple leafs", "toronto". */
function teamNames(team: Team) {
  return [team.commonName.default, team.placeName.default].map((name) => name.toLowerCase()).filter((name) => name.length >= 4);
}

const mentions = (text: string, team: Team) => teamNames(team).some((name) => text.includes(name));

export type Watch = { channel: BaseItem; reason: "airing" | "network" | "team" };

/** How far from puck drop a guide entry may start and still be about this game:
 * "Upcoming" entries run up to the start, the game itself about three hours. */
const BEFORE = 12 * 60 * 60 * 1000;
const AFTER = 4 * 60 * 60 * 1000;

/**
 * The channels a game is on, best first, so the first is where a click goes:
 * a channel whose guide names both teams around the game's time (per-game
 * event channels, or a network's own listing), then the game's broadcasters,
 * then a team's own feed. French channels only when there is nothing else.
 * `programs` is the guide around the game's day; without it the channels'
 * current programmes are used.
 */
export function watchOptions(game: NhlGame, channels: BaseItem[], programs: BaseItem[] = []): Watch[] {
  const found = new Map<string, Watch>();
  const start = Date.parse(game.startTimeUTC);
  const near = (program: BaseItem) => {
    const from = Date.parse(program.StartDate ?? "");
    const to = Date.parse(program.EndDate ?? "");
    return Number.isFinite(from) && Number.isFinite(to) && from <= start + AFTER && to >= start - 60 * 60 * 1000 && from >= start - BEFORE;
  };
  const byId = new Map(channels.map((channel) => [channel.Id, channel]));
  const about = (text: string) => mentions(text, game.awayTeam) && mentions(text, game.homeTeam) && !/\b(replay|classic|best of|highlights)\b|^ended\b/.test(text);
  // How long after puck drop a listing picks the game up; one that covers it from the start is 0.
  const late = new Map<string, number>();
  for (const program of programs) {
    const channel = program.ChannelId ? byId.get(program.ChannelId) : undefined;
    if (!channel || !near(program) || !about(said(program))) continue;
    const gap = Math.max(0, Date.parse(program.StartDate ?? "") - start - 15 * 60 * 1000);
    late.set(channel.Id, Math.min(late.get(channel.Id) ?? Infinity, gap));
  }
  for (const [id, gap] of [...late].sort((a, b) => a[1] - b[1])) {
    const channel = byId.get(id);
    if (channel && gap === 0) found.set(id, { channel, reason: "airing" });
  }
  const joining = [...late].filter(([, gap]) => gap > 0).sort((a, b) => a[1] - b[1]);
  if (isLive(game)) {
    for (const channel of channels) if (!found.has(channel.Id) && about(said(channel.CurrentProgram))) found.set(channel.Id, { channel, reason: "airing" });
  }
  const nets = [...new Set((game.tvBroadcasts ?? []).map((entry) => entry.network.toUpperCase()))].filter((code) => NETWORKS[code]);
  const french: Watch[] = [];
  for (const code of nets) {
    for (const channel of channels) {
      if (found.has(channel.Id) || late.has(channel.Id) || !NETWORKS[code].test(plain(channel.Name))) continue;
      const watch: Watch = { channel, reason: "network" };
      if (FRENCH.has(code)) french.push(watch);
      else found.set(channel.Id, watch);
    }
  }
  // A team's own feed, named after it in full ("US: Winnipeg Jets").
  for (const team of [game.homeTeam, game.awayTeam]) {
    const full = `${team.placeName.default} ${team.commonName.default}`.toLowerCase();
    for (const channel of channels) if (!found.has(channel.Id) && plain(channel.Name).includes(full)) found.set(channel.Id, { channel, reason: "team" });
  }
  // Channels that join the game in progress, after everything that has it from the start.
  for (const [id] of joining) {
    const channel = byId.get(id);
    if (channel && !found.has(id)) found.set(id, { channel, reason: "airing" });
  }
  if (found.size === 0) for (const watch of french) found.set(watch.channel.Id, watch);
  return [...found.values()];
}
