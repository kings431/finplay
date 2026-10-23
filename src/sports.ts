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

/** Canadian broadcasters' codes in the schedule, and what their channels are called. */
const NETWORKS: Record<string, RegExp> = {
  SN: /sportsnet (east|west|pacific|ontario|one)/,
  SNE: /sportsnet east/,
  SNW: /sportsnet west/,
  SNP: /sportsnet pacific/,
  SNO: /sportsnet ontario/,
  SN1: /sportsnet one/,
  SN360: /sportsnet (et )?360/,
  TSN: /\btsn ?[1-5]\b/,
  TSN1: /\btsn ?1\b/,
  TSN2: /\btsn ?2\b/,
  TSN3: /\btsn ?3\b/,
  TSN4: /\btsn ?4\b/,
  TSN5: /\btsn ?5\b/,
  TVAS: /tva sports?(?![a-z])(?! ?2)/,
  TVAS2: /tva sports?(?![a-z]) ?2/,
  RDS: /\brds\b(?! ?(info|2))/,
  RDSI: /rds ?(info|2)/,
  RDS2: /rds ?2/,
  NHLN: /nhl network/,
  CBC: /\bcbc\b(?! (news|kids))/,
  CITY: /\bcity ?tv\b|\bcity\b/,
};

/** A channel's name the way matching reads it: lower case, no lineup prefix or "HD". */
function plain(name: string) {
  return name
    .toLowerCase()
    .replace(/^[a-z]{2} ?[a-z]{2}:\s*/, "")
    .replace(/\brogers\b/g, "")
    .replace(/\bhd\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function text(channel: BaseItem) {
  const program = channel.CurrentProgram;
  return [program?.Name, program?.EpisodeTitle, program?.Overview].filter(Boolean).join(" ").toLowerCase();
}

export type Watch = { channel: BaseItem; reason: "airing" | "network" };

/**
 * The channels a game is on: any whose current programme names one of the
 * teams (a game under way), then those on the game's Canadian broadcasters.
 * Best first, so the first is where a click goes.
 */
export function watchOptions(game: NhlGame, channels: BaseItem[]): Watch[] {
  const found = new Map<string, Watch>();
  if (isLive(game)) {
    const names = [game.awayTeam, game.homeTeam].flatMap((team) => [team.commonName.default, team.placeName.default]).map((name) => name.toLowerCase());
    for (const channel of channels) {
      const shown = text(channel);
      const hits = names.filter((name) => name.length >= 4 && shown.includes(name)).length;
      if (hits >= 2) found.set(channel.Id, { channel, reason: "airing" });
    }
  }
  const nets = (game.tvBroadcasts ?? []).filter((entry) => entry.countryCode === "CA");
  for (const net of nets) {
    const pattern = NETWORKS[net.network.toUpperCase()];
    if (!pattern) continue;
    for (const channel of channels) {
      if (!found.has(channel.Id) && pattern.test(plain(channel.Name))) found.set(channel.Id, { channel, reason: "network" });
    }
  }
  return [...found.values()];
}
