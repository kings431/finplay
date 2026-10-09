import type {
  ActiveSession,
  BaseItem,
  ItemList,
  MediaSegment,
  PlaybackInfo,
  SeerrRequestPage,
  SeerrResult,
  SeerrSearch,
  SeerrTv,
  SyncGroup,
} from "./types";
import { deviceProfile } from "./profile";

export type Auth = {
  server: string;
  token: string;
  userId: string;
  deviceId: string;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CLIENT = "Finplay";
const VERSION = "0.3.8";
const DEVICE = "Desktop";

export function normalizeServer(input: string) {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Server address needs to start with http:// or https://");
  }
  return trimmed;
}

function authHeader(deviceId: string, token?: string) {
  const tokenPart = token ? `, Token="${token}"` : "";
  return `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId}", Version="${VERSION}"${tokenPart}`;
}

const LIST_FIELDS = "Overview,Genres,CommunityRating,OfficialRating,RunTimeTicks,ChildCount,PrimaryImageAspectRatio";

export class Jellyfin {
  constructor(
    readonly auth: Auth,
    private onUnauthorized: () => void,
  ) {}

  private static async anonymous(server: string, deviceId: string, path: string, body?: unknown) {
    try {
      return await fetch(`${server}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: authHeader(deviceId),
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Could not reach that server. Check the address.");
    }
  }

  static async login(server: string, username: string, password: string, deviceId: string) {
    const response = await Jellyfin.anonymous(server, deviceId, "/Users/AuthenticateByName", { Username: username, Pw: password });
    if (!response.ok) {
      if (response.status === 401) throw new Error("That username or password was not accepted.");
      throw new Error(`Could not reach the server (${response.status}).`);
    }
    return Jellyfin.signedIn(response);
  }

  static async publicUsers(server: string, deviceId: string) {
    const response = await Jellyfin.anonymous(server, deviceId, "/Users/Public");
    if (!response.ok) return [];
    return (await response.json()) as { Id: string; Name: string; PrimaryImageTag?: string; HasPassword?: boolean }[];
  }

  static async quickConnectStart(server: string, deviceId: string) {
    const enabled = await Jellyfin.anonymous(server, deviceId, "/QuickConnect/Enabled");
    if (!enabled.ok || (await enabled.json()) !== true) throw new Error("Quick Connect is turned off on this server. An admin can enable it in Dashboard → General.");
    const response = await fetch(`${server}/QuickConnect/Initiate`, { method: "POST", headers: { Authorization: authHeader(deviceId), Accept: "application/json" } });
    if (!response.ok) throw new Error(`Quick Connect could not start (${response.status}).`);
    return (await response.json()) as { Secret: string; Code: string };
  }

  static async quickConnectReady(server: string, deviceId: string, secret: string) {
    const response = await Jellyfin.anonymous(server, deviceId, `/QuickConnect/Connect?${new URLSearchParams({ Secret: secret })}`);
    if (response.status === 404) throw new Error("That code expired. Start again for a new one.");
    if (!response.ok) return false;
    return ((await response.json()) as { Authenticated?: boolean }).Authenticated === true;
  }

  static async quickConnectLogin(server: string, deviceId: string, secret: string) {
    const response = await Jellyfin.anonymous(server, deviceId, "/Users/AuthenticateWithQuickConnect", { Secret: secret });
    if (!response.ok) throw new Error(`Quick Connect sign-in failed (${response.status}).`);
    return Jellyfin.signedIn(response);
  }

  private static async signedIn(response: Response) {
    const body = (await response.json()) as {
      AccessToken: string;
      User: { Id: string; Name: string; PrimaryImageTag?: string; Policy?: { IsAdministrator?: boolean } };
    };
    return {
      token: body.AccessToken,
      userId: body.User.Id,
      username: body.User.Name,
      imageTag: body.User.PrimaryImageTag,
      isAdmin: body.User.Policy?.IsAdministrator === true,
    };
  }

  async quickConnectAuthorize(code: string) {
    const params = new URLSearchParams({ code: code.trim(), userId: this.auth.userId });
    await this.send("POST", `/QuickConnect/Authorize?${params}`);
  }

  async signOut() {
    await this.send("POST", "/Sessions/Logout");
  }

  me() {
    return this.json<{ Name: string; Id: string; PrimaryImageTag?: string; Policy?: { IsAdministrator?: boolean } }>("/Users/Me");
  }

  async serverName() {
    const info = await this.json<{ ServerName?: string }>("/System/Info/Public");
    return info.ServerName?.trim() || "";
  }

  views() {
    return this.json<ItemList>(`/Users/${this.auth.userId}/Views`);
  }

  resume() {
    return this.json<ItemList>(
      `/Users/${this.auth.userId}/Items/Resume?Limit=24&MediaTypes=Video&Fields=${LIST_FIELDS}&EnableImageTypes=Primary,Backdrop,Thumb,Logo`,
    );
  }

  nextUp(seriesId?: string) {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      Limit: "24",
      Fields: LIST_FIELDS,
      EnableImageTypes: "Primary,Backdrop,Thumb,Logo",
    });
    if (seriesId) params.set("SeriesId", seriesId);
    return this.json<ItemList>(`/Shows/NextUp?${params}`);
  }

  latest(parentId?: string, includeItemTypes?: string) {
    const params = new URLSearchParams({
      Limit: "18",
      Fields: LIST_FIELDS,
      EnableImageTypes: "Primary,Backdrop,Thumb,Logo",
    });
    if (parentId) params.set("ParentId", parentId);
    if (includeItemTypes) params.set("IncludeItemTypes", includeItemTypes);
    return this.json<BaseItem[]>(`/Users/${this.auth.userId}/Items/Latest?${params}`);
  }

  items(options: {
    parentId?: string;
    includeItemTypes?: string;
    sortBy?: string;
    sortOrder?: string;
    startIndex?: number;
    limit?: number;
    filters?: string;
    searchTerm?: string;
    recursive?: boolean;
    genres?: string;
    years?: string;
    /** Extra Jellyfin query parameters such as MinCommunityRating. */
    extra?: Record<string, string>;
  }) {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      Recursive: String(options.recursive ?? true),
      Fields: LIST_FIELDS,
      Limit: String(options.limit ?? 60),
      StartIndex: String(options.startIndex ?? 0),
      EnableImageTypes: "Primary,Backdrop,Thumb,Logo",
    });
    if (options.parentId) params.set("ParentId", options.parentId);
    if (options.includeItemTypes) params.set("IncludeItemTypes", options.includeItemTypes);
    if (options.sortBy) params.set("SortBy", options.sortBy);
    if (options.sortOrder) params.set("SortOrder", options.sortOrder);
    if (options.filters) params.set("Filters", options.filters);
    if (options.searchTerm) params.set("SearchTerm", options.searchTerm);
    if (options.genres) params.set("Genres", options.genres);
    if (options.years) params.set("Years", options.years);
    for (const [name, value] of Object.entries(options.extra ?? {})) params.set(name, value);
    return this.json<ItemList>(`/Users/${this.auth.userId}/Items?${params}`);
  }

  genres(parentId: string | undefined, includeItemTypes: string) {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      IncludeItemTypes: includeItemTypes,
      SortBy: "SortName",
      Recursive: "true",
    });
    if (parentId) params.set("ParentId", parentId);
    return this.json<ItemList>(`/Genres?${params}`);
  }

  /** Admin only. Sessions with something playing right now. */
  async nowPlaying() {
    const sessions = await this.json<ActiveSession[]>("/Sessions?ActiveWithinSeconds=960");
    return sessions.filter((session) => session.NowPlayingItem);
  }

  /**
   * Admin only. Runs a read-only query against the Playback Reporting plugin's
   * PlaybackActivity table. User ids come back as user names.
   */
  async playbackQuery(sql: string) {
    const body = await this.json<{ colums?: string[]; results?: string[][]; message?: string }>("/user_usage_stats/submit_custom_query", {
      CustomQueryString: sql,
      ReplaceUserId: true,
    });
    if (body.message) throw new Error(body.message);
    return body.results ?? [];
  }

  async itemsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const list = await this.items({ limit: ids.length, extra: { Ids: ids.join(",") } });
    return list.Items ?? [];
  }

  similar(id: string, limit = 20) {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      Limit: String(limit),
      Fields: LIST_FIELDS,
      EnableImageTypes: "Primary,Backdrop,Thumb",
    });
    return this.json<ItemList>(`/Items/${id}/Similar?${params}`);
  }

  item(id: string) {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      Fields:
        "Overview,Genres,People,Studios,MediaSources,MediaStreams,OfficialRating,CommunityRating,CriticRating,RunTimeTicks,ChildCount,Taglines,PremiereDate,EndDate,Status,Trickplay,ProductionLocations,LocalTrailerCount,RemoteTrailers",
    });
    return this.json<BaseItem>(`/Users/${this.auth.userId}/Items/${id}?${params}`);
  }

  localTrailers(id: string) {
    return this.json<BaseItem[]>(`/Items/${id}/LocalTrailers?${new URLSearchParams({ userId: this.auth.userId })}`);
  }

  seasons(seriesId: string) {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      Fields: "Overview,ChildCount,PrimaryImageAspectRatio",
      EnableImageTypes: "Primary,Thumb,Backdrop",
      EnableUserData: "true",
    });
    return this.json<ItemList>(`/Shows/${seriesId}/Seasons?${params}`);
  }

  episodes(seriesId: string, seasonId: string) {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      SeasonId: seasonId,
      Fields: "Overview,RunTimeTicks,PrimaryImageAspectRatio,PremiereDate",
      EnableImageTypes: "Primary,Thumb,Backdrop",
      EnableUserData: "true",
    });
    return this.json<ItemList>(`/Shows/${seriesId}/Episodes?${params}`);
  }

  async nextEpisode(episode: BaseItem): Promise<BaseItem | undefined> {
    if (episode.Type !== "Episode" || !episode.SeriesId) return undefined;
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      StartItemId: episode.Id,
      Limit: "2",
      Fields: "Overview,RunTimeTicks,PrimaryImageAspectRatio",
      EnableImageTypes: "Primary,Thumb,Backdrop",
      EnableUserData: "true",
    });
    const list = await this.json<ItemList>(`/Shows/${episode.SeriesId}/Episodes?${params}`);
    const items = list.Items ?? [];
    return items[0]?.Id === episode.Id ? items[1] : undefined;
  }

  /** Intro, credits and recap markers. Empty on servers without segment providers. */
  async segments(itemId: string): Promise<MediaSegment[]> {
    try {
      const list = await this.json<{ Items?: MediaSegment[] }>(`/MediaSegments/${itemId}`);
      return list.Items ?? [];
    } catch {
      return [];
    }
  }

  setFavorite(itemId: string, favorite: boolean) {
    return this.send(favorite ? "POST" : "DELETE", `/UserFavoriteItems/${itemId}?userId=${this.auth.userId}`);
  }

  setPlayed(itemId: string, played: boolean) {
    return this.send(played ? "POST" : "DELETE", `/UserPlayedItems/${itemId}?userId=${this.auth.userId}`);
  }

  search(term: string, includeItemTypes: string, limit = 24) {
    return this.items({ searchTerm: term, includeItemTypes, limit });
  }

  playbackInfo(itemId: string, options: { startTicks: number; mediaSourceId?: string; subtitleIndex?: number; maxBitrate: number }) {
    return this.json<PlaybackInfo>(`/Items/${itemId}/PlaybackInfo`, {
      UserId: this.auth.userId,
      MaxStreamingBitrate: options.maxBitrate,
      StartTimeTicks: options.startTicks,
      AutoOpenLiveStream: true,
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      MediaSourceId: options.mediaSourceId,
      SubtitleStreamIndex: options.subtitleIndex,
      DeviceProfile: deviceProfile(options.maxBitrate),
    });
  }

  syncGroups() {
    return this.json<SyncGroup[]>("/SyncPlay/List");
  }

  async sync(action: string, body?: Record<string, unknown>) {
    await this.send("POST", `/SyncPlay/${action}`, body ?? {});
  }

  utcTime() {
    return this.json<{ RequestReceptionTime: string; ResponseTransmissionTime: string }>("/GetUtcTime");
  }

  /** The server push socket. The token rides in the query because browsers can't set socket headers. */
  socketUrl() {
    const params = new URLSearchParams({ ApiKey: this.auth.token, deviceId: this.auth.deviceId });
    return `${this.auth.server.replace(/^http/i, "ws")}/socket?${params}`;
  }

  liveChannels() {
    const params = new URLSearchParams({
      UserId: this.auth.userId,
      AddCurrentProgram: "true",
      EnableImageTypes: "Primary,Thumb,Backdrop",
      EnableUserData: "true",
      Fields: "PrimaryImageAspectRatio,Overview",
      Limit: "500",
    });
    return this.json<ItemList>(`/LiveTv/Channels?${params}`);
  }

  livePrograms(channelIds: string[], start: Date, end: Date) {
    return this.json<ItemList>("/LiveTv/Programs", {
      UserId: this.auth.userId,
      ChannelIds: channelIds,
      MinEndDate: start.toISOString(),
      MaxStartDate: end.toISOString(),
      SortBy: ["StartDate"],
      EnableImages: true,
      EnableImageTypes: ["Primary", "Thumb"],
      Fields: ["Overview"],
      EnableTotalRecordCount: false,
      Limit: 5000,
    });
  }

  report(event: "start" | "progress" | "stop", body: Record<string, unknown>) {
    const path =
      event === "start" ? "/Sessions/Playing" : event === "progress" ? "/Sessions/Playing/Progress" : "/Sessions/Playing/Stopped";
    return this.send("POST", path, body);
  }

  capabilities() {
    return this.send("POST", "/Sessions/Capabilities/Full", {
      PlayableMediaTypes: ["Video", "Audio"],
      SupportedCommands: [],
      SupportsMediaControl: false,
      SupportsPersistentIdentifier: true,
    });
  }

  seerrUserStatus() {
    return this.seerr<{ active: boolean; userFound: boolean }>("/user-status");
  }

  seerrSearch(query: string) {
    return this.seerr<SeerrSearch>(`/search?query=${encodeURIComponent(query)}`);
  }

  seerrDiscover(list: string, page = 1) {
    return this.seerr<SeerrSearch>(`/discover/${list}?page=${page}`);
  }

  seerrRequests(take: number, skip: number) {
    return this.seerr<SeerrRequestPage>(`/request?take=${take}&skip=${skip}&sort=added`);
  }

  seerrMovie(tmdbId: number) {
    return this.seerr<SeerrResult>(`/movie/${tmdbId}`);
  }

  seerrTv(tmdbId: number) {
    return this.seerr<SeerrTv>(`/tv/${tmdbId}`);
  }

  seerrRequest(body: { mediaType: "movie" | "tv"; mediaId: number; seasons?: number[] }) {
    return this.seerr<unknown>("/request", body);
  }

  private async seerr<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.send(body ? "POST" : "GET", `/JellyfinEnhanced/jellyseerr${path}`, body, {
      "X-Jellyfin-User-Id": this.auth.userId,
    });
    return (await response.json()) as T;
  }

  private async json<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.send(body ? "POST" : "GET", path, body);
    return (await response.json()) as T;
  }

  private async send(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    let response: Response;
    try {
      response = await fetch(`${this.auth.server}${path}`, {
        method,
        headers: {
          Authorization: authHeader(this.auth.deviceId, this.auth.token),
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Could not reach the Jellyfin server.");
    }
    if (response.status === 401) {
      this.onUnauthorized();
      throw new ApiError(401, "The server session expired. Sign in again.");
    }
    if (!response.ok) {
      throw new ApiError(response.status, `The server returned ${response.status}.`);
    }
    return response;
  }
}
